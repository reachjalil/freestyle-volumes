import { SandboxError } from './errors.js';

/**
 * The narrow interface this library needs from a sandbox: run a shell script as
 * root with extra environment variables and a wall-clock limit. Everything the
 * library does inside a sandbox goes through this single method.
 */
export interface SandboxExecInput {
  /** A POSIX `sh` script. Never contains credentials. */
  command: string;
  /** Extra environment variables. This is how credentials reach the guest. */
  env?: Record<string, string>;
  /** Wall-clock limit in milliseconds. */
  timeoutMs: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  /** Exit status, or null when the command was killed by its timeout. */
  exitCode: number | null;
}

export interface SandboxRuntime {
  readonly id: string;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
}

/** Turns a sandbox id into a runtime handle. Implemented for Freestyle VMs and Docker containers. */
export interface SandboxResolver {
  get(sandboxId: string): SandboxRuntime | Promise<SandboxRuntime>;
}

export interface GuestRun extends SandboxExecResult {
  label: string;
}

/** Run a guest script and normalise transport-level failures into {@link SandboxError}. */
export async function runGuest(
  sandbox: SandboxRuntime,
  input: { label: string; script: string; env?: Record<string, string>; timeoutMs: number },
): Promise<GuestRun> {
  let result: SandboxExecResult;
  try {
    result = await sandbox.exec({ command: input.script, env: input.env, timeoutMs: input.timeoutMs });
  } catch (error) {
    throw new SandboxError('SANDBOX_EXEC', `Could not run the ${input.label} step in sandbox "${sandbox.id}".`, {
      cause: error,
      details: { sandboxId: sandbox.id, step: input.label },
    });
  }
  if (result.exitCode === null) {
    throw new SandboxError('SANDBOX_EXEC_TIMEOUT', `The ${input.label} step in sandbox "${sandbox.id}" hit its ${input.timeoutMs} ms limit.`, {
      details: { sandboxId: sandbox.id, step: input.label, timeoutMs: input.timeoutMs, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr) },
    });
  }
  return { ...result, label: input.label };
}

export function tail(text: string, lines = 20): string[] {
  return text.split('\n').filter((line) => line.length > 0).slice(-lines);
}
