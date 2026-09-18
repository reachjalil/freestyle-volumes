# Explicit Git operations on a volume

`VolumeGit` runs preinstalled Git inside a trusted sandbox against a healthy, managed volume mount. It is a narrow helper, not a Git hosting service, a GitHub REST client, or a general compatibility layer for arbitrary repositories. Keep active worktrees, dependencies and watcher-heavy work on **native VM disk**; use this helper only when the object-backed tradeoffs are acceptable. It does not operate on unmounted native checkouts or support Git linked worktrees.

## Imports and setup

`VolumeGit`, `volumeGit`, `VolumeGitError` and their public types are exported from both `freestyle-volumes` and `freestyle-volumes/git`. The factory and constructor accept the same `VolumeGitOptions`:

```ts
import { volumeGit, type GitLocation } from 'freestyle-volumes/git';

const git = volumeGit({ volumes, sandboxes });
const location: GitLocation = {
  sandboxId: vmId,
  mountPath: '/mnt/source',
  repoPath: 'repo',
  timeoutMs: 120_000,
};
```

Here `volumes` supplies `inspectMount` (normally a `FreestyleVolumes` instance), and `sandboxes` is the resolver for that same guest, such as `freestyleSandboxes(freestyle)` or `dockerSandboxes()`. Provision Git, HTTPS trust roots and required shell utilities in the guest beforehand: **volume bootstrap does not install Git**. The script uses `/usr/bin:/bin`. Allow guest network access to the Git remote as well as storage.

Every call checks mount health, responsiveness, sandbox and mount-path identity. Every operation except `status`, including `push`, requires a writable mount. `repoPath` defaults to `'.'` (mount root); otherwise it must be a clean relative path below the mount. Clone's parent must already exist and the destination must be absent or empty as required by Git. `timeoutMs` defaults to 120,000 and accepts integers 1,000–300,000; it bounds the Git exec, not a combined Git-and-detach transaction.

## API and explicit changes

| Method | Contract |
| :--- | :--- |
| `clone({ ...location, remote, token?, branch? })` | Clone without checkout, validate the repository, then check out HEAD and validate again. Omitted branch uses the remote default. Requires a resolvable commit; not an empty-repository initializer. |
| `status(location)` | Return `{ porcelain, clean }`. `porcelain` is Git porcelain v1 with NUL delimiters, including untracked files, without external diff or optional index writes. It is not line-delimited JSON. |
| `commit({ ...location, paths, message, identity })` | Stage only explicit literal paths, then commit with the supplied `{ name, email }`. Reject an already-staged index with `GIT_INDEX_NOT_EMPTY`; do not silently include prior staged work. |
| `pull({ ...location, remote, branch, token? })` | Require a clean worktree/index (including untracked files) and an attached HEAD; fetch the explicit remote branch and merge **fast-forward only** into the current branch. No automatic merge commit, rebase, stash or conflict resolution. |
| `push({ ...location, remote, branch, token? })` | Normal, non-force push of `HEAD:refs/heads/<branch>`, without following tags or recursing submodules. It pushes commits, not uncommitted files; unlike pull it does not require a clean worktree. |
| `sync({ ...location, remote, branch, token?, direction })` | `direction` must explicitly be `'pull'` or `'push'`; delegates to that one operation. Not a two-way sync and never a commit. |

Mutating calls return `GitResult`: `{ operation, head, durability: 'guest-local' }`. `sync` returns the delegated operation (`pull` or `push`). This is not a promise that S3 has all repository objects and refs.

`paths` must contain 1–256 literal paths relative to the repo. Explicit `'.'` stages all; pathspec expansion is disabled. Absolute paths, traversal, empty segments, `.git` components and option-like leading `-` paths are rejected. Message and identity are required, validated single-line strings; identity is command-scoped, not persisted as repository configuration. Branch arguments are branch names, not revision expressions or refspecs. Pull does not switch the current local branch to the supplied remote branch name; choose/check the intended checkout beforehand.

An explicit sequence, assuming an attached writable mount, application-enforced exclusive access, and a caller-defined `writeFiles` that changes `README.md`:

```ts
await git.clone({ ...location, remote: 'owner/name', branch: 'main', token });
await writeFiles();
const before = await git.status(location);
await git.commit({
  ...location,
  paths: ['README.md'],
  message: 'Update project overview',
  identity: { name: 'Example Author', email: 'author@example.com' },
});
await git.sync({ ...location, remote: 'owner/name', branch: 'main', token, direction: 'push' });
const detached = await volumes.detach({ sandboxId: location.sandboxId, mountPath: location.mountPath });
if (!detached.flushed) throw new Error('Repository durability in S3 is unproven.');
```

The caller defines `writeFiles` and deliberately selects commit paths; a dirty status elsewhere does not mean the selected paths changed. A no-change commit can fail. Unselected changes remain uncommitted, even after push. See [`examples/git.ts`](../examples/git.ts) for caller-supplied change and quiescence callbacks, and a separate ff-only pull example. No method creates commits automatically except the explicit `commit` call. There are no PR, issue, repository-creation or other GitHub REST operations.

