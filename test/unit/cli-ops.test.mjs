// CLI commands added in 0.2.0 for operations: flush, restore, discard, usage, leases, reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../dist/cli.js';
import { MemoryObjectStore } from '../../dist/index.js';
import { FakeSandbox, fakeResolver, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';

const SECRET = 'super-secret-value-never-logged';
const SANDBOX_SECRET = 'sandbox-secret-never-logged';
const ENV = {
  VOLUMES_S3_BUCKET: 'test-bucket',
  VOLUMES_S3_ACCESS_KEY_ID: 'AKIAFAKEKEYID',
  VOLUMES_S3_SECRET_ACCESS_KEY: SECRET,
  VOLUMES_S3_ENDPOINT: 'http://127.0.0.1:9000',
  VOLUMES_S3_PREFIX: 'cli',
};

async function cli(args, io = {}, env = ENV) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { env, ...io, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
  for (const secret of [SECRET, SANDBOX_SECRET]) assert.equal(stdout.includes(secret) || stderr.includes(secret), false, `secret leaked by ${args.join(' ')}`);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

test('help lists the operations commands', async () => {
  const help = await cli(['--help']);
  for (const command of ['flush', 'flush-all', 'restore', 'discard', 'usage', 'lease', 'release-lease', 'reconcile', 'remove-orphan']) {
    assert.match(help.stdout, new RegExp(`^  ${command}\\b`, 'm'), command);
  }
  assert.match(help.stdout, /--exclusive/);
  assert.match(help.stdout, /VOLUMES_S3_SANDBOX_ACCESS_KEY_ID/);
});

test('destructive operations commands need --confirm and exit 2 without touching anything', async () => {
  const objectStore = new MemoryObjectStore();
  objectStore.failWith = new Error('storage must not be called');
  const sandbox = new FakeSandbox('vm-1', []);
  const io = { objectStore, sandboxes: fakeResolver([sandbox]) };
  for (const [args, pattern] of [
    [['discard', 'vm-1', '/mnt/data'], /repeat the path with --confirm \/mnt\/data/],
    [['discard', 'vm-1', '/mnt/data', '--confirm', '/mnt/other'], /repeat the path/],
    [['release-lease', 'data'], /repeat the name with --confirm data/],
    [['remove-orphan', 'data', '0f8b0000-0000-4000-8000-000000000000'], /--confirm data\/0f8b0000-0000-4000-8000-000000000000/],
  ]) {
    const result = await cli(args, io);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, pattern);
  }
  assert.equal(sandbox.calls.length, 0);
});

test('flush exits 1 while uploads are pending; attach --exclusive takes a lease that lease shows', async () => {
  const objectStore = new MemoryObjectStore();
  await cli(['create', 'data'], { objectStore });
  const sandbox = new FakeSandbox('vm-1', [
    BOOTSTRAP_OK, MOUNT_OK,
    { stdout: 'FSVOL_RESULT status=flushed pending=0 errored=0 mounted=1 mid=abc volume=data\n' },
    { stdout: 'FSVOL_RESULT status=pending pending=2 errored=0 mounted=1 mid=abc volume=data\n' },
  ]);
  const io = { objectStore, sandboxes: fakeResolver([sandbox]) };
  const attached = await cli(['attach', 'vm-1', 'data', '/mnt/data', '--exclusive', '--cache-min-free-space', '2G'], io);
  assert.equal(attached.code, 0, attached.stderr);
  assert.equal(attached.json().exclusive, true);
  assert.ok(sandbox.calls[1].command.includes('"CacheMinFreeSpace":"2G"'));
  const lease = await cli(['lease', 'data'], io);
  assert.equal(lease.json().sandboxId, 'vm-1');
  assert.equal((await cli(['flush', 'vm-1', '/mnt/data'], io)).code, 0);
  const pending = await cli(['flush', 'vm-1', '/mnt/data', '--flush-timeout', '5000'], io);
  assert.equal(pending.code, 1);
  assert.equal(pending.json().pendingUploads, 2);
  const released = await cli(['release-lease', 'data', '--confirm', 'data'], io);
  assert.deepEqual(released.json(), { volumeId: 'data', released: true });
  assert.equal((await cli(['lease', 'data'], io)).json(), null);
});

test('VOLUMES_S3_SANDBOX_* keys go to the VM; the host keys stay on the host', async () => {
  const objectStore = new MemoryObjectStore();
  await cli(['create', 'data'], { objectStore });
  const sandbox = new FakeSandbox('vm-1', [BOOTSTRAP_OK, MOUNT_OK]);
  const env = { ...ENV, VOLUMES_S3_SANDBOX_ACCESS_KEY_ID: 'AKIASANDBOX', VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY: SANDBOX_SECRET };
  const attached = await cli(['attach', 'vm-1', 'data', '/mnt/data'], { objectStore, sandboxes: fakeResolver([sandbox]) }, env);
  assert.equal(attached.code, 0, attached.stderr);
  assert.equal(sandbox.calls[1].env.RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID, 'AKIASANDBOX');
  assert.equal(sandbox.calls[1].env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, SANDBOX_SECRET);
  assert.ok(!JSON.stringify(sandbox.calls).includes(SECRET));
  const half = await cli(['attach', 'vm-1', 'data', '/mnt/data'], { objectStore, sandboxes: fakeResolver([sandbox]) }, { ...ENV, VOLUMES_S3_SANDBOX_ACCESS_KEY_ID: 'AKIASANDBOX' });
  assert.equal(half.code, 2, 'half a key pair is a configuration error');
});

test('usage, list --skip-invalid, reconcile and restore print JSON with meaningful exit codes', async () => {
  const objectStore = new MemoryObjectStore();
  const created = (await cli(['create', 'data'], { objectStore })).json();
  objectStore.objects.set(`${created.dataPrefix}/a.txt`, 'hello');
  objectStore.objects.set('cli/_volumes/broken.json', 'torn');
  objectStore.objects.set('cli/_doctor/0f8b0000-0000-4000-8000-000000000000.json', '{}');
  assert.deepEqual((await cli(['usage', 'data'], { objectStore })).json(), { volumeId: 'data', dataPrefix: created.dataPrefix, objects: 1, bytes: 5, directoryMarkers: 0 });
  assert.equal((await cli(['list'], { objectStore })).code, 1, 'a malformed record fails a plain list');
  const skipped = await cli(['list', '--skip-invalid'], { objectStore });
  assert.equal(skipped.code, 0);
  assert.deepEqual(skipped.json().map((v) => v.name), ['data']);
  assert.match(skipped.stderr, /\[warning\] broken/);
  const report = await cli(['reconcile'], { objectStore });
  assert.deepEqual(report.json().invalidRecords.map((r) => r.volumeId), ['broken']);
  assert.equal(report.json().doctorProbes.length, 1);
  const cleaned = await cli(['reconcile', '--remove-stale'], { objectStore });
  assert.equal(cleaned.json().removed.doctorProbes, 1);

  const sandbox = new FakeSandbox('vm-1', [{ stdout: `FSVOL_MOUNT mid=abc mounted=0 alive=0 pid= ro= state=${JSON.stringify({ mountPath: '/mnt/data', volumeId: 'data', generation: created.generation })}\nFSVOL_RESULT status=listed\n` }, BOOTSTRAP_OK, { stdout: 'FSVOL_ERR mount-create-failed\n', exitCode: 22 }]);
  const restored = await cli(['restore', 'vm-1'], { objectStore, sandboxes: fakeResolver([sandbox]) });
  assert.equal(restored.code, 1);
  assert.equal(restored.json().failed[0].error.code, 'MOUNT_FAILED');
  assert.match(restored.stderr, /error: \/mnt\/data: MOUNT_FAILED/);
});
