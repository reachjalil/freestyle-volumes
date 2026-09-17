import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, MemoryObjectStore, VolumeError, StorageError, ValidationError, VolumeNotFoundError } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage, BOOTSTRAP_OK, MOUNT_OK, MOUNT_ALREADY } from '../helpers/fake-sandbox.mjs';

function setup(responses = [], options = {}) {
  const store = new MemoryObjectStore();
  const sandbox = new FakeSandbox('vm-1', responses);
  const events = [];
  const volumes = new FreestyleVolumes({ storage, sandboxes: fakeResolver([sandbox]), objectStore: store, onEvent: (e) => events.push(e), ...options });
  return { store, sandbox, volumes, events };
}

test('constructor validates its inputs', () => {
  assert.throws(() => new FreestyleVolumes({ storage }), VolumeError);
  assert.throws(() => new FreestyleVolumes({ storage: { ...storage, bucket: 'BAD' }, sandboxes: fakeResolver([]) }), ValidationError);
  assert.throws(() => setup([], { defaults: { cacheMode: 'nope' } }), VolumeError);
  assert.throws(() => setup([], { defaults: { writeBackSeconds: -1 } }), ValidationError);
});

test('attach checks storage before touching the sandbox, passes credentials only via env, and records the attachment', async () => {
  const { store, sandbox, volumes, events } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  const attachment = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', uid: 1000, gid: 1000 });
  assert.equal(attachment.pid, 4242);
  assert.equal(attachment.alreadyAttached, false);
  assert.deepEqual(attachment.warnings, []);
  assert.equal(sandbox.calls.length, 2, 'bootstrap then mount');
  const [bootstrap, mount] = sandbox.calls;
  assert.equal(bootstrap.env, undefined, 'bootstrap needs no credentials');
  assert.equal(mount.env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, storage.secretAccessKey);
  assert.equal(mount.env.RCLONE_CONFIG_FSVOL_ENDPOINT, storage.sandboxEndpoint);
  assert.doesNotMatch(mount.command, new RegExp(storage.secretAccessKey));
  assert.doesNotMatch(mount.command, new RegExp(storage.accessKeyId));
  assert.match(mount.command, /fsvol:test-bucket\/tenant-a\/v\/data/);
  assert.match(mount.command, /--uid 1000 --gid 1000/);
  assert.ok(mount.timeoutMs <= 300000);
  const records = await volumes.registry.listAttachments('data');
  assert.equal(records.length, 1);
  assert.equal(records[0].sandboxId, 'vm-1');
  assert.equal(records[0].mountPath, '/mnt/data');
  assert.deepEqual(events.map((e) => e.type), ['volume.created', 'attach.bootstrap', 'attach.mount', 'attach.done']);
  assert.equal(JSON.stringify(events).includes(storage.secretAccessKey), false);
  assert.ok([...store.objects.keys()].some((k) => k.startsWith('tenant-a/_attachments/data/vm-1__')));
});

test('attach with subpath mounts a sub-prefix and validates traversal', async () => {
  const { sandbox, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', subpath: '../other' }), ValidationError);
  await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/etc/x' }), ValidationError);
  assert.equal(sandbox.calls.length, 0, 'validation happens before any sandbox call');
  const attachment = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/alice', subpath: 'users/alice', readOnly: true });
  assert.equal(attachment.subpath, 'users/alice');
  assert.match(sandbox.calls[1].command, /fsvol:test-bucket\/tenant-a\/v\/data\/users\/alice/);
  assert.match(sandbox.calls[1].command, /--read-only/);
});

test('attach is idempotent and reports alreadyAttached', async () => {
  const { volumes } = setup([BOOTSTRAP_OK, MOUNT_OK, BOOTSTRAP_OK, MOUNT_ALREADY]);
  await volumes.create({ name: 'data' });
  const first = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  const second = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  assert.equal(first.mountId, second.mountId);
  assert.equal(second.alreadyAttached, true);
  assert.equal((await volumes.registry.listAttachments('data')).length, 1, 'one record per mount id');
});

test('unknown volumes and unreachable or unauthorized storage fail before any sandbox exec', async () => {
  const { store, sandbox, volumes } = setup([]);
  await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'ghost', mountPath: '/mnt/x' }), VolumeNotFoundError);
  await volumes.create({ name: 'data' });
  store.failWith = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  const error = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/x' }).catch((e) => e);
  assert.ok(error instanceof StorageError, String(error));
  assert.equal(error.code, 'STORAGE_AUTH');
  assert.equal(sandbox.calls.length, 0);
  store.failWith = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal((await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/x' }).catch((e) => e)).code, 'STORAGE_UNREACHABLE');
  assert.equal(sandbox.calls.length, 0);
});

