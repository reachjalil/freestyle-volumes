import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../dist/cli.js';
import { MemoryObjectStore } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';

const SECRET = 'super-secret-value-never-logged';
const ENV = {
  VOLUMES_S3_BUCKET: 'test-bucket',
  VOLUMES_S3_ACCESS_KEY_ID: 'AKIAFAKEKEYID',
  VOLUMES_S3_SECRET_ACCESS_KEY: SECRET,
  VOLUMES_S3_ENDPOINT: 'http://127.0.0.1:9000',
  VOLUMES_S3_PREFIX: 'cli',
};
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/** Run the CLI in-process with a hermetic environment; never lets the secret reach stdout or stderr. */
async function cli(args, io = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    env: ENV,
    ...io,
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  assert.equal(stdout.includes(SECRET) || stderr.includes(SECRET), false, `secret leaked by ${args.join(' ')}`);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

test('--version, --help and bare invocation', async () => {
  assert.deepEqual(await cli(['--version']).then((r) => [r.code, r.stdout]), [0, `${version}\n`]);
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  for (const command of ['list', 'get', 'create', 'clone', 'delete', 'attachments', 'attach', 'inspect', 'detach', 'prepare-snapshot']) {
    assert.match(help.stdout, new RegExp(`^  ${command}\\b`, 'm'), command);
  }
  assert.ok(help.stdout.split('\n').every((line) => line.length <= 80), 'help fits 80 columns');
  assert.equal((await cli(['attach', '--help'])).code, 0);
  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.equal(bare.stdout, '');
  assert.match(bare.stderr, /Usage: freestyle-volumes <command>/);
});

test('usage errors exit 2 without touching storage', async () => {
  const objectStore = new MemoryObjectStore();
  objectStore.failWith = new Error('storage must not be called');
  const cases = [
    [['bogus'], /Unknown command "bogus"/],
    [['toString'], /Unknown command "toString"/],
    [['list', '--nope'], /Unknown option '--nope'/],
    [['get'], /Usage: freestyle-volumes get <volume>/],
    [['get', 'a', 'b'], /Usage: freestyle-volumes get <volume>/],
    [['create', 'data', '--label', 'novalue'], /--label "novalue" must look like key=value/],
    [['clone', 'a', 'b', '--concurrency', 'eight'], /--concurrency must be an integer/],
    [['attach', 'vm-1', 'data', '/mnt/data', '--uid', '10.5'], /--uid must be an integer/],
    [['delete', 'data'], /repeat the name with --confirm data/],
    [['delete', 'data', '--confirm', 'other'], /repeat the name with --confirm data/],
    [['get', 'Not_A_Volume'], /VALIDATION: Invalid volume name/],
    [['--env-file', '/nonexistent/freestyle-volumes.env', 'list'], /Could not read --env-file/],
  ];
  for (const [args, message] of cases) {
    const result = await cli(args, { objectStore });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message, args.join(' '));
  }
});

test('missing or invalid configuration names the variables to set', async () => {
  const missing = await cli(['list'], { env: { VOLUMES_S3_BUCKET: 'b' } });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Missing environment variables: VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY/);
  const pathStyle = await cli(['list'], { env: { ...ENV, VOLUMES_S3_FORCE_PATH_STYLE: 'maybe' }, objectStore: new MemoryObjectStore() });
  assert.equal(pathStyle.code, 2);
  assert.match(pathStyle.stderr, /VOLUMES_S3_FORCE_PATH_STYLE must be true or false/);
  const noKey = await cli(['inspect', 'vm-1', '/mnt/data'], { objectStore: new MemoryObjectStore() });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /FREESTYLE_API_KEY is not set/);
});

