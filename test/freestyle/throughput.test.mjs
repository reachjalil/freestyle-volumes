// Live Freestyle benchmark, opt-in with VOLUMES_TEST_THROUGHPUT=1: large-file
// write and upload, many small files, and a cold read, on one VM against your
// bucket. Prints the measurements as JSON and asserts only correctness (sizes
// and checksums): throughput depends on the VM size, region and provider.
// Billed; writes about 300 MB to the bucket, then deletes the VM and the volume.
//
// Required: FREESTYLE_API_KEY, VOLUMES_S3_BUCKET, VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY, VOLUMES_TEST_THROUGHPUT=1
// Optional: VOLUMES_S3_ENDPOINT, VOLUMES_S3_REGION, VOLUMES_S3_PREFIX, VOLUMES_S3_PROVIDER, VOLUMES_TEST_SNAPSHOT,
//           VOLUMES_TEST_THROUGHPUT_MB (default 256), VOLUMES_TEST_THROUGHPUT_FILES (default 1000)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, freestyleSandboxes, storageConfigFromEnv } from '../../dist/index.js';

const env = process.env;
const required = ['FREESTYLE_API_KEY', 'VOLUMES_S3_BUCKET', 'VOLUMES_S3_ACCESS_KEY_ID', 'VOLUMES_S3_SECRET_ACCESS_KEY'];
const missing = required.filter((key) => !env[key]);
const skip = env.VOLUMES_TEST_THROUGHPUT !== '1' ? 'set VOLUMES_TEST_THROUGHPUT=1 (billed benchmark)' : missing.length > 0 && `set ${missing.join(', ')}`;
const megabytes = Number(env.VOLUMES_TEST_THROUGHPUT_MB ?? 256);
const files = Number(env.VOLUMES_TEST_THROUGHPUT_FILES ?? 1000);

test('Freestyle live: throughput of large and small writes, uploads and cold reads', { skip, timeout: 30 * 60 * 1000 }, async () => {
  assert.ok(Number.isInteger(megabytes) && megabytes > 0 && Number.isInteger(files) && files > 0);
  const { Freestyle } = await import('freestyle');
  const freestyle = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });
  const storage = { prefix: 'freestyle-volumes-live-test', ...storageConfigFromEnv(env) };
  const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle), defaults: { flushTimeoutMs: 250_000 } });
  const volumeName = `live-throughput-${Date.now().toString(36)}`;
  const snapshot = env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm';
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: snapshot,
    displayName: 'freestyle-volumes-live-throughput',
    metadata: { 'freestyle-volumes': 'live-test' },
    ttlSeconds: 3600,
    firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  });
  const run = async (command, timeoutMs = 280_000) => {
    const result = await vm.exec({ command, linuxUser: 'root', timeoutMs });
    assert.equal(result.statusCode, 0, `${command}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const timed = async (fn) => {
    const started = Date.now();
    const value = await fn();
    return { value, seconds: (Date.now() - started) / 1000 };
  };
  const results = { snapshot, megabytes, files };
  try {
    await volumes.create({ name: volumeName });
    await volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/bench', writeBackSeconds: 600 });

    const large = await timed(() => run(`dd if=/dev/urandom of=/mnt/bench/large.bin bs=1M count=${megabytes} status=none && sha256sum /mnt/bench/large.bin | cut -d' ' -f1`));
    results.largeWriteToCacheMBps = megabytes / large.seconds;
    const largeUpload = await timed(() => volumes.flush({ sandboxId: vmId, mountPath: '/mnt/bench' }));
    assert.equal(largeUpload.value.flushed, true);
    results.largeUploadMBps = megabytes / largeUpload.seconds;

    const small = await timed(() => run(`mkdir -p /mnt/bench/small && i=0; while [ $i -lt ${files} ]; do head -c 4096 /dev/urandom > /mnt/bench/small/f$i; i=$((i+1)); done`));
    results.smallFilesWrittenPerSecond = files / small.seconds;
    const smallUpload = await timed(() => volumes.flush({ sandboxId: vmId, mountPath: '/mnt/bench' }));
    assert.equal(smallUpload.value.flushed, true);
    results.smallFilesUploadedPerSecond = files / smallUpload.seconds;

    const drain = await timed(() => volumes.detach({ sandboxId: vmId, mountPath: '/mnt/bench' }));
    assert.equal(drain.value.flushed, true);
    results.detachSecondsWhenFlushed = drain.seconds;

    const attach = await timed(() => volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/cold', readOnly: true }));
    results.attachSeconds = attach.seconds;
    const cold = await timed(() => run('sha256sum /mnt/cold/large.bin | cut -d\' \' -f1'));
    assert.equal(cold.value, large.value, 'the large file reads back byte for byte');
    results.coldReadMBps = megabytes / cold.seconds;
    const listed = await timed(() => run('ls /mnt/cold/small | wc -l'));
    assert.equal(Number(listed.value), files);
    results.listSmallFilesSeconds = listed.seconds;
    console.log(`[throughput] ${JSON.stringify(results)}`);
    assert.equal((await volumes.detachAll({ sandboxId: vmId })).flushed, true);
  } finally {
    await vm.delete().catch((error) => console.error(`could not delete VM ${vmId}: ${error}`));
    await volumes.delete({ volumeId: volumeName, confirm: volumeName, force: true }).catch(() => {});
  }
});