test('a failing advisory record does not fail a live attach but is reported', async () => {
  const { store, volumes } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  const original = store.putObject.bind(store);
  store.putObject = async (key, body) => {
    if (key.includes('_attachments')) throw new StorageError('STORAGE_ERROR', 'flaky');
    return original(key, body);
  };
  const attachment = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  assert.equal(attachment.warnings.length, 1);
  assert.match(attachment.warnings[0], /advisory attachment record/);
});

test('inspectMount classifies mounted, stale, absent and unmanaged', async () => {
  const state = JSON.stringify({ version: 1, mountId: 'm1', volumeId: 'data', subpath: null, mountPath: '/mnt/data', readOnly: false, startedAt: '2026-09-17T00:00:00.000Z' });
  const stats = JSON.stringify({ diskCache: { uploadsQueued: 2, uploadsInProgress: 1, erroredFiles: 0, bytesUsed: 512, files: 3 } });
  const { volumes } = setup([
    { stdout: `FSVOL_RESULT mounted=1 state=1 alive=1 responsive=1 pid=17 ro=0 src=fsvol{x}:b/p mid=m1\nFSVOL_STATE_BEGIN\n${state}\nFSVOL_STATE_END\nFSVOL_STATS_BEGIN\n${stats}\nFSVOL_STATS_END\nFSVOL_LOG_BEGIN\nINFO: ok\nFSVOL_LOG_END\n` },
    { stdout: `FSVOL_RESULT mounted=1 state=1 alive=0 responsive=0 pid=17 ro=0 src=fsvol{x}:b/p mid=m1\nFSVOL_STATE_BEGIN\n${state}\nFSVOL_STATE_END\n` },
    { stdout: 'FSVOL_RESULT mounted=0 state=0 alive=0 responsive=0 pid= ro= src= mid=\n' },
    { stdout: 'FSVOL_RESULT mounted=1 state=0 alive=0 responsive=1 pid= ro=1 src=other{y}:b/q mid=\n' },
  ]);
  const mounted = await volumes.inspectMount({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(mounted.status, 'mounted');
  assert.equal(mounted.volumeId, 'data');
  assert.equal(mounted.pid, 17);
  assert.deepEqual(mounted.uploads, { queued: 2, inProgress: 1, errored: 0 });
  assert.equal(mounted.cacheBytes, 512);
  assert.equal(mounted.startedAt, '2026-09-17T00:00:00.000Z');
  assert.deepEqual(mounted.logTail, ['INFO: ok']);
  const stale = await volumes.inspectMount({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.pid, null);
  assert.equal((await volumes.inspectMount({ sandboxId: 'vm-1', mountPath: '/mnt/data' })).status, 'absent');
  const unmanaged = await volumes.inspectMount({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(unmanaged.status, 'unmanaged');
  assert.equal(unmanaged.readOnly, true);
});

test('detach removes the advisory record only after a real detach and is idempotent', async () => {
  const { volumes } = setup([BOOTSTRAP_OK, MOUNT_OK, { stdout: 'FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=MID ro=0\n' }, { stdout: 'FSVOL_RESULT status=absent\n' }]);
  await volumes.create({ name: 'data' });
  const attachment = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  volumes.registry.removeAttachment = async (volumeId, sandboxId, mountId) => {
    assert.equal(mountId, 'MID');
    await volumes.registry.constructor.prototype.removeAttachment.call(volumes.registry, volumeId, sandboxId, attachment.mountId);
  };
  const detached = await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(detached.status, 'detached');
  assert.equal(detached.flushed, true);
  assert.equal(detached.volumeId, 'data');
  assert.deepEqual(await volumes.registry.listAttachments('data'), []);
  const absent = await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  assert.equal(absent.status, 'absent');
  assert.equal(absent.flushed, false);
});

test('delete requires confirmation and refuses recorded attachments unless forced', async () => {
  const { volumes } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  await assert.rejects(volumes.delete({ volumeId: 'data', confirm: 'nope' }), (e) => e.code === 'CONFIRMATION_REQUIRED');
  await assert.rejects(volumes.delete({ volumeId: 'data', confirm: 'data' }), (e) => e.code === 'VOLUME_IN_USE');
  const result = await volumes.delete({ volumeId: 'data', confirm: 'data', force: true });
  assert.equal(result.volumeId, 'data');
  assert.equal(result.attachments.length, 1);
  assert.deepEqual(await volumes.list(), []);
});

test('get with create is idempotent and list reflects the namespace', async () => {
  const { volumes } = setup([]);
  const a = await volumes.get('cache', { create: true });
  const b = await volumes.get('cache', { create: true });
  assert.equal(a.createdAt, b.createdAt);
  await assert.rejects(volumes.get('other'), VolumeNotFoundError);
  assert.deepEqual((await volumes.list()).map((v) => v.id), ['cache']);
});
