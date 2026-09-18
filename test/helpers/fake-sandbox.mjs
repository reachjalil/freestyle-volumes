// A scripted sandbox: each exec call pops the next canned response. Records
// every call so tests can assert on commands and environment.
export class FakeSandbox {
  constructor(id, responses = []) {
    this.id = id;
    this.responses = [...responses];
    this.calls = [];
  }
  async exec(input) {
    this.calls.push(input);
    const next = this.responses.shift();
    if (next === undefined) throw new Error(`FakeSandbox ${this.id}: no canned response for call ${this.calls.length}`);
    if (typeof next === 'function') return next(input);
    if (next instanceof Error) throw next;
    return { stdout: '', stderr: '', exitCode: 0, ...next };
  }
}

export function fakeResolver(sandboxes) {
  return {
    get(id) {
      const found = sandboxes.find((s) => s.id === id);
      if (!found) throw new Error(`unknown sandbox ${id}`);
      return found;
    },
  };
}

export const BOOTSTRAP_OK = { stdout: 'FSVOL_RESULT rclone=/usr/bin/rclone version=1.75.1 fusermount=/usr/bin/fusermount3 arch=x86_64\n' };
export const MOUNT_OK = { stdout: 'FSVOL_RESULT status=attached already=0 pid=4242\n' };
export const MOUNT_ALREADY = { stdout: 'FSVOL_RESULT status=attached already=1 pid=4242\n' };

export const storage = {
  endpoint: 'http://127.0.0.1:9000',
  sandboxEndpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'test-bucket',
  prefix: 'tenant-a',
  accessKeyId: 'AKIAFAKEKEYID',
  secretAccessKey: 'super-secret-value-never-logged',
};
