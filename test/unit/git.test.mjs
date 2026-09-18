import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { volumeGit, VolumeGit, VolumeGitError } from 'freestyle-volumes/git';
import { volumeGit as rootVolumeGit, MAX_MULTIPART_COPY_BYTES } from 'freestyle-volumes';

test('Git and multipart APIs are available through public package exports', () => {
  assert.equal(rootVolumeGit, volumeGit);
  assert.equal(MAX_MULTIPART_COPY_BYTES, 5 * 1024 ** 4);
});

const exec = promisify(execFile);
const identity = { name: 'Volume Test', email: 'volume@example.invalid' };
const exists = path => access(path).then(() => true, () => false);
const q = value => `'${value.replaceAll("'", "'\\''")}'`;
const nativeGit = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fv-git-')));
  const mount = join(root, 'volume');
  await mkdir(mount);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const inspections = [];
  const location = { sandboxId: 'native-test', mountPath: mount, repoPath: 'repo' };
  const inspection = { status: 'mounted', responsive: true, readOnly: false, sandboxId: location.sandboxId, mountPath: mount };
  const adapter = {
    id: location.sandboxId,
    async exec(input) {
      calls.push(input);
      if (overrides.exec) return overrides.exec(input);
      return exec('sh', ['-c', input.command], { env: { ...process.env, ...overrides.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 })
        .then(result => ({ ...result, exitCode: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.killed ? null : error.code }));
    },
  };
  const helper = volumeGit({
    volumes: { async inspectMount(input) { inspections.push(input); return inspection; } },
    sandboxes: { get: () => adapter },
    allowInsecureLoopbackHttp: overrides.loopback ?? true,
  });
  const repo = join(mount, 'repo');
  const init = async () => {
    await mkdir(repo);
    await nativeGit(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'one.txt'), 'one\n');
    return helper.commit({ ...location, paths: ['one.txt'], message: 'Initial', identity });
  };
  return { root, mount, repo, helper, calls, inspections, inspection, location, init };
}

