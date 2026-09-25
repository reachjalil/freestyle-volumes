import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FreestyleVolumes, MemoryObjectStore, RcloneBackend, StorageError, checkScript, DEFAULT_GUEST_PATHS } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage } from '../helpers/fake-sandbox.mjs';
import { LocalShellSandbox } from '../helpers/local-sandbox.mjs';

const statuses = (report) => Object.fromEntries(report.checks.map((check) => [check.name, check.status]));
const probeKeys = (store) => [...store.objects.keys()].filter((key) => key.includes('/_doctor/'));

function volumesWith(objectStore, sandboxes = fakeResolver([]), backend = undefined) {
  return new FreestyleVolumes({ storage, sandboxes, objectStore, ...(backend ? { backend } : {}) });
}

test('checkStorage passes on a store that enforces conditional creates and leaves no probe behind', async () => {
  const store = new MemoryObjectStore();
  const report = await volumesWith(store).checkStorage();
  assert.equal(report.ok, true);
  assert.deepEqual(statuses(report), { bucket: 'ok', list: 'ok', 'conditional-create': 'ok', read: 'ok', delete: 'ok' });
  assert.deepEqual(probeKeys(store), []);
});

test('checkStorage catches a provider that ignores If-None-Match', async () => {
  class IgnoresConditions extends MemoryObjectStore {
    async putObjectIfAbsent(key, body) {
      this.objects.set(key, body);
      return true;
    }
  }
  const store = new IgnoresConditions();
  const report = await volumesWith(store).checkStorage();
  assert.equal(report.ok, false);
  assert.deepEqual(statuses(report), { bucket: 'ok', list: 'ok', 'conditional-create': 'fail', read: 'fail', delete: 'ok' });
  const conditional = report.checks.find((check) => check.name === 'conditional-create');
  assert.match(conditional.detail, /does not enforce If-None-Match/);
  assert.match(conditional.hint, /If-None-Match: \*/);
  assert.deepEqual(probeKeys(store), [], 'the probe is deleted even after a failed check');
});

test('checkStorage reports rejected conditional writes, and stops early when the bucket or listing fails', async () => {
  class RejectsConditions extends MemoryObjectStore {
    async putObjectIfAbsent() {
      throw new StorageError('STORAGE_ERROR', 'Storage request putIfAbsent failed (NotImplemented).');
    }
  }
  const rejected = await volumesWith(new RejectsConditions()).checkStorage();
  assert.deepEqual(statuses(rejected), { bucket: 'ok', list: 'ok', 'conditional-create': 'fail' }, 'nothing was written, so read and delete are not probed');
  assert.match(rejected.checks[2].detail, /STORAGE_ERROR: .*NotImplemented/);

  const noBucket = new MemoryObjectStore();
  noBucket.failWith = Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
  const missing = await volumesWith(noBucket).checkStorage();
  assert.deepEqual(statuses(missing), { bucket: 'fail' });
  assert.match(missing.checks[0].detail, /^BUCKET_NOT_FOUND: /);

  class CannotList extends MemoryObjectStore {
    listObjects() {
      throw new StorageError('STORAGE_AUTH', 'Access denied while listing.');
    }
  }
  const unlisted = await volumesWith(new CannotList()).checkStorage();
  assert.deepEqual(statuses(unlisted), { bucket: 'ok', list: 'fail' });
  assert.match(unlisted.checks[1].hint, /ListBucket/);
});

test('checkStorage names the probe to remove when delete is not allowed', async () => {
  class CannotDelete extends MemoryObjectStore {
    async deleteObject() {
      throw new StorageError('STORAGE_AUTH', 'Access denied while deleting.');
    }
  }
  const store = new CannotDelete();
  const report = await volumesWith(store).checkStorage();
  assert.deepEqual(statuses(report), { bucket: 'ok', list: 'ok', 'conditional-create': 'ok', read: 'ok', delete: 'fail' });
  const [probe] = probeKeys(store);
  assert.match(probe, /^tenant-a\/_doctor\/[0-9a-f-]{36}\.json$/);
  assert.ok(report.checks[4].hint.includes(probe));
});

