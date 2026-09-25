// Exclusive-writer leases and the deleting marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, MemoryObjectStore, ValidationError, toStorageError } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';

const DETACH_FLUSHED = (mid) => ({ stdout: `FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=${mid} ro=0\n` });
const DETACH_FORCED = (mid) => ({ stdout: `FSVOL_RESULT status=detached flushed=0 pending=-1 volume=data mid=${mid} ro=0\n` });

function setup(first = [], second = [], options = {}) {
  const store = new MemoryObjectStore();
  const vm1 = new FakeSandbox('vm-1', first);
  const vm2 = new FakeSandbox('vm-2', second);
  const volumes = new FreestyleVolumes({ storage, sandboxes: fakeResolver([vm1, vm2]), objectStore: store, ...options });
  return { store, vm1, vm2, volumes };
}
const leaseKey = `${storage.prefix}/_leases/data.json`;

test('an exclusive attach takes the lease; other writers are refused and readers are not', async () => {
  const { store, vm1, vm2, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK, BOOTSTRAP_OK, MOUNT_OK], [BOOTSTRAP_OK, MOUNT_OK]);
  const volume = await volumes.create({ name: 'data' });
  const writer = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  assert.equal(writer.exclusive, true);
  const lease = await volumes.getLease('data');
  assert.deepEqual({ ...lease, acquiredAt: undefined }, { volumeId: 'data', generation: volume.generation, sandboxId: 'vm-1', mountId: writer.mountId, mountPath: '/mnt/data', acquiredAt: undefined });
  assert.ok(vm1.calls[1].command.includes('"exclusive":true'), 'the mount state remembers the lease for restore');

  for (const attempt of [{ sandboxId: 'vm-2', exclusive: true }, { sandboxId: 'vm-2' }, { sandboxId: 'vm-1', mountPath: '/mnt/other' }]) {
    await assert.rejects(volumes.attach({ volumeId: 'data', mountPath: '/mnt/data', ...attempt }), (error) => error.code === 'VOLUME_IN_USE' && /exclusive/.test(error.message), JSON.stringify(attempt));
  }
  assert.equal(vm2.calls.length, 0, 'refused before touching the sandbox');
  const reader = await volumes.attach({ sandboxId: 'vm-2', volumeId: 'data', mountPath: '/mnt/ro', readOnly: true });
  assert.equal(reader.exclusive, false);
  const again = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  assert.equal(again.mountId, writer.mountId, 'the holder can attach again idempotently');
  assert.ok(store.objects.has(leaseKey));
  await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/x', exclusive: true, readOnly: true }), ValidationError);
});

test('a flushed detach releases the lease; an unflushed one keeps it and blocks delete and clone', async () => {
  const { store, vm1, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  const writer = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  vm1.responses.push(DETACH_FORCED(writer.mountId));
  const forced = await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data', force: true });
  assert.equal(forced.flushed, false);
  assert.ok(store.objects.has(leaseKey), 'unflushed data in the VM keeps the lease');
  await assert.rejects(volumes.delete({ volumeId: 'data', confirm: 'data' }), (error) => error.code === 'VOLUME_IN_USE' && /exclusive/.test(error.message));
  await assert.rejects(volumes.clone({ sourceVolumeId: 'data', name: 'copy' }), { code: 'VOLUME_IN_USE' });

  vm1.responses.push(BOOTSTRAP_OK, MOUNT_OK, DETACH_FLUSHED(writer.mountId));
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  const flushed = await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(flushed.flushed, true);
  assert.equal(store.objects.has(leaseKey), false);
  assert.equal(await volumes.getLease('data'), null);
});

test('releasing a lease by hand needs confirmation; a detach never releases someone else\'s lease', async () => {
  const { store, vm2, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK], []);
  await volumes.create({ name: 'data' });
  const writer = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  vm2.responses.push({ stdout: `FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=${writer.mountId}0 ro=1\n` });
  await volumes.detach({ sandboxId: 'vm-2', mountPath: '/mnt/ro' });
  assert.ok(store.objects.has(leaseKey), 'another mount\'s detach leaves the lease alone');
  await assert.rejects(volumes.releaseLease({ volumeId: 'data', confirm: 'nope' }), { code: 'CONFIRMATION_REQUIRED' });
  assert.deepEqual(await volumes.releaseLease({ volumeId: 'data', confirm: 'data' }), { volumeId: 'data', released: true });
  assert.deepEqual(await volumes.releaseLease({ volumeId: 'data', confirm: 'data' }), { volumeId: 'data', released: false });
});

