import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FreestyleVolumes, MemoryObjectStore, RcloneBackend, listMountsScript, parseMountListing, DEFAULT_GUEST_PATHS } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage } from '../helpers/fake-sandbox.mjs';
import { LocalShellSandbox } from '../helpers/local-sandbox.mjs';

const listLine = (mid, { mounted = 1, alive = 1, pid = 4242, ro = 0, state = {} } = {}) =>
  `FSVOL_MOUNT mid=${mid} mounted=${mounted} alive=${alive} pid=${pid} ro=${mounted ? ro : ''} state=${JSON.stringify(state)}`;

function volumesWith(sandbox, options = {}) {
  return new FreestyleVolumes({ storage, sandboxes: fakeResolver([sandbox]), objectStore: new MemoryObjectStore(), ...options });
}

test('the listing script is valid POSIX sh, read-only and credential-free', () => {
  const script = listMountsScript(DEFAULT_GUEST_PATHS);
  const syntax = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.doesNotMatch(script, /ACCESS_KEY|SECRET|TOKEN/);
  const body = script.slice(script.indexOf('# List managed mounts'));
  assert.doesNotMatch(body, /fsvol_lock|mkdir|rm -|kill|fusermount/, 'listing never locks, writes, deletes, signals or unmounts');
});

test('the real listing script reports healthy, read-only, stale, unreadable and unmanaged mounts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fv-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { stateRoot: join(root, 's'), runRoot: join(root, 'r'), cacheRoot: join(root, 'c'), binDir: join(root, 'b') };
  const state = async (mid, files) => {
    const dir = join(paths.stateRoot, 'mounts', mid);
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  };
  await state('aaaa000000000001', { 'mount.json': `${JSON.stringify({ mountPath: '/mnt/healthy', volumeId: 'data', subpath: null, readOnly: false, startedAt: '2026-09-25T00:00:00.000Z' })}\n`, pid: '101' });
  await state('aaaa000000000002', { 'mount.json': JSON.stringify({ mountPath: '/mnt/ro', volumeId: 'models', subpath: 'team-a', readOnly: true }), pid: '102' });
  await state('aaaa000000000003', { 'mount.json': JSON.stringify({ mountPath: '/mnt/crashed', volumeId: 'data' }), pid: 'not-a-pid' });
  await state('aaaa000000000004', { 'mount.json': 'not json at all', pid: '104' });
  await state('aaaa000000000005', { pid: '105' });
  const sandbox = new LocalShellSandbox('vm-1', {
    marker: '# List managed mounts',
    overrides: `
fsvol_mounted() { case "$1" in /mnt/healthy|/mnt/ro) return 0;; *) return 1;; esac; }
fsvol_owned() { [ "$1" = 101 ] || [ "$1" = 102 ]; }
fsvol_mount_ro() { if [ "$1" = /mnt/ro ]; then echo 1; else echo 0; fi; }
fsvol_rclone_mounts() { printf '%s\\n' /mnt/healthy /mnt/ro /mnt/foreign; }`,
  });

  const run = await sandbox.exec({ command: listMountsScript(paths), timeoutMs: 10_000 });
  assert.equal(run.exitCode, 0, run.stdout + run.stderr);
  const guest = parseMountListing(run.stdout);
  assert.deepEqual(guest.unmanaged, ['/mnt/foreign']);
  assert.deepEqual(guest.mounts.map((m) => [m.mountId, m.mounted, m.alive, m.pid, m.readOnly]), [
    ['aaaa000000000001', true, true, 101, false],
    ['aaaa000000000002', true, true, 102, true],
    ['aaaa000000000003', false, false, null, null],
    ['aaaa000000000004', false, false, 104, null],
  ]);
  assert.equal(guest.mounts[3].state, null, 'an unreadable record is still listed');

  const volumes = volumesWith(sandbox, { backend: new RcloneBackend({ paths }) });
  const listing = await volumes.listMounts({ sandboxId: 'vm-1' });
  assert.deepEqual(listing.unmanaged, ['/mnt/foreign']);
  assert.deepEqual(listing.mounts.map((m) => [m.mountPath, m.status, m.volumeId, m.subpath, m.readOnly, m.pid]), [
    [null, 'stale', null, null, null, null],
    ['/mnt/crashed', 'stale', 'data', null, null, null],
    ['/mnt/healthy', 'mounted', 'data', null, false, 101],
    ['/mnt/ro', 'mounted', 'models', 'team-a', true, 102],
  ]);
  assert.equal(listing.mounts[2].startedAt, '2026-09-25T00:00:00.000Z');
});

