import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { StorageError } from '../../dist/errors.js';
import { VolumeRegistry } from '../../dist/registry.js';
import { resolveStorage, storageConfigFromEnv, rcloneRemoteEnv, toStorageError, MemoryObjectStore, S3ObjectStore, ValidationError } from '../../dist/index.js';
import { PutObjectCommand, CopyObjectCommand, HeadObjectCommand, GetObjectTaggingCommand, CreateMultipartUploadCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { MAX_SINGLE_COPY_BYTES, MAX_MULTIPART_COPY_BYTES, MIN_MULTIPART_COPY_PART_BYTES, DEFAULT_MULTIPART_COPY_PART_BYTES, MAX_MULTIPART_COPY_PARTS } from '../../dist/storage.js';
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

test('multipart configuration defaults, limits and invalid overrides', () => {
  const defaults = resolveStorage(storage);
  assert.equal(defaults.multipartCopyThresholdBytes, MAX_SINGLE_COPY_BYTES);
  assert.equal(defaults.multipartCopyPartSizeBytes, DEFAULT_MULTIPART_COPY_PART_BYTES);
  for (const key of ['multipartCopyThresholdBytes', 'multipartCopyPartSizeBytes']) {
    for (const value of [MIN_MULTIPART_COPY_PART_BYTES, MAX_SINGLE_COPY_BYTES]) {
      assert.equal(resolveStorage({ ...storage, [key]: value })[key], value);
    }
    for (const value of [null, 0, -1, MIN_MULTIPART_COPY_PART_BYTES - 1, MAX_SINGLE_COPY_BYTES + 1, NaN, Infinity, 5.5, '5242880']) {
      assert.throws(() => resolveStorage({ ...storage, [key]: value }), ValidationError);
    }
  }
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

const secretConfig = { ...storage, accessKeyId: 'AKIA_FIXTURE_PRIVATE', secretAccessKey: 'fixture-secret-private', sessionToken: 'fixture-session-private' };
const secrets = [secretConfig.accessKeyId, secretConfig.secretAccessKey, secretConfig.sessionToken];
const secretText = secrets.join(' / ');

function assertSafeError(error) {
  const views = [String(error), JSON.stringify(error), inspect(error, { depth: null, showHidden: true }), inspect(error, { depth: null, showHidden: true, getters: true, customInspect: false })];
  for (const view of views) for (const secret of secrets) assert.equal(view.includes(secret), false, 'error must not expose provider credentials');
}

function leakingError(name = 'TimeoutError') {
  const cause = Object.assign(Error(secretText), { code: 'ECONNRESET', credentials: secretConfig });
  const error = Object.assign(Error(secretText, { cause }), { name, code: secretText, $metadata: { httpStatusCode: 503, credentials: secretConfig }, headers: { authorization: secretText }, stack: secretText });
  error.self = error;
  error.toJSON = () => secretText;
  error[inspect.custom] = () => secretText;
  return error;
}

test('toStorageError allowlists classifications and never retains raw provider strings, stacks, nested causes or custom serializers', () => {
  const credentialError = leakingError('AccessDenied');
  const classified = toStorageError(credentialError, 'list', storage.bucket);
  assert.equal(classified.code, 'STORAGE_AUTH');
  assert.equal(classified.details.name, 'AccessDenied');
  assert.equal(classified.details.status, 503);
  assert.equal(classified.details.code, 'ECONNRESET');
  assert.notEqual(classified.cause, credentialError);
  assertSafeError(classified);
  const unknownFields = { name: secretText, code: secretText, message: secretText, $metadata: { httpStatusCode: secretText }, cause: { code: secretText, message: secretText } };
  const accessorError = Object.defineProperties({}, Object.fromEntries(['name', 'code', 'message', 'stack', 'cause', '$metadata'].map(key => [key, { get() { throw Error(secretText); } }])));
  const errors = [unknownFields, accessorError, secretText, new AggregateError([credentialError], secretText), new StorageError('STORAGE_AUTH', secretText, { cause: credentialError, details: secretConfig }), new Proxy({}, { getOwnPropertyDescriptor() { throw Error(secretText); } })];
  for (const raw of errors) {
    const error = toStorageError(raw, 'get', storage.bucket);
    assertSafeError(error);
    assert.equal(error.details.name, raw instanceof StorageError ? 'StorageError' : 'Error');
    assert.equal(error.details.status, undefined);
    assert.equal(error.details.code, undefined);
    assert.equal(error.code, raw instanceof StorageError ? 'STORAGE_AUTH' : 'STORAGE_ERROR');
  }
  for (const status of [NaN, Infinity, -1, 99, 600, 403.1, { toString: () => secretText }]) {
    const error = toStorageError({ $metadata: { httpStatusCode: status } }, 'get', storage.bucket);
    assert.equal(error.details.status, undefined);
    assertSafeError(error);
  }
});

test('every S3 operation sanitizes provider errors, including preconstructed StorageErrors and partial deletion failures', async () => {
  for (const raw of [leakingError(), new StorageError('STORAGE_AUTH', secretText, { cause: leakingError(), details: secretConfig })]) {
    const store = new S3ObjectStore(resolveStorage(secretConfig), { send: async () => { throw raw; } });
    const operations = [
      () => store.headBucket(), () => store.putObject('key', 'body'), () => store.putObjectIfAbsent('key', 'body'),
      () => store.getObject('key'), () => store.deleteObject('key'), () => store.deleteObjects(['key']),
      async () => { for await (const _ of store.listObjects('prefix')) assert.fail('failed listing must not yield'); },
      () => store.copyObject('source', 'destination', { size: 1, sourceIfMatch: '"source"' }),
    ];
    for (const operation of operations) {
      await assert.rejects(operation(), error => { assertSafeError(error); return true; });
    }
  }
  const store = new S3ObjectStore(resolveStorage(secretConfig), { send: async () => ({ Errors: [
    { Key: 'key', Code: 'AccessDenied', Message: secretText },
    { Key: secretText, Code: secretText, Message: secretText },
  ] }) });
  await assert.rejects(store.deleteObjects(['key']), error => {
    assertSafeError(error);
    assert.deepEqual(error.details.failed, [{ key: 'key', code: 'AccessDenied' }, { key: undefined, code: 'Error' }]);
    return error.code === 'STORAGE_ERROR';
  });
  const memory = new MemoryObjectStore();
  memory.failWith = new StorageError('STORAGE_AUTH', secretText, { cause: leakingError() });
  await assert.rejects(memory.headBucket(), error => { assertSafeError(error); return error.code === 'STORAGE_AUTH'; });
});

test('multipart and abort errors remain sanitized through registry error aggregation without losing primary classification', async () => {
  for (const stage of [CreateMultipartUploadCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand]) {
    const original = leakingError('TimeoutError');
    const abortFailure = leakingError('AccessDenied');
    const fixture = multipartFixture({ config: secretConfig, respond: command => {
      if (command instanceof stage) throw original;
      if (command instanceof AbortMultipartUploadCommand) throw abortFailure;
    } });
    const memory = new MemoryObjectStore();
    const registry = new VolumeRegistry(memory, 'ns');
    const source = await registry.create({ name: 'source' });
    const list = memory.listObjects.bind(memory);
    memory.listObjects = async function* (prefix, options) {
      if (prefix === `${source.dataPrefix}/`) yield { key: `${prefix}object`, size: 11 * 1024 ** 2, etag: '"source"' };
      else yield* list(prefix, options);
    };
    memory.copyObject = fixture.store.copyObject.bind(fixture.store);
    await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target' }), error => {
      assertSafeError(error);
      assert.equal(error.code, 'STORAGE_UNREACHABLE');
      assert.equal(error.cause.cause.details.name, 'TimeoutError');
      assert.equal(error.details.abortStatus, stage === CreateMultipartUploadCommand ? 'not-attempted' : 'failed');
      if (stage !== CreateMultipartUploadCommand) {
        assert.equal(error.details.abortError.code, 'STORAGE_AUTH');
        assert.equal(error.details.abortError.details.name, 'AccessDenied');
        assert.equal(error.details.uploadId, 'upload-id');
      }
      return true;
    });
  }
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

test('MemoryObjectStore conditional writes are atomic and preserve existing empty objects', async () => {
  const store = new MemoryObjectStore();
  assert.deepEqual(await Promise.all([store.putObjectIfAbsent('key', ''), store.putObjectIfAbsent('key', 'overwrite')]), [true, false]);
  assert.equal(await store.getObject('key'), '');
  store.failWith = new Error('offline');
  await assert.rejects(store.putObjectIfAbsent('other', 'body'), { code: 'STORAGE_ERROR' });
  assert.equal(store.objects.has('other'), false);
});

test('S3 conditional writes use If-None-Match and distinguish preconditions from errors', async () => {
  const calls = [];
  let failure;
  const client = { send: async (command, options) => {
    calls.push(command);
    assert.ok(options.abortSignal instanceof AbortSignal);
    if (failure) throw failure;
    return {};
  } };
  const store = new S3ObjectStore(resolveStorage(storage), client);
  assert.equal(await store.putObjectIfAbsent('ns/record', 'body'), true);
  assert.ok(calls[0] instanceof PutObjectCommand);
  assert.deepEqual(calls[0].input, { Bucket: storage.bucket, Key: 'ns/record', Body: 'body', ContentType: 'application/json', IfNoneMatch: '*' });
  for (const error of [{ name: 'PreconditionFailed' }, { $metadata: { httpStatusCode: 412 } }]) {
    failure = error;
    assert.equal(await store.putObjectIfAbsent('ns/record', 'loser'), false);
  }
  for (const [error, code] of [
    [{ name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } }, 'STORAGE_ERROR'],
    [{ name: 'NotImplemented', $metadata: { httpStatusCode: 501 } }, 'STORAGE_ERROR'],
    [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'STORAGE_AUTH'],
    [{ name: 'TimeoutError' }, 'STORAGE_UNREACHABLE'],
  ]) {
    failure = error;
    const before = calls.length;
    await assert.rejects(store.putObjectIfAbsent('ns/record', 'loser'), { code });
    assert.equal(calls.length, before + 1, 'no fallback or retry after failure');
    assert.equal(calls.at(-1).input.IfNoneMatch, '*');
  }
});

test('S3 single copy HEAD validates size/ETag, encodes names and pins versions without downloading bodies', async () => {
  for (const size of [0, MAX_SINGLE_COPY_BYTES]) {
    const calls = [];
    const store = new S3ObjectStore(resolveStorage(storage), { send: async command => {
      calls.push(command);
      return command instanceof HeadObjectCommand ? { ContentLength: size, ETag: '"etag"', VersionId: 'v +/%?#' } : { CopyObjectResult: { ETag: 'opaque-copy-receipt' } };
    } });
    const source = "ns/a +%#é!'()/file";
    await store.copyObject(source, 'ns/destination', { size, sourceIfMatch: '"etag"' });
    assert.ok(calls[0] instanceof HeadObjectCommand);
    assert.deepEqual(calls[0].input, { Bucket: storage.bucket, Key: source, IfMatch: '"etag"' });
    assert.ok(calls[1] instanceof CopyObjectCommand);
    assert.deepEqual(calls[1].input, { Bucket: storage.bucket, Key: 'ns/destination', CopySource: `${storage.bucket}/ns/a%20%2B%25%23%C3%A9%21%27%28%29/file?versionId=v%20%2B%2F%25%3F%23`, CopySourceIfMatch: '"etag"' });
    for (const invalid of [-1, NaN, Infinity, 1.5, MAX_MULTIPART_COPY_BYTES + 1]) {
      await assert.rejects(store.copyObject('source', 'dest', { size: invalid, sourceIfMatch: '"etag"' }), ValidationError);
    }
    await assert.rejects(store.copyObject('source', 'dest', { size: 0, sourceIfMatch: '' }), ValidationError);
    assert.equal(calls.length, 2);
  }
});

function multipartFixture({ size = 11 * 1024 ** 2, config = {}, head = {}, respond } = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const sourceHead = { ContentLength: size, ETag: '"source"', ...head };
  const store = new S3ObjectStore(resolveStorage({ ...storage, multipartCopyThresholdBytes: MIN_MULTIPART_COPY_PART_BYTES, multipartCopyPartSizeBytes: MIN_MULTIPART_COPY_PART_BYTES, ...config }), {
    send: async (command, options) => {
      calls.push(command);
      assert.ok(options.abortSignal instanceof AbortSignal);
      peak = Math.max(peak, ++active);
      try {
        await Promise.resolve();
        const custom = await respond?.(command, calls);
        if (custom !== undefined) return custom;
        if (command instanceof HeadObjectCommand) return sourceHead;
        if (command instanceof GetObjectTaggingCommand) return { TagSet: [] };
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-id' };
        if (command instanceof UploadPartCopyCommand) return { CopyPartResult: { ETag: `"part-${command.input.PartNumber}"` } };
        if (command instanceof CompleteMultipartUploadCommand) return { ETag: 'opaque-completion-receipt' };
        if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: 'opaque-copy-receipt' } };
        if (command instanceof AbortMultipartUploadCommand) return {};
        assert.fail(`unexpected command ${command.constructor.name}`);
      } finally { active--; }
    },
  });
  return { store, calls, copy: () => store.copyObject("ns/a +%#é!'()/file", 'ns/destination', { size, sourceIfMatch: '"source"' }), peak: () => peak };
}

