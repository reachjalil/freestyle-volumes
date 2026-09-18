import type { FreestyleVolumes } from '../src/volumes.js';
import type { SandboxResolver } from '../src/sandbox.js';
import { volumeGit, type GitLocation } from '../src/git.js';

/**
 * Not a distributed lock or an ACID S3 transaction. The caller must stop every
 * other writer and prevent new writers/attachments until detach has flushed.
 * Provision Git in the trusted guest first. Only HTTPS authentication is supported;
 * tokens travel through exec.env, never URLs, Git config or command arguments.
 * Root-only askpass state is temporary and outside the mount. Do not log exec.env.
 * On failure/timeout, quiesce and inspect partial state rather than retrying blindly.
 * Consumers can import volumeGit from 'freestyle-volumes' or 'freestyle-volumes/git'.
 */
export async function cloneCommitAndPush(
  volumes: FreestyleVolumes,
  sandboxes: SandboxResolver,
  location: GitLocation,
  remote: string,
  branch: string,
  token: string | undefined,
  change: {
    paths: string[];
    message: string;
    identity: { name: string; email: string };
    writeFiles: () => Promise<void>;
  },
  quiesceOtherWriters: () => Promise<void>,
) {
  await quiesceOtherWriters();
  const git = volumeGit({ volumes, sandboxes });
  await git.clone({ ...location, remote, branch, token });
  await change.writeFiles();
  const commit = await git.commit({ ...location, paths: change.paths, message: change.message, identity: change.identity });
  await git.sync({ ...location, remote, branch, token, direction: 'push' });
  const status = await git.status(location);
  const detached = await volumes.detach(location);
  if (!detached.flushed) throw new Error('Git succeeded locally, but volume durability is unproven.');
  return { commit, status, detached };
}

/** Pull is fast-forward only, requires a clean attached repository, and never commits. */
export async function pullExistingRepository(
  volumes: FreestyleVolumes,
  sandboxes: SandboxResolver,
  location: GitLocation,
  remote: string,
  branch: string,
  token?: string,
) {
  return volumeGit({ volumes, sandboxes }).sync({ ...location, remote, branch, token, direction: 'pull' });
}
