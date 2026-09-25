/**
 * Freestyle VM integration. Structural types mirror the `freestyle` SDK's
 * `Vm.exec` so the SDK stays an optional peer dependency; the real `Freestyle`
 * client and `Vm` handles satisfy them without any adapter code.
 *
 * Scripts run as `root` (override with `linuxUser`) because mounting FUSE
 * filesystems and installing packages need it. Freestyle caps one exec call at
 * five minutes; every step in this library stays under that.
 */
import { ValidationError } from './errors.js';
import { RcloneBackend, type RuntimeInfo } from './rclone.js';
import type { SandboxExecInput, SandboxExecResult, SandboxResolver, SandboxRuntime } from './sandbox.js';
import { assertInteger } from './validate.js';

export interface FreestyleExecOptions {
  command: string;
  linuxUser?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface FreestyleExecResult {
  stdout?: string | null;
  stderr?: string | null;
  /** Exit status, null when the command was killed by its timeout. */
  statusCode?: number | null;
}

/** What this library needs from a `Vm` handle of the `freestyle` SDK. */
export interface FreestyleVmLike {
  readonly id: string;
  exec(options: FreestyleExecOptions): Promise<FreestyleExecResult>;
}

/** What this library needs from a `Freestyle` client of the `freestyle` SDK. */
export interface FreestyleClientLike {
  vms: { ref(vmIdOrSlug: string): FreestyleVmLike };
}

export interface FreestyleSandboxOptions {
  /** Guest user for every script. Default `root`. */
  linuxUser?: string;
}

const FREESTYLE_MAX_EXEC_MS = 300_000;

export class FreestyleSandbox implements SandboxRuntime {
  private readonly linuxUser: string;

  constructor(
    readonly vm: FreestyleVmLike,
    options: FreestyleSandboxOptions = {},
  ) {
    this.linuxUser = options.linuxUser ?? 'root';
  }

  get id(): string {
    return this.vm.id;
  }

  async exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    const options: FreestyleExecOptions = {
      command: input.command,
      linuxUser: this.linuxUser,
      timeoutMs: Math.max(1, Math.min(input.timeoutMs, FREESTYLE_MAX_EXEC_MS)),
    };
    if (input.env) options.env = input.env;
    const result = await this.vm.exec(options);
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.statusCode ?? null };
  }
}

/**
 * Sandbox resolver over a `Freestyle` client: `sandboxId` is a VM id or slug.
 *
 * @example
 * import { Freestyle } from 'freestyle';
 * const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
 * const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle) });
 */
export function freestyleSandboxes(freestyle: FreestyleClientLike, options: FreestyleSandboxOptions = {}): SandboxResolver {
  return {
    get(sandboxId: string): SandboxRuntime {
      return new FreestyleSandbox(freestyle.vms.ref(sandboxId), options);
    },
  };
}

/** One side of a Freestyle firewall rule (the SDK's `FirewallEndpoint`). */
export interface FreestyleFirewallEndpoint {
  vmId?: string;
  vpcId?: string;
  tunnelId?: string;
  cidr?: string;
  public?: true;
  port?: number;
  protocol?: 'tcp' | 'udp' | 'icmp';
}

/** The `firewall` block of `freestyle.vms.create` (the SDK's `FirewallSpec`). */
export interface FreestyleFirewallSpec {
  rules: Array<{ action: 'allow'; source: FreestyleFirewallEndpoint; destination: FreestyleFirewallEndpoint; description?: string }>;
}

/** The `vms.create` options {@link createVolumeReadySnapshot} sets on its builder VM. */
export interface FreestyleCreateVmOptionsLike {
  snapshotId?: string | null;
  displayName?: string | null;
  metadata?: Record<string, string>;
  ttlSeconds?: number | null;
  firewall: FreestyleFirewallSpec;
}

/** What {@link createVolumeReadySnapshot} needs from a `Vm` handle. */
export interface FreestyleSnapshotVmLike extends FreestyleVmLike {
  snapshot(options?: { slug?: string; displayName?: string }): Promise<{ snapshotId: string }>;
  delete(): Promise<void>;
}

/** What {@link createVolumeReadySnapshot} needs from a `Freestyle` client. */
export interface FreestyleSnapshotClientLike {
  vms: { create(options: FreestyleCreateVmOptionsLike): Promise<{ vm: FreestyleSnapshotVmLike; vmId: string }> };
}

export interface VolumeReadySnapshotEvent {
  type: 'builder.created' | 'runtime.ready' | 'snapshot.created' | 'builder.deleted' | 'warning';
  vmId: string;
  message?: string;
}

