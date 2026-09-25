import type { SandboxResolver } from './sandbox.js';
import type { FreestyleVolumes } from './volumes.js';
import { assertMountPath, assertSandboxId, shellQuote } from './validate.js';

/**
 * Git on S3 FUSE is NOT ACID or a distributed single-writer system. Callers must
 * quiesce all other writers and prevent detach/replacement throughout each call.
 * Success is guest-local, not durable: separately detach and verify flushed.
 * Requires a trusted sandbox adapter, OS/Git installation and exclusive guest.
 * HTTPS only; no SSH, inherited credentials, submodules, worktrees or filters.
 * Filesystem symlinks/hardlinks and in-progress merge/rebase state are rejected.
 * Unknown repository configuration is rejected rather than trusted. Errors and
 * timeouts can leave partial work/index changes; inspect before retrying. A hard
 * kill may prevent the temporary helper cleanup trap from running (no token is
 * written to disk). The adapter must never log exec.env.
 */
export interface VolumeGitOptions {
  volumes: Pick<FreestyleVolumes, 'inspectMount'>;
  sandboxes: SandboxResolver;
  /** Development only: HTTP to literal localhost/127.0.0.1/[::1], without tokens. */
  allowInsecureLoopbackHttp?: boolean;
}

export interface GitLocation {
  sandboxId: string;
  mountPath: string;
  /** Clean relative directory, default mount root. Clone's parent must exist. */
  repoPath?: string;
  timeoutMs?: number;
}

export interface GitRemoteOptions extends GitLocation {
  /** HTTPS URL or GitHub owner/name. Required each time; stored remotes are not used. */
  remote: string;
  token?: string;
  /** Branch name, not a revision expression or refspec. */
  branch: string;
}

export interface GitCloneOptions extends GitLocation {
  remote: string;
  token?: string;
  branch?: string;
}

export interface GitCommitOptions extends GitLocation {
  /** Literal paths only. Explicit '.' stages all; existing staged changes are rejected. */
  paths: string[];
  message: string;
  identity: { name: string; email: string };
}

export interface GitResult {
  operation: 'clone' | 'commit' | 'pull' | 'push';
  head: string;
  durability: 'guest-local';
}

export interface GitStatus {
  /** Git porcelain v1, NUL-delimited, without external diff or optional index writes. */
  porcelain: string;
  clean: boolean;
}

export class VolumeGitError extends Error {
  constructor(
    readonly code: 'GIT_VALIDATION' | 'GIT_MOUNT' | 'GIT_UNSAFE_REPOSITORY' | 'GIT_INDEX_NOT_EMPTY' | 'GIT_FAILED' | 'GIT_TIMEOUT' | 'GIT_EXEC',
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'VolumeGitError';
  }
}

const invalid = (): never => { throw new VolumeGitError('GIT_VALIDATION', 'Invalid Git options; use clean relative paths, a credential-free HTTPS remote and explicit branch/identity.'); };

function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}

function relative(value: unknown): string {
  const path = text(value, 512);
  if (path === '.') return path;
  if (path.startsWith('-') || path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..' || /^\.git(?:\.|$)/i.test(part))) return invalid();
  return path;
}

function branchName(value: unknown): string {
  const branch = text(value, 200);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || branch === 'HEAD' || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || branch.includes('..')) return invalid();
  return branch;
}

function remoteUrl(value: unknown, loopback: boolean, token?: string): string {
  let remote = text(value, 2048);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(remote)) remote = `https://github.com/${remote.replace(/\.git$/, '')}.git`;
  if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9_./~-]+$/.test(remote) || remote.split('/').some(part => part === '..' || part === '.')) return invalid();
  let url: URL;
  try { url = new URL(remote); } catch { return invalid(); }
  const insecure = url.protocol === 'http:' && loopback && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && token === undefined;
  if ((url.protocol !== 'https:' && !insecure) || url.username || url.password || url.search || url.hash || url.pathname.split('/').some(part => part === '..' || part === '.')) return invalid();
  return url.href;
}

export class VolumeGit {
  constructor(private readonly options: VolumeGitOptions) {
    if (!options?.volumes?.inspectMount || !options?.sandboxes?.get) invalid();
  }

