import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStorage, rcloneRemoteEnv, toStorageError, MemoryObjectStore, ValidationError } from '../../dist/index.js';
import { storage } from '../helpers/fake-sandbox.mjs';

test('resolveStorage applies defaults and validates', () => {
  const resolved = resolveStorage(storage);
  assert.equal(resolved.forcePathStyle, true, 'path style defaults on for custom endpoints');
  assert.equal(resolved.provider, 'Other');
  assert.equal(resolved.prefix, 'tenant-a');
  assert.equal(resolved.requestTimeoutMs, 15000);
  const aws = resolveStorage({ bucket: 'b-1', accessKeyId: 'k', secretAccessKey: 's' });
  assert.equal(aws.forcePathStyle, false);
  assert.equal(aws.provider, 'AWS');
  assert.equal(aws.prefix, 'freestyle-volumes');
  assert.equal(aws.region, 'us-east-1');
  assert.throws(() => resolveStorage({ ...storage, endpoint: 'ftp://x' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, endpoint: "http://x/'" }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, secretAccessKey: '' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, secretAccessKey: 'a\nb' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, bucket: 'Bad' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, provider: 'x;y' }), ValidationError);
  assert.throws(() => resolveStorage({ ...storage, requestTimeoutMs: 1 }), ValidationError);
});

test('rclone remote env carries credentials and the sandbox endpoint, nothing else', () => {
  const env = rcloneRemoteEnv(resolveStorage(storage));
  assert.equal(env.RCLONE_CONFIG, '/dev/null');
  assert.equal(env.RCLONE_CONFIG_FSVOL_TYPE, 's3');
  assert.equal(env.RCLONE_CONFIG_FSVOL_ENDPOINT, 'http://minio:9000');
  assert.equal(env.RCLONE_CONFIG_FSVOL_ACCESS_KEY_ID, storage.accessKeyId);
  assert.equal(env.RCLONE_CONFIG_FSVOL_SECRET_ACCESS_KEY, storage.secretAccessKey);
  assert.equal(env.RCLONE_CONFIG_FSVOL_FORCE_PATH_STYLE, 'true');
  assert.equal(env.RCLONE_CONFIG_FSVOL_NO_CHECK_BUCKET, 'true', 'never creates buckets');
  assert.equal(env.RCLONE_CONFIG_FSVOL_DIRECTORY_MARKERS, 'true');
  assert.equal('RCLONE_CONFIG_FSVOL_SESSION_TOKEN' in env, false);
  for (const key of Object.keys(env)) assert.match(key, /^[A-Z_][A-Z0-9_]*$/, 'valid POSIX env names');
  const withToken = rcloneRemoteEnv(resolveStorage({ ...storage, sessionToken: 'tok' }));
  assert.equal(withToken.RCLONE_CONFIG_FSVOL_SESSION_TOKEN, 'tok');
});

test('toStorageError classifies auth, missing bucket, network and other failures without leaking secrets', () => {
  const auth = toStorageError(Object.assign(new Error('The AWS Access Key Id you provided does not exist'), { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } }), 'list', 'b');
  assert.equal(auth.code, 'STORAGE_AUTH');
  assert.equal(toStorageError(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), 'put', 'b').code, 'STORAGE_AUTH');
  assert.equal(toStorageError(Object.assign(new Error('nope'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }), 'list', 'b').code, 'BUCKET_NOT_FOUND');
  assert.equal(toStorageError(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }), 'headBucket', 'b').code, 'BUCKET_NOT_FOUND');
  assert.equal(toStorageError(Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error', code: 'ECONNREFUSED' }), 'list', 'b').code, 'STORAGE_UNREACHABLE');
  assert.equal(toStorageError(Object.assign(new Error('fetch failed'), { name: 'TypeError', cause: { code: 'ENOTFOUND' } }), 'list', 'b').code, 'STORAGE_UNREACHABLE');
  assert.equal(toStorageError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'list', 'b').code, 'STORAGE_UNREACHABLE');
  const other = toStorageError(new Error('boom'), 'list', 'b');
  assert.equal(other.code, 'STORAGE_ERROR');
  assert.match(other.message, /bucket "b"/);
  assert.match(auth.hint, /accessKeyId, secretAccessKey/);
  assert.doesNotMatch(auth.message, /AKIA|super-secret/);
});

test('MemoryObjectStore lists by prefix in key order with limits', async () => {
  const store = new MemoryObjectStore();
  await store.putObject('p/b', '1');
  await store.putObject('p/a', '2');
  await store.putObject('q/a', '3');
  const keys = [];
  for await (const o of store.listObjects('p/')) keys.push(o.key);
  assert.deepEqual(keys, ['p/a', 'p/b']);
  const limited = [];
  for await (const o of store.listObjects('p/', { limit: 1 })) limited.push(o.key);
  assert.deepEqual(limited, ['p/a']);
  assert.equal(await store.getObject('missing'), undefined);
});