test('missing or malformed completion receipts never publish or delete possibly committed destinations', async () => {
  for (const multipart of [false, true]) {
    const commandType = multipart ? CompleteMultipartUploadCommand : CopyObjectCommand;
    const size = multipart ? 11 * 1024 ** 2 : 1;
    const receipts = [null, {}, { $metadata: { httpStatusCode: 200 } }, ...[undefined, null, '', ' \t\n ', 42, {}, ['etag']].map(ETag => multipart ? { ETag } : { CopyObjectResult: { ETag } })];
    for (const receipt of receipts) {
      for (const committed of [false, true]) {
        const memory = new MemoryObjectStore();
        const registry = new VolumeRegistry(memory, 'ns');
        const source = await registry.create({ name: 'source' });
        const fixture = multipartFixture({ size, respond: command => {
          if (command instanceof commandType) {
            if (committed) memory.objects.set(command.input.Key, 'committed');
            return receipt;
          }
        } });
        const list = memory.listObjects.bind(memory);
        memory.listObjects = async function* (prefix, options) {
          if (prefix === `${source.dataPrefix}/`) yield { key: `${prefix}object`, size, etag: '"source"' };
          else yield* list(prefix, options);
        };
        memory.copyObject = fixture.store.copyObject.bind(fixture.store);
        memory.deleteObjects = async () => assert.fail('unknown completion must retain destination generation');
        const error = await registry.clone({ sourceVolumeId: 'source', name: 'target' }).catch(error => error);
        assert.equal(error.code, 'STORAGE_ERROR');
        assert.equal(error.details.completionStatus, 'unknown');
        assert.equal(error.details.completionUnknown, true);
        assert.equal(error.details.cleanupStatus, 'retained');
        assert.equal(error.details.publication, 'not-attempted');
        assert.match(error.cause.cause.message, /completion ETag/);
        assert.equal(error.details.abortStatus, multipart ? 'acknowledged' : 'not-attempted');
        assert.equal(fixture.calls.filter(command => command instanceof commandType).length, 1);
        assert.equal(fixture.calls.filter(command => command instanceof AbortMultipartUploadCommand).length, multipart ? 1 : 0);
        assert.equal(await registry.find('target'), undefined);
        assert.equal(memory.objects.has(`${error.details.destinationPrefix}/object`), committed);
        assert.ok(memory.objects.has(`ns/_operations/${error.details.operationId}.json`));
      }
    }
  }
});

