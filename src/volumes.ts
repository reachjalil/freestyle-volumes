/**
 * The Daytona-style facade. Storage configuration, the sandbox integration and
 * the filesystem process management stay separate underneath:
 *   - {@link VolumeRegistry}   metadata + data prefixes in the bucket
 *   - {@link RcloneBackend}    the rclone FUSE mount inside the sandbox
 *   - {@link SandboxResolver}  how to run a script in a sandbox (Freestyle, Docker)
 */
import { VolumeError } from './errors.js';
import { DEFAULT_GUEST_PATHS, RcloneBackend, type CacheMode, type MountSpec } from './rclone.js';
import { VolumeRegistry, type AttachmentRecord, type Volume, type CloneVolumeOptions, type CloneResult, type ListVolumesOptions } from './registry.js';
import type { SandboxResolver } from './sandbox.js';
import { RCLONE_REMOTE, S3ObjectStore, rcloneRemoteEnv, resolveStorage, type ObjectStore, type ResolvedStorage, type StorageConfig } from './storage.js';
import { assertCacheSize, assertInteger, assertMountPath, assertRcloneSize, assertSandboxId, assertSubpath, assertUmask, assertVolumeName, mountIdFor } from './validate.js';

export interface MountDefaults {
  /** rclone VFS cache mode. `writes` buffers writes on the sandbox disk; `full` also caches reads. */
  cacheMode: CacheMode;
  /** Seconds a closed file waits before its upload starts. Detach forces pending uploads regardless. */
  writeBackSeconds: number;
  /** Seconds directory listings are cached. Changes made by other sandboxes become visible after this. */
  dirCacheSeconds: number;
  /** Let users other than root use the mount (`--allow-other`). */
  allowOther: boolean;
  /** Report this uid as the owner of every file (`--uid`). Default: the mounting user, root. */
  uid?: number;
  gid?: number;
  /** Permission mask, e.g. "022". */
  umask?: string;
  /** Cap for the on-disk write cache, e.g. "10G". Unbounded by default. */
  cacheMaxSize?: string;
  /** Per-open-file memory buffer, e.g. "16M" or "0B". Explicit units required; omitted uses rclone's default. */
  bufferSize?: string;
  /** Extra disk read-ahead, effective only with cacheMode: "full"; does not change cacheMode. Explicit units required. */
  readAhead?: string;
  /** Initial ranged-read chunk size, e.g. "128M". Explicit units required; omitted uses rclone's default. */
  readChunkSize?: string;
  /** Maximum ranged-read chunk size with explicit units, or "off" for no limit. Omitted uses rclone's default. */
  readChunkSizeLimit?: string;
  /** Daemon-wide concurrent file transfers, integer 1–64. Omitted uses rclone's default. */
  transfers?: number;
  /** How long attach waits for the FUSE mount to answer a directory listing. */
  readyTimeoutMs: number;
  /** How long detach waits for pending uploads to finish. */
  flushTimeoutMs: number;
  /** How long the runtime bootstrap (fuse3 + rclone install) may take. */
  bootstrapTimeoutMs: number;
  inspectTimeoutMs: number;
}

export const DEFAULT_MOUNT_DEFAULTS: MountDefaults = {
  cacheMode: 'writes',
  writeBackSeconds: 5,
  dirCacheSeconds: 60,
  allowOther: true,
  readyTimeoutMs: 30_000,
  flushTimeoutMs: 60_000,
  bootstrapTimeoutMs: 240_000,
  inspectTimeoutMs: 30_000,
};

/** Freestyle's hard cap on one exec call. */
const MAX_EXEC_MS = 300_000;

export interface VolumeEvent {
  type: 'volume.created' | 'volume.deleted' | 'attach.bootstrap' | 'attach.mount' | 'attach.done' | 'detach.start' | 'detach.done' | 'warning';
  sandboxId?: string;
  volumeId?: string;
  mountPath?: string;
  message?: string;
}

