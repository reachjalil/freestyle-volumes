// flush, discardMount, restoreMounts, per-mount upload stats and createVmWithVolumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  FreestyleVolumes, MemoryObjectStore, ValidationError, createVmWithVolumes, flushScript, discardScript, parseMountListing, DEFAULT_GUEST_PATHS,
} from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';

function setup(responses = []) {
  const store = new MemoryObjectStore();
  const sandbox = new FakeSandbox('vm-1', responses);
  const events = [];
  const volumes = new FreestyleVolumes({ storage, sandboxes: fakeResolver([sandbox]), objectStore: store, onEvent: (e) => events.push(e) });
  return { store, sandbox, volumes, events };
}

const LISTED = 'FSVOL_RESULT status=listed\n';
const mountLine = (mid, state, { mounted = 0, alive = 0, pid = '', ro = '' } = {}) => `FSVOL_MOUNT mid=${mid} mounted=${mounted} alive=${alive} pid=${pid} ro=${ro} state=${JSON.stringify(state)}\n`;

test('the flush and discard scripts are valid POSIX sh, locked and credential-free', () => {
  for (const script of [flushScript(DEFAULT_GUEST_PATHS, { mountPath: '/mnt/data', flushTimeoutMs: 30_000 }), discardScript(DEFAULT_GUEST_PATHS, { mountPath: '/mnt/data' })]) {
    const syntax = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.doesNotMatch(script, /ACCESS_KEY|SECRET|SESSION_TOKEN/);
    assert.match(script, /\nfsvol_lock\n/, 'serialized with attach, detach and inspect at the same path');
  }
  const flush = flushScript(DEFAULT_GUEST_PATHS, { mountPath: '/mnt/data', flushTimeoutMs: 30_000 });
  assert.match(flush, /FLUSH=30\n/);
  const flushBody = flush.slice(flush.indexOf("MP='/mnt/data'"));
  assert.doesNotMatch(flushBody, /fusermount|kill |rm -/, 'flush never unmounts, signals or deletes');
  const discard = discardScript(DEFAULT_GUEST_PATHS, { mountPath: '/mnt/data' });
  assert.ok(discard.indexOf('fsvol_mounted "$MP"') < discard.indexOf('rm -rf'), 'refuses while mounted before deleting anything');
  assert.ok(discard.indexOf('fsvol_owned "$pid"') < discard.indexOf('rm -rf'), 'refuses while the uploader runs before deleting anything');
});

test('flush keeps the mount, reports what is left, and maps guest refusals', async () => {
  const { volumes, sandbox, events } = setup([
    { stdout: 'FSVOL_RESULT status=flushed pending=0 errored=0 mounted=1 mid=abc volume=data\n' },
    { stdout: 'FSVOL_RESULT status=pending pending=3 errored=1 mounted=1 mid=abc volume=data\nFSVOL_LOG_BEGIN\nERROR : upload failed\nFSVOL_LOG_END\n' },
    { stdout: 'FSVOL_ERR absent\n', exitCode: 33 },
    { stdout: 'FSVOL_ERR stale uploader-not-running\n', exitCode: 32 },
    { stdout: 'FSVOL_ERR lifecycle-busy\n', exitCode: 36 },
    { stdout: 'FSVOL_ERR unmanaged fsvol:x\n', exitCode: 34 },
  ]);
  assert.deepEqual(await volumes.flush({ sandboxId: 'vm-1', mountPath: '/mnt/data' }), {
    status: 'flushed', sandboxId: 'vm-1', mountPath: '/mnt/data', volumeId: 'data', flushed: true, pendingUploads: 0, erroredUploads: 0, mounted: true,
  });
  assert.match(sandbox.calls[0].command, /FLUSH=60\n/, 'defaults to the flush timeout');
  const pending = await volumes.flush({ sandboxId: 'vm-1', mountPath: '/mnt/data', flushTimeoutMs: 5000 });
  assert.deepEqual([pending.status, pending.flushed, pending.pendingUploads, pending.erroredUploads], ['pending', false, 3, 1]);
  assert.match(sandbox.calls[1].command, /FLUSH=5\n/);
  for (const code of ['MOUNT_NOT_FOUND', 'MOUNT_STALE', 'MOUNT_BUSY', 'MOUNT_UNMANAGED']) {
    await assert.rejects(volumes.flush({ sandboxId: 'vm-1', mountPath: '/mnt/data' }), { code });
  }
  assert.deepEqual(events.filter((e) => e.type === 'flush.done').map((e) => e.message), ['flushed', 'pending 3, errored 1']);
  await assert.rejects(volumes.flush({ sandboxId: 'vm-1', mountPath: '/mnt/data', flushTimeoutMs: 299_000 }), ValidationError);
});

