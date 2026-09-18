import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FreestyleVolumes, MemoryObjectStore, VolumeError, StorageError, ValidationError, VolumeNotFoundError, mountIdFor, mountScript, shellQuote } from '../../dist/index.js';
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

test('optional tuning stays absent by default and attach overrides inherited settings without forcing full cache', async () => {
  const specs = [];
  const backend = {
    ensureRuntime: async () => {},
    mount: async (_sandbox, spec) => { specs.push(spec); return { pid: 42, alreadyAttached: false }; },
  };
  const keys = ['bufferSize', 'readAhead', 'readChunkSize', 'readChunkSizeLimit', 'transfers'];
  const plain = setup([], { backend });
  await plain.volumes.create({ name: 'data' });
  await plain.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/plain' });
  for (const key of keys) {
    assert.equal(Object.hasOwn(plain.volumes.defaults, key), false);
    assert.equal(Object.hasOwn(specs[0], key), false);
  }

  const defaults = { bufferSize: '16M', readAhead: '1GiB', readChunkSize: '128M', readChunkSizeLimit: 'off', transfers: 4 };
  const tuned = setup([], { backend, defaults });
  await tuned.volumes.create({ name: 'data' });
  await tuned.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/inherited', bufferSize: undefined });
  for (const key of keys) assert.equal(specs[1][key], defaults[key]);
  assert.equal(specs[1].cacheMode, 'writes', 'readAhead must not force full cache');
  const overrides = { bufferSize: '0B', readAhead: '0K', readChunkSize: '2MiB', readChunkSizeLimit: '512M', transfers: 64 };
  await tuned.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/override', ...overrides });
  for (const key of keys) {
    assert.equal(specs[2][key], overrides[key]);
    assert.equal(tuned.volumes.defaults[key], defaults[key], 'attach does not mutate defaults');
  }
});

