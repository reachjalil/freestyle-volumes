import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  bootstrapScript, mountScript, inspectScript, detachScript, mountFlags, parseGuestOutput, parseVfsStats,
  DEFAULT_GUEST_PATHS, RCLONE_VERSION, RCLONE_SHA256, RcloneBackend, MountError, FlushError, VolumeError, SandboxError,
} from '../../dist/index.js';
import { FakeSandbox } from '../helpers/fake-sandbox.mjs';

const spec = {
  mountId: 'abcdef0123456789',
  remotePath: 'fsvol:test-bucket/tenant-a/v/data',
  mountPath: '/mnt/data',
  readOnly: false,
  cacheMode: 'writes',
  writeBackSeconds: 5,
  dirCacheSeconds: 60,
  allowOther: true,
  readyTimeoutMs: 30000,
  stateJson: JSON.stringify({ version: 1, mountId: 'abcdef0123456789', volumeId: 'data', mountPath: '/mnt/data', readOnly: false }),
};

function shellCheck(script) {
  // `sh -n` parses without executing; catches quoting mistakes in generated scripts.
  const r = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('generated scripts are valid POSIX sh and contain no credential-looking values', () => {
  const scripts = [bootstrapScript(DEFAULT_GUEST_PATHS), mountScript(DEFAULT_GUEST_PATHS, spec), inspectScript(DEFAULT_GUEST_PATHS, '/mnt/data'), detachScript(DEFAULT_GUEST_PATHS, { mountPath: '/mnt/data', flushTimeoutMs: 60000, force: false })];
  for (const script of scripts) {
    shellCheck(script);
    assert.doesNotMatch(script, /ACCESS_KEY|SECRET|TOKEN/, 'scripts never embed credentials');
    assert.match(script, /RCLONE_CONFIG=\/dev\/null/, 'no config file is read or written');
  }
});

test('bootstrap pins the rclone version and checksums and never creates buckets', () => {
  const script = bootstrapScript(DEFAULT_GUEST_PATHS);
  assert.match(script, new RegExp(`downloads\\.rclone\\.org/v${RCLONE_VERSION.replace(/\\./g, '\\\\.')}/`));
  assert.ok(script.includes(RCLONE_SHA256.amd64) && script.includes(RCLONE_SHA256.arm64));
  assert.match(script, /sha256sum -c/);
  assert.match(script, /no-dev-fuse/);
  assert.doesNotMatch(script, /mkbucket|CreateBucket|rclone mkdir/);
});

test('mount flags reflect read-only, ownership and cache options', () => {
  assert.equal(mountFlags(spec), '--vfs-cache-mode writes --vfs-write-back 5s --dir-cache-time 60s --poll-interval 0 --allow-other');
  assert.equal(
    mountFlags({ ...spec, readOnly: true, uid: 1000, gid: 1000, umask: '022', cacheMaxSize: '10G', cacheMode: 'full', allowOther: false }),
    '--vfs-cache-mode full --vfs-write-back 5s --dir-cache-time 60s --poll-interval 0 --vfs-cache-max-size 10G --uid 1000 --gid 1000 --umask 022 --read-only',
  );
  const script = mountScript(DEFAULT_GUEST_PATHS, { ...spec, readOnly: true });
  assert.match(script, /--read-only/);
  assert.match(script, /--rc-addr 'unix:\/\/\$SOCK'/);
  assert.match(script, /setsid sh "\$SD\/run.sh"/);
  assert.match(script, /fail_cleanup\(\) \{ rm -f/, 'failed attaches move their state aside so inspect reports absent');
  assert.match(bootstrapScript(DEFAULT_GUEST_PATHS), /\/proc\/\$1\/stat/, 'liveness checks reject zombies');
  assert.throws(() => mountScript(DEFAULT_GUEST_PATHS, { ...spec, stateJson: "{'x':1}" }), VolumeError);
});

test('parseGuestOutput reads results, errors and blocks', () => {
  const out = parseGuestOutput('junk\nFSVOL_LOG_BEGIN\nline1\nline2\nFSVOL_LOG_END\nFSVOL_ERR process-exited some detail here\n');
  assert.deepEqual(out.error, { code: 'process-exited', detail: 'some detail here' });
  assert.deepEqual(out.blocks.LOG, ['line1', 'line2']);
  const ok = parseGuestOutput('FSVOL_RESULT status=attached already=1 pid=17\n');
  assert.deepEqual(ok.result, { status: 'attached', already: '1', pid: '17' });
  assert.equal(ok.error, undefined);
  assert.equal(parseVfsStats(['{"diskCache":{"uploadsQueued":2,"uploadsInProgress":1,"erroredFiles":0,"bytesUsed":99,"files":3}}']).uploadsQueued, 2);
  assert.equal(parseVfsStats(['not json']), undefined);
  assert.equal(parseVfsStats(undefined), undefined);
});

async function mountWith(stdout, exitCode = 22) {
  const backend = new RcloneBackend();
  const sandbox = new FakeSandbox('vm-1', [{ stdout, exitCode }]);
  return backend.mount(sandbox, spec, { RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY: 's' }, { timeoutMs: 5000 }).then(
    () => { throw new Error('expected failure'); },
    (error) => error,
  );
}

test('mount failures map to precise error codes with log tails', async () => {
  const fuse = await mountWith('FSVOL_ERR process-exited\nFSVOL_LOG_BEGIN\nNOTICE: mount helper error: fusermount3: fuse device /dev/fuse not found. Kernel module not loaded?\nFSVOL_LOG_END\n');
  assert.ok(fuse instanceof MountError);
  assert.equal(fuse.code, 'FUSE_UNAVAILABLE');
  assert.ok(fuse.details.logTail.length === 1);

  const auth = await mountWith('FSVOL_ERR process-exited\nFSVOL_LOG_BEGIN\nCRITICAL: Failed to create file system for "fsvol:b/x": is a file not a directory\nFSVOL_LOG_END\n');
  assert.equal(auth.code, 'MOUNT_FAILED');
  assert.match(auth.message, /reach or authenticate/);

  const timeout = await mountWith('FSVOL_ERR ready-timeout\n', 23);
  assert.equal(timeout.code, 'MOUNT_TIMEOUT');
  assert.match(timeout.message, /30000 ms/);

  const inUse = await mountWith('FSVOL_ERR path-in-use fsvol{abc}:other-bucket/x\n', 20);
  assert.equal(inUse.code, 'MOUNT_PATH_IN_USE');
  assert.match(inUse.message, /other-bucket/);

  const notEmpty = await mountWith('FSVOL_ERR mountpoint-not-empty\n', 21);
  assert.equal(notEmpty.code, 'MOUNT_FAILED');

  const unknown = await mountWith('garbage without markers\n', 1);
  assert.equal(unknown.code, 'MOUNT_FAILED');
});

test('bootstrap failures map to FUSE_UNAVAILABLE, RUNTIME_INSTALL and UNSUPPORTED', async () => {
  const backend = new RcloneBackend();
  const run = (stdout, exitCode) => backend.ensureRuntime(new FakeSandbox('vm-1', [{ stdout, exitCode }]), { timeoutMs: 1000 }).then(() => { throw new Error('expected failure'); }, (e) => e);
  assert.equal((await run('FSVOL_ERR no-dev-fuse\n', 12)).code, 'FUSE_UNAVAILABLE');
  assert.equal((await run('FSVOL_ERR checksum-mismatch https://x\n', 15)).code, 'RUNTIME_INSTALL');
  assert.equal((await run('FSVOL_ERR download https://x\n', 14)).code, 'RUNTIME_INSTALL');
  assert.equal((await run('FSVOL_ERR fuse3-install\n', 13)).code, 'RUNTIME_INSTALL');
  assert.equal((await run('FSVOL_ERR unsupported-arch riscv64\n', 14)).code, 'UNSUPPORTED');
  const ok = await backend.ensureRuntime(new FakeSandbox('vm-1', [{ stdout: 'FSVOL_RESULT rclone=/opt/x/rclone version=1.75.1 fusermount=/usr/bin/fusermount3 arch=aarch64\n' }]), { timeoutMs: 1000 });
  assert.deepEqual(ok, { rclonePath: '/opt/x/rclone', rcloneVersion: '1.75.1', fusermountPath: '/usr/bin/fusermount3', arch: 'aarch64' });
});

test('detach maps flush, busy, stale and unmanaged outcomes and returns absent idempotently', async () => {
  const backend = new RcloneBackend();
  const run = (stdout, exitCode = 0) => backend.unmount(new FakeSandbox('vm-1', [{ stdout, exitCode }]), { mountPath: '/mnt/data', flushTimeoutMs: 60000, force: false, timeoutMs: 1000 });
  const absent = await run('FSVOL_RESULT status=absent\n');
  assert.equal(absent.status, 'absent');
  const detached = await run('FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=abc ro=0\n');
  assert.deepEqual(detached, { status: 'detached', flushed: true, pending: 0, volumeId: 'data', mountId: 'abc', readOnly: false });
  const forced = await run('FSVOL_RESULT status=detached flushed=0 pending=-1 volume=data mid=abc ro=0\n');
  assert.equal(forced.flushed, false);
  assert.equal(forced.pending, null);
  const flush = await run('FSVOL_ERR flush-timeout pending=3 errored=1\n', 30).catch((e) => e);
  assert.ok(flush instanceof FlushError || flush.code === 'FLUSH_FAILED');
  assert.match(flush.message, /still attached/);
  assert.equal((await run('FSVOL_ERR busy fusermount3: failed to unmount /mnt/data: Resource busy\n', 31).catch((e) => e)).code, 'MOUNT_BUSY');
  assert.equal((await run('FSVOL_ERR stale process-dead\n', 32).catch((e) => e)).code, 'MOUNT_STALE');
  assert.equal((await run('FSVOL_ERR unmanaged fsvol{x}:b/p\n', 34).catch((e) => e)).code, 'MOUNT_UNMANAGED');
});

test('exec timeouts and transport failures become SandboxError', async () => {
  const backend = new RcloneBackend();
  const timedOut = await backend.ensureRuntime(new FakeSandbox('vm-1', [{ stdout: '', exitCode: null }]), { timeoutMs: 1000 }).catch((e) => e);
  assert.ok(timedOut instanceof SandboxError);
  assert.equal(timedOut.code, 'SANDBOX_EXEC_TIMEOUT');
  const failed = await backend.ensureRuntime(new FakeSandbox('vm-1', [new Error('network down')]), { timeoutMs: 1000 }).catch((e) => e);
  assert.equal(failed.code, 'SANDBOX_EXEC');
  assert.equal(failed.cause.message, 'network down');
});