test('flushAll flushes healthy mounts and counts stale ones as not flushed', async () => {
  const listing = mountLine('aaa', { mountPath: '/mnt/a', volumeId: 'data' }, { mounted: 1, alive: 1, pid: 7, ro: 0 })
    + mountLine('bbb', { mountPath: '/mnt/b', volumeId: 'data' }) + LISTED;
  const { volumes } = setup([{ stdout: listing }, { stdout: 'FSVOL_RESULT status=flushed pending=0 errored=0 mounted=1 mid=aaa volume=data\n' }]);
  const result = await volumes.flushAll({ sandboxId: 'vm-1' });
  assert.equal(result.flushed, false);
  assert.deepEqual(result.results.map((r) => [r.mountPath, r.status]), [['/mnt/a', 'flushed'], ['/mnt/b', 'failed']]);
  assert.equal(result.results[1].error.code, 'MOUNT_STALE');
});

test('listMounts reports the upload queue and cache size of running uploaders', async () => {
  const stats = JSON.stringify({ diskCache: { uploadsQueued: 2, uploadsInProgress: 1, erroredFiles: 0, bytesUsed: 4096, files: 3 } });
  const stdout = mountLine('aaa', { mountPath: '/mnt/a', volumeId: 'data', exclusive: true, credentialsExpireAt: '2026-09-26T00:00:00.000Z' }, { mounted: 1, alive: 1, pid: 7, ro: 0 })
    + `FSVOL_MSTATS mid=aaa ${stats}\n`
    + mountLine('bbb', { mountPath: '/mnt/b', volumeId: 'data' })
    + 'FSVOL_MSTATS mid=bbb {"diskCache":{"uploadsQueued":9,"uploadsInProgress":0,"erroredFiles":0}}\n' + LISTED;
  const guest = parseMountListing(stdout);
  assert.equal(guest.mounts[1].stats, null, 'stats of a dead process are ignored');
  const { volumes } = setup([{ stdout }]);
  const listing = await volumes.listMounts({ sandboxId: 'vm-1' });
  assert.deepEqual(listing.mounts.map((m) => [m.mountPath, m.status, m.uploads, m.cacheBytes, m.exclusive, m.credentialsExpireAt]), [
    ['/mnt/a', 'mounted', { queued: 2, inProgress: 1, errored: 0 }, 4096, true, '2026-09-26T00:00:00.000Z'],
    ['/mnt/b', 'stale', null, null, false, null],
  ]);
});