test('volume lifecycle: create, list, get, attachments, delete', async () => {
  const objectStore = new MemoryObjectStore();
  const created = await cli(['create', 'data', '--label', 'team=ml', '--label', 'tier=hot'], { objectStore });
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.json().name, 'data');
  assert.deepEqual(created.json().labels, { team: 'ml', tier: 'hot' });
  assert.match(created.stderr, /\[volume\.created\] data/);

  const again = await cli(['create', 'data'], { objectStore });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /VOLUME_ALREADY_EXISTS/);
  assert.equal((await cli(['create', 'data', '--if-not-exists', '--quiet'], { objectStore })).stderr, '');

  await cli(['create', 'models'], { objectStore });
  assert.deepEqual((await cli(['list'], { objectStore })).json().map((volume) => volume.name), ['data', 'models']);
  assert.equal((await cli(['get', 'data'], { objectStore })).json().dataPrefix.startsWith('cli/v2/data/'), true);
  assert.deepEqual((await cli(['attachments', 'data'], { objectStore })).json(), []);

  const deleted = await cli(['delete', 'models', '--confirm', 'models'], { objectStore });
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.equal(deleted.json().volumeId, 'models');
  const gone = await cli(['get', 'models'], { objectStore });
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /VOLUME_NOT_FOUND: Volume "models" does not exist/);
  assert.match(gone.stderr, /"volumeId": "models"/, 'error details are printed as JSON');
});