test('completion ETags are opaque nonempty strings, not restricted to quoted MD5 hashes', async () => {
  for (const multipart of [false, true]) {
    for (const ETag of ['opaque-provider-etag', '"multipart-123-3"', 'W/"opaque"']) {
      const fixture = multipartFixture({ size: multipart ? 11 * 1024 ** 2 : 1, respond: command => {
        if (command instanceof CompleteMultipartUploadCommand) return { ETag };
        if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag } };
      } });
      await fixture.copy();
      assert.equal(fixture.calls.some(command => command instanceof AbortMultipartUploadCommand), false);
    }
  }
});

test('multipart copies preserve metadata and tags, pin versions, and submit sequential inclusive ranges', async () => {
  for (const VersionId of [undefined, 'v +/%?#', 'null']) {
    const metadata = { ContentType: 'application/octet-stream', ContentEncoding: 'gzip', ContentLanguage: 'fr', ContentDisposition: 'attachment; filename="data"', CacheControl: 'max-age=123', Expires: new Date('2030-01-01T00:00:00Z'), Metadata: { owner: 'test', custom: 'value' } };
    const fixture = multipartFixture({ head: { ...metadata, ...(VersionId === undefined ? {} : { VersionId }) }, respond: command => command instanceof GetObjectTaggingCommand ? { TagSet: [{ Key: 'a +&é', Value: "v=%/!'" }, { Key: 'empty', Value: '' }] } : undefined });
    await fixture.copy();
    const { calls } = fixture;
    assert.deepEqual(calls.map(c => c.constructor.name), ['HeadObjectCommand', 'GetObjectTaggingCommand', 'CreateMultipartUploadCommand', 'UploadPartCopyCommand', 'UploadPartCopyCommand', 'UploadPartCopyCommand', 'CompleteMultipartUploadCommand']);
    assert.deepEqual(calls[1].input, { Bucket: storage.bucket, Key: "ns/a +%#é!'()/file", ...(VersionId === undefined ? {} : { VersionId }) });
    assert.deepEqual(calls[2].input, { Bucket: storage.bucket, Key: 'ns/destination', ...metadata, Tagging: 'a%20%2B%26%C3%A9=v%3D%25%2F%21%27&empty=' });
    const parts = calls.filter(c => c instanceof UploadPartCopyCommand);
    assert.deepEqual(parts.map(p => p.input.CopySourceRange), ['bytes=0-5242879', 'bytes=5242880-10485759', 'bytes=10485760-11534335']);
    for (const [i, part] of parts.entries()) {
      assert.deepEqual(part.input, { Bucket: storage.bucket, Key: 'ns/destination', UploadId: 'upload-id', PartNumber: i + 1, CopySource: `${storage.bucket}/ns/a%20%2B%25%23%C3%A9%21%27%28%29/file${VersionId === undefined ? '' : `?versionId=${encodeURIComponent(VersionId)}`}`, CopySourceIfMatch: '"source"', CopySourceRange: part.input.CopySourceRange });
    }
    assert.deepEqual(calls.at(-1).input.MultipartUpload.Parts, [1, 2, 3].map(PartNumber => ({ PartNumber, ETag: `"part-${PartNumber}"` })));
    assert.equal(fixture.peak(), 1);
  }
});

