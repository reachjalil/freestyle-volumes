// Runs generated guest scripts in a local `sh`, like a sandbox would, with
// shell overrides injected at a marker line. The overrides replace Linux
// introspection (proc files, tools, network probes) only; everything else is
// the real generated script.
import { execFile } from 'node:child_process';

export class LocalShellSandbox {
  constructor(id, { marker, overrides = '' }) {
    this.id = id;
    this.marker = marker;
    this.overrides = overrides;
    this.calls = [];
  }

  exec(input) {
    this.calls.push(input);
    if (!input.command.includes(this.marker)) throw new Error(`LocalShellSandbox ${this.id}: marker ${JSON.stringify(this.marker)} not found in the script`);
    const script = input.command.replace(this.marker, `${this.overrides}\n${this.marker}`);
    return new Promise((resolve) => {
      execFile('sh', ['-c', script], { env: { PATH: process.env.PATH, ...input.env }, timeout: input.timeoutMs }, (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}