test('--prefix, --env-file and environment precedence', async () => {
  const objectStore = new MemoryObjectStore();
  assert.equal((await cli(['--prefix', 'other', 'create', 'data'], { objectStore })).code, 0);
  assert.deepEqual((await cli(['list'], { objectStore })).json(), [], 'namespaces are separate');
  assert.equal((await cli(['list', '--prefix', 'other'], { objectStore })).json().length, 1, 'options may follow the command');

  const dir = await mkdtemp(join(tmpdir(), 'fsvol-cli-'));
  try {
    const file = join(dir, 'volumes.env');
    await writeFile(file, Object.entries({ ...ENV, VOLUMES_S3_PREFIX: 'from-file' }).map(([key, value]) => `${key}=${value}`).join('\n'));
    const fromFile = new MemoryObjectStore();
    assert.equal((await cli(['--env-file', file, 'create', 'data'], { env: {}, objectStore: fromFile })).code, 0);
    assert.ok([...fromFile.objects.keys()].every((key) => key.startsWith('from-file/')));
    const realEnvWins = new MemoryObjectStore();
    assert.equal((await cli(['create', 'data', '--env-file', file], { env: { VOLUMES_S3_PREFIX: 'from-env' }, objectStore: realEnvWins })).code, 0);
    assert.ok([...realEnvWins.objects.keys()].every((key) => key.startsWith('from-env/')));
    const emptyIsUnset = new MemoryObjectStore();
    assert.equal((await cli(['create', 'data', '--env-file', file], { env: { VOLUMES_S3_PREFIX: '' }, objectStore: emptyIsUnset })).code, 0);
    assert.ok([...emptyIsUnset.objects.keys()].every((key) => key.startsWith('from-file/')), 'an empty variable does not mask the file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('attach passes mount options through, and inspect and detach print the mount state', async () => {
  const objectStore = new MemoryObjectStore();
  await cli(['create', 'data'], { objectStore });
  const sandbox = new FakeSandbox('vm-1', [
    BOOTSTRAP_OK,
    MOUNT_OK,
    { stdout: 'FSVOL_RESULT mounted=1 state=1 alive=1 responsive=1 pid=4242 ro=1 src=fsvol:test-bucket/cli/v2/data mid=abc\nFSVOL_STATE_BEGIN\n{"volumeId":"data","subpath":"team-a","readOnly":true}\nFSVOL_STATE_END\n' },
    { stdout: 'FSVOL_RESULT status=detached flushed=1 pending=0 volume=data mid=abc ro=1\n' },
  ]);
  const io = { objectStore, sandboxes: fakeResolver([sandbox]) };

  const attached = await cli(['attach', 'vm-1', 'data', '/mnt/data', '--read-only', '--subpath', 'team-a', '--uid', '1000', '--gid', '1000', '--cache-mode', 'full', '--transfers', '4', '--read-chunk-size-limit', 'off'], io);
  assert.equal(attached.code, 0, attached.stderr);
  assert.deepEqual({ ...attached.json(), mountId: undefined }, { sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', subpath: 'team-a', readOnly: true, exclusive: false, mountId: undefined, pid: 4242, alreadyAttached: false, cacheFreeBytes: null, credentialsExpireAt: null, warnings: [] });
  assert.match(attached.stderr, /\[attach\.bootstrap\] vm-1 \/mnt\/data data/);
  assert.match(attached.stderr, /\[attach\.done\] vm-1 \/mnt\/data data \(pid 4242\)/);
  const mount = sandbox.calls[1];
  for (const expected of ['"UID":1000', '"GID":1000', '"ReadOnly":true', '"CacheMode":3', '"ChunkSizeLimit":"off"', '--transfers', '/team-a']) {
    assert.ok(mount.command.includes(expected), `mount script contains ${expected}`);
  }
  assert.equal(mount.env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, SECRET, 'credentials reach the guest only as exec env');

  const inspected = await cli(['inspect', 'vm-1', '/mnt/data'], io);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.json().status, 'mounted');
  assert.equal(inspected.json().subpath, 'team-a');

  const detached = await cli(['detach', 'vm-1', '/mnt/data', '--flush-timeout', '120000'], io);
  assert.equal(detached.code, 0, detached.stderr);
  assert.equal(detached.json().flushed, true);
  assert.match(sandbox.calls[3].command, /FLUSH=120\n/);
  assert.doesNotMatch(detached.stderr, /warning/);
});

test('detach reports forced and failed flushes', async () => {
  const sandbox = new FakeSandbox('vm-1', [
    { stdout: 'FSVOL_RESULT status=detached flushed=0 pending=-1 volume=data mid=abc ro=0\n' },
    { stdout: 'FSVOL_ERR flush-timeout pending=2 errored=0\n', exitCode: 30 },
  ]);
  const io = { objectStore: new MemoryObjectStore(), sandboxes: fakeResolver([sandbox]) };
  const forced = await cli(['detach', 'vm-1', '/mnt/data', '--force'], io);
  assert.equal(forced.code, 0);
  assert.equal(forced.json().flushed, false);
  assert.match(forced.stderr, /warning: detached without a verified flush/);
  assert.match(sandbox.calls[0].command, /FORCE=1\n/);

  const failed = await cli(['detach', 'vm-1', '/mnt/data'], io);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /FLUSH_FAILED: Pending writes under \/mnt\/data/);
});

test('prepare-snapshot drives the Freestyle client without storage configuration', async () => {
  const execs = [];
  const vm = {
    id: 'vm-builder',
    exec: async (options) => { execs.push(options); return { stdout: BOOTSTRAP_OK.stdout, stderr: '', statusCode: 0 }; },
    snapshot: async (options) => ({ snapshotId: `sh-${options.slug}` }),
    delete: async () => {},
  };
  const creates = [];
  const freestyle = { vms: { create: async (options) => { creates.push(options); return { vm, vmId: vm.id }; }, ref: () => vm } };

  const result = await cli(['prepare-snapshot', '--base', 'freestyle/ubuntu-sm', '--slug', 'ubuntu-sm-volumes', '--name', 'Ubuntu small + volumes'], { env: {}, freestyle });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json().snapshotId, 'sh-ubuntu-sm-volumes');
  assert.equal(creates[0].snapshotId, 'freestyle/ubuntu-sm');
  assert.equal(execs[0].linuxUser, 'root');
  assert.match(result.stderr, /\[builder\.created\] vm-builder freestyle\/ubuntu-sm/);
  assert.match(result.stderr, /\[builder\.deleted\] vm-builder/);

  assert.equal((await cli(['prepare-snapshot', '--slug', 'Bad_Slug'], { env: {}, freestyle })).code, 2);
  assert.equal((await cli(['prepare-snapshot', '--docker'], { env: {}, freestyle })).code, 2);
  const noKey = await cli(['prepare-snapshot'], { env: {} });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /FREESTYLE_API_KEY is not set/);
});

