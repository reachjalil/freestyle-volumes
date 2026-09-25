// Live Freestyle test: mounts come back after a VM stop/start. Writes a file
// that is still queued, powers the VM off from inside, starts it again, then
// requires restoreMounts to remount with the saved options, the cached write to
// be readable again and the pending upload to reach the bucket. Billed; deletes
// the VM and the volume.
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
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** The guest agent needs a moment after a boot before exec works. */
async function whenExecWorks(vm, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await vm.exec({ command: 'true', linuxUser: 'root', timeoutMs: 10_000 })).statusCode === 0) return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error(`exec did not work on VM ${vm.id} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

test('Freestyle live: restoreMounts after a stop/start remounts and resumes a pending upload', { skip: missing.length > 0 && `set ${missing.join(', ')}`, timeout: 20 * 60 * 1000 }, async () => {
  const { Freestyle } = await import('freestyle');
  const freestyle = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });
  const storage = { prefix: 'freestyle-volumes-live-test', ...storageConfigFromEnv(env) };
  const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle), onEvent: (event) => console.log(`[event] ${JSON.stringify(event)}`) });
  const volumeName = `live-restart-${Date.now().toString(36)}`;
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm',
    displayName: 'freestyle-volumes-live-restart',
    metadata: { 'freestyle-volumes': 'live-test' },
    ttlSeconds: 1800,
    automaticRestart: false,
    firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  });
  console.log(`created VM ${vmId}`);
  try {
    await volumes.create({ name: volumeName });
    // A long write-back keeps the write queued in the VM's cache through the stop.
    await volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/vol', writeBackSeconds: 600, uid: 1000, gid: 1000 });
    assert.equal((await vm.exec({ command: 'echo before-stop > /mnt/vol/before.txt && sync', linuxUser: 'root' })).statusCode, 0);
    assert.equal((await volumes.inspectMount({ sandboxId: vmId, mountPath: '/mnt/vol' })).uploads?.queued, 1, 'the write is still pending when the VM stops');

    let started = Date.now();
    // Power off from inside; the exec may not come back cleanly while the VM goes down.
    await vm.exec({ command: '(sleep 1; systemctl poweroff || poweroff) >/dev/null 2>&1 &', linuxUser: 'root', timeoutMs: 30_000 }).catch(() => undefined);
    await waitForState(vm, 'stopped', 180_000);
    console.log(`stopped in ${Date.now() - started} ms`);
    started = Date.now();
    await vm.start();
    await waitForState(vm, 'running', 180_000);
    await whenExecWorks(vm, 120_000);
    console.log(`started in ${Date.now() - started} ms`);

    const listing = await volumes.listMounts({ sandboxId: vmId });
    assert.deepEqual(listing.mounts.map((m) => [m.mountPath, m.status]), [['/mnt/vol', 'stale']], 'a boot loses the mount but keeps its state and cache');
    started = Date.now();
    const restored = await volumes.restoreMounts({ sandboxId: vmId });
    console.log(`restored in ${Date.now() - started} ms: ${JSON.stringify(restored)}`);
    assert.deepEqual(restored.failed, []);
    assert.deepEqual(restored.restored.map((r) => r.mountPath), ['/mnt/vol']);

    const read = await vm.exec({ command: 'cat /mnt/vol/before.txt && stat -c %u /mnt/vol/before.txt', linuxUser: 'root' });
    assert.equal(read.stdout, 'before-stop\n1000\n', 'the cached write is readable again, with the saved owner');
    const detached = await volumes.detach({ sandboxId: vmId, mountPath: '/mnt/vol' });
    assert.equal(detached.flushed, true, 'the upload queued before the stop drains after the restore');
    await volumes.attach({ sandboxId: vmId, volumeId: volumeName, mountPath: '/mnt/check', readOnly: true });
    assert.equal((await vm.exec({ command: 'cat /mnt/check/before.txt', linuxUser: 'root' })).stdout, 'before-stop\n', 'the write reached the bucket');
    assert.equal((await volumes.detachAll({ sandboxId: vmId })).flushed, true);
    assert.ok((await volumes.delete({ volumeId: volumeName, confirm: volumeName })).deletedObjects >= 1);
  } finally {
    await vm.delete().catch((error) => console.error(`could not delete VM ${vmId}: ${error}`));
    await volumes.delete({ volumeId: volumeName, confirm: volumeName, force: true }).catch(() => {});
  }
});
