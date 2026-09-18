import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, dockerSandboxes } from '../../dist/index.js';
import { volumeGit } from '../../dist/git.js';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

test('real Git on MinIO FUSE: explicit commit, status, flushed detach and fresh-sandbox persistence', { skip: !dockerAvailable() }, async t => {
  const stack = new Stack();
  t.after(() => stack.stop());
  await stack.start();
  const sandboxes = dockerSandboxes();
  const volumes = new FreestyleVolumes({ storage: stack.storage('git'), sandboxes, defaults: { writeBackSeconds: 1, dirCacheSeconds: 1 } });
  const helper = volumeGit({ volumes, sandboxes });
  const first = stack.sandbox();
  const second = stack.sandbox();
  for (const sandbox of [first, second]) {
    const installed = stack.exec(sandbox, 'apk add --no-cache git');
    assert.equal(installed.status, 0, installed.stderr);
  }
  const volume = await volumes.create({ name: 'git-data' });
  const location = { sandboxId: first, mountPath: '/mnt/git-data', repoPath: 'repo' };
  await volumes.attach({ sandboxId: first, volumeId: volume.id, mountPath: location.mountPath });
  const setup = stack.exec(first, 'mkdir /mnt/git-data/repo && git -C /mnt/git-data/repo init -b main && printf "first\\n" > /mnt/git-data/repo/first.txt && printf "unstaged\\n" > /mnt/git-data/repo/other.txt');
  assert.equal(setup.status, 0, setup.stderr);
  const committed = await helper.commit({ ...location, paths: ['first.txt'], message: 'Persist on FUSE', identity: { name: 'FUSE Test', email: 'fuse@example.invalid' } });
  assert.equal(committed.durability, 'guest-local');
  assert.equal((await helper.status(location)).porcelain, '?? other.txt\0');
  const detach = await volumes.detach(location);
  assert.equal(detach.flushed, true);
  assert.equal(detach.pendingUploads, 0);
  assert.ok((await stack.listKeys(`${volume.dataPrefix}/`)).includes(`${volume.dataPrefix}/repo/.git/HEAD`));
  const fresh = { ...location, sandboxId: second };
  await volumes.attach({ ...fresh, volumeId: volume.id });
  assert.equal((await helper.status(fresh)).porcelain, '?? other.txt\0');
  const head = stack.exec(second, 'git -C /mnt/git-data/repo rev-parse HEAD && cat /mnt/git-data/repo/first.txt && git -C /mnt/git-data/repo fsck --full');
  assert.equal(head.status, 0, head.stderr);
  assert.equal(head.stdout.split('\n')[0], committed.head);
  assert.equal(head.stdout.split('\n')[1], 'first');
  await helper.commit({ ...fresh, paths: ['other.txt'], message: 'Second sandbox', identity: { name: 'FUSE Test', email: 'fuse@example.invalid' } });
  assert.equal((await helper.status(fresh)).clean, true);
  assert.equal((await volumes.detach(fresh)).flushed, true);
  await volumes.attach({ ...location, volumeId: volume.id, readOnly: true });
  assert.equal((await helper.status(location)).clean, true);
  await assert.rejects(helper.commit({ ...location, paths: ['.'], message: 'Forbidden', identity: { name: 'FUSE Test', email: 'fuse@example.invalid' } }), { code: 'GIT_MOUNT' });
  assert.equal((await volumes.detach(location)).flushed, true);
});
