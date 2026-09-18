// Execute the generated guest control flow with fake FUSE/RC endpoints. The
// mocks replace Linux introspection only; ordering, deadlines, cleanup, and
// retry state are the actual generated POSIX shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detachScript } from '../../dist/index.js';

const exec = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);

async function fixture(t, mode = 'late') {
  // Short socket pathname also works on macOS.
  const root = await mkdtemp(join(tmpdir(), 'fv-'));
  const paths = { stateRoot: join(root, 's'), runRoot: join(root, 'r'), cacheRoot: join(root, 'c'), binDir: join(root, 'b') };
  const sd = join(paths.stateRoot, 'mounts', 'abc');
  const cache = join(paths.cacheRoot, 'abc');
  await Promise.all([sd, cache, paths.runRoot, paths.binDir].map(p => mkdir(p, { recursive: true })));
  await writeFile(join(sd, 'mount.json'), JSON.stringify({ mountPath: '/mnt/data', volumeId: 'data', readOnly: false }));
  await writeFile(join(sd, 'pid'), '42');
  await writeFile(join(sd, 'driver'), 'rcd');
  await writeFile(join(sd, 'remote'), 'fsvol:bucket/data');
  await writeFile(join(cache, 'dirty'), 'late write');
  await Promise.all(['mounted', 'alive'].map(p => writeFile(join(root, p), '1')));
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(join(paths.runRoot, 'abc.sock'), resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const fm = join(paths.binDir, 'fm');
  const rc = join(paths.binDir, 'rc');
  await writeFile(fm, `#!/bin/sh
echo unmount >> '${root}/events'
if [ '${mode}' = busy ]; then echo 'Resource busy'; exit 1; fi
if [ '${mode}' = lying ]; then exit 0; fi
rm '${root}/mounted'
echo 1 > '${root}/late'
`, { mode: 0o700 });
  await writeFile(rc, `#!/bin/sh
echo "$4" >> '${root}/events'
case "$4" in
  mount/listmounts)
    if [ '${mode}' = closing ] && [ ! -f '${root}/closed' ]; then touch '${root}/closed'; echo '{"mountPoints": [{"MountPoint": "/mnt/data"}]}'; else echo '{"mountPoints": []}'; fi;;
  vfs/queue) echo '{}';;
  vfs/stats)
    if [ '${mode}' = missing ]; then printf '{\n "uploadsQueued": 0,\n "uploadsInProgress": 0\n}\n'; exit; fi
    if [ '${mode}' = slow ]; then sleep 3; exit 1; fi
    n=0
    if [ -f '${root}/late' ]; then n=1; rm '${root}/late'; fi
    if [ '${mode}' = pending ]; then n=1; fi
    printf '{\n "uploadsQueued": %s,\n "uploadsInProgress": 0,\n "erroredFiles": 0\n}\n' "$n"
    ;;
esac
`, { mode: 0o700 });
  const overrides = `
fsvol_lock() { :; }
fsvol_now() { date +%s; }
fsvol_rclone() { echo '${rc}'; }
fsvol_fusermount() { echo '${fm}'; }
fsvol_mounted() { [ -f '${root}/mounted' ]; }
fsvol_mount_source() { echo fsvol:bucket/data; }
fsvol_mount_ro() { echo 0; }
fsvol_pid_alive() { [ -f '${root}/alive' ]; }
fsvol_owned() { [ -f '${root}/alive' ]; }
kill() { echo stop >> '${root}/events'; rm -f '${root}/alive'; }
`;
  // Use the real utility on Linux. Portable fallback keeps these control-flow
  // tests executable on macOS without installing guest dependencies.
  let timeout = await exec('sh', ['-c', 'command -v timeout || command -v gtimeout']).then(r => `'${r.stdout.trim()}'`, () => '');
  if (!timeout) {
    const helper = join(root, 'timeout.mjs');
    await writeFile(helper, `import { spawn } from 'node:child_process';
const [seconds, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit', detached: true });
let expired = false;
const timer = setTimeout(() => { expired = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, Number(seconds) * 1000);
child.on('exit', code => { clearTimeout(timer); process.exit(expired ? 124 : code ?? 1); });
`);
    timeout = `'${process.execPath}' '${helper}'`;
  }
  const run = async (force = false, flushTimeoutMs = 2000) => {
    const script = detachScript(paths, { mountPath: '/mnt/data', force, flushTimeoutMs }).replace("MP='/mnt/data'", `${overrides}\ntimeout() { ${timeout} "$@"; }\nMP='/mnt/data'`);
    return exec('sh', ['-c', script], { timeout: 10000 }).then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
  };
  return { root, sd, cache, run };
}

test('guest detach unmounts before sampling and drains a late upload before deleting cache', async t => {
  const f = await fixture(t);
  const r = await f.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /flushed=1 pending=0/);
  const events = (await readFile(join(f.root, 'events'), 'utf8')).trim().split('\n');
  assert.equal(events[0], 'unmount');
  assert.equal(events.filter(x => x === 'vfs/stats').length, 2);
  assert.equal(events.at(-1), 'stop');
  assert.equal(await exists(f.cache), false);
});