test('a lease from an earlier volume of the same name is replaced, and an unreadable one fails closed', async () => {
  const { store, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  store.objects.set(leaseKey, JSON.stringify({ version: 1, volumeId: 'data', generation: '00000000-0000-4000-8000-000000000000', sandboxId: 'old-vm', mountId: 'abc', mountPath: '/mnt/old', acquiredAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(await volumes.getLease('data'), null, 'stale generations do not count');
  const writer = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true });
  assert.equal((await volumes.getLease('data')).mountId, writer.mountId);
  store.objects.set(leaseKey, '{ torn write');
  await assert.rejects(volumes.attach({ sandboxId: 'vm-2', volumeId: 'data', mountPath: '/mnt/data' }), (error) => error.code === 'VOLUME_IN_USE' && /unreadable/.test(error.message));
});

test('a lease taken by a failed attach is released unless the mount may have started', async () => {
  const early = setup([{ stdout: 'FSVOL_ERR no-dev-fuse\n', exitCode: 12 }]);
  await early.volumes.create({ name: 'data' });
  await assert.rejects(early.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true }), { code: 'FUSE_UNAVAILABLE' });
  assert.equal(early.store.objects.has(leaseKey), false, 'bootstrap failed before any mount: lease released');

  const refused = setup([BOOTSTRAP_OK, { stdout: 'FSVOL_ERR path-in-use stale-mount-requires-detach\n', exitCode: 20 }]);
  await refused.volumes.create({ name: 'data' });
  await assert.rejects(refused.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true }), { code: 'MOUNT_PATH_IN_USE' });
  assert.equal(refused.store.objects.has(leaseKey), false, 'the guest refused before starting anything');

  const timedOut = setup([BOOTSTRAP_OK, { stdout: 'FSVOL_ERR ready-timeout\n', exitCode: 23 }]);
  await timedOut.volumes.create({ name: 'data' });
  const error = await timedOut.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', exclusive: true }).catch((e) => e);
  assert.equal(error.code, 'MOUNT_TIMEOUT');
  assert.equal(error.details.leaseRetained, true);
  assert.ok(timedOut.store.objects.has(leaseKey), 'a mount that may still come up keeps the lease');
});

test('the deleting marker refuses new attaches until an interrupted delete is finished', async () => {
  const { store, vm1, volumes } = setup([]);
  const volume = await volumes.create({ name: 'data' });
  store.objects.set(`${volume.dataPrefix}/a`, 'a');
  store.objects.set(`${volume.dataPrefix}/b`, 'b');
  const deleteObjects = store.deleteObjects.bind(store);
  store.deleteObjects = async () => { throw toStorageError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), 'deleteObjects', 'memory'); };
  await assert.rejects(volumes.delete({ volumeId: 'data', confirm: 'data' }), { code: 'STORAGE_UNREACHABLE' });
  assert.ok(store.objects.has(`${storage.prefix}/_deleting/data.json`));
  await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' }), (error) => error.code === 'VOLUME_DELETING' && /run delete again/.test(error.hint));
  await assert.rejects(volumes.clone({ sourceVolumeId: 'data', name: 'copy' }), { code: 'VOLUME_DELETING' });
  assert.equal(vm1.calls.length, 0);

  store.deleteObjects = deleteObjects;
  const finished = await volumes.delete({ volumeId: 'data', confirm: 'data' });
  assert.equal(finished.deletedObjects, 2);
  assert.deepEqual([...store.objects.keys()].filter((key) => key.includes('/_deleting/') || key.includes('/_volumes/')), []);

  // A marker left over from an earlier volume of the same name does not block the new one.
  store.objects.set(`${storage.prefix}/_deleting/data.json`, JSON.stringify({ version: 1, volumeId: 'data', generation: volume.generation }));
  await volumes.create({ name: 'data' });
  vm1.responses.push(BOOTSTRAP_OK, MOUNT_OK);
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
});