export interface FreestyleVolumesOptions {
  storage: StorageConfig;
  sandboxes: SandboxResolver;
  /** Override the object store (tests, dry runs). */
  objectStore?: ObjectStore;
  backend?: RcloneBackend;
  defaults?: Partial<MountDefaults>;
  /** Structured progress events. Never contain credentials. */
  onEvent?: (event: VolumeEvent) => void;
}

export interface CreateVolumeOptions {
  name: string;
  labels?: Record<string, string>;
  /** Return the existing volume instead of failing when the name is taken. */
  ifNotExists?: boolean;
}

export interface GetVolumeOptions {
  /** Create the volume when it does not exist (Daytona's `volume.get(name, true)`). */
  create?: boolean;
}

export interface AttachVolumeOptions extends Partial<Omit<MountDefaults, 'flushTimeoutMs' | 'inspectTimeoutMs'>> {
  sandboxId: string;
  volumeId: string;
  /** Absolute path inside the sandbox. Created if missing; must be empty. */
  mountPath: string;
  readOnly?: boolean;
  /** Directory inside the volume to expose as the mount root (tenant isolation). */
  subpath?: string;
}

export interface VolumeAttachment {
  sandboxId: string;
  volumeId: string;
  mountPath: string;
  subpath: string | null;
  readOnly: boolean;
  mountId: string;
  pid: number;
  /** True when a healthy mount of the same volume already existed at this path. */
  alreadyAttached: boolean;
  warnings: string[];
}

export interface InspectMountOptions {
  sandboxId: string;
  mountPath: string;
  timeoutMs?: number;
}

export interface MountInspection {
  /**
   * `mounted`: healthy. `stale`: this library attached something here, but the
   * mount or its process is gone (crash, sandbox restart); pending writes may
   * sit in the sandbox cache. `absent`: nothing managed here. `unmanaged`: an
   * rclone mount this library did not create.
   */
  status: 'mounted' | 'stale' | 'absent' | 'unmanaged';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  subpath: string | null;
  readOnly: boolean | null;
  pid: number | null;
  /** The FUSE mount answered a stat call within 5 seconds. */
  responsive: boolean;
  uploads: { queued: number; inProgress: number; errored: number } | null;
  cacheBytes: number | null;
  startedAt: string | null;
  logTail: string[];
}

export interface DetachVolumeOptions {
  sandboxId: string;
  mountPath: string;
  flushTimeoutMs?: number;
  /**
   * Detach even when pending writes cannot be flushed, a process holds files
   * open, or the mount is stale. The result then reports `flushed: false` and
   * the unflushed data stays in the sandbox cache directory.
   */
  force?: boolean;
}

export interface DetachResult {
  status: 'detached' | 'absent';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  /** True only when the mount was removed and its pending uploads then fully drained. */
  flushed: boolean;
  /** Uploads still pending after the drain attempt; null when unknown. */
  pendingUploads: number | null;
  warnings: string[];
}

export interface ListMountsOptions {
  sandboxId: string;
  timeoutMs?: number;
}

export interface MountSummary {
  /** `mounted`: healthy. `stale`: a state record without a healthy mount (crash, restart, or recovery data retained by a failed or forced detach). */
  status: 'mounted' | 'stale';
  /** Null when the state record is unreadable; inspect it in the sandbox. */
  mountPath: string | null;
  volumeId: string | null;
  subpath: string | null;
  readOnly: boolean | null;
  mountId: string;
  pid: number | null;
  startedAt: string | null;
}

export interface MountListing {
  sandboxId: string;
  /** Every mount this library manages in the sandbox, sorted by mount path. */
  mounts: MountSummary[];
  /** rclone mounts that this library did not create. They are never touched. */
  unmanaged: string[];
}

export interface DetachAllOptions {
  sandboxId: string;
  flushTimeoutMs?: number;
  /** Passed to every detach; see {@link DetachVolumeOptions.force}. */
  force?: boolean;
}

