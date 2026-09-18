// Option acceptance and read/write integrity, not a throughput benchmark.
// Exercise the guest backend directly, independently of public option wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { RcloneBackend, DockerSandbox, DEFAULT_GUEST_PATHS } from '../../dist/index.js';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

test('real MinIO guest: opt-in tuning accepted on minimum and pinned rclone', { skip: !dockerAvailable(), timeout: 300000 }, async t => {
  const stack = new Stack();
  t.after(() => stack.stop());
  await stack.start();
  const payload = randomBytes(12 * 1024 * 1024);
  const digest = createHash('sha256').update(payload).digest('hex');
  await stack.s3.send(new PutObjectCommand({ Bucket: stack.bucket, Key: 'perf/input', Body: payload }));
  const env = {
    RCLONE_CONFIG_FSVOL_TYPE: 's3', RCLONE_CONFIG_FSVOL_PROVIDER: 'Minio',
    RCLONE_CONFIG_FSVOL_ENDPOINT: stack.sandboxEndpoint,
    RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID: stack.accessKeyId,
    RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY: stack.secretAccessKey,
    RCLONE_CONFIG_FSVOL_REGION: 'us-east-1', RCLONE_CONFIG_FSVOL_FORCE_PATH_STYLE: 'true',
  };
  for (const version of ['1.68.0', '1.75.1']) {
    await t.test(`rclone ${version}`, async () => {
      const sb = new DockerSandbox(stack.sandbox({ image: `rclone/rclone:${version}` }));
      const backend = new RcloneBackend();
      const runtime = await backend.ensureRuntime(sb, { timeoutMs: 120000 });
      assert.equal(runtime.rcloneVersion, version, 'minimum-version test must not silently upgrade');
      const shell = async command => {
        const r = await sb.exec({ command, timeoutMs: 20000 });
        assert.equal(r.exitCode, 0, r.stdout + r.stderr);
        return r.stdout;
      };
      const spec = {
        mountId: 'perf1234', remotePath: `fsvol:${stack.bucket}/perf`, mountPath: '/mnt/perf',
        readOnly: false, cacheMode: 'full', writeBackSeconds: 3600, dirCacheSeconds: 60,
        allowOther: false, readyTimeoutMs: 20000,
        bufferSize: '1048576B', readAhead: '2M', readChunkSize: '1MiB', readChunkSizeLimit: '4M', transfers: 2,
        stateJson: JSON.stringify({ mountId: 'perf1234', mountPath: '/mnt/perf', volumeId: 'perf', readOnly: false }),
      };
      const rc = async endpoint => JSON.parse(await shell(`'${runtime.rclonePath}' rc --unix-socket '${DEFAULT_GUEST_PATHS.runRoot}/${spec.mountId}.sock' ${endpoint}`));
      const attached = await backend.mount(sb, spec, env, { timeoutMs: 30000 });
      assert.equal(attached.alreadyAttached, false);
      const assertOptions = async () => {
        const { opt } = await rc('vfs/stats');
        assert.equal(opt.ReadAhead, 2 * 1024 * 1024);
        assert.equal(opt.ChunkSize, 1024 * 1024);
        assert.equal(opt.ChunkSizeLimit, 4 * 1024 * 1024);
        const { main } = await rc('options/get');
        assert.equal(main.BufferSize, 1024 * 1024);
        assert.equal(main.Transfers, 2);
      };
      await assertOptions();
      assert.equal((await shell('sha256sum /mnt/perf/input')).split(' ')[0], digest);
      await shell('printf tuned-write > /mnt/perf/output');
      const before = await shell(`cat '${DEFAULT_GUEST_PATHS.stateRoot}/mounts/${spec.mountId}/mount.json'`);
      const reused = await backend.mount(sb, {
        ...spec, bufferSize: '8M', readAhead: '8M', readChunkSize: '8M', readChunkSizeLimit: 'off', transfers: 8,
        stateJson: JSON.stringify({ changed: true }),
      }, env, { timeoutMs: 30000 });
      assert.deepEqual(reused, { pid: attached.pid, alreadyAttached: true });
      await assertOptions();
      assert.equal(await shell(`cat '${DEFAULT_GUEST_PATHS.stateRoot}/mounts/${spec.mountId}/mount.json'`), before);
      const detached = await backend.unmount(sb, { mountPath: spec.mountPath, flushTimeoutMs: 20000, force: false, timeoutMs: 35000 });
      assert.equal(detached.flushed, true);
      assert.equal(await stack.readObject('perf/output'), 'tuned-write');
    });
  }
});
