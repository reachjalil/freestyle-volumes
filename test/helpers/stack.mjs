// Local Linux integration stack: one MinIO container as the S3-compatible
// service, plus Docker containers that stand in for sandboxes. Containers get
// /dev/fuse so rclone can really mount. Everything is named per run and torn
// down afterwards.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

export const MINIO_IMAGE = process.env.VOLUMES_TEST_MINIO_IMAGE ?? 'quay.io/minio/minio:latest';
export const SANDBOX_IMAGE = process.env.VOLUMES_TEST_SANDBOX_IMAGE ?? 'rclone/rclone:latest';

export function dockerAvailable() {
  if (process.env.VOLUMES_SKIP_INTEGRATION === '1') return false;
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  return r.status === 0;
}

export function docker(args, options = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...options });
  if (r.status !== 0 && !options.allowFailure) throw new Error(`docker ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}

export async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}: ${lastError?.message ?? ''}`);
}

export class Stack {
  constructor() {
    this.id = randomBytes(4).toString('hex');
    this.network = `fsvol-net-${this.id}`;
    this.minio = `fsvol-minio-${this.id}`;
    this.sandboxes = [];
    this.accessKeyId = 'testadmin';
    this.secretAccessKey = `secret-${this.id}-0123456789`;
    this.bucket = 'volumes-test';
    this.counter = 0;
  }

  async start() {
    docker(['network', 'create', this.network]);
    docker(
      ['run', '-d', '--name', this.minio, '--network', this.network, '-p', '127.0.0.1::9000', '-e', 'MINIO_ROOT_USER', '-e', 'MINIO_ROOT_PASSWORD', MINIO_IMAGE, 'server', '/data'],
      { env: { ...process.env, MINIO_ROOT_USER: this.accessKeyId, MINIO_ROOT_PASSWORD: this.secretAccessKey } },
    );
    const port = docker(['port', this.minio, '9000/tcp']).stdout.trim().split('\n')[0].split(':').pop();
    this.hostEndpoint = `http://127.0.0.1:${port}`;
    this.sandboxEndpoint = `http://${this.minio}:9000`;
    await waitFor(async () => (await fetch(`${this.hostEndpoint}/minio/health/live`)).ok, 60000, 'minio');
    this.s3 = new S3Client({ endpoint: this.hostEndpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey } });
    await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
  }

  storage(prefix = 'it', overrides = {}) {
    return {
      endpoint: this.hostEndpoint,
      sandboxEndpoint: this.sandboxEndpoint,
      region: 'us-east-1',
      bucket: this.bucket,
      prefix,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      forcePathStyle: true,
      provider: 'Minio',
      ...overrides,
    };
  }

  sandbox({ image = SANDBOX_IMAGE, fuse = true } = {}) {
    const name = `fsvol-sb-${this.id}-${++this.counter}`;
    const args = ['run', '-d', '--name', name, '--network', this.network];
    if (fuse) args.push('--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor:unconfined');
    args.push('--entrypoint', 'sh', image, '-c', 'sleep 7200');
    docker(args);
    this.sandboxes.push(name);
    return name;
  }

  exec(name, command, options = {}) {
    const r = docker(['exec', name, 'sh', '-c', command], { allowFailure: true, ...options });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }

  /** Run a command detached inside the sandbox (background process). */
  execDetached(name, command) {
    docker(['exec', '-d', name, 'sh', '-c', command]);
  }

  async listKeys(prefix) {
    const keys = [];
    let token;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async readObject(key) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body.transformToString();
  }

  pauseStorage() {
    docker(['pause', this.minio]);
  }

  unpauseStorage() {
    docker(['unpause', this.minio]);
  }

  async stop() {
    for (const name of this.sandboxes) docker(['rm', '-f', name], { allowFailure: true });
    docker(['rm', '-f', this.minio], { allowFailure: true });
    docker(['network', 'rm', this.network], { allowFailure: true });
    this.s3?.destroy();
  }
}