test('listMounts rejects invalid ids and surfaces a failed listing', async () => {
  const sandbox = new FakeSandbox('vm-1', [{ stdout: 'garbage\n', exitCode: 2 }]);
  const volumes = volumesWith(sandbox);
  await assert.rejects(volumes.listMounts({ sandboxId: 'bad id' }), { code: 'VALIDATION' });
  await assert.rejects(volumes.listMounts({ sandboxId: 'vm-1' }), { code: 'MOUNT_FAILED' });
});

test('listMounts drops mount paths that fail validation instead of trusting guest state', async () => {
  const sandbox = new FakeSandbox('vm-1', [{ stdout: `${listLine('aaaa000000000001', { state: { mountPath: '/etc/../root', volumeId: 'data' } })}\nFSVOL_RESULT status=listed\n` }]);
  const listing = await volumesWith(sandbox).listMounts({ sandboxId: 'vm-1' });
  assert.equal(listing.mounts[0].mountPath, null);
});

test('detachAll drains every managed mount, reports failures without throwing, and skips unmanaged mounts', async () => {
  const listing = [
    listLine('aaaa000000000001', { state: { mountPath: '/mnt/a', volumeId: 'a' } }),
    listLine('aaaa000000000002', { mounted: 0, alive: 0, state: { mountPath: '/mnt/b', volumeId: 'b' } }),
    listLine('aaaa000000000003', { mounted: 0, alive: 0, state: {} }),
    'FSVOL_UNMANAGED /mnt/foreign',
    'FSVOL_RESULT status=listed',
  ].join('\n');
  const sandbox = new FakeSandbox('vm-1', [
    { stdout: `${listing}\n` },
    { stdout: 'FSVOL_RESULT status=detached flushed=1 pending=0 volume=a mid=aaaa000000000001 ro=0\n' },
    { stdout: 'FSVOL_ERR stale drain-not-verifiable\n', exitCode: 32 },
  ]);
  const events = [];
  const volumes = volumesWith(sandbox, { onEvent: (event) => events.push(event.type) });
  const result = await volumes.detachAll({ sandboxId: 'vm-1', flushTimeoutMs: 30_000 });

  assert.equal(result.flushed, false, 'a stale mount with unverifiable data is not flushed');
  assert.deepEqual(result.unmanaged, ['/mnt/foreign']);
  assert.deepEqual(result.results.map((r) => [r.status, r.mountPath, r.flushed]), [
    ['failed', null, false],
    ['detached', '/mnt/a', true],
    ['failed', '/mnt/b', false],
  ]);
  assert.equal(result.results[0].error.code, 'MOUNT_STALE');
  assert.match(result.results[0].error.message, /aaaa000000000003/);
  assert.equal(result.results[2].error.code, 'MOUNT_STALE');
  assert.equal(sandbox.calls.length, 3, 'one listing plus one detach per mount with a path');
  assert.match(sandbox.calls[1].command, /MP='\/mnt\/a'/);
  assert.match(sandbox.calls[1].command, /FLUSH=30\n/);
  assert.match(sandbox.calls[2].command, /MP='\/mnt\/b'/);
  assert.deepEqual(events, ['detach.start', 'detach.done', 'detach.start']);
});

test('detachAll is flushed when every mount drains or nothing is mounted', async () => {
  const empty = volumesWith(new FakeSandbox('vm-1', [{ stdout: 'FSVOL_RESULT status=listed\n' }]));
  assert.deepEqual(await empty.detachAll({ sandboxId: 'vm-1' }), { sandboxId: 'vm-1', flushed: true, results: [], unmanaged: [] });

  const forced = new FakeSandbox('vm-1', [
    { stdout: `${listLine('aaaa000000000001', { state: { mountPath: '/mnt/a', volumeId: 'a' } })}\nFSVOL_RESULT status=listed\n` },
    { stdout: 'FSVOL_RESULT status=detached flushed=0 pending=-1 volume=a mid=aaaa000000000001 ro=0\n' },
  ]);
  const result = await volumesWith(forced).detachAll({ sandboxId: 'vm-1', force: true });
  assert.equal(result.flushed, false, 'a forced detach without a verified drain is not flushed');
  assert.match(forced.calls[1].command, /FORCE=1\n/);
  await assert.rejects(volumesWith(forced).detachAll({ sandboxId: 'vm-1', flushTimeoutMs: 10 }), { code: 'VALIDATION' });
});