/** A mount that `detachAll` could not detach. Its recovery state, cache and advisory record are retained. */
export interface DetachFailure {
  status: 'failed';
  sandboxId: string;
  mountPath: string | null;
  volumeId: string | null;
  flushed: false;
  pendingUploads: null;
  warnings: string[];
  error: { code: string; message: string };
}

export interface DetachAllResult {
  sandboxId: string;
  /** True when every managed mount was detached with a verified flush or was already gone: nothing unflushed is left in the sandbox. */
  flushed: boolean;
  results: Array<DetachResult | DetachFailure>;
  /** rclone mounts this library did not create; left alone. */
  unmanaged: string[];
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** The next step when the status is `warn` or `fail`. */
  hint?: string;
}

export interface CheckReport {
  /** False when any check failed. Warnings are work attach will do, such as installing rclone, or checks that cannot run yet. */
  ok: boolean;
  checks: CheckResult[];
}

export interface CheckSandboxOptions {
  sandboxId: string;
  /** Default 120000 ms; the check makes network probes from inside the sandbox. */
  timeoutMs?: number;
}

const SANDBOX_CHECK_HINTS: Record<string, string> = {
  'arch:fail': 'Only x86_64 and aarch64 sandboxes are supported.',
  'root:fail': 'Run the scripts as root, the default linuxUser of freestyleSandboxes().',
  'fuse-device:fail': 'Freestyle Ubuntu VMs expose /dev/fuse. A Docker container needs --device /dev/fuse --cap-add SYS_ADMIN.',
  'fusermount:fail': 'Use an image with apt-get or apk, or preinstall fuse3.',
  'flock:fail': 'Use an image with apt-get or apk, or preinstall util-linux.',
  'rclone:warn': 'Boot from a volume-ready snapshot (createVolumeReadySnapshot or `freestyle-volumes prepare-snapshot`) to skip the download on attach.',
  'rclone-download:fail': 'Allow outbound HTTPS to downloads.rclone.org in the VM firewall, or boot from a volume-ready snapshot.',
  'storage:fail': 'If checkStorage passes from this process, the VM cannot reach the bucket: allow outbound traffic to the storage endpoint in the VM firewall, and set storage.sandboxEndpoint when the VM reaches storage at a different address.',
  'storage:warn': 'Credentials are verified from inside the VM once rclone is installed.',
  'cache-disk:warn': 'Pending writes are cached on the VM disk; set cacheMaxSize or use a larger VM.',
};

export interface DeleteVolumeOptions {
  volumeId: string;
  /** Must equal `volumeId`. Deleting destroys every object under the volume's data prefix. */
  confirm: string;
  /** Delete even when advisory attachment records exist. */
  force?: boolean;
}

export interface DeleteResult {
  volumeId: string;
  deletedObjects: number;
  attachments: AttachmentRecord[];
}

export class FreestyleVolumes {
  readonly storage: ResolvedStorage;
  readonly registry: VolumeRegistry;
  readonly backend: RcloneBackend;
  readonly defaults: MountDefaults;
  private readonly sandboxes: SandboxResolver;
  private readonly onEvent: ((event: VolumeEvent) => void) | undefined;

  constructor(options: FreestyleVolumesOptions) {
    if (!options || typeof options !== 'object') throw new VolumeError('VALIDATION', 'FreestyleVolumes needs an options object.');
    if (!options.sandboxes || typeof options.sandboxes.get !== 'function') {
      throw new VolumeError('VALIDATION', 'options.sandboxes must be a SandboxResolver (see freestyleSandboxes() or dockerSandboxes()).');
    }
    this.storage = resolveStorage(options.storage);
    this.registry = new VolumeRegistry(options.objectStore ?? new S3ObjectStore(this.storage), this.storage.prefix);
    this.backend = options.backend ?? new RcloneBackend();
    this.defaults = validateDefaults({ ...DEFAULT_MOUNT_DEFAULTS, ...options.defaults });
    this.sandboxes = options.sandboxes;
    this.onEvent = options.onEvent;
  }