test('multipart boundaries honor threshold, final short parts, 5 GiB part cap and automatic 10000-part scaling', async () => {
  for (const [size, config, expectedParts] of [
    [MIN_MULTIPART_COPY_PART_BYTES, {}, 0],
    [MIN_MULTIPART_COPY_PART_BYTES + 1, {}, 2],
    [2 * MIN_MULTIPART_COPY_PART_BYTES, {}, 2],
    [MAX_SINGLE_COPY_BYTES, { multipartCopyThresholdBytes: MAX_SINGLE_COPY_BYTES }, 0],
    [MAX_SINGLE_COPY_BYTES + 1, { multipartCopyThresholdBytes: MAX_SINGLE_COPY_BYTES, multipartCopyPartSizeBytes: DEFAULT_MULTIPART_COPY_PART_BYTES }, 41],
    [MAX_SINGLE_COPY_BYTES + 1, { multipartCopyPartSizeBytes: MAX_SINGLE_COPY_BYTES }, 2],
    [MAX_MULTIPART_COPY_BYTES, {}, MAX_MULTIPART_COPY_PARTS],
  ]) {
    const fixture = multipartFixture({ size, config });
    await fixture.copy();
    const parts = fixture.calls.filter(c => c instanceof UploadPartCopyCommand);
    assert.equal(parts.length, expectedParts);
    let next = 0;
    for (const [i, part] of parts.entries()) {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(part.input.CopySourceRange).map(Number);
      assert.equal(start, next);
      const length = end - start + 1;
      assert.ok(length <= MAX_SINGLE_COPY_BYTES);
      if (i !== parts.length - 1) assert.ok(length >= MIN_MULTIPART_COPY_PART_BYTES);
      assert.equal(part.input.PartNumber, i + 1);
      next = end + 1;
    }
    if (parts.length) assert.equal(next, size);
    assert.equal(fixture.peak(), 1);
  }
});

