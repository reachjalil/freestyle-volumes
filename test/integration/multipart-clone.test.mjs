import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, GetObjectTaggingCommand, UploadPartCopyCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, PutBucketVersioningCommand } from '@aws-sdk/client-s3';
import { FreestyleVolumes, S3ObjectStore, resolveStorage } from '../../dist/index.js';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

const digest = body => createHash('sha256').update(body).digest('hex');

test('MinIO multipart clone preserves bytes/metadata/tags and aborts failed copies without unfinished uploads', { skip: !dockerAvailable() }, async t => {
  const stack = new Stack();
  t.after(() => stack.stop());
  await stack.start();
  const config = stack.storage('multipart-clone', { multipartCopyThresholdBytes: 5 * 1024 ** 2, multipartCopyPartSizeBytes: 5 * 1024 ** 2 });
  const payload = Buffer.alloc(11 * 1024 ** 2 + 17);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const metadata = { ContentType: 'application/octet-stream', ContentEncoding: 'gzip', ContentLanguage: 'fr', ContentDisposition: 'attachment; filename="fixture.bin"', CacheControl: 'max-age=321', Expires: new Date('2030-01-01T00:00:00Z'), Metadata: { owner: 'multipart-test', custom: 'preserved' } };
  const calls = [];
  let sourceKey, failureMode;
  const client = { send: async (command, options) => {
    calls.push(command);
    if (command instanceof GetObjectCommand) assert.notEqual(command.input.Key, sourceKey, 'clone must not download source bodies');
    if (command instanceof UploadPartCopyCommand && command.input.PartNumber === 2) {
      if (failureMode === 'injected') throw Error('injected second part failure');
      if (failureMode === 'mutation' || failureMode === 'version-pinned') {
        await stack.s3.send(new PutObjectCommand({ Bucket: stack.bucket, Key: sourceKey, Body: Buffer.alloc(payload.length, 42) }));
      }
    }
    const result = await stack.s3.send(command, options);
    if (failureMode === 'complete-response-lost' && command instanceof CompleteMultipartUploadCommand) throw Object.assign(Error('completion response lost'), { name: 'TimeoutError' });
    if (failureMode === 'malformed-complete' && command instanceof CompleteMultipartUploadCommand) return {};
    if (failureMode === 'malformed-copy' && command instanceof CopyObjectCommand) return { CopyObjectResult: {} };
    if (failureMode === 'missing-etag' && command instanceof UploadPartCopyCommand && command.input.PartNumber === 2) return {};
    return result;
  } };
  const store = new S3ObjectStore(resolveStorage(config), client);
  const volumes = new FreestyleVolumes({ storage: config, objectStore: store, sandboxes: { get() { assert.fail('no guest operations'); } } });
  const source = await volumes.create({ name: 'source' });
  const suffix = "nested/space +%#é!'().bin";
  sourceKey = `${source.dataPrefix}/${suffix}`;
  const putSource = () => stack.s3.send(new PutObjectCommand({ Bucket: stack.bucket, Key: sourceKey, Body: payload, ...metadata, Tagging: 'label=preserved&owner=integration' }));
  const assertNoUploads = async () => {
    const uploads = await stack.s3.send(new ListMultipartUploadsCommand({ Bucket: stack.bucket, Prefix: 'multipart-clone/' }));
    assert.deepEqual(uploads.Uploads ?? [], []);
    assert.notEqual(uploads.IsTruncated, true);
  };
  await putSource();
  const result = await volumes.clone({ sourceVolumeId: 'source', name: 'target', concurrency: 2 });
  assert.equal(result.copiedObjects, 1);
  assert.equal(result.copiedBytes, payload.length);
  const parts = calls.filter(command => command instanceof UploadPartCopyCommand);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(command => command.input.CopySourceRange), ['bytes=0-5242879', 'bytes=5242880-10485759', `bytes=10485760-${payload.length - 1}`]);
  assert.ok(parts.every(command => command.input.CopySourceIfMatch));
  const destinationKey = `${result.volume.dataPrefix}/${suffix}`;
  const body = await stack.s3.send(new GetObjectCommand({ Bucket: stack.bucket, Key: destinationKey }));
  assert.equal(digest(await body.Body.transformToByteArray()), digest(payload));
  const head = await stack.s3.send(new HeadObjectCommand({ Bucket: stack.bucket, Key: destinationKey }));
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(head[key], value, key);
  const tags = await stack.s3.send(new GetObjectTaggingCommand({ Bucket: stack.bucket, Key: destinationKey }));
  assert.deepEqual(tags.TagSet.sort((a, b) => a.Key.localeCompare(b.Key)), [{ Key: 'label', Value: 'preserved' }, { Key: 'owner', Value: 'integration' }]);
  await assertNoUploads();
  assert.deepEqual(await volumes.get('target'), result.volume);

  for (const mode of ['injected', 'mutation', 'missing-etag']) {
    await t.test(`abort after ${mode}`, async () => {
      await putSource();
      failureMode = mode;
      const before = calls.length;
      const error = await volumes.clone({ sourceVolumeId: 'source', name: `failed-${mode}`, concurrency: 1 }).catch(error => error);
      assert.equal(error.code, 'STORAGE_ERROR');
      assert.equal(error.details.abortStatus, 'acknowledged');
      assert.equal(error.details.cleanupStatus, 'uncertain');
      assert.ok(error.details.uploadId);
      assert.equal(calls.slice(before).filter(command => command instanceof AbortMultipartUploadCommand).length, 1);
      assert.equal(calls.slice(before).filter(command => command instanceof UploadPartCopyCommand).length, 2);
      if (mode === 'mutation') assert.equal(error.cause.cause.details.status, 412);
      await assert.rejects(volumes.get(`failed-${mode}`), { code: 'VOLUME_NOT_FOUND' });
      assert.deepEqual(await stack.listKeys(`${error.details.destinationPrefix}/`), []);
      await assertNoUploads();
    });
  }

  await t.test('lost completion response retains committed object without publishing or claiming cleanup', async () => {
    await putSource();
    failureMode = 'complete-response-lost';
    const error = await volumes.clone({ sourceVolumeId: 'source', name: 'ambiguous', concurrency: 1 }).catch(error => error);
    assert.equal(error.code, 'STORAGE_UNREACHABLE');
    assert.equal(error.details.completionUnknown, true);
    assert.equal(error.details.cleanupStatus, 'retained');
    assert.equal(error.details.publication, 'not-attempted');
    assert.deepEqual(await stack.listKeys(`${error.details.destinationPrefix}/`), [`${error.details.destinationPrefix}/${suffix}`]);
    await assert.rejects(volumes.get('ambiguous'), { code: 'VOLUME_NOT_FOUND' });
    await assertNoUploads();
  });

  for (const mode of ['malformed-complete', 'malformed-copy']) {
    await t.test(`${mode} retains committed bytes without publishing`, async () => {
      await putSource();
      failureMode = mode;
      const copyConfig = { ...config, ...(mode === 'malformed-copy' ? { multipartCopyThresholdBytes: 5 * 1024 ** 3 } : {}) };
      const copyStore = new S3ObjectStore(resolveStorage(copyConfig), client);
      const copyVolumes = new FreestyleVolumes({ storage: copyConfig, objectStore: copyStore, sandboxes: { get() { assert.fail('no guest operations'); } } });
      const error = await copyVolumes.clone({ sourceVolumeId: 'source', name: mode }).catch(error => error);
      assert.equal(error.code, 'STORAGE_ERROR');
      assert.equal(error.details.completionStatus, 'unknown');
      assert.equal(error.details.cleanupStatus, 'retained');
      assert.equal(error.details.publication, 'not-attempted');
      const copied = await stack.s3.send(new GetObjectCommand({ Bucket: stack.bucket, Key: `${error.details.destinationPrefix}/${suffix}` }));
      assert.equal(digest(await copied.Body.transformToByteArray()), digest(payload));
      await assert.rejects(volumes.get(mode), { code: 'VOLUME_NOT_FOUND' });
      await assertNoUploads();
    });
  }

  await t.test('versioned source remains pinned when its current object changes between parts', async () => {
    await stack.s3.send(new PutBucketVersioningCommand({ Bucket: stack.bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const selected = await putSource();
    assert.ok(selected.VersionId);
    failureMode = 'version-pinned';
    const before = calls.length;
    const pinned = await volumes.clone({ sourceVolumeId: 'source', name: 'versioned', concurrency: 1 });
    const versionedCalls = calls.slice(before);
    assert.ok(versionedCalls.filter(command => command instanceof UploadPartCopyCommand).every(command => command.input.CopySource.endsWith(`?versionId=${encodeURIComponent(selected.VersionId)}`)));
    assert.equal(versionedCalls.find(command => command instanceof GetObjectTaggingCommand).input.VersionId, selected.VersionId);
    const copied = await stack.s3.send(new GetObjectCommand({ Bucket: stack.bucket, Key: `${pinned.volume.dataPrefix}/${suffix}` }));
    assert.equal(digest(await copied.Body.transformToByteArray()), digest(payload));
    const current = await stack.s3.send(new HeadObjectCommand({ Bucket: stack.bucket, Key: sourceKey }));
    assert.notEqual(current.VersionId, selected.VersionId);
    await assertNoUploads();
  });
});