  private emit(event: VolumeEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observers must not break operations.
    }
  }

  async create(options: CreateVolumeOptions): Promise<Volume> {
    const volume = await this.registry.create({ name: options.name, labels: options.labels }, { ifNotExists: options.ifNotExists });
    this.emit({ type: 'volume.created', volumeId: volume.id });
    return volume;
  }

  async get(name: string, options: GetVolumeOptions = {}): Promise<Volume> {
    if (options.create) return this.create({ name, ifNotExists: true });
    return this.registry.get(name);
  }

  /** Server-side, object-wise consistent clone. Advisory attachment checks do not provide snapshot isolation. */
  async clone(options: CloneVolumeOptions): Promise<CloneResult> {
    const result = await this.registry.clone(options);
    this.emit({ type: 'volume.created', volumeId: result.volume.id });
    return result;
  }

  async list(options: ListVolumesOptions = {}): Promise<Volume[]> {
    return this.registry.list(options);
  }

  /** Destroys the volume record and every object under its data prefix. Requires `confirm === volumeId`. */
  async delete(options: DeleteVolumeOptions): Promise<DeleteResult> {
    const volumeId = assertVolumeName(options.volumeId);
    if (options.confirm !== volumeId) {
      throw new VolumeError('CONFIRMATION_REQUIRED', `Refusing to delete volume "${volumeId}": pass { confirm: "${volumeId}" } to confirm destroying all of its data.`);
    }
    const result = await this.registry.delete(volumeId, { force: options.force });
    this.emit({ type: 'volume.deleted', volumeId, message: `${result.deletedObjects} objects deleted` });
    return { volumeId, ...result };
  }

  /**
   * Mount a volume into a sandbox. Idempotent: a healthy mount of the same
   * storage identity, volume and read-only mode at the same path is reported with
   * `alreadyAttached: true`. Stale mounts require detach before retrying;
   * retained cache is reused only for the same storage and mount identity.
   */
  async attach(options: AttachVolumeOptions): Promise<VolumeAttachment> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const volumeId = assertVolumeName(options.volumeId);
    const mountPath = assertMountPath(options.mountPath);
    const subpath = options.subpath === undefined ? undefined : assertSubpath(options.subpath);
    const readOnly = options.readOnly === true;
    const settings = validateDefaults({ ...this.defaults, ...stripUndefined(options) });
    const volume = await this.registry.get(volumeId);
    const mountId = mountIdFor(volumeId, subpath, mountPath, this.storage, volume.generation);
    const dataPrefix = subpath ? `${volume.dataPrefix}/${subpath}` : volume.dataPrefix;
    await this.registry.precheck(dataPrefix);

    const sandbox = await this.sandboxes.get(sandboxId);
    this.emit({ type: 'attach.bootstrap', sandboxId, volumeId, mountPath });
    await this.backend.ensureRuntime(sandbox, { timeoutMs: Math.min(settings.bootstrapTimeoutMs, MAX_EXEC_MS) });

    const spec: MountSpec = {
      mountId,
      remotePath: `${RCLONE_REMOTE}:${this.storage.bucket}/${dataPrefix}`,
      mountPath,
      readOnly,
      cacheMode: settings.cacheMode,
      writeBackSeconds: settings.writeBackSeconds,
      dirCacheSeconds: settings.dirCacheSeconds,
      allowOther: settings.allowOther,
      readyTimeoutMs: settings.readyTimeoutMs,
      stateJson: JSON.stringify({
        version: 1,
        mountId,
        volumeId: volume.id,
        generation: volume.generation,
        subpath: subpath ?? null,
        mountPath,
        readOnly,
        cacheMode: settings.cacheMode,
        sandboxId,
        startedAt: new Date().toISOString(),
      }),
    };
    if (settings.uid !== undefined) spec.uid = settings.uid;
    if (settings.gid !== undefined) spec.gid = settings.gid;
    if (settings.umask !== undefined) spec.umask = settings.umask;
    if (settings.cacheMaxSize !== undefined) spec.cacheMaxSize = settings.cacheMaxSize;
    if (settings.bufferSize !== undefined) spec.bufferSize = settings.bufferSize;
    if (settings.readAhead !== undefined) spec.readAhead = settings.readAhead;
    if (settings.readChunkSize !== undefined) spec.readChunkSize = settings.readChunkSize;
    if (settings.readChunkSizeLimit !== undefined) spec.readChunkSizeLimit = settings.readChunkSizeLimit;
    if (settings.transfers !== undefined) spec.transfers = settings.transfers;

    this.emit({ type: 'attach.mount', sandboxId, volumeId, mountPath });
    const mounted = await this.backend.mount(sandbox, spec, rcloneRemoteEnv(this.storage), { timeoutMs: Math.min(settings.readyTimeoutMs + 30_000, MAX_EXEC_MS) });

    const warnings: string[] = [];
    try {
      await this.registry.putAttachment({ volumeId: volume.id, sandboxId, mountId, mountPath, subpath: subpath ?? null, readOnly, attachedAt: new Date().toISOString() });
    } catch (error) {
      const message = `The mount is live, but the advisory attachment record could not be written: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      this.emit({ type: 'warning', sandboxId, volumeId, mountPath, message });
    }
    this.emit({ type: 'attach.done', sandboxId, volumeId, mountPath, message: mounted.alreadyAttached ? 'already attached' : `pid ${mounted.pid}` });
    return { sandboxId, volumeId: volume.id, mountPath, subpath: subpath ?? null, readOnly, mountId, pid: mounted.pid, alreadyAttached: mounted.alreadyAttached, warnings };
  }

  async inspectMount(options: InspectMountOptions): Promise<MountInspection> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    const timeoutMs = Math.min(assertInteger('timeoutMs', options.timeoutMs ?? this.defaults.inspectTimeoutMs, 1000, MAX_EXEC_MS), MAX_EXEC_MS);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.inspect(sandbox, mountPath, { timeoutMs });
    let status: MountInspection['status'];
    if (guest.hasState) status = guest.mounted && guest.alive ? 'mounted' : 'stale';
    else status = guest.mounted ? 'unmanaged' : 'absent';
    const state = guest.state ?? {};
    return {
      status,
      sandboxId,
      mountPath,
      volumeId: typeof state.volumeId === 'string' ? state.volumeId : null,
      subpath: typeof state.subpath === 'string' ? state.subpath : null,
      readOnly: guest.readOnly ?? (typeof state.readOnly === 'boolean' ? state.readOnly : null),
      pid: guest.alive ? guest.pid : null,
      responsive: guest.responsive,
      uploads: guest.stats ? { queued: guest.stats.uploadsQueued, inProgress: guest.stats.uploadsInProgress, errored: guest.stats.erroredFiles } : null,
      cacheBytes: guest.stats ? guest.stats.cacheBytes : null,
      startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
      logTail: guest.logTail,
    };
  }

  /**
   * Unmount first to stop new writes, drain pending uploads, then stop the
   * filesystem process. Succeeds only after a verified drain (`flushed: true`),
   * unless `force` is set. An unflushed detach retains the advisory attachment
   * record to guard deletion while recoverable data remains in the sandbox.
   * Never deletes volume data.
   */
  async detach(options: DetachVolumeOptions): Promise<DetachResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    const flushTimeoutMs = assertInteger('flushTimeoutMs', options.flushTimeoutMs ?? this.defaults.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000);
    const force = options.force === true;
    const sandbox = await this.sandboxes.get(sandboxId);
    this.emit({ type: 'detach.start', sandboxId, mountPath });
    const guest = await this.backend.unmount(sandbox, { mountPath, flushTimeoutMs, force, timeoutMs: flushTimeoutMs + 40_000 });
    const warnings: string[] = [];
    if (guest.status === 'detached' && guest.flushed && guest.volumeId && guest.mountId) {
      try {
        await this.registry.removeAttachment(guest.volumeId, sandboxId, guest.mountId);
      } catch (error) {
        const message = `Detached, but the advisory attachment record could not be removed: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        this.emit({ type: 'warning', sandboxId, mountPath, volumeId: guest.volumeId, message });
      }
    }
    this.emit({ type: 'detach.done', sandboxId, mountPath, volumeId: guest.volumeId ?? undefined, message: guest.status === 'absent' ? 'nothing mounted' : guest.flushed ? 'flushed' : 'not flushed' });
    return {
      status: guest.status,
      sandboxId,
      mountPath,
      volumeId: guest.volumeId,
      flushed: guest.status === 'detached' && guest.flushed,
      pendingUploads: guest.pending,
      warnings,
    };
  }

  /**
   * Every mount this library manages in a sandbox, healthy or stale, plus rclone
   * mounts it did not create. A point-in-time view: no locks are taken.
   */
  async listMounts(options: ListMountsOptions): Promise<MountListing> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const timeoutMs = assertInteger('timeoutMs', options.timeoutMs ?? this.defaults.inspectTimeoutMs, 1000, MAX_EXEC_MS);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.listMounts(sandbox, { timeoutMs });
    const mounts = guest.mounts.map((mount): MountSummary => {
      const state = mount.state ?? {};
      return {
        status: mount.mounted && mount.alive ? 'mounted' : 'stale',
        mountPath: mountPathOrNull(state.mountPath),
        volumeId: typeof state.volumeId === 'string' ? state.volumeId : null,
        subpath: typeof state.subpath === 'string' ? state.subpath : null,
        readOnly: mount.readOnly ?? (typeof state.readOnly === 'boolean' ? state.readOnly : null),
        mountId: mount.mountId,
        pid: mount.alive ? mount.pid : null,
        startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
      };
    });
    mounts.sort((a, b) => (a.mountPath ?? '').localeCompare(b.mountPath ?? '') || a.mountId.localeCompare(b.mountId));
    return { sandboxId, mounts, unmanaged: [...guest.unmanaged].sort() };
  }

  /**
   * Detach every managed mount in a sandbox, one after another, before the VM
   * is deleted or snapshotted. Never throws for an individual mount: failures
   * are reported in `results`, with their recovery data retained, and
   * `flushed` is true only when nothing unflushed is left behind.
   */
  async detachAll(options: DetachAllOptions): Promise<DetachAllResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    if (options.flushTimeoutMs !== undefined) assertInteger('flushTimeoutMs', options.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000);
    const listing = await this.listMounts({ sandboxId });
    const results: Array<DetachResult | DetachFailure> = [];
    for (const mount of listing.mounts) {
      const failure = (code: string, message: string): DetachFailure => ({
        status: 'failed', sandboxId, mountPath: mount.mountPath, volumeId: mount.volumeId, flushed: false, pendingUploads: null, warnings: [], error: { code, message },
      });
      if (mount.mountPath === null) {
        results.push(failure('MOUNT_STALE', `State record ${mount.mountId} has no valid mount path; inspect ${this.backend.paths.stateRoot}/mounts/${mount.mountId} in the sandbox.`));
        continue;
      }
      const detachOptions: DetachVolumeOptions = { sandboxId, mountPath: mount.mountPath, force: options.force === true };
      if (options.flushTimeoutMs !== undefined) detachOptions.flushTimeoutMs = options.flushTimeoutMs;
      try {
        results.push(await this.detach(detachOptions));
      } catch (error) {
        results.push(failure(error instanceof VolumeError ? error.code : 'UNKNOWN', error instanceof Error ? error.message : String(error)));
      }
    }
    const flushed = results.every((result) => result.status === 'absent' || (result.status === 'detached' && result.flushed));
    return { sandboxId, flushed, results, unmanaged: listing.unmanaged };
  }

  /**
   * Preflight the bucket from this process: reachability, listing, atomic
   * conditional creation, read-back and delete, using one short-lived probe
   * object under `<prefix>/_doctor/`. Never throws for a failed check.
   */
  async checkStorage(): Promise<CheckReport> {
    const checks: CheckResult[] = await this.registry.checkStore();
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  /**
   * Preflight a sandbox without changing it: CPU, root, /dev/fuse, fusermount,
   * flock and rclone (or whether attach can install them), whether the sandbox
   * can reach the bucket with these credentials, and cache disk space.
   */
  async checkSandbox(options: CheckSandboxOptions): Promise<CheckReport> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const timeoutMs = assertInteger('timeoutMs', options.timeoutMs ?? 120_000, 1000, MAX_EXEC_MS);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.check(sandbox, rcloneRemoteEnv(this.storage), {
      remotePath: `${RCLONE_REMOTE}:${this.storage.bucket}/${this.storage.prefix}`,
      endpointUrl: this.storage.sandboxEndpoint ?? `https://s3.${this.storage.region}.amazonaws.com`,
      timeoutMs,
    });
    const checks = guest.map((check): CheckResult => {
      const hint = SANDBOX_CHECK_HINTS[`${check.name}:${check.status}`];
      return hint === undefined ? check : { ...check, hint };
    });
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }
}