async function httpRemote(t, f) {
  const seed = join(f.root, 'seed');
  const bare = join(f.root, 'repo.git');
  await mkdir(seed);
  await nativeGit(seed, 'init', '-b', 'main');
  await writeFile(join(seed, 'readme.txt'), 'initial\n');
  await nativeGit(seed, 'add', '--', 'readme.txt');
  await nativeGit(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'seed');
  await nativeGit(f.root, 'clone', '--bare', seed, bare);
  await nativeGit(bare, 'config', 'http.receivepack', 'true');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, 'http://127.0.0.1');
    const child = spawn('git', ['http-backend'], { env: {
      ...process.env,
      GIT_PROJECT_ROOT: f.root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'test',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0);
    let headers = false;
    child.stdout.on('data', chunk => {
      if (headers) { response.write(chunk); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      for (const line of buffer.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]);
        else response.setHeader(key, value);
      }
      headers = true;
      response.write(buffer.subarray(end + 4));
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { response.statusCode = 500; response.end(); });
    child.on('close', () => response.end());
    request.pipe(child.stdin);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { remote: `http://127.0.0.1:${server.address().port}/repo.git`, seed, bare, requests };
}

test('real HTTP clone, explicit commit, normal push, fast-forward pull and divergence refusal', async t => {
  const f = await fixture(t);
  const r = await httpRemote(t, f);
  const cloned = await f.helper.clone({ ...f.location, remote: r.remote, branch: 'main' });
  assert.equal(cloned.durability, 'guest-local');
  assert.equal((await f.helper.status(f.location)).clean, true);
  await writeFile(join(f.repo, 'local.txt'), 'local\n');
  const committed = await f.helper.commit({ ...f.location, paths: ['local.txt'], message: 'Local', identity });
  const pushed = await f.helper.sync({ ...f.location, remote: r.remote, branch: 'main', direction: 'push' });
  assert.equal(pushed.head, committed.head);
  assert.equal((await nativeGit(r.bare, 'rev-parse', 'main')).stdout.trim(), committed.head);
  await nativeGit(r.seed, 'pull', '--ff-only', r.bare, 'main');
  await writeFile(join(r.seed, 'upstream.txt'), 'upstream\n');
  await nativeGit(r.seed, 'add', '--', 'upstream.txt');
  await nativeGit(r.seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'upstream');
  await nativeGit(r.seed, 'push', r.bare, 'main');
  const pulled = await f.helper.sync({ ...f.location, remote: r.remote, branch: 'main', direction: 'pull' });
  assert.notEqual(pulled.head, committed.head);
  assert.equal(await readFile(join(f.repo, 'upstream.txt'), 'utf8'), 'upstream\n');
  await writeFile(join(f.repo, 'local.txt'), 'diverged local\n');
  const local = await f.helper.commit({ ...f.location, paths: ['local.txt'], message: 'Diverge', identity });
  await writeFile(join(r.seed, 'upstream.txt'), 'diverged upstream\n');
  await nativeGit(r.seed, 'add', '--', 'upstream.txt');
  await nativeGit(r.seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-m', 'diverge');
  await nativeGit(r.seed, 'push', r.bare, 'main');
  for (const direction of ['pull', 'push']) {
    await assert.rejects(f.helper.sync({ ...f.location, remote: r.remote, branch: 'main', direction }), { code: 'GIT_FAILED' });
  }
  assert.equal((await nativeGit(f.repo, 'rev-parse', 'HEAD')).stdout.trim(), local.head);
  assert.ok(r.requests.some(path => path.includes('git-receive-pack')));
  assert.ok(f.calls.every(call => !call.command.includes('--force') && !call.command.includes('config --global')));
});

test('mount-root clone refuses overwrite and dirty pull never commits or contacts the remote', async t => {
  const f = await fixture(t);
  const r = await httpRemote(t, f);
  const location = { ...f.location, repoPath: undefined };
  const cloned = await f.helper.clone({ ...location, remote: r.remote });
  await writeFile(join(f.mount, 'readme.txt'), 'dirty\n');
  const requests = r.requests.length;
  await assert.rejects(f.helper.pull({ ...location, remote: r.remote, branch: 'main' }), { code: 'GIT_FAILED' });
  assert.equal(r.requests.length, requests);
  assert.equal((await nativeGit(f.mount, 'rev-parse', 'HEAD')).stdout.trim(), cloned.head);
  await assert.rejects(f.helper.clone({ ...location, remote: r.remote }), { code: 'GIT_FAILED' });
  assert.equal(await readFile(join(f.mount, 'readme.txt'), 'utf8'), 'dirty\n');
});

test('in-progress operations and indexed submodules cannot become implicit commits', async t => {
  const f = await fixture(t);
  const initial = await f.init();
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    await writeFile(join(f.repo, '.git', state), `${initial.head}\n`);
    await assert.rejects(f.helper.commit({ ...f.location, paths: ['.'], message: 'No', identity }), { code: 'GIT_UNSAFE_REPOSITORY' });
    await rm(join(f.repo, '.git', state));
  }
  await nativeGit(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${initial.head},submodule`);
  await assert.rejects(f.helper.commit({ ...f.location, paths: ['one.txt'], message: 'No', identity }), { code: 'GIT_UNSAFE_REPOSITORY' });
  assert.equal((await nativeGit(f.repo, 'rev-parse', 'HEAD')).stdout.trim(), initial.head);
});

test('literal shell/pathspec injection, explicit paths, staged-change refusal and per-call identity', async t => {
  const f = await fixture(t);
  await f.init();
  const filename = "file'$(touch PWNED)*.txt";
  await writeFile(join(f.repo, filename), 'safe');
  await writeFile(join(f.repo, 'other.txt'), 'not selected');
  const result = await f.helper.commit({ ...f.location, paths: [filename], message: "message'$(touch PWNED)", identity });
  assert.match(result.head, /^[0-9a-f]{40}$/);
  assert.equal(await exists(join(f.repo, 'PWNED')), false);
  const status = await f.helper.status(f.location);
  assert.equal(status.porcelain, '?? other.txt\0');
  assert.equal((await nativeGit(f.repo, 'log', '-1', '--format=%an <%ae>')).stdout.trim(), 'Volume Test <volume@example.invalid>');
  const config = await readFile(join(f.repo, '.git/config'), 'utf8');
  assert.doesNotMatch(config, /Volume Test|volume@example.invalid/);
  await nativeGit(f.repo, 'add', '--', 'other.txt');
  await assert.rejects(f.helper.commit({ ...f.location, paths: ['one.txt'], message: 'No', identity }), { code: 'GIT_INDEX_NOT_EMPTY' });
  await nativeGit(f.repo, 'reset');
  await f.helper.commit({ ...f.location, paths: ['.'], message: 'Explicit all', identity });
  assert.equal((await f.helper.status(f.location)).clean, true);
  await rm(join(f.repo, 'one.txt'));
  await f.helper.commit({ ...f.location, paths: ['one.txt'], message: 'Delete', identity });
  assert.equal((await f.helper.status(f.location)).clean, true);
});

test('hooks and inherited Git configuration cannot execute', async t => {
  const f = await fixture(t, { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'touch /tmp/fv-git-should-not-exist', GIT_DIR: '/missing', GIT_TRACE: '1' } });
  await f.init();
  await writeFile(join(f.repo, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch "$PWD/PWNED"\nexit 1\n', { mode: 0o700 });
  await writeFile(join(f.repo, 'one.txt'), 'changed\n');
  await f.helper.commit({ ...f.location, paths: ['one.txt'], message: 'No hooks', identity });
  assert.equal(await exists(join(f.repo, 'PWNED')), false);
});

test('unsafe config is rejected before includes, filters, helpers or remote rewrites run', async t => {
  const f = await fixture(t);
  await f.init();
  const path = join(f.repo, '.git/config');
  const original = await readFile(path, 'utf8');
  for (const extra of [
    '[include]\npath = /outside\n', '[core]\nfsmonitor = touch PWNED\n',
    '[filter "evil"]\nclean = touch PWNED\n', '[credential]\nhelper = !touch PWNED\n',
    '[url "file:///outside"]\ninsteadOf = https://example.com/\n',
    '[core]\nworktree = /outside\n', '[extensions]\nworktreeConfig = true\n',
    '[remote "origin"]\nurl = https://user:secret@example.com/repo\n',
  ]) {
    await writeFile(path, original + extra);
    await assert.rejects(f.helper.status(f.location), { code: 'GIT_UNSAFE_REPOSITORY' });
  }
  assert.equal(await exists(join(f.repo, 'PWNED')), false);
});

test('symlinks, alternate object stores, nested repositories and gitdir indirection fail closed', async t => {
  const f = await fixture(t);
  await f.init();
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.repo, 'escape'));
  await assert.rejects(f.helper.commit({ ...f.location, paths: ['.'], message: 'No', identity }), { code: 'GIT_UNSAFE_REPOSITORY' });
  await rm(join(f.repo, 'escape'));
  await mkdir(join(f.repo, 'nested/.git'), { recursive: true });
  await assert.rejects(f.helper.status(f.location), { code: 'GIT_UNSAFE_REPOSITORY' });
  await rm(join(f.repo, 'nested'), { recursive: true });
  await writeFile(join(f.repo, '.git/objects/info/alternates'), outside);
  await assert.rejects(f.helper.status(f.location), { code: 'GIT_UNSAFE_REPOSITORY' });
  await rm(join(f.repo, '.git/objects/info/alternates'));
  await symlink(outside, join(f.mount, 'linked'));
  await assert.rejects(f.helper.clone({ ...f.location, repoPath: 'linked/repo', remote: 'owner/repo' }), { code: 'GIT_UNSAFE_REPOSITORY' });
  await rm(join(f.repo, '.git'), { recursive: true });
  await writeFile(join(f.repo, '.git'), `gitdir: ${outside}\n`);
  await assert.rejects(f.helper.status(f.location), { code: 'GIT_UNSAFE_REPOSITORY' });
});

test('unhealthy and read-only mounts prevent writes; status works on read-only mount', async t => {
  const f = await fixture(t);
  await f.init();
  for (const status of ['stale', 'absent', 'unmanaged']) {
    f.inspection.status = status;
    const before = f.calls.length;
    await assert.rejects(f.helper.status(f.location), { code: 'GIT_MOUNT' });
    assert.equal(f.calls.length, before);
  }
  f.inspection.status = 'mounted';
  f.inspection.responsive = false;
  await assert.rejects(f.helper.status(f.location), { code: 'GIT_MOUNT' });
  f.inspection.responsive = true;
  f.inspection.readOnly = true;
  const index = await readFile(join(f.repo, '.git/index'));
  assert.equal((await f.helper.status(f.location)).clean, true);
  assert.deepEqual(await readFile(join(f.repo, '.git/index')), index);
  for (const readOnly of [true, null]) {
    f.inspection.readOnly = readOnly;
    await assert.rejects(f.helper.commit({ ...f.location, paths: ['.'], message: 'No', identity }), { code: 'GIT_MOUNT' });
    await assert.rejects(f.helper.push({ ...f.location, remote: 'owner/repo', branch: 'main' }), { code: 'GIT_MOUNT' });
  }
});

test('validation rejects unsafe remotes, paths, branches and implicit commits before exec', async t => {
  const f = await fixture(t, { loopback: false });
  for (const remote of ['file:///repo', '/tmp/repo', '../repo', 'ext::sh -c id', 'git@github.com:owner/repo', 'ssh://git@github.com/owner/repo', 'http://127.0.0.1/repo', 'https://user:secret@example.com/repo', 'https://example.com/repo?token=secret', 'https://example.com/repo#secret', 'https://example.com/a/../b', 'https://example.com/%0aevil']) {
    await assert.rejects(f.helper.clone({ ...f.location, remote }), { code: 'GIT_VALIDATION' });
  }
  for (const repoPath of ['../escape', '/outside', '.git', 'x/.GIT/config', 'x//y', 'x/./y', ':magic', '-C']) {
    await assert.rejects(f.helper.status({ ...f.location, repoPath }), { code: 'GIT_VALIDATION' });
    await assert.rejects(f.helper.commit({ ...f.location, paths: [repoPath], message: 'No', identity }), { code: 'GIT_VALIDATION' });
  }
  for (const branch of ['-main', 'HEAD', 'main:other', '+main', 'a..b', 'main.lock', 'a@{1}', 'a\nb']) {
    await assert.rejects(f.helper.pull({ ...f.location, remote: 'owner/repo', branch }), { code: 'GIT_VALIDATION' });
  }
  await assert.rejects(f.helper.commit({ ...f.location, paths: [], message: 'No', identity }), { code: 'GIT_VALIDATION' });
  await assert.rejects(f.helper.commit({ ...f.location, paths: ['.'], message: 'No' }), { code: 'GIT_VALIDATION' });
  await assert.rejects(f.helper.sync({ ...f.location, remote: 'owner/repo', branch: 'main', direction: 'both' }), { code: 'GIT_VALIDATION' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.inspections.length, 0);
});

test('GitHub shorthand, token env transport, sanitized failures and no automatic retries', async t => {
  const token = 'very-private-token';
  const f = await fixture(t, { exec: async input => {
    assert.equal(input.command.includes(token), false);
    assert.equal(input.env.FV_GIT_TOKEN, token);
    assert.match(input.command, /https:\/\/github.com\/owner\/repo.git/);
    return { exitCode: 1, stdout: token, stderr: token };
  } });
  const error = await f.helper.clone({ ...f.location, remote: 'owner/repo', token }).catch(error => error);
  assert.ok(error instanceof VolumeGitError);
  assert.equal(error.code, 'GIT_FAILED');
  assert.equal(JSON.stringify(error).includes(token), false);
  assert.equal(String(error).includes(token), false);
  assert.equal(error.cause, undefined);
  assert.equal(f.calls.length, 1);
  const timed = await fixture(t, { exec: async () => ({ exitCode: null, stdout: token, stderr: token }) });
  await assert.rejects(timed.helper.clone({ ...timed.location, remote: 'owner/repo', token }), { code: 'GIT_TIMEOUT', outcomeUnknown: true });
  const transport = await fixture(t, { exec: async () => { throw new Error(token); } });
  const thrown = await transport.helper.clone({ ...transport.location, remote: 'owner/repo', token }).catch(error => error);
  assert.equal(thrown.code, 'GIT_EXEC');
  assert.equal(thrown.cause, undefined);
  assert.equal(String(thrown).includes(token), false);
});

test('askpass is private, outside mount, contains no token and cleans up on success and failure', async t => {
  for (const fail of [false, true]) {
    let helperPath;
    const token = 'private-askpass-token';
    const f = await fixture(t, { exec: async input => {
      const replacement = `
credentials=$(printf 'protocol=https\\nhost=github.com\\n\\n' | safe_git credential fill)
case "$credentials" in *"password=$FV_GIT_TOKEN"*) ;; *) exit 1 ;; esac
unset credentials
exec 3>&1
safe_git() {
  printf '%s' "$TMP" > ${q(join(f.root, 'helper-path'))}
  permissions=$(stat -c %a "$TMP" 2>/dev/null) || permissions=$(stat -f %Lp "$TMP")
  [ "$permissions" = 700 ] || exit 1
  case "$TMP" in "$MOUNT"/*) exit 1 ;; esac
  [ "$("$GIT_ASKPASS" "Username for 'https://github.com': ")" = x-access-token ] || exit 1
  [ "$("$GIT_ASKPASS" "Password for 'https://x-access-token@github.com': ")" = "$FV_GIT_TOKEN" ] || exit 1
  if "$GIT_ASKPASS" "Password for 'https://x-access-token@evil.example': "; then exit 1; fi
  contents=$(cat "$GIT_ASKPASS")
  case "$contents" in *"$FV_GIT_TOKEN"*) exit 1 ;; esac
  ${fail ? 'exit 1' : "printf '%040d\\n' 1 >&3; exit 0"}
}
`;
      const command = input.command.replace('[ "$(id -u)" = 0 ]', '[ 0 = 0 ]').replace('\nsafe_git clone ', `${replacement}\nsafe_git clone `);
      const result = await exec('sh', ['-c', command], { env: { ...process.env, ...input.env } })
        .then(r => ({ ...r, exitCode: 0 }), e => ({ stdout: e.stdout, stderr: e.stderr, exitCode: e.code }));
      helperPath = await readFile(join(f.root, 'helper-path'), 'utf8');
      return result;
    } });
    const promise = f.helper.clone({ ...f.location, remote: 'owner/repo', token });
    if (fail) await assert.rejects(promise, { code: 'GIT_FAILED' });
    else assert.equal((await promise).durability, 'guest-local');
    assert.equal(await exists(helperPath), false);
    assert.deepEqual(await readdir(f.mount), []);
  }
});

test('loopback opt-in never accepts credentials or non-loopback HTTP', async t => {
  const f = await fixture(t);
  for (const remote of ['http://example.com/repo', 'http://127.0.0.2/repo', 'http://localhost.evil/repo']) {
    await assert.rejects(f.helper.clone({ ...f.location, remote }), { code: 'GIT_VALIDATION' });
  }
  await assert.rejects(f.helper.clone({ ...f.location, remote: 'http://127.0.0.1/repo', token: 'secret' }), { code: 'GIT_VALIDATION' });
  assert.ok(f.helper instanceof VolumeGit);
});