  async clone(options: GitCloneOptions): Promise<GitResult> {
    const token = options.token === undefined ? undefined : text(options.token, 8192);
    const remote = remoteUrl(options.remote, this.options.allowInsecureLoopbackHttp === true, token);
    const branch = options.branch === undefined ? undefined : branchName(options.branch);
    const body = `${branch ? `safe_git check-ref-format --branch ${shellQuote(branch)} >/dev/null\n` : ''}
safe_git clone --no-checkout --template="$TMP/empty" ${branch ? `--branch ${shellQuote(branch)}` : ''} -- ${shellQuote(remote)} "$REPO" >/dev/null 2>&1
check_repository
safe_git -C "$REPO" reset --hard HEAD >/dev/null 2>&1
check_repository
safe_git -C "$REPO" rev-parse --verify HEAD`;
    return this.result('clone', await this.run(options, 'clone', body, token, new URL(remote).host));
  }

  async status(options: GitLocation): Promise<GitStatus> {
    const porcelain = await this.run(options, 'status', 'safe_git -C "$REPO" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all');
    return { porcelain, clean: porcelain.length === 0 };
  }

  async commit(options: GitCommitOptions): Promise<GitResult> {
    if (!Array.isArray(options.paths) || options.paths.length === 0 || options.paths.length > 256) invalid();
    const paths = options.paths.map(relative);
    const message = text(options.message, 16384);
    const name = text(options.identity?.name, 200);
    const email = text(options.identity?.email, 320);
    if (/[<>]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) invalid();
    const body = `
if ! safe_git -C "$REPO" diff --cached --quiet --no-ext-diff --ignore-submodules=none --; then exit 82; fi
safe_git -C "$REPO" add -- ${paths.map(shellQuote).join(' ')} >/dev/null 2>&1
safe_git -C "$REPO" -c ${shellQuote(`user.name=${name}`)} -c ${shellQuote(`user.email=${email}`)} commit --no-gpg-sign -m ${shellQuote(message)} >/dev/null 2>&1
safe_git -C "$REPO" rev-parse --verify HEAD`;
    return this.result('commit', await this.run(options, 'commit', body));
  }

  async pull(options: GitRemoteOptions): Promise<GitResult> {
    return this.transfer('pull', options);
  }

  async push(options: GitRemoteOptions): Promise<GitResult> {
    return this.transfer('push', options);
  }

  async sync(options: GitRemoteOptions & { direction: 'pull' | 'push' }): Promise<GitResult> {
    if (options.direction !== 'pull' && options.direction !== 'push') invalid();
    return this.transfer(options.direction, options);
  }

  private async transfer(operation: 'pull' | 'push', options: GitRemoteOptions): Promise<GitResult> {
    const token = options.token === undefined ? undefined : text(options.token, 8192);
    const remote = remoteUrl(options.remote, this.options.allowInsecureLoopbackHttp === true, token);
    const branch = branchName(options.branch);
    const body = `safe_git check-ref-format --branch ${shellQuote(branch)} >/dev/null
${operation === 'pull' ? `
safe_git -C "$REPO" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all > "$TMP/status"
[ ! -s "$TMP/status" ] || exit 83
safe_git -C "$REPO" symbolic-ref -q HEAD >/dev/null
safe_git -C "$REPO" fetch --no-tags --no-recurse-submodules -- ${shellQuote(remote)} ${shellQuote(`refs/heads/${branch}`)} >/dev/null 2>&1
safe_git -C "$REPO" merge --ff-only --no-edit --no-stat FETCH_HEAD >/dev/null 2>&1
check_repository` : `safe_git -C "$REPO" push --no-verify --no-follow-tags --recurse-submodules=no -- ${shellQuote(remote)} ${shellQuote(`HEAD:refs/heads/${branch}`)} >/dev/null 2>&1`}
safe_git -C "$REPO" rev-parse --verify HEAD`;
    return this.result(operation, await this.run(options, operation, body, token, new URL(remote).host));
  }

  private result(operation: GitResult['operation'], stdout: string): GitResult {
    const head = stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new VolumeGitError('GIT_FAILED', 'Git returned an invalid result; inspect before retrying.', true);
    return { operation, head, durability: 'guest-local' };
  }