function mountPathOrNull(value: unknown): string | null {
  try {
    return assertMountPath(value);
  } catch {
    return null;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

function validateDefaults(input: MountDefaults & Record<string, unknown>): MountDefaults {
  if (input.cacheMode !== 'writes' && input.cacheMode !== 'full') {
    throw new VolumeError('VALIDATION', `cacheMode must be "writes" or "full", got ${JSON.stringify(input.cacheMode)}.`);
  }
  const out: MountDefaults = {
    cacheMode: input.cacheMode,
    writeBackSeconds: assertInteger('writeBackSeconds', input.writeBackSeconds, 0, 3600),
    dirCacheSeconds: assertInteger('dirCacheSeconds', input.dirCacheSeconds, 0, 86_400),
    allowOther: input.allowOther === true,
    readyTimeoutMs: assertInteger('readyTimeoutMs', input.readyTimeoutMs, 1000, MAX_EXEC_MS - 30_000),
    flushTimeoutMs: assertInteger('flushTimeoutMs', input.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000),
    bootstrapTimeoutMs: assertInteger('bootstrapTimeoutMs', input.bootstrapTimeoutMs, 1000, MAX_EXEC_MS),
    inspectTimeoutMs: assertInteger('inspectTimeoutMs', input.inspectTimeoutMs, 1000, MAX_EXEC_MS),
  };
  if (input.uid !== undefined) out.uid = assertInteger('uid', input.uid, 0, 4_294_967_294);
  if (input.gid !== undefined) out.gid = assertInteger('gid', input.gid, 0, 4_294_967_294);
  if (input.umask !== undefined) out.umask = assertUmask(input.umask);
  if (input.cacheMaxSize !== undefined) out.cacheMaxSize = assertCacheSize(input.cacheMaxSize);
  if (input.bufferSize !== undefined) out.bufferSize = assertRcloneSize('bufferSize', input.bufferSize);
  if (input.readAhead !== undefined) out.readAhead = assertRcloneSize('readAhead', input.readAhead);
  if (input.readChunkSize !== undefined) out.readChunkSize = assertRcloneSize('readChunkSize', input.readChunkSize);
  if (input.readChunkSizeLimit !== undefined) out.readChunkSizeLimit = assertRcloneSize('readChunkSizeLimit', input.readChunkSizeLimit, true);
  if (input.transfers !== undefined) out.transfers = assertInteger('transfers', input.transfers, 1, 64);
  return out;
}

export { DEFAULT_GUEST_PATHS };
export type { Volume, AttachmentRecord };
export type { CloneVolumeOptions, CloneResult, ListVolumesOptions };
