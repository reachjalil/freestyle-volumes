/**
 * Freestyle VM integration. Structural types mirror the `freestyle` SDK's
 * `Vm.exec` so the SDK stays an optional peer dependency; the real `Freestyle`
 * client and `Vm` handles satisfy them without any adapter code.
 *
 * Scripts run as `root` (override with `linuxUser`) because mounting FUSE
 * filesystems and installing packages need it. Freestyle caps one exec call at
 * five minutes; every step in this library stays under that.
 */
import type { SandboxExecInput, SandboxExecResult, SandboxResolver, SandboxRuntime } from './sandbox.js';

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