test('the check script is valid POSIX sh, installs nothing and embeds no credentials', () => {
  const script = checkScript(DEFAULT_GUEST_PATHS, { remotePath: 'fsvol:bucket/prefix', endpointUrl: 'https://s3.us-east-1.amazonaws.com' });
  const syntax = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.doesNotMatch(script, /ACCESS_KEY|SECRET|TOKEN/);
  const body = script.slice(script.indexOf('# Check the runtime attach needs.'));
  assert.doesNotMatch(body, /apt-get install|apk add|install -m|mkdir|fsvol_lock|rm -|kill|>\s*"\$(STATE|RUN|CACHE)_ROOT/, 'a check installs, locks and writes nothing');
});

/** Runs the real check script locally; `probes` fakes the tools and network that differ per scenario. */
async function checkScenario(t, { probes, rclone }) {
  const root = await mkdtemp(join(tmpdir(), 'fv-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { stateRoot: join(root, 's'), runRoot: join(root, 'r'), cacheRoot: join(root, 'c'), binDir: root };
  await writeFile(join(root, 'fuse'), '');
  if (rclone !== undefined) {
    await writeFile(join(root, 'rclone'), `#!/bin/sh
case "$1" in
  version) echo 'rclone v1.75.1';;
  lsf) printf '%s\\n' "$@" > '${root}/lsf-args'; printf '%s' "$RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID" > '${root}/lsf-key'; ${rclone};;
esac
`, { mode: 0o700 });
  }
  const sandbox = new LocalShellSandbox('vm-1', {
    marker: '# Check the runtime attach needs.',
    overrides: `
uname() { echo x86_64; }
id() { echo 0; }
FUSE_DEV='${root}/fuse'
timeout() { shift; "$@"; }
df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 1 1 52428800 1%% /\\n'; }
${probes}`,
  });
  const report = await volumesWith(new MemoryObjectStore(), fakeResolver([sandbox]), new RcloneBackend({ paths })).checkSandbox({ sandboxId: 'vm-1', timeoutMs: 10_000 });
  assert.equal(JSON.stringify(report).includes(storage.secretAccessKey), false, 'the report never contains the secret');
  const read = (name) => readFile(join(root, name), 'utf8').catch(() => undefined);
  return { report, sandbox, read };
}

test('checkSandbox on a prepared VM: runtime present, bucket listed from inside with exec-env credentials', async (t) => {
  const { report, sandbox, read } = await checkScenario(t, {
    probes: `have() { case "$1" in fusermount3|flock|apt-get|curl) return 0;; *) return 1;; esac; }
fsvol_fusermount() { echo /usr/bin/fusermount3; }`,
    rclone: 'exit 3',
  });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepEqual(statuses(report), { arch: 'ok', root: 'ok', 'fuse-device': 'ok', fusermount: 'ok', flock: 'ok', rclone: 'ok', storage: 'ok', 'cache-disk': 'ok' });
  assert.match(report.checks.find((c) => c.name === 'rclone').detail, /v1\.75\.1$/);
  assert.match(report.checks.find((c) => c.name === 'cache-disk').detail, /^50 GiB free under \/.+ for the write cache$/, 'the nearest existing ancestor of the cache root');
  assert.match(await read('lsf-args'), /^lsf\nfsvol:test-bucket\/tenant-a\n--max-depth\n1\n/);
  assert.equal(await read('lsf-key'), storage.accessKeyId);
  assert.equal(sandbox.calls[0].env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, storage.secretAccessKey, 'credentials travel only in the exec env');
  assert.equal(report.checks.every((check) => check.hint === undefined), true, 'passing checks carry no hints');
});

test('checkSandbox on a fresh VM: what attach will install, what blocks it, and hints', async (t) => {
  const { report } = await checkScenario(t, {
    probes: `id() { echo 1000; }
FUSE_DEV=/nonexistent/fuse
have() { case "$1" in apt-get|curl) return 0;; *) return 1;; esac; }
curl() { for a; do u="$a"; done; case "$u" in https://downloads.rclone.org/) printf 200;; *) printf 403;; esac; }
df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 1 1 512000 1%% /\\n'; }`,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(statuses(report), { arch: 'ok', root: 'fail', 'fuse-device': 'fail', fusermount: 'warn', flock: 'warn', rclone: 'warn', 'rclone-download': 'ok', storage: 'warn', 'cache-disk': 'warn' });
  const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
  assert.equal(byName.fusermount.detail, 'not installed; attach installs fuse3 with apt-get');
  assert.equal(byName.storage.detail, 'http://minio:9000 answered HTTP 403; credentials are checked once rclone is installed');
  assert.match(byName['cache-disk'].detail, /^500 MiB free under \/.+ for the write cache$/);
  assert.match(byName['fuse-device'].hint, /--device \/dev\/fuse/);
  assert.match(byName.rclone.hint, /volume-ready snapshot/);
  assert.match(byName.root.hint, /root/);
});

test('checkSandbox surfaces storage denied from inside the VM and missing tools without a package manager', async (t) => {
  const { report } = await checkScenario(t, {
    probes: `have() { return 1; }
fsvol_fusermount() { return 1; }`,
    rclone: `echo '2026/09/25 ERROR : error listing: AccessDenied: Access Denied' >&2; echo >&2; exit 1`,
  });
  assert.deepEqual(statuses(report), { arch: 'ok', root: 'ok', 'fuse-device': 'ok', fusermount: 'fail', flock: 'fail', rclone: 'ok', storage: 'fail', 'cache-disk': 'ok' });
  const storageCheck = report.checks.find((check) => check.name === 'storage');
  assert.equal(storageCheck.detail, 'rclone exited 1: 2026/09/25 ERROR : error listing: AccessDenied: Access Denied');
  assert.match(storageCheck.hint, /firewall/);
});

test('checkSandbox without rclone or curl says what it could not test', async (t) => {
  const bare = await checkScenario(t, { probes: `have() { [ "$1" = apt-get ]; }` });
  assert.equal(bare.report.ok, true, 'warnings alone do not fail the check');
  assert.deepEqual(statuses(bare.report), { arch: 'ok', root: 'ok', 'fuse-device': 'ok', fusermount: 'warn', flock: 'warn', rclone: 'warn', 'rclone-download': 'warn', storage: 'warn', 'cache-disk': 'ok' });
  assert.equal(bare.report.checks.find((c) => c.name === 'rclone-download').detail, 'no curl or wget yet; attach installs curl with apt-get first');

  const alpine = await checkScenario(t, { probes: `have() { case "$1" in apk|wget) return 0;; *) return 1;; esac; }
wget() { return 0; }` });
  assert.equal(alpine.report.checks.find((c) => c.name === 'rclone-download').status, 'ok');
  assert.equal(alpine.report.checks.find((c) => c.name === 'fusermount').detail, 'not installed; attach installs fuse3 with apk');
});

test('checkSandbox validates its input and reports a check that could not run', async () => {
  const sandbox = new FakeSandbox('vm-1', [{ stdout: '', stderr: 'sh: syntax error', exitCode: 2 }]);
  const volumes = volumesWith(new MemoryObjectStore(), fakeResolver([sandbox]));
  await assert.rejects(volumes.checkSandbox({ sandboxId: 'vm-1', timeoutMs: 1 }), { code: 'VALIDATION' });
  await assert.rejects(volumes.checkSandbox({ sandboxId: 'vm-1' }), { code: 'SANDBOX_EXEC' });
});
