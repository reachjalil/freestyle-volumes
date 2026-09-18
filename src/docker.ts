/**
 * Docker integration for local development and the Linux integration tests.
 * A container stands in for a sandbox; it must be started with
 * `--device /dev/fuse --cap-add SYS_ADMIN` (and `--security-opt apparmor:unconfined`
 * on hosts that enforce AppArmor) for FUSE mounts to work.
 *
 * Environment variables are passed with `-e NAME` (value taken from this
 * process's environment for the docker CLI), so credentials never appear on
 * the host command line.
 */
import { spawn } from 'node:child_process';
import type { SandboxExecInput, SandboxExecResult, SandboxResolver, SandboxRuntime } from './sandbox.js';

export interface DockerSandboxOptions {
  /** Docker CLI binary. Default `docker`. */
  dockerBinary?: string;
  /** Container user. Default: the container's configured user (root for the images used in tests). */
  user?: string;
}

export class DockerSandbox implements SandboxRuntime {
  constructor(
    readonly id: string,
    private readonly options: DockerSandboxOptions = {},
  ) {}

  exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    return new Promise((resolve, reject) => {
      const args = ['exec'];
      if (this.options.user) args.push('-u', this.options.user);
      for (const key of Object.keys(input.env ?? {})) args.push('-e', key);
      args.push(this.id, 'sh', '-c', input.command);
      const child = spawn(this.options.dockerBinary ?? 'docker', args, {
        env: { ...process.env, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, input.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: timedOut ? null : code });
      });
    });
  }
}

/** Sandbox resolver over running Docker containers: `sandboxId` is a container name or id. */
export function dockerSandboxes(options: DockerSandboxOptions = {}): SandboxResolver {
  return {
    get(sandboxId: string): SandboxRuntime {
      return new DockerSandbox(sandboxId, options);
    },
  };
}
