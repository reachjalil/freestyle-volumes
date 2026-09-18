// Real Linux/rclone regression, deliberately independent of volumes/registry.
// Local storage is enough to exercise the VFS write-back and FUSE lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RcloneBackend, DockerSandbox, DEFAULT_GUEST_PATHS } from '../../dist/index.js';
import { docker, dockerAvailable } from '../helpers/stack.mjs';

test('real guest: rejected reattach preserves stopped identity and pending uploads', { skip: !dockerAvailable(), timeout: 180000 }, async t => {
  const name = `fsvol-recovery-${randomUUID().slice(0, 8)}`;
  docker(['run', '-d', '--name', name, '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor:unconfined', '--entrypoint', 'sh', 'rclone/rclone:1.75.1', '-c', 'sleep 300']);
  t.after(() => docker(['rm', '-f', name], { allowFailure: true }));
  const sb = new DockerSandbox(name);
  const backend = new RcloneBackend();
  const shell = async command => {
    const r = await sb.exec({ command, timeoutMs: 10000 });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  await backend.ensureRuntime(sb, { timeoutMs: 120000 });
  await shell('mkdir /remote');
  const spec = {
    mountId: 'recover1234', remotePath: '/remote', mountPath: '/mnt/data', readOnly: false,
    cacheMode: 'writes', writeBackSeconds: 3600, dirCacheSeconds: 60, allowOther: false,
    readyTimeoutMs: 15000,
    stateJson: JSON.stringify({ mountId: 'recover1234', remotePath: '/remote', mountPath: '/mnt/data', volumeId: 'local', readOnly: false }),
  };
  const sd = `${DEFAULT_GUEST_PATHS.stateRoot}/mounts/${spec.mountId}`;
  const cache = `${DEFAULT_GUEST_PATHS.cacheRoot}/${spec.mountId}`;
  await backend.mount(sb, spec, {}, { timeoutMs: 20000 });
  await shell('printf recover-this-pending-write > /mnt/data/pending');
  assert.equal((await backend.inspect(sb, spec.mountPath, { timeoutMs: 5000 })).stats.uploadsQueued, 1);
  await shell('test ! -e /remote/pending');
  // Hold the mount busy without keeping the pending file open: its contents
  // are already in the write-back cache and must survive a forced detach.
  docker(['exec', '-d', name, 'sh', '-c', 'cd /mnt/data && touch /holder-ready; while [ ! -e /holder-release ]; do sleep 0.1; done; cd /; touch /holder-done']);
  await shell('i=0; until [ -e /holder-ready ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || exit 1; done');
  const detachOptions = { mountPath: spec.mountPath, flushTimeoutMs: 5000, force: true, timeoutMs: 20000 };
  const forced = await backend.unmount(sb, detachOptions);
  assert.equal(forced.flushed, false);
  await shell(`test -f '${sd}/stopped' && test ! -e '${sd}/pid' && test -d '${cache}' && test ! -e /remote/pending`);
  await shell('touch /holder-release; i=0; until [ -e /holder-done ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || exit 1; done');
  const evidenceCommand = `sha256sum '${sd}/stopped' '${sd}/pid.start' '${sd}/pid.exe' '${sd}/mount.json' '${sd}/remote'`;
  const evidence = await shell(evidenceCommand);
  await shell('printf obstructing-file > /mnt/data/obstruction');
  await assert.rejects(backend.mount(sb, spec, {}, { timeoutMs: 20000 }), e => e.details?.guestError?.code === 'mountpoint-not-empty');
  assert.equal(await shell(evidenceCommand), evidence, 'rejected preflight must leave recovery evidence intact');
  assert.equal((await backend.unmount(sb, detachOptions)).flushed, false, 'force remains usable after rejected reattach');
  await shell(`test -d '${cache}' && test ! -e /remote/pending && rm /mnt/data/obstruction`);
  assert.equal((await backend.mount(sb, spec, {}, { timeoutMs: 20000 })).alreadyAttached, false);
  assert.equal(await shell('cat /mnt/data/pending'), 'recover-this-pending-write');
  assert.equal((await backend.inspect(sb, spec.mountPath, { timeoutMs: 5000 })).stats.uploadsQueued, 1);
  const drained = await backend.unmount(sb, { ...detachOptions, force: false, flushTimeoutMs: 15000, timeoutMs: 30000 });
  assert.equal(drained.flushed, true);
  assert.equal(await shell('cat /remote/pending'), 'recover-this-pending-write');
  await shell(`test ! -d '${cache}' && test ! -d '${sd}'`);
});

test('real guest: late writer is uploaded after unmount; lifecycle lock and PID guards', { skip: !dockerAvailable(), timeout: 180000 }, async t => {
  const name = `fsvol-rclone-${randomUUID().slice(0, 8)}`;
  docker(['run', '-d', '--name', name, '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor:unconfined', '--entrypoint', 'sh', 'rclone/rclone:1.75.1', '-c', 'sleep 300']);
  t.after(() => docker(['rm', '-f', name], { allowFailure: true }));
  const sb = new DockerSandbox(name);
  const backend = new RcloneBackend();
  await backend.ensureRuntime(sb, { timeoutMs: 120000 });
  const shell = async command => {
    const r = await sb.exec({ command, timeoutMs: 10000 });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  await shell('mkdir -p /remote /test-bin; command -v fusermount3 > /test-bin/real-fm');
  // This writer runs at the last possible instant before the actual unmount.
  // The old algorithm had already checked an empty queue at this point.
  await shell(`printf '%s\n' '#!/bin/sh' 'if [ "$1" = -u ] && [ -f /inject ]; then rm /inject; printf late-write > /mnt/data/late; fi' 'exec "$(cat /test-bin/real-fm)" "$@"' > /test-bin/fusermount3; chmod +x /test-bin/fusermount3`);
  const runtime = { id: sb.id, exec: input => sb.exec({ ...input, command: `export PATH=/test-bin:$PATH; ${input.command}` }) };
  const spec = {
    mountId: 'abcd1234', remotePath: '/remote', mountPath: '/mnt/data', readOnly: false,
    cacheMode: 'writes', writeBackSeconds: 3600, dirCacheSeconds: 60, allowOther: false,
    readyTimeoutMs: 15000,
    stateJson: JSON.stringify({ mountId: 'abcd1234', remotePath: '/remote', mountPath: '/mnt/data', volumeId: 'local', readOnly: false }),
  };
  const attached = await backend.mount(runtime, spec, {}, { timeoutMs: 20000 });
  assert.ok(attached.pid > 1);
  // This second call also proves the daemon did not inherit the lock FD.
  assert.equal((await backend.mount(runtime, spec, {}, { timeoutMs: 20000 })).alreadyAttached, true);
  await shell('touch /inject');
  const result = await backend.unmount(runtime, { mountPath: spec.mountPath, flushTimeoutMs: 15000, force: false, timeoutMs: 30000 });
  assert.equal(result.flushed, true);
  assert.equal(await shell('cat /remote/late'), 'late-write');
  await shell(`test ! -d '${DEFAULT_GUEST_PATHS.cacheRoot}/${spec.mountId}'`);

  // A separate guest process holding the path lock blocks all lifecycle entry
  // points, including another volume ID that would otherwise use another SD.
  docker(['exec', '-d', name, 'sh', '-c', `key=$(printf /mnt/data | sha256sum); key=\${key%% *}; exec 8>'${DEFAULT_GUEST_PATHS.stateRoot}/locks/'"$key".lock; flock 8; touch /lock-ready; while [ ! -f /lock-release ]; do sleep 0.1; done`]);
  await shell('i=0; until [ -f /lock-ready ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || exit 1; done');
  await assert.rejects(backend.mount(runtime, { ...spec, mountId: 'other' }, {}, { timeoutMs: 5000 }), e => e.details?.guestError?.code === 'lifecycle-busy');
  await assert.rejects(backend.inspect(runtime, spec.mountPath, { timeoutMs: 5000 }), e => e.details?.guestError?.code === 'lifecycle-busy');
  await assert.rejects(backend.unmount(runtime, { mountPath: spec.mountPath, flushTimeoutMs: 1000, force: true, timeoutMs: 5000 }), e => e.details?.guestError?.code === 'lifecycle-busy');
  await shell('touch /lock-release; sleep 0.3');

  await backend.mount(runtime, spec, {}, { timeoutMs: 20000 });
  const sd = `${DEFAULT_GUEST_PATHS.stateRoot}/mounts/${spec.mountId}`;
  // Keep a real unrelated process alive and point stale state at its PID.
  docker(['exec', '-d', name, 'sh', '-c', 'echo $$ > /unrelated; exec sleep 120']);
  await shell('i=0; until [ -s /unrelated ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || exit 1; done');
  await shell(`cp /unrelated '${sd}/pid'`);
  await assert.rejects(backend.unmount(runtime, { mountPath: spec.mountPath, flushTimeoutMs: 1000, force: true, timeoutMs: 15000 }));
  await shell(`kill -0 "$(cat /unrelated)"; test -d '${DEFAULT_GUEST_PATHS.cacheRoot}/${spec.mountId}'`);
});
