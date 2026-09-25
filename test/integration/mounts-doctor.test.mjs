// listMounts, detachAll and the preflight checks on real rclone FUSE mounts
// in Docker containers against MinIO. NOT Freestyle tests.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, dockerSandboxes } from '../../dist/index.js';
import { Stack, dockerAvailable, waitFor } from '../helpers/stack.mjs';

const statuses = (report) => Object.fromEntries(report.checks.map((check) => [check.name, check.status]));

if (!dockerAvailable()) {
  test('mount listing and doctor integration tests (skipped: Docker is not available or VOLUMES_SKIP_INTEGRATION=1)', { skip: true }, () => {});
} else {
  describe('listMounts, detachAll and checks on Docker + MinIO', () => {
    const stack = new Stack();
    let volumes;
    let sb;
    before(async () => {
      await stack.start();
      volumes = new FreestyleVolumes({ storage: stack.storage('md'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 1, dirCacheSeconds: 2 } });
      sb = stack.sandbox();
    });
    after(async () => {
      await stack.stop();
    });

    test('checkStorage passes against MinIO, including enforced conditional creates, and removes its probe', async () => {
      const report = await volumes.checkStorage();
      assert.equal(report.ok, true, JSON.stringify(report, null, 2));
      assert.deepEqual(statuses(report), { bucket: 'ok', list: 'ok', 'conditional-create': 'ok', read: 'ok', delete: 'ok' });
      assert.deepEqual(await stack.listKeys('md/_doctor/'), []);

      const wrong = new FreestyleVolumes({ storage: stack.storage('md', { secretAccessKey: 'wrong-secret-0123456789' }), sandboxes: dockerSandboxes() });
      const denied = await wrong.checkStorage();
      assert.equal(denied.ok, false);
      assert.match(denied.checks[0].detail, /^STORAGE_AUTH: /);
    });

    test('checkSandbox: a ready container passes, one without FUSE or with wrong credentials fails the right check', async () => {
      const ready = await volumes.checkSandbox({ sandboxId: sb });
      assert.equal(ready.ok, true, JSON.stringify(ready, null, 2));
      assert.deepEqual(Object.keys(statuses(ready)), ['arch', 'root', 'fuse-device', 'fusermount', 'flock', 'rclone', 'storage', 'cache-disk']);
      assert.equal(statuses(ready).storage, 'ok', 'rclone listed MinIO from inside the container');

      const noFuse = await volumes.checkSandbox({ sandboxId: stack.sandbox({ fuse: false }) });
      assert.equal(noFuse.ok, false);
      assert.equal(statuses(noFuse)['fuse-device'], 'fail');
      assert.match(noFuse.checks.find((check) => check.name === 'fuse-device').hint, /--device \/dev\/fuse/);

      const wrong = new FreestyleVolumes({ storage: stack.storage('md', { secretAccessKey: 'wrong-secret-0123456789' }), sandboxes: dockerSandboxes() });
      const denied = await wrong.checkSandbox({ sandboxId: sb });
      assert.equal(statuses(denied).storage, 'fail');
      assert.match(denied.checks.find((check) => check.name === 'storage').detail, /^rclone exited \d+: /);
      assert.equal(JSON.stringify(denied).includes('wrong-secret-0123456789'), false);
    });

    test('listMounts and detachAll drain every managed mount and leave an unmanaged rclone mount alone', async () => {
      const a = await volumes.create({ name: 'md-a' });
      await volumes.create({ name: 'md-b' });
      await volumes.attach({ sandboxId: sb, volumeId: 'md-a', mountPath: '/mnt/a' });
      await volumes.attach({ sandboxId: sb, volumeId: 'md-b', mountPath: '/mnt/b', readOnly: true, subpath: 'team' });
      assert.equal(stack.exec(sb, 'echo one > /mnt/a/one.txt').status, 0);
      stack.exec(sb, 'mkdir -p /tmp/src /mnt/foreign && rclone mount /tmp/src /mnt/foreign --daemon');
      await waitFor(() => stack.exec(sb, 'grep -q " /mnt/foreign fuse.rclone " /proc/mounts').status === 0, 20000, 'unmanaged mount');

      const listing = await volumes.listMounts({ sandboxId: sb });
      assert.deepEqual(listing.mounts.map((m) => [m.mountPath, m.status, m.volumeId, m.subpath, m.readOnly]), [
        ['/mnt/a', 'mounted', 'md-a', null, false],
        ['/mnt/b', 'mounted', 'md-b', 'team', true],
      ]);
      assert.ok(listing.mounts.every((m) => m.pid > 0 && m.startedAt));
      assert.deepEqual(listing.unmanaged, ['/mnt/foreign']);

      const result = await volumes.detachAll({ sandboxId: sb });
      assert.equal(result.flushed, true, JSON.stringify(result, null, 2));
      assert.deepEqual(result.results.map((r) => [r.mountPath, r.status, r.flushed]), [['/mnt/a', 'detached', true], ['/mnt/b', 'detached', true]]);
      assert.deepEqual(result.unmanaged, ['/mnt/foreign']);
      assert.equal(await stack.readObject(`${a.dataPrefix}/one.txt`), 'one\n');

      const after = await volumes.listMounts({ sandboxId: sb });
      assert.deepEqual(after.mounts, []);
      assert.deepEqual(after.unmanaged, ['/mnt/foreign'], 'the unmanaged mount is untouched');
      assert.deepEqual(await volumes.registry.listAttachments('md-a'), []);
      stack.exec(sb, 'fusermount3 -u /mnt/foreign || fusermount -u /mnt/foreign');
    });

    test('a crashed mount is listed as stale and keeps detachAll from reporting flushed', async () => {
      const crashBox = stack.sandbox();
      const slow = new FreestyleVolumes({ storage: stack.storage('md'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 120 } });
      const attached = await slow.attach({ sandboxId: crashBox, volumeId: 'md-a', mountPath: '/mnt/crash' });
      assert.equal(stack.exec(crashBox, 'echo pending > /mnt/crash/pending.txt').status, 0);
      stack.exec(crashBox, `kill -9 ${attached.pid}`);
      await waitFor(async () => (await slow.listMounts({ sandboxId: crashBox })).mounts[0]?.status === 'stale', 10000, 'stale listing');

      const blocked = await slow.detachAll({ sandboxId: crashBox });
      assert.equal(blocked.flushed, false);
      assert.equal(blocked.results[0].status, 'failed');
      assert.equal(blocked.results[0].error.code, 'MOUNT_STALE');
      assert.equal((await slow.listMounts({ sandboxId: crashBox })).mounts.length, 1, 'recovery state is retained');

      // Recover as documented: reattach resumes the pending upload, then drain everything.
      await slow.attach({ sandboxId: crashBox, volumeId: 'md-a', mountPath: '/mnt/crash' });
      const recovered = await slow.detachAll({ sandboxId: crashBox });
      assert.equal(recovered.flushed, true, JSON.stringify(recovered, null, 2));
      const volume = await slow.get('md-a');
      assert.equal(await stack.readObject(`${volume.dataPrefix}/pending.txt`), 'pending\n');
    });
  });
}
