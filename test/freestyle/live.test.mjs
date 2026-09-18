// Live Freestyle test. Creates two real VMs (billed to your account), mounts a
// volume in each, verifies persistence across them, and deletes everything it
// created. Skipped unless credentials are present. This is the only test that
// proves the Freestyle integration; Docker tests prove the mount mechanics.
//
// Required: FREESTYLE_API_KEY, VOLUMES_S3_BUCKET, VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY
// Optional: VOLUMES_S3_ENDPOINT, VOLUMES_S3_REGION, VOLUMES_S3_PREFIX, VOLUMES_S3_FORCE_PATH_STYLE, VOLUMES_S3_PROVIDER, VOLUMES_TEST_SNAPSHOT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, freestyleSandboxes } from '../../dist/index.js';

const env = process.env;
const required = ['FREESTYLE_API_KEY', 'VOLUMES_S3_BUCKET', 'VOLUMES_S3_ACCESS_KEY_ID', 'VOLUMES_S3_SECRET_ACCESS_KEY'];
const missing = required.filter((key) => !env[key]);

test('Freestyle live: create, attach, write, detach, reattach on a second VM, read-only, delete', { skip: missing.length > 0 && `set ${missing.join(', ')}`, timeout: 15 * 60 * 1000 }, async () => {
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
  const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle), onEvent: (event) => console.log(`[event] ${JSON.stringify(event)}`) });

  const created = [];
  const createVm = async (displayName) => {
    const { vm, vmId } = await freestyle.vms.create({
      snapshotId: env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm',
      displayName,
      metadata: { 'freestyle-volumes': 'live-test' },
      // The VM needs outbound access to the storage endpoint and to downloads.rclone.org.
      firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
    });
    created.push(vm);
    console.log(`created VM ${vmId} (${displayName})`);
    return vmId;
  };

  const volumeName = `live-${Date.now().toString(36)}`;
  try {
    await volumes.create({ name: volumeName, labels: { test: 'live' } });
    const vm1 = await createVm('freestyle-volumes-live-1');
    const attached = await volumes.attach({ sandboxId: vm1, volumeId: volumeName, mountPath: '/mnt/vol', uid: 1000, gid: 1000 });
    assert.equal(attached.alreadyAttached, false);
    // Write as the VM's default user (uid 1000) to prove non-root access works.
    const write = await freestyle.vms.ref(vm1).exec('echo "hello from vm1" > /mnt/vol/hello.txt && mkdir -p /mnt/vol/dir && echo nested > /mnt/vol/dir/n.txt && cat /mnt/vol/hello.txt');
    assert.equal(write.statusCode, 0, `${write.stdout}\n${write.stderr}`);
    const inspection = await volumes.inspectMount({ sandboxId: vm1, mountPath: '/mnt/vol' });
    assert.equal(inspection.status, 'mounted');
    const detached = await volumes.detach({ sandboxId: vm1, mountPath: '/mnt/vol' });
    assert.equal(detached.flushed, true);

    const vm2 = await createVm('freestyle-volumes-live-2');
    await volumes.attach({ sandboxId: vm2, volumeId: volumeName, mountPath: '/mnt/vol' });
    const read = await freestyle.vms.ref(vm2).exec('cat /mnt/vol/hello.txt /mnt/vol/dir/n.txt');
    assert.equal(read.stdout, 'hello from vm1\nnested\n');
    await volumes.attach({ sandboxId: vm2, volumeId: volumeName, mountPath: '/mnt/ro', readOnly: true });
    const roWrite = await freestyle.vms.ref(vm2).exec('echo x > /mnt/ro/nope.txt');
    assert.notEqual(roWrite.statusCode, 0, 'read-only mount rejects writes');
    assert.equal((await volumes.detach({ sandboxId: vm2, mountPath: '/mnt/ro' })).flushed, true);
    assert.equal((await volumes.detach({ sandboxId: vm2, mountPath: '/mnt/vol' })).flushed, true);
    const deleted = await volumes.delete({ volumeId: volumeName, confirm: volumeName });
    assert.ok(deleted.deletedObjects >= 2);
  } finally {
    for (const vm of created) {
      await vm.delete().catch((error) => console.error(`could not delete VM ${vm.id}: ${error}`));
    }
    await volumes.delete({ volumeId: volumeName, confirm: volumeName, force: true }).catch(() => {});
  }
});