test('HEAD rejects missing or changed size and ETag before creating a destination', async () => {
  for (const head of [{ ContentLength: undefined }, { ContentLength: 1 }, { ETag: undefined }, { ETag: '"changed"' }]) {
    const fixture = multipartFixture({ head });
    await assert.rejects(fixture.copy(), e => e.code === 'STORAGE_ERROR' && /size or ETag/.test(e.cause.message));
    assert.deepEqual(fixture.calls.map(c => c.constructor.name), ['HeadObjectCommand']);
  }
  for (const commandType of [HeadObjectCommand, GetObjectTaggingCommand]) {
    const failure = Object.assign(Error('denied or mutated'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    const fixture = multipartFixture({ respond: command => { if (command instanceof commandType) throw failure; } });
    await assert.rejects(fixture.copy(), e => e.cause !== failure && e.cause.details.name === 'PreconditionFailed' && e.cause.details.status === 412);
    assert.equal(fixture.calls.some(c => c instanceof CreateMultipartUploadCommand), false);
  }
});

test('part mutation and missing ETags abort the identified upload, preserving the original failure', async () => {
  for (const missing of [false, true, 'empty']) {
    const failure = Object.assign(Error('source changed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    const fixture = multipartFixture({ respond: command => {
      if (command instanceof UploadPartCopyCommand && command.input.PartNumber === 2) {
        if (missing) return missing === 'empty' ? { CopyPartResult: { ETag: '' } } : {};
        throw failure;
      }
    } });
    await assert.rejects(fixture.copy(), error => {
      assert.equal(error.details.abortStatus, 'acknowledged');
      assert.equal(error.details.completionStatus, 'not-attempted');
      assert.equal(error.details.uploadId, 'upload-id');
      if (!missing) { assert.notEqual(error.cause, failure); assert.equal(error.cause.details.name, 'PreconditionFailed'); }
      else assert.match(error.cause.message, /part ETag/);
      return true;
    });
    assert.ok(fixture.calls.at(-1) instanceof AbortMultipartUploadCommand);
    assert.deepEqual(fixture.calls.at(-1).input, { Bucket: storage.bucket, Key: 'ns/destination', UploadId: 'upload-id' });
    assert.equal(fixture.calls.filter(c => c instanceof UploadPartCopyCommand).length, 2);
    assert.equal(fixture.calls.some(c => c instanceof CompleteMultipartUploadCommand), false);
  }
});

test('missing UploadId and failed creation remain uncertain without guessing an upload ID', async () => {
  for (const UploadId of [undefined, '', '   ']) {
    const fixture = multipartFixture({ respond: command => command instanceof CreateMultipartUploadCommand ? { UploadId } : undefined });
    await assert.rejects(fixture.copy(), error => {
      assert.match(error.cause.message, /no UploadId/);
      assert.equal(error.details.stage, 'create');
      assert.equal(error.details.abortStatus, 'not-attempted');
      assert.match(error.hint, /unfinished uploads/);
      return true;
    });
    assert.ok(fixture.calls.at(-1) instanceof CreateMultipartUploadCommand);
  }
  const failure = Error('lost creation response');
  const fixture = multipartFixture({ respond: command => { if (command instanceof CreateMultipartUploadCommand) throw failure; } });
  await assert.rejects(fixture.copy(), error => error.cause !== failure && error.cause.details.name === 'Error' && error.details.abortStatus === 'not-attempted');
});

test('abort failure preserves original classification with safe reconciliation details; completion errors never claim cleanup', async () => {
  for (const stage of ['part', 'complete']) {
    for (const abortFails of [false, true]) {
      const original = Object.assign(Error('original provider failure secret-token'), { name: 'TimeoutError' });
      const abortFailure = Error('abort provider failure secret-token');
      const fixture = multipartFixture({ respond: command => {
        if ((stage === 'part' && command instanceof UploadPartCopyCommand) || (stage === 'complete' && command instanceof CompleteMultipartUploadCommand)) throw original;
        if (abortFails && command instanceof AbortMultipartUploadCommand) throw abortFailure;
      } });
      await assert.rejects(fixture.copy(), error => {
        assert.notEqual(error.cause, original);
        assert.equal(error.cause.details.name, 'TimeoutError');
        assert.equal(error.code, 'STORAGE_UNREACHABLE');
        assert.equal(error.details.bucket, storage.bucket);
        assert.equal(error.details.destinationKey, 'ns/destination');
        assert.equal(error.details.uploadId, 'upload-id');
        assert.equal(error.details.abortStatus, abortFails ? 'failed' : 'acknowledged');
        assert.notEqual(error.details.abortError?.cause, abortFailure);
        assert.equal(error.details.abortError?.details.name, abortFails ? 'Error' : undefined);
        assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /secret-token/);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.doesNotMatch(JSON.stringify(error.details), /secret-token/);
        assert.equal(error.details.completionStatus, stage === 'complete' ? 'unknown' : 'not-attempted');
        if (stage === 'complete') assert.match(error.hint, /may have succeeded.*Retain/);
        return true;
      });
      assert.ok(fixture.calls.at(-1) instanceof AbortMultipartUploadCommand);
    }
  }
});

