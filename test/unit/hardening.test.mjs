// Scoped sandbox credentials, encryption settings, cache-size validation and
// the smaller correctness fixes of 0.2.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PutObjectCommand, CopyObjectCommand, HeadObjectCommand, CreateMultipartUploadCommand, GetObjectTaggingCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import {
  FreestyleVolumes, MemoryObjectStore, RcloneBackend, S3ObjectStore, ValidationError, VolumeError,
  resolveStorage, rcloneRemoteEnv, storageConfigFromEnv, sandboxCredentialsFromEnv, scopedPolicy, mountScript, DEFAULT_GUEST_PATHS,
} from '../../dist/index.js';
import { FakeSandbox, fakeResolver, storage, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';

const SANDBOX_KEY = { accessKeyId: 'AKIASANDBOXKEY', secretAccessKey: 'sandbox-secret-never-logged' };

function setup(responses = [], options = {}) {
  const store = new MemoryObjectStore();
  const sandbox = new FakeSandbox('vm-1', responses);
  const events = [];
  const volumes = new FreestyleVolumes({ storage, sandboxes: fakeResolver([sandbox]), objectStore: store, onEvent: (e) => events.push(e), ...options });
  return { store, sandbox, volumes, events };
}

test('cache sizes need explicit units, because rclone reads a bare number as KiB', async () => {
  for (const bare of ['1024', '10', '0', '1.5']) {
    assert.throws(() => setup([], { defaults: { cacheMaxSize: bare } }), (error) => error instanceof ValidationError && /KiB/.test(error.message) && error.message.includes(`${bare} KiB`));
    assert.throws(() => setup([], { defaults: { cacheMinFreeSpace: bare } }), ValidationError);
  }
  for (const bad of ['10 G', '10GB/s', '-1G', 'lots', '', 10]) assert.throws(() => setup([], { defaults: { cacheMaxSize: bad } }), ValidationError, String(bad));
  for (const ok of ['10G', '500M', '1GiB', '0B', 'off']) assert.equal(setup([], { defaults: { cacheMaxSize: ok } }).volumes.defaults.cacheMaxSize, ok);
});

test('the write cache keeps 1G free by default, and the attach result warns when the VM disk is nearly full', async () => {
  const { volumes, sandbox, events } = setup([BOOTSTRAP_OK, { stdout: 'FSVOL_RESULT status=attached already=0 pid=4242 cachefree=524288\n' }]);
  assert.equal(volumes.defaults.cacheMinFreeSpace, '1G');
  await volumes.create({ name: 'data' });
  const attached = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  assert.ok(sandbox.calls[1].command.includes('"CacheMinFreeSpace":"1G"'), 'the default reaches the VFS options');
  assert.equal(attached.cacheFreeBytes, 512 * 1024 * 1024);
  assert.match(attached.warnings.join('\n'), /Only 512 MiB are free on the VM disk/);
  assert.ok(events.some((e) => e.type === 'warning' && /512 MiB/.test(e.message)));

  const off = setup([BOOTSTRAP_OK, { stdout: 'FSVOL_RESULT status=attached already=0 pid=1 cachefree=104857600\n' }], { defaults: { cacheMinFreeSpace: 'off' } });
  await off.volumes.create({ name: 'data' });
  const roomy = await off.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data', readOnly: true });
  assert.ok(off.sandbox.calls[1].command.includes('"CacheMinFreeSpace":"off"'));
  assert.deepEqual(roomy.warnings, [], 'read-only mounts write nothing to the cache');
  const script = mountScript(DEFAULT_GUEST_PATHS, { mountId: 'abc', remotePath: 'fsvol:b/p', mountPath: '/mnt/x', readOnly: false, cacheMode: 'writes', writeBackSeconds: 5, dirCacheSeconds: 60, allowOther: true, readyTimeoutMs: 1000, stateJson: '{}' });
  assert.doesNotMatch(script, /CacheMinFreeSpace/, 'omitted at the script level unless set');
});

test('volume.created fires only when a record was written', async () => {
  const { volumes, events } = setup();
  await volumes.get('data', { create: true });
  await volumes.get('data', { create: true });
  await volumes.create({ name: 'data', ifNotExists: true });
  assert.deepEqual(events.filter((e) => e.type === 'volume.created').map((e) => e.volumeId), ['data']);
});

test('inspect during another lifecycle operation reports MOUNT_BUSY, not MOUNT_FAILED', async () => {
  const backend = new RcloneBackend();
  const busy = await backend.inspect(new FakeSandbox('vm-1', [{ stdout: 'FSVOL_ERR lifecycle-busy\n', exitCode: 36 }]), '/mnt/data', { timeoutMs: 1000 }).catch((e) => e);
  assert.equal(busy.code, 'MOUNT_BUSY');
  assert.match(busy.message, /listMounts/);
  const broken = await backend.inspect(new FakeSandbox('vm-1', [{ stdout: 'FSVOL_ERR tool-missing flock\n', exitCode: 13 }]), '/mnt/data', { timeoutMs: 1000 }).catch((e) => e);
  assert.equal(broken.code, 'MOUNT_FAILED');
});

test('fixed sandbox credentials replace the host keys in the guest, and only there', async () => {
  const { volumes, sandbox } = setup([BOOTSTRAP_OK, MOUNT_OK], { sandboxCredentials: SANDBOX_KEY });
  await volumes.create({ name: 'data' });
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  const env = sandbox.calls[1].env;
  assert.equal(env.RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID, SANDBOX_KEY.accessKeyId);
  assert.equal(env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, SANDBOX_KEY.secretAccessKey);
  assert.equal(env.RCLONE_CONFIG_FSVOL_SESSION_TOKEN, undefined);
  assert.equal(env.RCLONE_CONFIG_FSVOL_NO_HEAD_OBJECT, 'true', 'prefix-limited keys cannot HEAD the mount root');
  assert.ok(!JSON.stringify(sandbox.calls).includes(storage.secretAccessKey), 'the host secret never reaches the sandbox');
  assert.ok(!sandbox.calls[1].command.includes(SANDBOX_KEY.secretAccessKey), 'credentials stay out of the script');
  assert.throws(() => setup([], { sandboxCredentials: { accessKeyId: 'a', secretAccessKey: '' } }), ValidationError);
  assert.throws(() => setup([], { sandboxCredentials: { accessKeyId: 'a', secretAccessKey: 'b\nc' } }), ValidationError);
});

test('a credentials provider is asked for exactly the scope of each mount and check', async () => {
  const requests = [];
  const expiresAt = new Date(Date.now() + 3_600_000);
  const provider = async (request) => {
    requests.push(request);
    return { ...SANDBOX_KEY, sessionToken: 'session-token', expiresAt };
  };
  const { volumes, sandbox } = setup([BOOTSTRAP_OK, MOUNT_OK, BOOTSTRAP_OK, MOUNT_OK, { stdout: 'FSVOL_CHECK arch ok x86_64\nFSVOL_RESULT status=checked\n' }], { sandboxCredentials: provider });
  const volume = await volumes.create({ name: 'data' });
  const writable = await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/rw', subpath: 'team-a' });
  await volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/ro', readOnly: true });
  await volumes.checkSandbox({ sandboxId: 'vm-1' });
  assert.deepEqual(requests.map((r) => [r.purpose, r.keyPrefix, r.readOnly, r.volumeId, r.subpath, r.mountPath, r.bucket, r.prefix, r.sandboxId]), [
    ['mount', `${volume.dataPrefix}/team-a`, false, 'data', 'team-a', '/mnt/rw', storage.bucket, storage.prefix, 'vm-1'],
    ['mount', volume.dataPrefix, true, 'data', null, '/mnt/ro', storage.bucket, storage.prefix, 'vm-1'],
    ['check', storage.prefix, true, null, null, null, storage.bucket, storage.prefix, 'vm-1'],
  ]);
  assert.equal(sandbox.calls[1].env.RCLONE_CONFIG_FSVOL_SESSION_TOKEN, 'session-token');
  assert.equal(sandbox.calls[4].env.RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID, SANDBOX_KEY.accessKeyId, 'checkSandbox tests the keys a mount would get');
  assert.equal(writable.credentialsExpireAt, expiresAt.toISOString());
  assert.ok(sandbox.calls[1].command.includes(`"credentialsExpireAt":"${expiresAt.toISOString()}"`), 'expiry is recorded with the mount');
  assert.deepEqual(writable.warnings, []);
});

test('provider failures stop before the sandbox, never fall back to host keys, and short expiry warns', async () => {
  const failing = setup([], { sandboxCredentials: async () => { throw new Error('sts: access denied for role'); } });
  await failing.volumes.create({ name: 'data' });
  const error = await failing.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' }).catch((e) => e);
  assert.equal(error.code, 'STORAGE_AUTH');
  assert.equal(error.cause.message, 'sts: access denied for role');
  assert.equal(failing.sandbox.calls.length, 0, 'nothing ran in the sandbox');

  const malformed = setup([], { sandboxCredentials: () => ({ accessKeyId: 'a' }) });
  await malformed.volumes.create({ name: 'data' });
  await assert.rejects(malformed.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' }), ValidationError);

  const soon = setup([BOOTSTRAP_OK, MOUNT_OK], { sandboxCredentials: () => ({ ...SANDBOX_KEY, expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
  await soon.volumes.create({ name: 'data' });
  const attached = await soon.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' });
  assert.match(attached.warnings.join('\n'), /expire at .* rclone cannot refresh them/);
  const bad = setup([], { sandboxCredentials: () => ({ ...SANDBOX_KEY, expiresAt: 'tomorrow-ish' }) });
  await bad.volumes.create({ name: 'data' });
  await assert.rejects(bad.volumes.attach({ sandboxId: 'vm-1', volumeId: 'data', mountPath: '/mnt/data' }), ValidationError);
});

test('sandbox credentials from the environment come as a pair', () => {
  assert.equal(sandboxCredentialsFromEnv({}), undefined);
  assert.deepEqual(sandboxCredentialsFromEnv({ VOLUMES_S3_SANDBOX_ACCESS_KEY_ID: 'a', VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY: 'b' }), { accessKeyId: 'a', secretAccessKey: 'b' });
  assert.deepEqual(sandboxCredentialsFromEnv({ VOLUMES_S3_SANDBOX_ACCESS_KEY_ID: 'a', VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY: 'b', VOLUMES_S3_SANDBOX_SESSION_TOKEN: 't' }), { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 't' });
  assert.throws(() => sandboxCredentialsFromEnv({ VOLUMES_S3_SANDBOX_ACCESS_KEY_ID: 'a' }), ValidationError);
});

test('scopedPolicy allows one prefix: list and read, plus write and delete unless read-only', () => {
  const rw = scopedPolicy({ bucket: 'my-volumes', keyPrefix: 'app/v2/data/0f8b', readOnly: false });
  assert.deepEqual(rw.Statement.map((s) => s.Sid), ['ListPrefix', 'ReadPrefix', 'WritePrefix']);
  assert.deepEqual(rw.Statement[0].Resource, ['arn:aws:s3:::my-volumes']);
  assert.deepEqual(rw.Statement[0].Condition.StringLike['s3:prefix'], ['app/v2/data/0f8b', 'app/v2/data/0f8b/', 'app/v2/data/0f8b/*']);
  assert.deepEqual(rw.Statement[1].Resource, ['arn:aws:s3:::my-volumes/app/v2/data/0f8b/*']);
  assert.ok(rw.Statement[2].Action.includes('s3:DeleteObject'));
  const ro = scopedPolicy({ bucket: 'my-volumes', keyPrefix: 'app/v2/data/0f8b/', readOnly: true });
  assert.deepEqual(ro.Statement.map((s) => s.Sid), ['ListPrefix', 'ReadPrefix']);
  assert.ok(!JSON.stringify(ro).includes('PutObject'));
  for (const keyPrefix of ['', 'a/*', 'a/../b', 'a b', "a'b"]) assert.throws(() => scopedPolicy({ bucket: 'my-volumes', keyPrefix, readOnly: true }), ValidationError, keyPrefix);
  assert.throws(() => scopedPolicy({ bucket: 'Bad_Bucket', keyPrefix: 'a', readOnly: true }), ValidationError);
});

test('encryption and storage class settings validate and reach both rclone and the S3 requests', async () => {
  assert.throws(() => resolveStorage({ ...storage, serverSideEncryption: 'rot13' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, sseKmsKeyId: 'key' }), ValidationError, 'a KMS key needs aws:kms');
  assert.throws(() => resolveStorage({ ...storage, serverSideEncryption: 'aws:kms', sseKmsKeyId: "key'; rm" }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, storageClass: 'standard ia' }), ValidationError);
  const plain = resolveStorage(storage);
  assert.equal(plain.serverSideEncryption, undefined);
  const plainEnv = rcloneRemoteEnv(plain);
  for (const key of ['SERVER_SIDE_ENCRYPTION', 'SSE_KMS_KEY_ID', 'STORAGE_CLASS']) assert.equal(plainEnv[`RCLONE_CONFIG_FSVOL_${key}`], undefined);

  const kmsKey = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
  const resolved = resolveStorage({ ...storage, serverSideEncryption: 'aws:kms', sseKmsKeyId: kmsKey, storageClass: 'STANDARD_IA' });
  const env = rcloneRemoteEnv(resolved);
  assert.equal(env.RCLONE_CONFIG_FSVOL_SERVER_SIDE_ENCRYPTION, 'aws:kms');
  assert.equal(env.RCLONE_CONFIG_FSVOL_SSE_KMS_KEY_ID, kmsKey);
  assert.equal(env.RCLONE_CONFIG_FSVOL_STORAGE_CLASS, 'STANDARD_IA');

  const calls = [];
  const store = new S3ObjectStore(resolved, { send: async (command) => {
    calls.push(command);
    if (command instanceof HeadObjectCommand) return { ContentLength: command.input.Key === 'big' ? 12 * 1024 ** 2 : 3, ETag: '"e"' };
    if (command instanceof GetObjectTaggingCommand) return { TagSet: [] };
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'up-1' };
    if (command instanceof UploadPartCopyCommand) return { CopyPartResult: { ETag: '"p"' } };
    if (command instanceof CompleteMultipartUploadCommand) return { ETag: '"c"' };
    if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: '"c"' } };
    return {};
  } });
  await store.putObject('ns/record', '{}');
  await store.putObjectIfAbsent('ns/new', '{}');
  await store.copyObject('small', 'ns/copy', { size: 3, sourceIfMatch: '"e"' });
  const multipart = new S3ObjectStore(resolveStorage({ ...storage, serverSideEncryption: 'AES256', storageClass: 'STANDARD_IA', multipartCopyThresholdBytes: 5 * 1024 ** 2, multipartCopyPartSizeBytes: 5 * 1024 ** 2 }), { send: async (command) => {
    calls.push(command);
    if (command instanceof HeadObjectCommand) return { ContentLength: 12 * 1024 ** 2, ETag: '"e"' };
    if (command instanceof GetObjectTaggingCommand) return { TagSet: [] };
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'up-1' };
    if (command instanceof UploadPartCopyCommand) return { CopyPartResult: { ETag: '"p"' } };
    return { ETag: '"c"' };
  } });
  await multipart.copyObject('big', 'ns/big', { size: 12 * 1024 ** 2, sourceIfMatch: '"e"' });
  const puts = calls.filter((c) => c instanceof PutObjectCommand);
  assert.equal(puts.length, 2);
  for (const put of puts) {
    assert.equal(put.input.ServerSideEncryption, 'aws:kms');
    assert.equal(put.input.SSEKMSKeyId, kmsKey);
    assert.equal(put.input.StorageClass, undefined, 'tiny records keep the bucket default class');
  }
  const copy = calls.find((c) => c instanceof CopyObjectCommand);
  assert.equal(copy.input.StorageClass, 'STANDARD_IA');
  assert.equal(copy.input.ServerSideEncryption, 'aws:kms');
  const created = calls.find((c) => c instanceof CreateMultipartUploadCommand);
  assert.equal(created.input.ServerSideEncryption, 'AES256');
  assert.equal(created.input.StorageClass, 'STANDARD_IA');

  const fromEnv = storageConfigFromEnv({ VOLUMES_S3_BUCKET: 'b-1', VOLUMES_S3_ACCESS_KEY_ID: 'k', VOLUMES_S3_SECRET_ACCESS_KEY: 's', VOLUMES_S3_SSE: 'AES256', VOLUMES_S3_STORAGE_CLASS: 'STANDARD_IA' });
  assert.equal(fromEnv.serverSideEncryption, 'AES256');
  assert.equal(fromEnv.storageClass, 'STANDARD_IA');
});

test('list can skip malformed records and still throws storage errors', async () => {
  const { store, volumes, events } = setup();
  await volumes.create({ name: 'good' });
  store.objects.set(`${storage.prefix}/_volumes/broken.json`, 'not json');
  await assert.rejects(volumes.list(), (error) => error instanceof VolumeError && error.code === 'STORAGE_ERROR');
  const skipped = [];
  const listed = await volumes.list({ skipInvalid: true, onInvalid: (name) => skipped.push(name) });
  assert.deepEqual(listed.map((v) => v.name), ['good']);
  assert.deepEqual(skipped, ['broken']);
  assert.ok(events.some((e) => e.type === 'warning' && e.volumeId === 'broken'));
  store.failWith = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
  await assert.rejects(volumes.list({ skipInvalid: true }), { code: 'STORAGE_AUTH' });
});

test('usage counts objects, bytes and directory markers under the data prefix only', async () => {
  const { store, volumes } = setup();
  const volume = await volumes.create({ name: 'data' });
  const other = await volumes.create({ name: 'data-2' });
  store.objects.set(`${volume.dataPrefix}/a.txt`, 'hello');
  store.objects.set(`${volume.dataPrefix}/dir/`, '');
  store.objects.set(`${volume.dataPrefix}/dir/b.bin`, 'xyz');
  store.objects.set(`${other.dataPrefix}/not-mine`, 'ignored');
  assert.deepEqual(await volumes.usage('data'), { volumeId: 'data', dataPrefix: volume.dataPrefix, objects: 3, bytes: 8, directoryMarkers: 1 });
  await assert.rejects(volumes.usage('missing'), { code: 'VOLUME_NOT_FOUND' });
});