test('mounts lists a VM, and detach-all exits 1 unless every mount detached', async () => {
  const listing = 'FSVOL_MOUNT mid=aaaa000000000001 mounted=1 alive=1 pid=7 ro=0 state={"mountPath":"/mnt/a","volumeId":"a"}\nFSVOL_UNMANAGED /mnt/foreign\nFSVOL_RESULT status=listed\n';
  const sandbox = new FakeSandbox('vm-1', [
    { stdout: listing },
    { stdout: listing },
    { stdout: 'FSVOL_RESULT status=detached flushed=1 pending=0 volume=a mid=aaaa000000000001 ro=0\n' },
    { stdout: listing },
    { stdout: 'FSVOL_ERR flush-timeout pending=1 errored=0\n', exitCode: 30 },
    { stdout: listing },
    { stdout: 'FSVOL_RESULT status=detached flushed=0 pending=-1 volume=a mid=aaaa000000000001 ro=0\n' },
  ]);
  const io = { objectStore: new MemoryObjectStore(), sandboxes: fakeResolver([sandbox]) };

  const mounts = await cli(['mounts', 'vm-1'], io);
  assert.equal(mounts.code, 0, mounts.stderr);
  assert.deepEqual(mounts.json().mounts.map((m) => [m.mountPath, m.status, m.volumeId]), [['/mnt/a', 'mounted', 'a']]);
  assert.deepEqual(mounts.json().unmanaged, ['/mnt/foreign']);

  const drained = await cli(['detach-all', 'vm-1'], io);
  assert.equal(drained.code, 0, drained.stderr);
  assert.equal(drained.json().flushed, true);

  const failed = await cli(['detach-all', 'vm-1', '--flush-timeout', '5000'], io);
  assert.equal(failed.code, 1);
  assert.equal(failed.json().flushed, false, 'the full result is still printed');
  assert.match(failed.stderr, /error: \/mnt\/a: FLUSH_FAILED: /);

  const forced = await cli(['detach-all', 'vm-1', '--force'], io);
  assert.equal(forced.code, 0, 'a forced detach is not a failure');
  assert.match(forced.stderr, /warning: \/mnt\/a detached without a verified flush/);
  assert.match(sandbox.calls[6].command, /FORCE=1\n/);
});

test('doctor checks the bucket, and a VM with --vm; exit 1 on any failure', async () => {
  const healthy = await cli(['doctor'], { objectStore: new MemoryObjectStore() });
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(healthy.json().ok, true);
  assert.equal(healthy.json().sandbox, undefined);
  assert.deepEqual(healthy.json().storage.checks.map((c) => c.name), ['bucket', 'list', 'conditional-create', 'read', 'delete']);
  assert.match(healthy.stderr, /^ok {3}storage conditional-create: /m);
  assert.equal((await cli(['doctor', '--quiet'], { objectStore: new MemoryObjectStore() })).stderr, '');

  class IgnoresConditions extends MemoryObjectStore {
    async putObjectIfAbsent(key, body) {
      this.objects.set(key, body);
      return true;
    }
  }
  const unsafe = await cli(['doctor'], { objectStore: new IgnoresConditions() });
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /^FAIL storage conditional-create: .*If-None-Match/m);
  assert.match(unsafe.stderr, /^ {5}Use a provider/m, 'hints are indented under the failure');

  const vm = new FakeSandbox('vm-1', [{ stdout: 'FSVOL_CHECK arch ok x86_64\nFSVOL_CHECK fuse-device fail /dev/fuse is missing\nFSVOL_CHECK rclone warn no rclone\nFSVOL_RESULT status=checked\n' }]);
  const withVm = await cli(['doctor', '--vm', 'vm-1'], { objectStore: new MemoryObjectStore(), sandboxes: fakeResolver([vm]) });
  assert.equal(withVm.code, 1);
  assert.equal(withVm.json().storage.ok, true);
  assert.deepEqual(withVm.json().sandbox.checks.map((c) => [c.name, c.status]), [['arch', 'ok'], ['fuse-device', 'fail'], ['rclone', 'warn']]);
  assert.match(withVm.stderr, /^FAIL vm-1 fuse-device: \/dev\/fuse is missing$/m);
  assert.match(withVm.stderr, /^warn vm-1 rclone: no rclone$/m);
  assert.equal(vm.calls[0].env.RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID, ENV.VOLUMES_S3_ACCESS_KEY_ID);

  const noKey = await cli(['doctor', '--vm', 'vm-1'], { objectStore: new MemoryObjectStore() });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /FREESTYLE_API_KEY is not set/);
});