test('a retried conditional PUT returning 412 is ambiguous, never a proven rejection', async t => {
  let attempts = 0;
  const client = new S3Client({
    region: 'us-east-1', endpoint: 'http://localhost:9000', forcePathStyle: true,
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret' }, maxAttempts: 2,
    requestHandler: { handle: async () => {
      const first = ++attempts === 1;
      return { response: { statusCode: first ? 500 : 412, headers: { 'content-type': 'application/xml' }, body: Buffer.from(`<Error><Code>${first ? 'InternalError' : 'PreconditionFailed'}</Code></Error>`) } };
    }, destroy() {} },
  });
  t.after(() => client.destroy());
  const store = new S3ObjectStore(resolveStorage(storage), client);
  await assert.rejects(store.putObjectIfAbsent('ns/target', 'record'), { code: 'STORAGE_ERROR' });
  assert.equal(attempts, 2);
});

test('storageConfigFromEnv reads the VOLUMES_S3_* convention shared by the CLI, examples and live tests', () => {
  const required = { VOLUMES_S3_BUCKET: 'my-volumes', VOLUMES_S3_ACCESS_KEY_ID: 'id', VOLUMES_S3_SECRET_ACCESS_KEY: 'secret' };
  assert.deepEqual(storageConfigFromEnv(required), { bucket: 'my-volumes', accessKeyId: 'id', secretAccessKey: 'secret' });
  const full = storageConfigFromEnv({
    ...required,
    VOLUMES_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    VOLUMES_S3_SANDBOX_ENDPOINT: 'http://minio:9000',
    VOLUMES_S3_REGION: 'auto',
    VOLUMES_S3_PREFIX: 'my-app',
    VOLUMES_S3_PROVIDER: 'Cloudflare',
    VOLUMES_S3_SESSION_TOKEN: 'session',
    VOLUMES_S3_FORCE_PATH_STYLE: '0',
    UNRELATED: 'ignored',
  });
  assert.deepEqual(full, {
    ...{ bucket: 'my-volumes', accessKeyId: 'id', secretAccessKey: 'secret' },
    endpoint: 'https://acct.r2.cloudflarestorage.com', sandboxEndpoint: 'http://minio:9000', region: 'auto', prefix: 'my-app',
    provider: 'Cloudflare', sessionToken: 'session', forcePathStyle: false,
  });
  assert.equal(resolveStorage(full).prefix, 'my-app', 'the result is a valid StorageConfig');
  assert.equal(storageConfigFromEnv({ ...required, VOLUMES_S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle, true);
  assert.deepEqual(storageConfigFromEnv({ ...required, VOLUMES_S3_ENDPOINT: '', VOLUMES_S3_PREFIX: '' }), { bucket: 'my-volumes', accessKeyId: 'id', secretAccessKey: 'secret' }, 'empty variables count as unset');

  assert.throws(() => storageConfigFromEnv({ VOLUMES_S3_BUCKET: 'b', VOLUMES_S3_SECRET_ACCESS_KEY: '' }), (error) => error instanceof ValidationError && /Missing environment variables: VOLUMES_S3_ACCESS_KEY_ID, VOLUMES_S3_SECRET_ACCESS_KEY\./.test(error.message));
  assert.throws(() => storageConfigFromEnv({ ...required, VOLUMES_S3_FORCE_PATH_STYLE: 'yes' }), ValidationError);
});