export interface VolumeReadySnapshotOptions {
  /**
   * Snapshot to build from: an id, your slug, or a base such as `freestyle/ubuntu-sm`.
   * Omit for Freestyle's platform default. VMs booted from the result keep the
   * base's CPU, memory and disk, so build one snapshot per size you boot.
   */
  baseSnapshotId?: string;
  /** Slug for the new snapshot, so VMs can boot from it by name: `vms.create({ snapshotId: slug, ... })`. */
  slug?: string;
  displayName?: string;
  /** Firewall for the temporary builder VM. Default: outbound to the public Internet, for apt mirrors and downloads.rclone.org. */
  firewall?: FreestyleFirewallSpec;
  /** Limit for installing fuse3 and rclone. Default 240000 ms; Freestyle caps one exec at 300000 ms. */
  bootstrapTimeoutMs?: number;
  /** Freestyle deletes the builder VM this many seconds after creating it, even if this process dies first. Default 3600. */
  builderTtlSeconds?: number;
  /** Guest paths must match the backend of the `FreestyleVolumes` instance that attaches volumes later. */
  backend?: RcloneBackend;
  /** Structured progress. Building takes minutes: VM boot, apt, a 30 MB download, then the snapshot. */
  onEvent?: (event: VolumeReadySnapshotEvent) => void;
}

export interface VolumeReadySnapshot {
  snapshotId: string;
  slug: string | null;
  /** The temporary VM the snapshot was taken from. It is deleted before this resolves unless `warnings` says otherwise. */
  builderVmId: string;
  /** What the snapshot contains: the rclone binary, its version and the fusermount helper. */
  runtime: RuntimeInfo;
  warnings: string[];
}

/** Freestyle's documented slug rule for VMs: 1-63 chars of [a-z0-9-], no leading, trailing or repeated hyphens. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$/;

/**
 * Build a Freestyle snapshot with the volume runtime (fuse3, flock and the
 * pinned, checksum-verified rclone) already installed, so VMs booted from it
 * skip the minute or two of installs on their first attach.
 *
 * Boots a temporary builder VM, runs the same bootstrap `attach` would, takes
 * a snapshot and deletes the builder VM. No storage credentials are involved,
 * so none can end up in the snapshot.
 *
 * @example
 * const { snapshotId } = await createVolumeReadySnapshot(freestyle, { baseSnapshotId: 'freestyle/ubuntu-sm', slug: 'ubuntu-sm-volumes' });
 * const { vmId } = await freestyle.vms.create({ snapshotId, firewall });
 */
export async function createVolumeReadySnapshot(freestyle: FreestyleSnapshotClientLike, options: VolumeReadySnapshotOptions = {}): Promise<VolumeReadySnapshot> {
  if (options.slug !== undefined && (typeof options.slug !== 'string' || !SLUG.test(options.slug))) {
    throw new ValidationError(`Invalid snapshot slug ${JSON.stringify(options.slug)}.`, {
      hint: 'Use 1-63 lowercase letters, digits or single hyphens, starting and ending with a letter or digit.',
    });
  }
  const timeoutMs = assertInteger('bootstrapTimeoutMs', options.bootstrapTimeoutMs ?? 240_000, 1000, FREESTYLE_MAX_EXEC_MS);
  const ttlSeconds = assertInteger('builderTtlSeconds', options.builderTtlSeconds ?? 3600, 600, 86_400);
  const backend = options.backend ?? new RcloneBackend();
  const emit = (event: VolumeReadySnapshotEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers must not break the build.
    }
  };

  const create: FreestyleCreateVmOptionsLike = {
    displayName: 'freestyle-volumes-snapshot-builder',
    metadata: { 'freestyle-volumes': 'snapshot-builder' },
    ttlSeconds,
    firewall: options.firewall ?? { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  };
  if (options.baseSnapshotId !== undefined) create.snapshotId = options.baseSnapshotId;
  const { vm, vmId } = await freestyle.vms.create(create);
  emit({ type: 'builder.created', vmId, message: options.baseSnapshotId ?? 'platform default snapshot' });

  const warnings: string[] = [];
  let result: VolumeReadySnapshot;
  try {
    const runtime = await backend.ensureRuntime(new FreestyleSandbox(vm), { timeoutMs });
    emit({ type: 'runtime.ready', vmId, message: `rclone ${runtime.rcloneVersion}` });
    const snapshotOptions: { slug?: string; displayName?: string } = {};
    if (options.slug !== undefined) snapshotOptions.slug = options.slug;
    if (options.displayName !== undefined) snapshotOptions.displayName = options.displayName;
    const { snapshotId } = await vm.snapshot(snapshotOptions);
    emit({ type: 'snapshot.created', vmId, message: snapshotId });
    result = { snapshotId, slug: options.slug ?? null, builderVmId: vmId, runtime, warnings };
  } finally {
    try {
      await vm.delete();
      emit({ type: 'builder.deleted', vmId });
    } catch (error) {
      const message = `Could not delete builder VM ${vmId} (${error instanceof Error ? error.message : String(error)}); Freestyle deletes it ${ttlSeconds} s after creation.`;
      warnings.push(message);
      emit({ type: 'warning', vmId, message });
    }
  }
  return result;
}