  private async run(location: GitLocation, operation: GitResult['operation'] | 'status', body: string, token?: string, authHost = ''): Promise<string> {
    let sandboxId: string;
    let mountPath: string;
    try {
      sandboxId = assertSandboxId(location.sandboxId);
      mountPath = assertMountPath(location.mountPath);
    } catch { return invalid(); }
    const repoPath = relative(location.repoPath ?? '.');
    const timeoutMs = location.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid();
    const write = operation !== 'status';
    let inspection;
    try { inspection = await this.options.volumes.inspectMount({ sandboxId, mountPath }); }
    catch { throw new VolumeGitError('GIT_MOUNT', 'Could not verify the volume mount.'); }
    if (inspection.status !== 'mounted' || !inspection.responsive || inspection.mountPath !== mountPath || inspection.sandboxId !== sandboxId || (write && inspection.readOnly !== false)) {
      throw new VolumeGitError('GIT_MOUNT', 'Git requires a healthy managed mount, writable for mutations.');
    }
    const repo = repoPath === '.' ? mountPath : `${mountPath}/${repoPath}`;
    let result;
    try {
      const sandbox = await this.options.sandboxes.get(sandboxId);
      result = await sandbox.exec({ command: guestScript(mountPath, repo, operation === 'clone', body, this.options.allowInsecureLoopbackHttp === true, authHost), env: { FV_GIT_TOKEN: token ?? '' }, timeoutMs });
    } catch { throw new VolumeGitError('GIT_EXEC', 'Git execution could not be confirmed; inspect before retrying.', write); }
    if (result.exitCode === null) throw new VolumeGitError('GIT_TIMEOUT', 'Git timed out; execution and cleanup may be incomplete. Quiesce the guest and inspect before retrying.', write);
    if (result.exitCode === 80) throw new VolumeGitError('GIT_UNSAFE_REPOSITORY', 'Repository layout or configuration is outside the supported trust boundary.', write);
    if (result.exitCode === 82) throw new VolumeGitError('GIT_INDEX_NOT_EMPTY', 'Existing staged changes must be resolved before committing explicit paths.');
    if (result.exitCode !== 0) throw new VolumeGitError('GIT_FAILED', 'Git failed; inspect the repository before retrying. No output is exposed because it may contain credentials.', write);
    return token ? result.stdout.split(token).join('[REDACTED]') : result.stdout;
  }
}

export function volumeGit(options: VolumeGitOptions): VolumeGit {
  return new VolumeGit(options);
}

