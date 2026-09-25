// Live Freestyle test for createVolumeReadySnapshot. Builds a snapshot (one
// builder VM), boots a second VM from it, attaches a volume without installing
// anything and round-trips a file. Deletes the VMs, the snapshot and the volume.
// Billed to your Freestyle account; skipped unless the variables below are set.
//
// Required: VOLUMES_TEST_PREPARE_SNAPSHOT=1, FREESTYLE_API_KEY, VOLUMES_S3_BUCKET, VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY
// Optional: VOLUMES_S3_ENDPOINT, VOLUMES_S3_REGION, VOLUMES_S3_PREFIX, VOLUMES_S3_FORCE_PATH_STYLE, VOLUMES_S3_PROVIDER, VOLUMES_TEST_SNAPSHOT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, createVolumeReadySnapshot, freestyleSandboxes } from '../../dist/index.js';

const env = process.env;
const required = ['FREESTYLE_API_KEY', 'VOLUMES_S3_BUCKET', 'VOLUMES_S3_ACCESS_KEY_ID', 'VOLUMES_S3_SECRET_ACCESS_KEY'];
const missing = required.filter((key) => !env[key]);
const skip = env.VOLUMES_TEST_PREPARE_SNAPSHOT !== '1' ? 'set VOLUMES_TEST_PREPARE_SNAPSHOT=1 to build a snapshot (billed)' : missing.length > 0 && `set ${missing.join(', ')}`;

test('Freestyle live: volume-ready snapshot, then attach without installs on a VM booted from it', { skip, timeout: 30 * 60 * 1000 }, async () => {
  const { Freestyle } = await import('freestyle');
  const freestyle = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });
  const storage = {
    bucket: env.VOLUMES_S3_BUCKET,
    accessKeyId: env.VOLUMES_S3_ACCESS_KEY_ID,
    secretAccessKey: env.VOLUMES_S3_SECRET_ACCESS_KEY,
    prefix: env.VOLUMES_S3_PREFIX || 'freestyle-volumes-live-test',
  };
  if (env.VOLUMES_S3_ENDPOINT) storage.endpoint = env.VOLUMES_S3_ENDPOINT;
  if (env.VOLUMES_S3_REGION) storage.region = env.VOLUMES_S3_REGION;
  if (env.VOLUMES_S3_PROVIDER) storage.provider = env.VOLUMES_S3_PROVIDER;
  if (env.VOLUMES_S3_FORCE_PATH_STYLE) storage.forcePathStyle = env.VOLUMES_S3_FORCE_PATH_STYLE === 'true';
  const log = (event) => console.log(`[event] ${JSON.stringify(event)}`);
  const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle), onEvent: log });
  const firewall = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };

  const volumeName = `live-snap-${Date.now().toString(36)}`;
  let snapshotId;
  let vm;
  try {
    const started = Date.now();
    const built = await createVolumeReadySnapshot(freestyle, {
      baseSnapshotId: env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm',
      displayName: 'freestyle-volumes-live-snapshot',
      onEvent: log,
    });
    snapshotId = built.snapshotId;
    console.log(`built snapshot ${snapshotId} in ${Date.now() - started} ms: ${JSON.stringify(built.runtime)}; warnings: ${JSON.stringify(built.warnings)}`);
    assert.match(built.runtime.rcloneVersion, /^1\.\d+/);

    const created = await freestyle.vms.create({ snapshotId, displayName: 'freestyle-volumes-live-snap', metadata: { 'freestyle-volumes': 'live-test' }, firewall });
    vm = created.vm;
    const preinstalled = await vm.exec({ command: `test -x ${built.runtime.rclonePath} && command -v fusermount3 && command -v flock`, linuxUser: 'root' });
    assert.equal(preinstalled.statusCode, 0, `runtime missing on a VM booted from the snapshot:\n${preinstalled.stdout}\n${preinstalled.stderr}`);

    await volumes.create({ name: volumeName, labels: { test: 'live-snapshot' } });
    const attachStarted = Date.now();
    const attached = await volumes.attach({ sandboxId: created.vmId, volumeId: volumeName, mountPath: '/mnt/vol', uid: 1000, gid: 1000 });
    console.log(`attach on a prepared VM took ${Date.now() - attachStarted} ms`);
    assert.equal(attached.alreadyAttached, false);
    const write = await vm.exec('echo "from a prepared snapshot" > /mnt/vol/hello.txt && cat /mnt/vol/hello.txt');
    assert.equal(write.statusCode, 0, `${write.stdout}\n${write.stderr}`);
    assert.equal((await volumes.detach({ sandboxId: created.vmId, mountPath: '/mnt/vol' })).flushed, true);
    assert.ok((await volumes.delete({ volumeId: volumeName, confirm: volumeName })).deletedObjects >= 1);
  } finally {
    await vm?.delete().catch((error) => console.error(`could not delete VM ${vm.id}: ${error}`));
    if (snapshotId) await freestyle.vms.snapshots.delete(snapshotId).catch((error) => console.error(`could not delete snapshot ${snapshotId}: ${error}`));
    await volumes.delete({ volumeId: volumeName, confirm: volumeName, force: true }).catch(() => {});
  }
});
