// Live Freestyle test: a mount survives pause and resume. Writes a file, pauses
// the VM inside the write-back window (before the upload starts), resumes it,
// then requires the mount to be healthy, the pending upload to drain and both
// files to read back from the bucket. Billed; deletes the VM and the volume.
//
// Required: FREESTYLE_API_KEY, VOLUMES_S3_BUCKET, VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY
// Optional: VOLUMES_S3_ENDPOINT, VOLUMES_S3_REGION, VOLUMES_S3_PREFIX, VOLUMES_S3_FORCE_PATH_STYLE, VOLUMES_S3_PROVIDER, VOLUMES_TEST_SNAPSHOT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, freestyleSandboxes, storageConfigFromEnv } from '../../dist/index.js';

const env = process.env;
const required = ['FREESTYLE_API_KEY', 'VOLUMES_S3_BUCKET', 'VOLUMES_S3_ACCESS_KEY_ID', 'VOLUMES_S3_SECRET_ACCESS_KEY'];
const missing = required.filter((key) => !env[key]);

async function waitForState(vm, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await vm.data();
    if (data.state === state) return;
    if (Date.now() > deadline) throw new Error(`VM ${vm.id} is ${data.state}, not ${state}, after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

test('Freestyle live: a mount and its pending upload survive pause and resume', { skip: missing.length > 0 && `set ${missing.join(', ')}`, timeout: 15 * 60 * 1000 }, async () => {
  const { Freestyle } = await import('freestyle');
  const freestyle = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });
  const storage = { prefix: 'freestyle-volumes-live-test', ...storageConfigFromEnv(env) };
  const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle), onEvent: (event) => console.log(`[event] ${JSON.stringify(event)}`) });
  const volumeName = `live-pause-${Date.now().toString(36)}`;
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm',
    displayName: 'freestyle-volumes-live-pause',
    metadata: { 'freestyle-volumes': 'live-test' },
    ttlSeconds: 1800,
    firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  });
  console.log(`created VM ${vmId}`);
  try {
    await volumes.create({ name: volumeName });
    // A long write-back keeps the first file queued in the VM's cache across the pause.
    await volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/vol', writeBackSeconds: 60 });
    assert.equal((await vm.exec({ command: 'echo before-pause > /mnt/vol/before.txt', linuxUser: 'root' })).statusCode, 0);
    const queued = await volumes.inspectMount({ sandboxId: vmId, mountPath: '/mnt/vol' });
    assert.equal(queued.uploads?.queued, 1, 'the write is still pending when the VM pauses');

    let started = Date.now();
    await vm.pause();
    await waitForState(vm, 'paused', 120_000);
    console.log(`paused in ${Date.now() - started} ms`);
    started = Date.now();
    await vm.start();
    await waitForState(vm, 'running', 120_000);
    console.log(`resumed in ${Date.now() - started} ms`);

    const resumed = await volumes.inspectMount({ sandboxId: vmId, mountPath: '/mnt/vol' });
    console.log(`after resume: ${JSON.stringify({ status: resumed.status, responsive: resumed.responsive, uploads: resumed.uploads })}`);
    assert.equal(resumed.status, 'mounted');
    assert.equal(resumed.responsive, true);
    const write = await vm.exec({ command: 'cat /mnt/vol/before.txt && echo after-resume > /mnt/vol/after.txt', linuxUser: 'root' });
    assert.equal(write.statusCode, 0, `${write.stdout}\n${write.stderr}`);
    assert.equal(write.stdout, 'before-pause\n');

    const detached = await volumes.detach({ sandboxId: vmId, mountPath: '/mnt/vol' });
    assert.equal(detached.flushed, true, 'the upload queued before the pause drains after the resume');
    await volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/check', readOnly: true });
    const read = await vm.exec({ command: 'cat /mnt/check/before.txt /mnt/check/after.txt', linuxUser: 'root' });
    assert.equal(read.stdout, 'before-pause\nafter-resume\n', 'both files reached the bucket');
    assert.equal((await volumes.detachAll({ sandboxId: vmId })).flushed, true);
    // Two files plus rclone's zero-byte directory markers.
    assert.ok((await volumes.delete({ volumeId: volumeName, confirm: volumeName })).deletedObjects >= 2);
  } finally {
    await vm.delete().catch((error) => console.error(`could not delete VM ${vmId}: ${error}`));
    await volumes.delete({ volumeId: volumeName, confirm: volumeName, force: true }).catch(() => {});
  }
});