function guestScript(mount: string, repo: string, clone: boolean, body: string, loopback: boolean, authHost: string): string {
  return `set +x
set +v
set -eu
PATH=/usr/bin:/bin
export PATH
for key in $(env | cut -d= -f1); do
  case "$key" in FV_GIT_TOKEN) ;; *) unset "$key" 2>/dev/null || : ;; esac
done
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
MOUNT=${shellQuote(mount)}
REPO=${shellQuote(repo)}
[ "$(cd -P "$MOUNT" && pwd -P)" = "$MOUNT" ] || exit 80
[ ! -L "$REPO" ] || exit 80
if [ -e "$REPO" ]; then
  [ -d "$REPO" ] && [ "$(cd -P "$REPO" && pwd -P)" = "$REPO" ] || exit 80
else
  parent=$(dirname "$REPO")
  [ "$(cd -P "$parent" && pwd -P)" = "$parent" ] || exit 80
fi
cd /
BASE=$(cd -P /var/tmp && pwd -P)
case "$BASE/" in "$MOUNT/"*) BASE=$(cd -P /tmp && pwd -P) ;; esac
case "$BASE/" in "$MOUNT/"*) exit 80 ;; esac
TMP=$(mktemp -d "$BASE/fsvol-git.XXXXXXXX")
trap 'rm -rf "$TMP"' EXIT
trap 'exit 124' HUP INT TERM
chmod 700 "$TMP"
HOME="$TMP"
XDG_CONFIG_HOME="$TMP"
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_GLOBAL=/dev/null
GIT_TERMINAL_PROMPT=0
GIT_OPTIONAL_LOCKS=0
GIT_LITERAL_PATHSPECS=1
GIT_NO_REPLACE_OBJECTS=1
GIT_ATTR_NOSYSTEM=1
GIT_ALLOW_PROTOCOL=${loopback ? 'https:http' : 'https'}
GIT_ASKPASS="$TMP/askpass"
FV_GIT_AUTH_HOST=${shellQuote(authHost)}
export FV_GIT_AUTH_HOST
export HOME XDG_CONFIG_HOME GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM GIT_CONFIG_GLOBAL GIT_TERMINAL_PROMPT GIT_OPTIONAL_LOCKS GIT_LITERAL_PATHSPECS GIT_NO_REPLACE_OBJECTS GIT_ATTR_NOSYSTEM GIT_ALLOW_PROTOCOL GIT_ASKPASS
umask 077
mkdir "$TMP/empty"
if [ -n "$FV_GIT_TOKEN" ]; then [ "$(id -u)" = 0 ] || exit 80; fi
cat > "$GIT_ASKPASS" <<'ASKPASS'
#!/bin/sh
case "$1" in
  "Username for 'https://$FV_GIT_AUTH_HOST': ") printf '%s\\n' x-access-token ;;
  "Password for 'https://x-access-token@$FV_GIT_AUTH_HOST': ") [ -n "$FV_GIT_TOKEN" ] && printf '%s\\n' "$FV_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 "$GIT_ASKPASS"
safe_git() {
  command git -c core.hooksPath="$TMP/empty" -c credential.helper= -c credential.username=x-access-token -c credential.useHttpPath=false \\
    -c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null \\
    -c core.bare=false -c core.logAllRefUpdates=true -c core.quotePath=true \\
    -c commit.gpgSign=false -c tag.gpgSign=false -c gc.auto=0 -c maintenance.auto=false \\
    -c submodule.recurse=false -c fetch.recurseSubmodules=false -c protocol.allow=never \\
    -c protocol.https.allow=always ${loopback ? '-c protocol.http.allow=always' : ''} \\
    -c http.followRedirects=false -c http.sslVerify=true -c http.proxy= \\
    -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 -c safe.directory="$REPO" "$@"
}
check_repository() {
  [ -d "$REPO/.git" ] && [ ! -L "$REPO/.git" ] || exit 80
  [ -f "$REPO/.git/config" ] || exit 80
  # One walk of the tree (each directory is a listing request on the object
  # store): anything but a plain file or directory, hard-linked files, and any
  # .git entry other than the repository's own.
  find "$REPO" \\( \\( ! -type d ! -type f \\) -o \\( -type f -links +1 \\) -o \\( -iname .git ! -path "$REPO/.git" \\) \\) -print > "$TMP/unsafe" || exit 80
  [ ! -s "$TMP/unsafe" ] || exit 80
  for forbidden in commondir objects/info/alternates objects/info/http-alternates info/grafts MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
    [ ! -e "$REPO/.git/$forbidden" ] || exit 80
  done
  safe_git config --file "$REPO/.git/config" --no-includes --name-only --list > "$TMP/keys" || exit 80
  while IFS= read -r key; do
    case "$key" in
      core.repositoryformatversion|core.filemode|core.symlinks|core.bare|core.logallrefupdates|core.ignorecase|core.precomposeunicode|remote.origin.url|remote.origin.fetch|branch.*.remote|branch.*.merge) ;;
      *) exit 80 ;;
    esac
  done < "$TMP/keys"
  safe_git config --file "$REPO/.git/config" --no-includes --get-all remote.origin.url > "$TMP/urls" || [ "$?" = 1 ] || exit 80
  while IFS= read -r url; do
    case "$url" in
      https://*) ;;
      ${loopback ? 'http://localhost/*|http://localhost:*|http://127.0.0.1/*|http://127.0.0.1:*|http://"[::1]"/*|http://"[::1]":*) ;;' : ''}
      *) exit 80 ;;
    esac
    printf '%s\\n' "$url" | grep -Eq '^https?://[][a-zA-Z0-9.:-]+/[a-zA-Z0-9_./~-]+$' || exit 80
  done < "$TMP/urls"
  [ "$(safe_git config --file "$REPO/.git/config" --no-includes --get core.repositoryformatversion)" = 0 ] || exit 80
  [ "$(safe_git config --file "$REPO/.git/config" --no-includes --get core.bare)" = false ] || exit 80
  safe_git -C "$REPO" ls-files --stage > "$TMP/index" || exit 80
  if grep -q '^160000 ' "$TMP/index"; then exit 80; fi
}
${clone ? '' : 'check_repository'}
${body}
`;
}