for (const mode of ['missing', 'pending', 'slow']) {
  test(`guest ${mode} RC result preserves cache, state and running uploader`, async t => {
    const f = await fixture(t, mode);
    const start = Date.now();
    const r = await f.run(false, 1000);
    assert.equal(r.code, 30, r.stdout + r.stderr);
    assert.match(r.stdout, /flush-timeout/);
    assert.ok(Date.now() - start < 2500, 'RPC duration counts against flush deadline');
    assert.equal(await exists(join(f.cache, 'dirty')), true);
    assert.equal(await exists(join(f.sd, 'quiesced')), true);
    assert.equal(await exists(join(f.root, 'alive')), true);
  });
}

test('guest busy unmount leaves mount intact and never samples a writable queue', async t => {
  const f = await fixture(t, 'busy');
  assert.equal((await f.run()).code, 31);
  assert.equal(await readFile(join(f.root, 'events'), 'utf8'), 'unmount\n');
  assert.equal(await exists(join(f.root, 'mounted')), true);
  assert.equal(await exists(f.cache), true);
});

test('guest verifies unmount result rather than trusting exit zero', async t => {
  const f = await fixture(t, 'lying');
  assert.equal((await f.run()).code, 35);
  assert.equal(await exists(f.cache), true);
});

test('guest forced failed drain keeps recovery state and cache', async t => {
  const f = await fixture(t, 'missing');
  const r = await f.run(true, 1000);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /flushed=0 pending=-1/);
  assert.equal(await exists(join(f.sd, 'mount.json')), true);
  assert.equal(await exists(join(f.cache, 'dirty')), true);
});

test('guest missing process identity cannot authorize cleanup even after an empty queue', async t => {
  const f = await fixture(t);
  await rm(join(f.sd, 'pid'));
  const r = await f.run(true);
  assert.equal(r.code, 32, r.stdout + r.stderr);
  assert.match(r.stdout, /cleanup-uncertain/);
  assert.equal(await exists(join(f.cache, 'dirty')), true);
  assert.equal(await exists(join(f.root, 'alive')), true);
});

test('guest retry can complete drain after filesystem has already been unmounted', async t => {
  const f = await fixture(t, 'pending');
  assert.equal((await f.run(false, 1000)).code, 30);
  const rc = join(f.root, 'b', 'rc');
  await writeFile(rc, (await readFile(rc, 'utf8')).replaceAll("'pending'", "'late'"), { mode: 0o700 });
  const r = await f.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal((await readFile(join(f.root, 'events'), 'utf8')).split('unmount').length - 1, 1);
  assert.equal(await exists(f.cache), false);
});

test('guest waits for FUSE request serving to finish before sampling uploads', async t => {
  const f = await fixture(t, 'closing');
  const r = await f.run(false, 5000);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const events = (await readFile(join(f.root, 'events'), 'utf8')).trim().split('\n');
  assert.deepEqual(events.slice(0, 4), ['unmount', 'mount/listmounts', 'mount/listmounts', 'vfs/queue']);
});

test('guest PID identity rejects malformed, reused and unrelated processes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fv-pid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = join(root, 'proc', '42');
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'stat'), `42 (rclone worker) S ${Array(18).fill('0').join(' ')} 123\n`);
  await writeFile(join(proc, 'cmdline'), 'rclone\0rcd\0--rc-addr\0unix:///rc.sock\0');
  await writeFile(join(root, 'pid.start'), '123\n');
  await writeFile(join(root, 'pid.exe'), '/usr/bin/rclone\n');
  const prelude = detachScript({ stateRoot: root, runRoot: root, cacheRoot: root, binDir: root }, { mountPath: '/x', force: false, flushTimeoutMs: 1000 }).split("MP='/x'")[0].replaceAll('/proc/', `${root}/proc/`);
  const run = pid => exec('sh', ['-c', `${prelude}\nSD='${root}'; SOCK=/rc.sock; kill() { return 0; }; readlink() { echo /usr/bin/rclone; }; fsvol_owned '${pid}'`]).then(() => true, () => false);
  assert.equal(await run('42'), true);
  for (const pid of ['-1', '0', '1', 'abc', '42 43']) assert.equal(await run(pid), false);
  await writeFile(join(root, 'pid.start'), '124\n');
  assert.equal(await run('42'), false);
  await writeFile(join(root, 'pid.start'), '123\n');
  await writeFile(join(root, 'pid.exe'), '/usr/bin/unrelated\n');
  assert.equal(await run('42'), false);
  await writeFile(join(root, 'pid.exe'), '/usr/bin/rclone\n');
  await writeFile(join(proc, 'cmdline'), 'rclone\0rcd\0--rc-addr\0unix:///other.sock\0');
  assert.equal(await run('42'), false);
  await writeFile(join(proc, 'cmdline'), 'rclone\0rcd\0--rc-addr\0unix:///rc.sock\0');
  await writeFile(join(proc, 'stat'), `42 (rclone worker) Z ${Array(18).fill('0').join(' ')} 123\n`);
  assert.equal(await run('42'), false);
});
