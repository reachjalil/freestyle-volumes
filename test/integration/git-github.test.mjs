// Live, authenticated GitHub test for the Git helper, opt-in: clone over HTTPS
// with a token, commit on a volume mounted with real rclone FUSE (Docker +
// MinIO), push a new branch, check it through the GitHub API, pull, then delete
// the branch. Writes to the repository you name.
//
// Required: Docker, VOLUMES_TEST_GITHUB_REPO (owner/name) and VOLUMES_TEST_GITHUB_TOKEN
// (a fine-grained token with Contents read and write on that repository only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FreestyleVolumes, dockerSandboxes } from '../../dist/index.js';
import { volumeGit } from '../../dist/git.js';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

const repo = process.env.VOLUMES_TEST_GITHUB_REPO;
const token = process.env.VOLUMES_TEST_GITHUB_TOKEN;
const skip = !dockerAvailable() ? 'Docker is not available' : !repo || !token ? 'set VOLUMES_TEST_GITHUB_REPO and VOLUMES_TEST_GITHUB_TOKEN (writes a branch)' : false;

async function github(path, init = {}) {
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...init.headers },
  });
}

test('Git helper against live GitHub: token clone, commit on FUSE, push a branch, pull', { skip, timeout: 600_000 }, async (t) => {
  const stack = new Stack();
  const branch = `fsvol-live-${randomBytes(4).toString('hex')}`;
  t.after(async () => {
    await github(`/git/refs/heads/${branch}`, { method: 'DELETE' }).catch(() => undefined);
    await stack.stop();
  });
  await stack.start();
  const sandboxes = dockerSandboxes();
  const volumes = new FreestyleVolumes({ storage: stack.storage('gh'), sandboxes, defaults: { writeBackSeconds: 1, dirCacheSeconds: 1 } });
  const git = volumeGit({ volumes, sandboxes });
  const sandbox = stack.sandbox();
  const installed = stack.exec(sandbox, 'apk add --no-cache git ca-certificates');
  assert.equal(installed.status, 0, installed.stderr);
  await volumes.create({ name: 'github' });
  const location = { sandboxId: sandbox, mountPath: '/mnt/gh', repoPath: 'repo', timeoutMs: 280_000 };
  await volumes.attach({ sandboxId: sandbox, volumeId: 'github', mountPath: location.mountPath });

  const cloned = await git.clone({ ...location, remote: repo, token });
  assert.match(cloned.head, /^[0-9a-f]{40}$/);
  const file = `fsvol-live/${branch}.txt`;
  assert.equal(stack.exec(sandbox, `mkdir -p /mnt/gh/repo/fsvol-live && printf 'written on a volume\\n' > /mnt/gh/repo/${file}`).status, 0);
  const committed = await git.commit({ ...location, paths: [file], message: `Live test ${branch}`, identity: { name: 'freestyle-volumes live test', email: 'live-test@example.invalid' } });
  const pushed = await git.push({ ...location, remote: repo, branch, token });
  assert.equal(pushed.head, committed.head);

  const remote = await github(`/contents/${file}?ref=${branch}`);
  assert.equal(remote.status, 200, 'the pushed branch has the file');
  assert.equal(Buffer.from((await remote.json()).content, 'base64').toString(), 'written on a volume\n');
  const pulled = await git.pull({ ...location, remote: repo, branch, token });
  assert.equal(pulled.head, committed.head, 'an up-to-date pull is a fast-forward no-op');
  assert.equal((await git.status(location)).clean, true);
  assert.equal((await volumes.detach(location)).flushed, true);
});
