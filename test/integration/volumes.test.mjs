// Linux FUSE integration tests. They need Docker (containers get /dev/fuse) and
// pull quay.io/minio/minio and rclone/rclone. They run the real library end to
// end: real rclone mounts, real object storage, real process crashes.
// These are NOT Freestyle tests; see test/freestyle for those.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, dockerSandboxes, MountError, StorageError, FlushError, VolumeError } from '../../dist/index.js';
import { Stack, dockerAvailable, waitFor } from '../helpers/stack.mjs';

if (!dockerAvailable()) {
  test('integration tests (skipped: Docker is not available or VOLUMES_SKIP_INTEGRATION=1)', { skip: true }, () => {});
} else {
  describe('freestyle-volumes on Docker + MinIO', () => {
    const stack = new Stack();
    let volumes;
    let sb1;
    let sb2;
    let dataPrefix;
    const events = [];
    before(async () => {
      await stack.start();
      volumes = new FreestyleVolumes({ storage: stack.storage('it'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 1, dirCacheSeconds: 2 }, onEvent: (e) => events.push(e) });
      sb1 = stack.sandbox();
      sb2 = stack.sandbox();
    });
    after(async () => {
      await stack.stop();
    });

    test('create, attach, write, flush, detach, reattach to a fresh sandbox, verify after replacement', async () => {
      const volume = await volumes.create({ name: 'data', labels: { suite: 'integration' } });
      dataPrefix = volume.dataPrefix;
      assert.equal(dataPrefix, `it/v2/data/${volume.generation}`);
      const attached = await volumes.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/data' });
      assert.equal(attached.alreadyAttached, false);
      assert.ok(attached.pid > 0);
      const write = stack.exec(sb1, 'echo "hello from sb1" > /mnt/data/hello.txt && mkdir -p /mnt/data/dir /mnt/data/emptydir && printf "nested" > /mnt/data/dir/nested.txt && cat /mnt/data/hello.txt');
      assert.equal(write.status, 0, write.stderr);
      assert.equal(write.stdout.trim(), 'hello from sb1');
      const inspection = await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/data' });
      assert.equal(inspection.status, 'mounted');
      assert.equal(inspection.volumeId, 'data');
      assert.equal(inspection.readOnly, false);
      assert.equal(inspection.responsive, true);
      assert.ok(inspection.uploads, 'rc stats are readable');

      // Credentials must not be visible on the process command line inside the sandbox.
      const ps = stack.exec(sb1, 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "');
      assert.equal(ps.stdout.includes(stack.secretAccessKey), false, 'secret never on a command line');
      assert.equal(ps.stdout.includes(stack.accessKeyId), false, 'access key never on a command line');

      const detached = await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/data' });
      assert.equal(detached.status, 'detached');
      assert.equal(detached.flushed, true);
      assert.equal(detached.pendingUploads, 0);
      assert.equal(stack.exec(sb1, 'grep -c " /mnt/data " /proc/mounts').stdout.trim(), '0', 'unmounted');
      assert.equal(stack.exec(sb1, 'ps -o args | grep -c "[r]clone mount"').stdout.trim(), '0', 'process gone');
      const keys = await stack.listKeys(`${dataPrefix}/`);
      assert.deepEqual(keys, ['', 'dir/', 'dir/nested.txt', 'emptydir/', 'hello.txt'].map(key => `${dataPrefix}/${key}`));
      assert.equal(await stack.readObject(`${dataPrefix}/hello.txt`), 'hello from sb1\n');

      // Fresh sandbox sees the persisted data, replaces a file, detaches.
      const second = await volumes.attach({ sandboxId: sb2, volumeId: 'data', mountPath: '/mnt/data' });
      assert.equal(second.alreadyAttached, false);
      const read = stack.exec(sb2, 'cat /mnt/data/hello.txt /mnt/data/dir/nested.txt; ls /mnt/data');
      assert.equal(read.stdout, 'hello from sb1\nnesteddir\nemptydir\nhello.txt\n');
      assert.equal(stack.exec(sb2, 'echo "replaced by sb2" > /mnt/data/hello.txt').status, 0);
      const secondDetach = await volumes.detach({ sandboxId: sb2, mountPath: '/mnt/data' });
      assert.equal(secondDetach.flushed, true);
      assert.equal(await stack.readObject(`${dataPrefix}/hello.txt`), 'replaced by sb2\n');

      // The first sandbox reattaches and observes the replacement.
      await volumes.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/data' });
      assert.equal(stack.exec(sb1, 'cat /mnt/data/hello.txt').stdout, 'replaced by sb2\n');
      const again = await volumes.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/data' });
      assert.equal(again.alreadyAttached, true, 'attach is idempotent');
      await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/data' });
      const absent = await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/data' });
      assert.equal(absent.status, 'absent', 'detach is idempotent');
    });

    test('read-only attach rejects writes and detaches without flushing', async () => {
      await volumes.attach({ sandboxId: sb2, volumeId: 'data', mountPath: '/mnt/ro', readOnly: true });
      const write = stack.exec(sb2, 'echo x > /mnt/ro/should-fail.txt');
      assert.notEqual(write.status, 0);
      assert.match(write.stderr, /Read-only file system/);
      assert.equal(stack.exec(sb2, 'cat /mnt/ro/hello.txt').stdout, 'replaced by sb2\n');
      assert.equal((await volumes.inspectMount({ sandboxId: sb2, mountPath: '/mnt/ro' })).readOnly, true);
      await assert.rejects(volumes.attach({ sandboxId: sb2, volumeId: 'data', mountPath: '/mnt/ro', readOnly: false }), (e) => e.code === 'MOUNT_PATH_IN_USE');
      const detached = await volumes.detach({ sandboxId: sb2, mountPath: '/mnt/ro' });
      assert.equal(detached.flushed, true);
      assert.equal((await stack.listKeys(`${dataPrefix}/`)).includes(`${dataPrefix}/should-fail.txt`), false);
    });

    test('namespaces and subpaths are isolated', async () => {
      const tenantA = new FreestyleVolumes({ storage: stack.storage('tenant-a'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 1 } });
      const tenantB = new FreestyleVolumes({ storage: stack.storage('tenant-b'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 1 } });
      const { dataPrefix: prefixA } = await tenantA.create({ name: 'shared' });
      const { dataPrefix: prefixB } = await tenantB.create({ name: 'shared' });
      assert.deepEqual((await tenantA.list()).map((v) => v.id), ['shared']);
      assert.deepEqual((await tenantB.list()).map((v) => v.id), ['shared']);
      await tenantA.attach({ sandboxId: sb1, volumeId: 'shared', mountPath: '/mnt/a' });
      await tenantB.attach({ sandboxId: sb1, volumeId: 'shared', mountPath: '/mnt/b' });
      assert.equal(stack.exec(sb1, 'mkdir -p /mnt/a/users/alice /mnt/a/users/bob && echo A > /mnt/a/users/alice/file.txt && echo SECRET > /mnt/a/users/bob/secret.txt && echo B > /mnt/b/file.txt').status, 0);
      await tenantA.detach({ sandboxId: sb1, mountPath: '/mnt/a' });
      await tenantB.detach({ sandboxId: sb1, mountPath: '/mnt/b' });
      assert.deepEqual(await stack.listKeys(`${prefixB}/`), [`${prefixB}/`, `${prefixB}/file.txt`]);
      assert.ok((await stack.listKeys(`${prefixA}/`)).includes(`${prefixA}/users/bob/secret.txt`));

      // A subpath mount sees only its prefix; the parent of the mount root is the host directory, not the volume.
      await tenantA.attach({ sandboxId: sb2, volumeId: 'shared', mountPath: '/mnt/alice', subpath: 'users/alice' });
      const listing = stack.exec(sb2, 'ls -R /mnt/alice; cat /mnt/alice/../bob/secret.txt 2>&1; cat /mnt/alice/../../users/bob/secret.txt 2>&1; find /mnt/alice -name secret.txt | wc -l');
      assert.match(listing.stdout, /file\.txt/);
      assert.doesNotMatch(listing.stdout, /SECRET/);
      assert.equal(listing.stdout.trim().split('\n').pop(), '0');
      assert.equal(stack.exec(sb2, 'echo from-alice > /mnt/alice/new.txt').status, 0);
      await tenantA.detach({ sandboxId: sb2, mountPath: '/mnt/alice' });
      assert.equal(await stack.readObject(`${prefixA}/users/alice/new.txt`), 'from-alice\n');
      await tenantB.delete({ volumeId: 'shared', confirm: 'shared' });
      assert.ok((await stack.listKeys(`${prefixA}/`)).length > 0, 'deleting tenant-b/shared leaves tenant-a/shared alone');
    });

    test('invalid credentials and unavailable storage fail on the host before any mount', async () => {
      const badCreds = new FreestyleVolumes({ storage: stack.storage('it', { secretAccessKey: 'wrong-secret-value' }), sandboxes: dockerSandboxes() });
      const authError = await badCreds.create({ name: 'never' }).catch((e) => e);
      assert.ok(authError instanceof StorageError, String(authError));
      assert.equal(authError.code, 'STORAGE_AUTH');
      assert.equal(authError.message.includes('wrong-secret-value'), false);
      const attachError = await badCreds.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/never' }).catch((e) => e);
      assert.equal(attachError.code, 'STORAGE_AUTH');

      const unreachable = new FreestyleVolumes({ storage: stack.storage('it', { endpoint: 'http://127.0.0.1:9', requestTimeoutMs: 3000 }), sandboxes: dockerSandboxes() });
      const netError = await unreachable.list().catch((e) => e);
      assert.ok(netError instanceof StorageError, String(netError));
      assert.equal(netError.code, 'STORAGE_UNREACHABLE');
      assert.equal(stack.exec(sb1, 'ls /var/lib/freestyle-volumes/mounts 2>/dev/null | wc -l').stdout.trim(), '0', 'no mount state was created');
    });

    test('mount failure and timeout retain recovery state; explicit force stops the uploader safely', async () => {
      const wrongHost = new FreestyleVolumes({ storage: stack.storage('it', { sandboxEndpoint: 'http://no-such-host.invalid:9000' }), sandboxes: dockerSandboxes(), defaults: { readyTimeoutMs: 20000 } });
      const failure = await wrongHost.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/broken' }).catch((e) => e);
      assert.ok(failure instanceof MountError, String(failure));
      assert.ok(['MOUNT_FAILED', 'MOUNT_TIMEOUT'].includes(failure.code), failure.code);
      assert.ok(Array.isArray(failure.details.logTail));
      const broken = await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/broken' });
      assert.equal(broken.status, 'stale');
      assert.ok(broken.pid > 1, 'failed RC mount retains its identifiable uploader');
      assert.equal(stack.exec(sb1, `test -f /var/lib/freestyle-volumes/mounts/${failure.details.mountId}/mount.json && test -d /var/cache/freestyle-volumes/${failure.details.mountId}`).status, 0, 'recovery metadata and cache retained');
      assert.equal((await wrongHost.detach({ sandboxId: sb1, mountPath: '/mnt/broken', force: true })).flushed, false);
      assert.equal((await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/broken' })).pid, null);
      assert.equal(stack.exec(sb1, 'grep -c " /mnt/broken " /proc/mounts').stdout.trim(), '0');

      const blackhole = new FreestyleVolumes({ storage: stack.storage('it', { sandboxEndpoint: 'http://10.255.255.1:9000' }), sandboxes: dockerSandboxes(), defaults: { readyTimeoutMs: 6000 } });
      const started = Date.now();
      const timeout = await blackhole.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/blackhole' }).catch((e) => e);
      assert.ok(timeout instanceof MountError, String(timeout));
      assert.ok(['MOUNT_TIMEOUT', 'MOUNT_FAILED'].includes(timeout.code), timeout.code);
      assert.ok(Date.now() - started < 60000, 'bounded');
      assert.equal(stack.exec(sb1, `test -f /var/lib/freestyle-volumes/mounts/${timeout.details.mountId}/mount.json && test -d /var/cache/freestyle-volumes/${timeout.details.mountId}`).status, 0, 'timeout retains recovery metadata and cache');
      const forced = await blackhole.detach({ sandboxId: sb1, mountPath: '/mnt/blackhole', force: true, flushTimeoutMs: 1000 });
      assert.equal(forced.flushed, false);
      assert.equal(stack.exec(sb1, 'grep -c " /mnt/blackhole " /proc/mounts').stdout.trim(), '0');
      const retained = await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/blackhole' });
      assert.equal(retained.status, 'stale');
      assert.equal(retained.pid, null, 'forced detach stopped the uploader');
      assert.equal(stack.exec(sb1, `test -d /var/cache/freestyle-volumes/${timeout.details.mountId}`).status, 0, 'force must not discard uncertain cache');
    });

    test('a sandbox without /dev/fuse is rejected with FUSE_UNAVAILABLE', async () => {
      const noFuse = stack.sandbox({ fuse: false });
      const error = await volumes.attach({ sandboxId: noFuse, volumeId: 'data', mountPath: '/mnt/data' }).catch((e) => e);
      assert.ok(error instanceof MountError, String(error));
      assert.equal(error.code, 'FUSE_UNAVAILABLE');
    });

    test('interrupted writes: a crashed mount is stale, reattach resumes the upload, detach flushes it', async () => {
      const slow = new FreestyleVolumes({ storage: stack.storage('it'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 120 } });
      const attached = await slow.attach({ sandboxId: sb2, volumeId: 'data', mountPath: '/mnt/crash' });
      assert.equal(stack.exec(sb2, 'echo "written before crash" > /mnt/crash/crash.txt').status, 0);
      const before = await slow.inspectMount({ sandboxId: sb2, mountPath: '/mnt/crash' });
      assert.equal(before.uploads.queued, 1, 'the write is buffered, not yet durable');
      stack.exec(sb2, `kill -9 ${attached.pid}`);
      await waitFor(async () => (await slow.inspectMount({ sandboxId: sb2, mountPath: '/mnt/crash' })).status === 'stale', 10000, 'stale detection');
      assert.equal((await stack.listKeys(`${dataPrefix}/`)).includes(`${dataPrefix}/crash.txt`), false, 'not durable after a crash');
      const staleDetach = await slow.detach({ sandboxId: sb2, mountPath: '/mnt/crash' }).catch((e) => e);
      assert.ok(staleDetach instanceof MountError, String(staleDetach));
      assert.equal(staleDetach.code, 'MOUNT_STALE');
      const resumed = await slow.attach({ sandboxId: sb2, volumeId: 'data', mountPath: '/mnt/crash' });
      assert.equal(resumed.alreadyAttached, false);
      assert.equal(stack.exec(sb2, 'cat /mnt/crash/crash.txt').stdout, 'written before crash\n', 'the cached write is visible again');
      const detached = await slow.detach({ sandboxId: sb2, mountPath: '/mnt/crash' });
      assert.equal(detached.flushed, true);
      assert.equal(await stack.readObject(`${dataPrefix}/crash.txt`), 'written before crash\n');
    });

    test('busy mounts refuse a normal detach; force detaches without a durability claim', async () => {
      const attached = await volumes.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/busy' });
      stack.execDetached(sb1, 'exec 3>/mnt/busy/held-open.txt; sleep 20');
      await new Promise((r) => setTimeout(r, 1000));
      const busy = await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/busy' }).catch((e) => e);
      assert.ok(busy instanceof MountError, String(busy));
      assert.equal(busy.code, 'MOUNT_BUSY');
      assert.equal((await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/busy' })).status, 'mounted', 'still attached after refusal');
      const forced = await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/busy', force: true });
      assert.equal(forced.status, 'detached');
      assert.equal(forced.flushed, false);
      const retained = await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/busy' });
      assert.equal(retained.status, 'stale', 'uncertain detach retains recovery state');
      assert.equal(retained.pid, null, 'uploader stopped');
      assert.equal(stack.exec(sb1, 'grep -c " /mnt/busy " /proc/mounts').stdout.trim(), '0', 'mount removed');
      assert.equal(stack.exec(sb1, `test -f /var/lib/freestyle-volumes/mounts/${attached.mountId}/mount.json && test -d /var/cache/freestyle-volumes/${attached.mountId}`).status, 0, 'state and cache retained');
    });

    test('flush failures retain the unmounted uploader and cache; retry persists every byte', async () => {
      const slow = new FreestyleVolumes({ storage: stack.storage('it'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 120 } });
      const attached = await slow.attach({ sandboxId: sb1, volumeId: 'data', mountPath: '/mnt/flush' });
      assert.equal(stack.exec(sb1, 'awk \'BEGIN { for (i=0; i<200000; i++) printf "x" }\' > /mnt/flush/blob.bin').status, 0);
      stack.pauseStorage();
      try {
        const failure = await slow.detach({ sandboxId: sb1, mountPath: '/mnt/flush', flushTimeoutMs: 5000 }).catch((e) => e);
        assert.ok(failure instanceof FlushError || failure?.code === 'FLUSH_FAILED', String(failure));
        assert.match(failure.message, /state and cache were retained/);
        const inspection = await slow.inspectMount({ sandboxId: sb1, mountPath: '/mnt/flush' });
        assert.equal(inspection.status, 'stale');
        assert.equal(inspection.pid, attached.pid, 'same uploader remains alive for retry');
        assert.ok(inspection.uploads.queued + inspection.uploads.inProgress > 0, 'upload has not drained');
        assert.equal(stack.exec(sb1, 'grep -c " /mnt/flush " /proc/mounts').stdout.trim(), '0', 'writers are quiesced');
        assert.equal(stack.exec(sb1, `test -f /var/lib/freestyle-volumes/mounts/${attached.mountId}/mount.json && test -d /var/cache/freestyle-volumes/${attached.mountId}`).status, 0);
      } finally {
        stack.unpauseStorage();
      }
      const detached = await slow.detach({ sandboxId: sb1, mountPath: '/mnt/flush', flushTimeoutMs: 60000 });
      assert.equal(detached.flushed, true);
      assert.ok((await stack.listKeys(`${dataPrefix}/`)).includes(`${dataPrefix}/blob.bin`));
      assert.equal(await stack.readObject(`${dataPrefix}/blob.bin`), 'x'.repeat(200000), 'complete cached payload reaches storage');
      assert.equal((await slow.inspectMount({ sandboxId: sb1, mountPath: '/mnt/flush' })).status, 'absent');
      assert.equal(stack.exec(sb1, `test ! -d /var/cache/freestyle-volumes/${attached.mountId}`).status, 0, 'verified drain permits cache removal');
    });

    test('delete refuses while attachments are recorded, then destroys only this volume', async () => {
      const doomed = await volumes.create({ name: 'doomed' });
      await volumes.attach({ sandboxId: sb2, volumeId: 'doomed', mountPath: '/mnt/doomed' });
      assert.equal(stack.exec(sb2, 'echo bye > /mnt/doomed/bye.txt').status, 0);
      await assert.rejects(volumes.delete({ volumeId: 'doomed', confirm: 'doomed' }), (e) => e instanceof VolumeError && e.code === 'VOLUME_IN_USE');
      await volumes.detach({ sandboxId: sb2, mountPath: '/mnt/doomed' });
      const result = await volumes.delete({ volumeId: 'doomed', confirm: 'doomed' });
      assert.ok(result.deletedObjects >= 2);
      assert.deepEqual(await stack.listKeys(`${doomed.dataPrefix}/`), []);
      assert.ok((await stack.listKeys(`${dataPrefix}/`)).length > 0, 'other volumes untouched');
      assert.deepEqual((await volumes.list()).map((v) => v.id), ['data']);
    });
  });
}