test('discardMount needs confirmation, deletes retained state, and cleans up the records it guarded', async () => {
  const { store, sandbox, volumes, events } = setup();
  const volume = await volumes.create({ name: 'data' });
  await volumes.registry.putAttachment({ volumeId: 'data', sandboxId: 'vm-1', mountId: 'abc', mountPath: '/mnt/data', subpath: null, readOnly: false, attachedAt: '2026-09-25T00:00:00.000Z' });
  await volumes.registry.acquireLease({ volumeId: 'data', generation: volume.generation, sandboxId: 'vm-1', mountId: 'abc', mountPath: '/mnt/data', acquiredAt: '2026-09-25T00:00:00.000Z' });
  await assert.rejects(volumes.discardMount({ sandboxId: 'vm-1', mountPath: '/mnt/data', confirm: '/mnt/other' }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(sandbox.calls.length, 0);

  sandbox.responses.push({ stdout: 'FSVOL_ERR path-in-use still-mounted\n', exitCode: 20 });
  await assert.rejects(volumes.discardMount({ sandboxId: 'vm-1', mountPath: '/mnt/data', confirm: '/mnt/data' }), (error) => error.code === 'MOUNT_PATH_IN_USE' && /Detach it first/.test(error.hint));
  sandbox.responses.push({ stdout: 'FSVOL_RESULT status=discarded volume=data mid=abc cachekb=2048\n' });
  const discarded = await volumes.discardMount({ sandboxId: 'vm-1', mountPath: '/mnt/data', confirm: '/mnt/data' });
  assert.deepEqual(discarded, { status: 'discarded', sandboxId: 'vm-1', mountPath: '/mnt/data', volumeId: 'data', discardedCacheBytes: 2048 * 1024, warnings: [] });
  assert.deepEqual(await volumes.registry.listAttachments('data'), []);
  assert.equal(await volumes.getLease('data'), null);
  assert.ok(events.some((e) => e.type === 'mount.discarded'));
  sandbox.responses.push({ stdout: 'FSVOL_RESULT status=absent\n' });
  assert.equal((await volumes.discardMount({ sandboxId: 'vm-1', mountPath: '/mnt/data', confirm: '/mnt/data' })).status, 'absent');
  assert.ok(store.objects.has(`${storage.prefix}/_volumes/data.json`), 'volume data and record are untouched');
});

test('restoreMounts reattaches stale mounts with their saved options and recovers dead FUSE entries', async () => {
  const { volumes, sandbox } = setup();
  const volume = await volumes.create({ name: 'data' });
  const saved = (mid, mountPath, extra = {}) => ({ version: 1, mountId: mid, volumeId: 'data', generation: volume.generation, subpath: null, mountPath, readOnly: false, exclusive: false, startedAt: '2026-09-25T00:00:00.000Z', ...extra });
  const listing = mountLine('aaa', saved('aaa', '/mnt/restart', { options: { cacheMode: 'full', writeBackSeconds: 30, dirCacheSeconds: 10, allowOther: false, uid: 1000, gid: 1000, cacheMinFreeSpace: '2G', transfers: 3 } }))
    + mountLine('bbb', saved('bbb', '/mnt/crashed', { subpath: 'team-a' }))
    + mountLine('ccc', saved('ccc', '/mnt/healthy'), { mounted: 1, alive: 1, pid: 9, ro: 0 })
    + mountLine('ddd', saved('ddd', '/mnt/broken'))
    + mountLine('eee', { mountId: 'eee', mountPath: 'not a path' })
    + LISTED;
  // Mounts are handled in mount-path order; the unreadable record sorts first and needs no sandbox call.
  sandbox.responses.push(
    { stdout: listing },
    BOOTSTRAP_OK, { stdout: 'FSVOL_ERR mount-create-failed\n', exitCode: 22 }, // /mnt/broken
    BOOTSTRAP_OK, { stdout: 'FSVOL_ERR path-in-use stale-mount-requires-detach\n', exitCode: 20 }, // /mnt/crashed
    { stdout: 'FSVOL_RESULT status=detached flushed=0 pending=-1 volume=data mid=bbb ro=0\n' },
    BOOTSTRAP_OK, MOUNT_OK, // /mnt/crashed after the forced detach
    BOOTSTRAP_OK, MOUNT_OK, // /mnt/restart mounts straight away
  );
  const result = await volumes.restoreMounts({ sandboxId: 'vm-1' });
  assert.deepEqual(result.restored.map((r) => r.mountPath), ['/mnt/crashed', '/mnt/restart']);
  assert.deepEqual(result.alreadyMounted, ['/mnt/healthy']);
  assert.deepEqual(result.failed.map((f) => [f.mountPath, f.error.code]), [[null, 'MOUNT_STALE'], ['/mnt/broken', 'MOUNT_FAILED']]);
  const restartMount = sandbox.calls[9].command;
  for (const expected of ['"CacheMode":3', '"WriteBack":"30s"', '"DirCacheTime":"10s"', '"UID":1000', '"GID":1000', '"CacheMinFreeSpace":"2G"', '"AllowOther":false', '--transfers']) {
    assert.ok(restartMount.includes(expected), `saved option ${expected} is reapplied`);
  }
  assert.match(sandbox.calls[5].command, /FORCE=1\n/, 'a dead FUSE entry is removed with a forced detach that keeps the cache');
  assert.ok(sandbox.calls[7].command.includes('/team-a'), 'the subpath is restored');
});

test('restoreMounts lets a still-draining uploader finish before mounting again', async () => {
  const { volumes, sandbox } = setup();
  const volume = await volumes.create({ name: 'data' });
  sandbox.responses.push(
    { stdout: mountLine('aaa', { mountId: 'aaa', volumeId: 'data', generation: volume.generation, mountPath: '/mnt/data', readOnly: false }) + LISTED },
    BOOTSTRAP_OK, { stdout: 'FSVOL_ERR path-in-use existing-process-requires-detach\n', exitCode: 20 },
    { stdout: 'FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=aaa ro=0\n' },
    BOOTSTRAP_OK, MOUNT_OK,
  );
  const result = await volumes.restoreMounts({ sandboxId: 'vm-1' });
  assert.equal(result.restored.length, 1);
  assert.match(sandbox.calls[3].command, /FORCE=0\n/, 'a verified drain, never a forced one, while the uploader lives');
});

test('createVmWithVolumes creates the VM, attaches in order, and cleans up only what is safe to lose', async () => {
  const created = [];
  const deleted = [];
  const freestyle = { vms: { create: async (options) => { created.push(options); return { vmId: `vm-${created.length}`, vm: { delete: async () => { deleted.push(`vm-${created.length}`); } } }; } } };
  const attached = [];
  let failOn = null;
  let detachFlushed = true;
  const volumes = {
    attach: async (options) => {
      attached.push(options);
      if (options.mountPath === failOn) throw Object.assign(new Error('mount failed'), { code: 'MOUNT_FAILED' });
      return { ...options, mountId: 'm', pid: 1, alreadyAttached: false, warnings: [] };
    },
    detachAll: async () => ({ flushed: detachFlushed }),
  };
  const firewall = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };
  const mounts = [{ volumeId: 'datasets', mountPath: '/data', readOnly: true }, { volumeId: 'runs', mountPath: '/out', subpath: 'run-1' }];
  const ok = await createVmWithVolumes(freestyle, volumes, { vm: { snapshotId: 'ubuntu-sm-volumes', firewall }, mounts });
  assert.equal(ok.vmId, 'vm-1');
  assert.deepEqual(ok.attachments.map((a) => [a.sandboxId, a.mountPath]), [['vm-1', '/data'], ['vm-1', '/out']]);
  assert.deepEqual(created[0], { snapshotId: 'ubuntu-sm-volumes', firewall });

  failOn = '/out';
  await assert.rejects(createVmWithVolumes(freestyle, volumes, { vm: { firewall }, mounts }), /mount failed/);
  assert.deepEqual(deleted, ['vm-2'], 'nothing unflushed: the half-built VM is deleted');
  detachFlushed = false;
  await assert.rejects(createVmWithVolumes(freestyle, volumes, { vm: { firewall }, mounts }), /mount failed/);
  assert.deepEqual(deleted, ['vm-2'], 'unflushed writes keep the VM');
  detachFlushed = true;
  await assert.rejects(createVmWithVolumes(freestyle, volumes, { vm: { firewall }, mounts, deleteOnFailure: false }), /mount failed/);
  assert.deepEqual(deleted, ['vm-2']);
  await assert.rejects(createVmWithVolumes(freestyle, volumes, { vm: { firewall } }), ValidationError);
});