## Remotes, authentication and sandbox trust

- Use a credential-free **HTTPS** Git URL or GitHub `owner/name` shorthand (expanded to `https://github.com/owner/name.git`). Clone accepts an optional branch; pull/push/sync require an explicit branch and remote every time. Stored remotes are not used for transfers. URL userinfo, query strings, fragments, SSH, local paths and arbitrary protocols are rejected; HTTPS redirects are disabled and TLS verification stays enabled.
- Clone can store the **credential-free** origin URL in `.git/config`. Tokens are never embedded in persistent URLs, config, command arguments or helper files. Do not interpret “no persistent credentials” as “no origin URL.”
- Pass `token` explicitly when needed. It travels as `FV_GIT_TOKEN` in `exec.env`; a temporary askpass script reads that environment value for the validated remote host, with username `x-access-token`. Inherited credential helpers/configuration are not an authentication fallback. Token-authenticated calls require root.
- The temporary directory and askpass helper are mode 0700, outside the mount under `/var/tmp` (or `/tmp` if needed). For credentialed calls they are root-only. Temporary HOME, isolated Git configuration and helper cleanup traps limit persistent state; a hard kill may leave helper/status files, but the token is not written into them.
- Trust the sandbox adapter, OS, Git binary and exclusive guest. Root or an equivalent guest observer can read process environments. **Never log `exec.env`**, dump environments, enable shell tracing, or snapshot a guest during a credentialed operation. Error output is deliberately suppressed/sanitized, but that is not protection against a malicious adapter or guest. Status and repository contents can themselves be sensitive.
- `allowInsecureLoopbackHttp: true` is development-only: it permits literal `localhost`, `127.0.0.1` or `[::1]` HTTP URLs **without tokens**. It is not permission to send credentials over HTTP or disable HTTPS verification.

## Deliberately restricted repository support

Repository checks reject layouts/configuration outside a small allowlist rather than trusting them. This means otherwise valid Git repositories may be refused; there is **no blanket Git compatibility claim**.

- Hooks are disabled by an empty `core.hooksPath` and empty clone template; custom hook configuration is rejected. Existing hook files are not executed (their mere presence is not necessarily a rejection).
- Configured filters (including Git LFS filters), credential helpers, config includes, fsmonitor commands, signing and other non-allowlisted configuration are rejected. Global/system configuration is isolated. Do not rely on custom filters or hooks running.
- Submodule gitlinks, nested repositories, linked worktrees/`.git` files, alternate object stores, grafts, and in-progress merge/cherry-pick/revert/rebase/sequencer state are rejected. Repository format must be 0 and non-bare.
- Filesystem symlinks, hardlinked files and special files are rejected, including unsafe repo/mount ancestry. Repositories containing such entries are not supported. Some checks happen **after** checkout or fast-forward changes; a rejection does not imply an untouched tree.

These checks reduce accidental execution of repository-supplied behavior; they do not make concurrent hostile writers or an untrusted operating system safe.

## Single writer, failures and durability

The application must stop **all** other writers (including direct bucket clients), prevent new writers/attachments and prevent detach/replacement during Git calls. Maintain that coordination through verified detach. Mount inspection is a point-in-time check, not a lock spanning Git execution. There is no distributed single-writer enforcement or ACID transaction across Git files, rclone cache and S3 objects. Git's local locks cannot coordinate separate mounted caches. Never share a writable `.git` tree across sandboxes.

A successful commit is **guest-local**: Git objects/index/refs may still be in the VFS cache. A successful push acknowledges a Git-remote operation, not S3 durability, and does not include uncommitted work. Close files, normally detach, and require `flushed: true` before discarding the guest/cache or treating the object-backed repository as persisted. Detach is not an atomic multi-object Git snapshot and does not upgrade crash semantics to ACID. Prefer native active worktrees with explicit Git pushes and separate artifact volumes.

`VolumeGitError` is separate from `VolumeError`. Codes are `GIT_VALIDATION`, `GIT_MOUNT`, `GIT_UNSAFE_REPOSITORY`, `GIT_INDEX_NOT_EMPTY`, `GIT_FAILED`, `GIT_TIMEOUT` and `GIT_EXEC`. Its `outcomeUnknown` flag can indicate partial or uncertain mutation; absence of that flag is not a universal rollback guarantee. Exec errors/timeouts can leave a partial clone, staged index, changed worktree/refs, unfinished guest process or remotely accepted push. Quiesce and inspect repository/process/remote state before retrying; do not automatically clean, re-commit, force-push or retry. No raw Git output is exposed in errors because it may contain credentials.

Implementation: [`src/git.ts`](../src/git.ts). Final main-run verification on **2026-09-18**: 112 unit tests passed (0 skipped), 26 integration tests passed (0 failed, 0 skipped), and SDK/example type checks passed. Git coverage includes unit tests, local smart HTTP and real-FUSE Git; it does **not** establish live authenticated GitHub success or blanket repository compatibility. The Freestyle live test was skipped for missing credentials, so no live Freestyle round trip or pause/resume is validated. See [verification evidence](evidence/v0.1.md).