test('tuning sizes require explicit units and invalid tuning fails before any storage or guest calls', async () => {
  const { store, sandbox, volumes } = setup();
  store.getObject = async () => assert.fail('invalid tuning must fail before registry reads');
  const invalid = ['', '0', '16', 16, null, '-1M', '+1M', 'NaNM', 'InfinityB', '1e3K', '1MB/s', ' 1M', '1M\n', '1M;id', '8E', '999999999999999999999999B'];
  for (const key of ['bufferSize', 'readAhead', 'readChunkSize', 'readChunkSizeLimit']) {
    for (const value of [...invalid, ...(key === 'readChunkSizeLimit' ? ['OFF'] : ['off'])]) {
      assert.throws(() => setup([], { defaults: { [key]: value } }), ValidationError);
      await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/x', [key]: value }), ValidationError);
    }
    for (const value of ['0B', '0M', '1B', '512K', '1.5M', '2G', '1T', '1P', '1E', '16KiB', '1MB', '1g']) {
      assert.equal(setup([], { defaults: { [key]: value } }).volumes.defaults[key], value);
    }
  }
  for (const transfers of [0, -1, 65, 1.5, '4', null, NaN, Infinity]) {
    assert.throws(() => setup([], { defaults: { transfers } }), ValidationError);
    await assert.rejects(volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/x', transfers }), ValidationError);
  }
  assert.equal(setup([], { defaults: { transfers: 1 } }).volumes.defaults.transfers, 1);
  assert.equal(sandbox.calls.length, 0);
});

test('public tuning reaches rclone daemon flags and VFS mount JSON', async () => {
  const { volumes, sandbox } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', cacheMode: 'full', bufferSize: '8M', readAhead: '32M', readChunkSize: '64M', readChunkSizeLimit: 'off', transfers: 3 });
  const command = sandbox.calls[1].command;
  assert.ok(command.includes(`DAEMON_FLAGS=${shellQuote("'--buffer-size' '8M' '--transfers' '3'")}`));
  assert.match(command, /"ReadAhead":"32M"/);
  assert.match(command, /"ChunkSize":"64M"/);
  assert.match(command, /"ChunkSizeLimit":"off"/);
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
  assert.ok(mount.command.includes(`fsvol:test-bucket/${(await volumes.get('data')).dataPrefix}`));
  assert.match(mount.command, /"UID":1000,"GID":1000/);
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
  assert.ok(sandbox.calls[1].command.includes(`fsvol:test-bucket/${(await volumes.get('data')).dataPrefix}/users/alice`));
  assert.match(sandbox.calls[1].command, /"ReadOnly":true/);
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

test('attach uses full storage identity for state and cache, independently of credentials', async () => {
  const store = new MemoryObjectStore();
  const attach = async config => {
    const { volumes, sandbox } = setup([BOOTSTRAP_OK, MOUNT_OK], { storage: config, objectStore: store });
    const volume = await volumes.create({ name: 'data', ifNotExists: true });
    const result = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
    assert.equal(result.mountId, mountIdFor('data', undefined, '/mnt/data', volumes.storage, volume.generation));
    assert.match(sandbox.calls[1].command, new RegExp(`MID='${result.mountId}'`));
    return result.mountId;
  };
  const original = await attach(storage);
  assert.notEqual(original, await attach({ ...storage, endpoint: 'https://other.example' }));
  assert.notEqual(original, await attach({ ...storage, sandboxEndpoint: 'https://other-guest.example' }));
  assert.equal(original, await attach({ ...storage, accessKeyId: 'new-key', secretAccessKey: 'new-secret', sessionToken: 'new-token' }));
});

test('unflushed detach retains the attachment and guards deletion, including after an absent retry', async () => {
  const { volumes, sandbox } = setup([BOOTSTRAP_OK, MOUNT_OK]);
  await volumes.create({ name: 'data' });
  const attachment = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  sandbox.responses.push({ stdout: `FSVOL_RESULT status=detached flushed=0 pending=-1 volume=data mid=${attachment.mountId} ro=0\n` }, { stdout: 'FSVOL_RESULT status=absent\n' });
  const detached = await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data', force: true });
  assert.equal(detached.flushed, false);
  assert.equal(detached.pendingUploads, null);
  assert.equal((await volumes.registry.listAttachments('data')).length, 1);
  await volumes.detach({ sandboxId: 'vm-1', mountPath: '/mnt/data' });
  await assert.rejects(volumes.delete({ volumeId: 'data', confirm: 'data' }), e => e.code === 'VOLUME_IN_USE');
});

// Execute the generated shell's identity checks while mocking Linux mount and
// process introspection. Both endpoints deliberately expose the same S3 path.
test('guest rejects healthy and stale mounts from another storage identity without rebinding cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fv-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { stateRoot: join(root, 's'), cacheRoot: join(root, 'c'), runRoot: join(root, 'r'), binDir: join(root, 'b') };
  const { volumes } = setup();
  const oldId = mountIdFor('data', undefined, '/mnt/data', volumes.storage);
  const newId = mountIdFor('data', undefined, '/mnt/data', { ...volumes.storage, sandboxEndpoint: 'https://other.example' });
  const sd = join(paths.stateRoot, 'mounts', oldId);
  const cache = join(paths.cacheRoot, oldId);
  await mkdir(sd, { recursive: true });
  await mkdir(cache, { recursive: true });
  const state = JSON.stringify({ mountId: oldId, mountPath: '/mnt/data', volumeId: 'data' });
  await writeFile(join(sd, 'mount.json'), state);
  await writeFile(join(sd, 'pid'), '42');
  await writeFile(join(cache, 'dirty'), 'pending data');
  const exec = promisify(execFile);
  const run = async (mountId, mounted) => {
    const spec = { mountId, mountPath: '/mnt/data', remotePath: 'fsvol:bucket/data', readOnly: false, cacheMode: 'writes', writeBackSeconds: 5, dirCacheSeconds: 60, allowOther: true, readyTimeoutMs: 1000, stateJson: state };
    const overrides = `fsvol_lock() { :; }\nfsvol_now() { echo 1; }\nfsvol_rclone() { echo rclone; }\nfsvol_fusermount() { echo fusermount; }\nfsvol_mounted() { return ${mounted ? 0 : 1}; }\nfsvol_mount_source() { echo fsvol:bucket/data; }\nfsvol_mount_ro() { echo 0; }\nfsvol_owned() { [ "$1" = 42 ]; }\nfsvol_pid_alive() { return 1; }\ntimeout() { return 0; }\n`;
    const script = mountScript(paths, spec).replace('RC=$(fsvol_rclone)', `${overrides}RC=$(fsvol_rclone)`);
    return exec('sh', ['-c', script]).then(r => ({ ...r, code: 0 }), e => e);
  };
  assert.match((await run(oldId, true)).stdout, /already=1/);
  const healthy = await run(newId, true);
  assert.equal(healthy.code, 20);
  assert.match(healthy.stdout, /mount-identity-mismatch/);
  const stale = await run(newId, false);
  assert.equal(stale.code, 20);
  assert.match(stale.stdout, /stale-state/);
  assert.equal(await readFile(join(cache, 'dirty'), 'utf8'), 'pending data');
  assert.equal(await readFile(join(sd, 'mount.json'), 'utf8'), state);
});

test('guest path lock rejects symlink targets and ancestors before touching state', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fv-alias-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink('/etc', join(root, 'alias'));
  const paths = { stateRoot: join(root, 's'), cacheRoot: join(root, 'c'), runRoot: join(root, 'r'), binDir: join(root, 'b') };
  const prelude = mountScript(paths, { readyTimeoutMs: 1000, cacheMode: 'writes', stateJson: '{}', mountId: 'id', mountPath: '/mnt/data', remotePath: 'fsvol:bucket/data' }).split('RC=$(fsvol_rclone)')[0];
  for (const path of [join(root, 'alias'), join(root, 'alias', 'missing', 'child')]) {
    await assert.rejects(promisify(execFile)('sh', ['-c', `${prelude}\nMP=${shellQuote(path)}\nfsvol_lock`]), e => e.code === 20 && /symlink-mount-path/.test(e.stdout));
  }
  await assert.rejects(promisify(execFile)('sh', ['-c', `${prelude}\nhave() { return 1; }\nMP=${shellQuote(join(root, 'missing', 'child'))}\nfsvol_lock`]), e => e.code === 13 && /tool-missing flock/.test(e.stdout));
});
