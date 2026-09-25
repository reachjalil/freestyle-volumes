// flush, prefix-scoped sandbox keys, restoreMounts, discardMount and exclusive
// leases on real rclone FUSE mounts in Docker containers against MinIO.
// NOT Freestyle tests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, dockerSandboxes, scopedPolicy } from '../../dist/index.js';
import { Stack, dockerAvailable, waitFor } from '../helpers/stack.mjs';

if (!dockerAvailable()) {
  test('operations integration tests (skipped: Docker is not available or VOLUMES_SKIP_INTEGRATION=1)', { skip: true }, () => {});
} else {
  describe('0.2.0 operations on Docker + MinIO', () => {
    const stack = new Stack();
    let volumes;
    let sb1;
    let sb2;

    /** A MinIO user whose only policy is scopedPolicy() for one key prefix. */
    function scopedUser(name, keyPrefix, readOnly) {
      const secret = `${name}-secret-0123456789`;
      stack.mc(['admin', 'user', 'add', 'local', name, secret]);
      stack.mc(['admin', 'policy', 'create', 'local', name, '/dev/stdin'], { input: JSON.stringify(scopedPolicy({ bucket: stack.bucket, keyPrefix, readOnly })) });
      stack.mc(['admin', 'policy', 'attach', 'local', name, '--user', name]);
      return { accessKeyId: name, secretAccessKey: secret };
    }

    /** Write one object with the given key from inside a sandbox using its own rclone; returns the exit status and output. */
    function rcloneWrite(sandbox, credentials, key) {
      const env = [
        'RCLONE_CONFIG=/dev/null', 'RCLONE_CONFIG_SC_TYPE=s3', 'RCLONE_CONFIG_SC_PROVIDER=Minio', `RCLONE_CONFIG_SC_ENDPOINT=${stack.sandboxEndpoint}`,
        `RCLONE_CONFIG_SC_ACCESS_KEY_ID=${credentials.accessKeyId}`, `RCLONE_CONFIG_SC_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
        'RCLONE_CONFIG_SC_REGION=us-east-1', 'RCLONE_CONFIG_SC_FORCE_PATH_STYLE=true', 'RCLONE_CONFIG_SC_NO_CHECK_BUCKET=true',
      ].join(' ');
      return stack.exec(sandbox, `echo intruder | env ${env} rclone rcat --retries 1 --low-level-retries 1 sc:${stack.bucket}/${key} 2>&1`);
    }

    before(async () => {
      await stack.start();
      volumes = new FreestyleVolumes({ storage: stack.storage('ops'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 300, dirCacheSeconds: 2 } });
      sb1 = stack.sandbox();
      sb2 = stack.sandbox();
    });
    after(async () => {
      await stack.stop();
    });

    test('flush uploads closed files while the mount stays up; listMounts shows the queue', async () => {
      const volume = await volumes.create({ name: 'flushed' });
      await volumes.attach({ sandboxId: sb1, volumeId: 'flushed', mountPath: '/mnt/flush' });
      assert.equal(stack.exec(sb1, 'echo checkpoint > /mnt/flush/step1.txt').status, 0);
      const listed = await volumes.listMounts({ sandboxId: sb1 });
      assert.deepEqual(listed.mounts.find((m) => m.mountPath === '/mnt/flush').uploads, { queued: 1, inProgress: 0, errored: 0 }, 'monitoring sees the pending upload');
      assert.equal((await stack.listKeys(`${volume.dataPrefix}/`)).length, 0, 'nothing uploaded yet with a 300 s write-back');

      const flushed = await volumes.flush({ sandboxId: sb1, mountPath: '/mnt/flush' });
      assert.deepEqual([flushed.flushed, flushed.mounted, flushed.pendingUploads, flushed.volumeId], [true, true, 0, 'flushed']);
      assert.equal(await stack.readObject(`${volume.dataPrefix}/step1.txt`), 'checkpoint\n');
      assert.equal((await volumes.inspectMount({ sandboxId: sb1, mountPath: '/mnt/flush' })).status, 'mounted', 'the mount stays up');
      assert.equal(stack.exec(sb1, 'echo more > /mnt/flush/step2.txt').status, 0);
      const all = await volumes.flushAll({ sandboxId: sb1 });
      assert.equal(all.flushed, true, JSON.stringify(all));
      assert.equal(await stack.readObject(`${volume.dataPrefix}/step2.txt`), 'more\n');
      assert.equal((await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/flush' })).flushed, true);
      await assert.rejects(volumes.flush({ sandboxId: sb1, mountPath: '/mnt/flush' }), { code: 'MOUNT_NOT_FOUND' });
    });

    test('prefix-scoped sandbox keys mount their volume and cannot reach any other', async () => {
      const scoped = await volumes.create({ name: 'scoped' });
      const other = await volumes.create({ name: 'other' });
      const readWrite = scopedUser('scopedrw', scoped.dataPrefix, false);
      const readOnly = scopedUser('scopedro', scoped.dataPrefix, true);
      const requests = [];
      const scopedVolumes = new FreestyleVolumes({
        storage: stack.storage('ops'),
        sandboxes: dockerSandboxes(),
        defaults: { writeBackSeconds: 1, dirCacheSeconds: 2 },
        sandboxCredentials: (request) => {
          requests.push(request);
          return request.readOnly ? readOnly : readWrite;
        },
      });
      await scopedVolumes.attach({ sandboxId: sb2, volumeId: 'scoped', mountPath: '/mnt/scoped' });
      assert.equal(stack.exec(sb2, 'mkdir -p /mnt/scoped/dir && echo inside > /mnt/scoped/dir/ok.txt').status, 0);
      assert.equal((await scopedVolumes.detach({ sandboxId: sb2, mountPath: '/mnt/scoped' })).flushed, true);
      assert.equal(await stack.readObject(`${scoped.dataPrefix}/dir/ok.txt`), 'inside\n');
      assert.deepEqual(requests.map((r) => [r.purpose, r.keyPrefix, r.readOnly]), [['mount', scoped.dataPrefix, false]]);

      const escape = rcloneWrite(sb2, readWrite, `${other.dataPrefix}/intrude.txt`);
      assert.notEqual(escape.status, 0, 'the scoped key cannot write to another volume');
      assert.match(escape.stdout, /AccessDenied|Access Denied|403/);
      assert.equal(rcloneWrite(sb2, readWrite, `${scoped.dataPrefix}/allowed.txt`).status, 0, 'the same key writes inside its own prefix');
      assert.deepEqual(await stack.listKeys(`${other.dataPrefix}/`), []);

      await scopedVolumes.attach({ sandboxId: sb2, volumeId: 'scoped', mountPath: '/mnt/scoped-ro', readOnly: true });
      assert.equal(stack.exec(sb2, 'cat /mnt/scoped-ro/dir/ok.txt').stdout, 'inside\n', 'a read-only key reads the volume');
      assert.notEqual(rcloneWrite(sb2, readOnly, `${scoped.dataPrefix}/nope.txt`).status, 0, 'and cannot write, even outside the mount');
      assert.equal((await scopedVolumes.detach({ sandboxId: sb2, mountPath: '/mnt/scoped-ro' })).flushed, true);
    });

    test('restoreMounts brings back a crashed mount and one lost to a restart, with their options and pending uploads', async () => {
      const volume = await volumes.create({ name: 'restore' });
      const crashed = await volumes.attach({ sandboxId: sb1, volumeId: 'restore', mountPath: '/mnt/crashed', subpath: 'a' });
      const restarted = await volumes.attach({ sandboxId: sb1, volumeId: 'restore', mountPath: '/mnt/restarted', subpath: 'b', uid: 1000, gid: 1000 });
      assert.equal(stack.exec(sb1, 'echo before-crash > /mnt/crashed/a.txt && echo before-restart > /mnt/restarted/b.txt').status, 0);
      stack.exec(sb1, `kill -9 ${crashed.pid}`);
      // A VM restart loses both the process and the mount; lazy unmount stands in for the reboot.
      stack.exec(sb1, `kill -9 ${restarted.pid}; fusermount3 -uz /mnt/restarted 2>/dev/null || umount -l /mnt/restarted`);
      await waitFor(async () => (await volumes.listMounts({ sandboxId: sb1 })).mounts.filter((m) => m.volumeId === 'restore').every((m) => m.status === 'stale'), 10000, 'both mounts stale');
      assert.deepEqual(await stack.listKeys(`${volume.dataPrefix}/`), [], 'neither write reached the bucket');

      const result = await volumes.restoreMounts({ sandboxId: sb1 });
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.restored.map((r) => r.mountPath).sort(), ['/mnt/crashed', '/mnt/restarted']);
      assert.equal(stack.exec(sb1, 'cat /mnt/crashed/a.txt /mnt/restarted/b.txt').stdout, 'before-crash\nbefore-restart\n', 'the cached writes are visible again');
      assert.equal(stack.exec(sb1, 'stat -c %u /mnt/restarted/b.txt').stdout.trim(), '1000', 'saved mount options are reapplied');
      for (const mountPath of ['/mnt/crashed', '/mnt/restarted']) {
        assert.equal((await volumes.detach({ sandboxId: sb1, mountPath })).flushed, true, mountPath);
      }
      assert.equal(await stack.readObject(`${volume.dataPrefix}/a/a.txt`), 'before-crash\n');
      assert.equal(await stack.readObject(`${volume.dataPrefix}/b/b.txt`), 'before-restart\n');
    });

    test('discardMount deletes what a forced detach kept, so another volume can use the path', async () => {
      const kept = await volumes.create({ name: 'kept' });
      await volumes.create({ name: 'next' });
      const attached = await volumes.attach({ sandboxId: sb2, volumeId: 'kept', mountPath: '/mnt/reuse' });
      assert.equal(stack.exec(sb2, 'echo never-uploaded > /mnt/reuse/lost.txt').status, 0);
      stack.exec(sb2, `kill -9 ${attached.pid}`);
      await waitFor(async () => (await volumes.inspectMount({ sandboxId: sb2, mountPath: '/mnt/reuse' })).status === 'stale', 10000, 'stale');
      const forced = await volumes.detach({ sandboxId: sb2, mountPath: '/mnt/reuse', force: true });
      assert.equal(forced.flushed, false);
      await assert.rejects(volumes.attach({ sandboxId: sb2, volumeId: 'next', mountPath: '/mnt/reuse' }), (error) => error.code === 'MOUNT_PATH_IN_USE' && /stale-state/.test(error.message));

      await assert.rejects(volumes.discardMount({ sandboxId: sb2, mountPath: '/mnt/reuse', confirm: '/mnt/other' }), { code: 'CONFIRMATION_REQUIRED' });
      const discarded = await volumes.discardMount({ sandboxId: sb2, mountPath: '/mnt/reuse', confirm: '/mnt/reuse' });
      assert.equal(discarded.status, 'discarded');
      assert.equal(discarded.volumeId, 'kept');
      assert.ok(discarded.discardedCacheBytes > 0);
      assert.deepEqual(await volumes.registry.listAttachments('kept'), []);
      await volumes.attach({ sandboxId: sb2, volumeId: 'next', mountPath: '/mnt/reuse' });
      assert.equal((await volumes.detach({ sandboxId: sb2, mountPath: '/mnt/reuse' })).flushed, true);
      assert.deepEqual(await stack.listKeys(`${kept.dataPrefix}/`), [], 'the discarded write is gone for good');
    });

    test('an exclusive writer blocks other writers in other containers until a flushed detach', async () => {
      await volumes.create({ name: 'exclusive' });
      await volumes.attach({ sandboxId: sb1, volumeId: 'exclusive', mountPath: '/mnt/excl', exclusive: true });
      await assert.rejects(volumes.attach({ sandboxId: sb2, volumeId: 'exclusive', mountPath: '/mnt/excl' }), { code: 'VOLUME_IN_USE' });
      await assert.rejects(volumes.attach({ sandboxId: sb2, volumeId: 'exclusive', mountPath: '/mnt/excl', exclusive: true }), { code: 'VOLUME_IN_USE' });
      await volumes.attach({ sandboxId: sb2, volumeId: 'exclusive', mountPath: '/mnt/excl-ro', readOnly: true });
      const listing = await volumes.listMounts({ sandboxId: sb1 });
      assert.equal(listing.mounts.find((m) => m.mountPath === '/mnt/excl').exclusive, true);
      assert.equal((await volumes.detach({ sandboxId: sb1, mountPath: '/mnt/excl' })).flushed, true);
      assert.equal(await volumes.getLease('exclusive'), null);
      await volumes.attach({ sandboxId: sb2, volumeId: 'exclusive', mountPath: '/mnt/excl' });
      assert.equal((await volumes.detachAll({ sandboxId: sb2 })).flushed, true);
    });
  });
}
