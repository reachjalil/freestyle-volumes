import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, VolumeRegistry, MemoryObjectStore, mountIdFor, MAX_SINGLE_COPY_BYTES, MAX_CLONE_OBJECTS, MAX_CLONE_MANIFEST_BYTES } from '../../dist/index.js';
import { storage, FakeSandbox, fakeResolver, BOOTSTRAP_OK, MOUNT_OK } from '../helpers/fake-sandbox.mjs';
import { MAX_MULTIPART_COPY_BYTES } from '../../dist/storage.js';
import { StorageError } from '../../dist/errors.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup() {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  const source = await registry.create({ name: 'source' });
  for (const key of ['', 'a', 'dir/b']) await store.putObject(`${source.dataPrefix}/${key}`, key);
  return { store, registry, source };
}

test('partial clone is hidden from get/list/attach; bounded copy completion precedes publication; zero guest/body reads', async () => {
  const { store, registry, source } = await setup();
  let guestCalls = 0;
  const volumes = new FreestyleVolumes({ storage: { ...storage, prefix: 'ns' }, objectStore: store, sandboxes: { get() { guestCalls++; throw Error('guest'); } } });
  const entered = deferred(), release = deferred();
  const copy = store.copyObject.bind(store);
  let active = 0, peak = 0, completed = 0;
  store.copyObject = async (...args) => {
    peak = Math.max(peak, ++active);
    if (active === 2) entered.resolve();
    await release.promise;
    await copy(...args);
    active--; completed++;
  };
  const get = store.getObject.bind(store);
  store.getObject = key => { assert.ok(!key.startsWith(source.dataPrefix), 'no host data reads'); return get(key); };
  const pending = volumes.clone({ sourceVolumeId: 'source', name: 'target', concurrency: 2 });
  await entered.promise;
  assert.equal(await registry.find('target'), undefined);
  assert.deepEqual((await registry.list()).map(v => v.name), ['source']);
  await assert.rejects(volumes.attach({ volumeId: 'target', sandboxId: 'vm', mountPath: '/mnt/x' }), { code: 'VOLUME_NOT_FOUND' });
  release.resolve();
  const result = await pending;
  assert.equal(completed, 3);
  assert.equal(peak, 2);
  assert.equal(guestCalls, 0);
  assert.equal(result.operationId, result.volume.generation);
  assert.equal(result.copiedObjects, 3);
  assert.equal(result.copiedBytes, 6);
  for (const key of ['', 'a', 'dir/b']) assert.equal(store.objects.get(`${result.volume.dataPrefix}/${key}`), key);
  assert.ok(store.objects.has(`ns/_operations/${result.operationId}.json`));
});

test('same-name racing clones isolate loser cleanup from winner and source', async () => {
  const { store, registry, source } = await setup();
  const copy = store.copyObject.bind(store);
  const entered = deferred();
  let copies = 0;
  store.copyObject = async (...args) => { if (++copies === 6) entered.resolve(); await entered.promise; return copy(...args); };
  const results = await Promise.allSettled([registry.clone({ sourceVolumeId: 'source', name: 'target' }), registry.clone({ sourceVolumeId: 'source', name: 'target' })]);
  const winner = results.find(r => r.status === 'fulfilled').value;
  const loser = results.find(r => r.status === 'rejected').reason;
  assert.equal(loser.code, 'VOLUME_ALREADY_EXISTS');
  assert.equal(loser.details.publication, 'rejected');
  assert.equal(loser.details.cleanupStatus, 'completed');
  assert.notEqual(loser.details.destinationPrefix, winner.volume.dataPrefix);
  assert.deepEqual(await registry.get('target'), winner.volume);
  assert.ok(![...store.objects.keys()].some(k => k.startsWith(`${loser.details.destinationPrefix}/`)));
  assert.equal(store.objects.get(`${winner.volume.dataPrefix}/a`), 'a');
  assert.equal(store.objects.get(`${source.dataPrefix}/a`), 'a');
});

test('cleanup waits for all workers after one fails and touches only its operation prefix', async () => {
  const { store, registry, source } = await setup();
  const release = deferred(), failed = deferred();
  const copy = store.copyObject.bind(store);
  let calls = 0, deletions = 0;
  store.copyObject = async (...args) => {
    if (++calls === 1) { failed.resolve(); throw Error('copy failure'); }
    await release.promise;
    return copy(...args);
  };
  const del = store.deleteObjects.bind(store);
  store.deleteObjects = async keys => { deletions++; for (const k of keys) assert.ok(k.startsWith('ns/v2/target/')); return del(keys); };
  const pending = registry.clone({ sourceVolumeId: 'source', name: 'target', concurrency: 2 }).catch(e => e);
  await failed.promise;
  assert.equal(deletions, 0);
  release.resolve();
  const error = await pending;
  assert.equal(error.details.publication, 'not-attempted');
  assert.equal(error.details.cleanupStatus, 'uncertain');
  assert.equal(await registry.find('target'), undefined);
  assert.ok(![...store.objects.keys()].some(k => k.startsWith(`${error.details.destinationPrefix}/`)));
  assert.equal(store.objects.get(`${source.dataPrefix}/a`), 'a');
});

test('ambiguous publication retains copied data whether metadata committed or is absent', async () => {
  for (const commit of [false, true]) {
    const { store, registry } = await setup();
    const put = store.putObjectIfAbsent.bind(store);
    store.putObjectIfAbsent = async (key, body) => {
      if (key === registry.volumeKey('target')) { if (commit) await put(key, body); throw Error('response lost'); }
      return put(key, body);
    };
    const error = await registry.clone({ sourceVolumeId: 'source', name: 'target' }).catch(e => e);
    assert.equal(error.details.publication, 'unknown');
    assert.equal(error.details.cleanupStatus, 'retained');
    assert.equal(store.objects.get(`${error.details.destinationPrefix}/a`), 'a');
    assert.equal(Boolean(await registry.find('target')), commit);
  }
});

test('source attachments require explicit advisory override and ETags reject source mutation', async () => {
  const { store, registry, source } = await setup();
  await registry.putAttachment({ volumeId: 'source', sandboxId: 'vm', mountId: 'id', mountPath: '/mnt/x', subpath: null, readOnly: true, attachedAt: 'now' });
  await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target' }), e => e.code === 'VOLUME_IN_USE' && /advisory/.test(e.message) && !!e.details.operationId);
  await registry.clone({ sourceVolumeId: 'source', name: 'live', allowLiveSource: true });
  const copy = store.copyObject.bind(store);
  store.copyObject = async (...args) => { await store.putObject(args[0], 'changed'); return copy(...args); };
  await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target', allowLiveSource: true }), { code: 'STORAGE_ERROR' });
  assert.equal(await registry.find('target'), undefined);
  assert.ok(store.objects.has(`${source.dataPrefix}/a`));
});

test('unsupported copies, absent ETags and oversized objects fail before publication', async () => {
  for (const mode of ['unsupported', 'etag', 'oversize']) {
    const { store, registry } = await setup();
    let copies = 0;
    const list = store.listObjects.bind(store);
    if (mode === 'unsupported') store.copyObject = undefined;
    else {
      store.copyObject = async () => { copies++; };
      store.listObjects = async function* (prefix, options) {
        for await (const object of list(prefix, options)) yield prefix.includes('/v2/') ? { ...object, ...(mode === 'etag' ? { etag: undefined } : { size: MAX_MULTIPART_COPY_BYTES + 1 }) } : object;
      };
    }
    await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target' }));
    assert.equal(copies, 0);
    assert.equal(await registry.find('target'), undefined);
  }
});

test('registry accepts multipart-sized objects through the conservative 5 TiB cap', async () => {
  for (const size of [MAX_SINGLE_COPY_BYTES + 1, MAX_MULTIPART_COPY_BYTES]) {
    const { store, registry, source } = await setup();
    const list = store.listObjects.bind(store);
    store.listObjects = async function* (prefix, options) {
      if (prefix === `${source.dataPrefix}/`) yield { key: `${prefix}large`, size, etag: '"large"' };
      else yield* list(prefix, options);
    };
    let copies = 0;
    store.copyObject = async (sourceKey, destinationKey, options) => {
      assert.equal(sourceKey, `${source.dataPrefix}/large`);
      assert.ok(destinationKey.startsWith('ns/v2/target/'));
      assert.deepEqual(options, { size, sourceIfMatch: '"large"' });
      copies++;
    };
    const result = await registry.clone({ sourceVolumeId: 'source', name: 'target' });
    assert.equal(result.copiedBytes, size);
    assert.equal(copies, 1);
  }
});

test('ambiguous multipart completion retains generation even when a different worker fails first', async () => {
  for (const otherFailsFirst of [false, true]) {
    const { store, registry } = await setup();
    const copy = store.copyObject.bind(store);
    let copies = 0;
    store.copyObject = async (...args) => {
      const index = copies++;
      if (otherFailsFirst && index === 0) { await Promise.resolve(); throw Error('other worker failed first'); }
      await copy(...args);
      throw new StorageError('STORAGE_UNREACHABLE', 'completion response lost', { details: { completionStatus: 'unknown', uploadId: 'upload-id' } });
    };
    store.deleteObjects = async () => assert.fail('must retain data after ambiguous completion');
    const error = await registry.clone({ sourceVolumeId: 'source', name: 'target', concurrency: 2 }).catch(e => e);
    assert.equal(error.details.cleanupStatus, 'retained');
    assert.equal(error.details.completionUnknown, true);
    assert.ok(error.details.multipartFailures.some(failure => failure.uploadId === 'upload-id'));
    assert.equal(error.details.publication, 'not-attempted');
    assert.match(error.hint, /Copy completion may have succeeded/);
    assert.ok([...store.objects.keys()].some(key => key.startsWith(`${error.details.destinationPrefix}/`)));
    assert.ok(store.objects.has(`ns/_operations/${error.details.operationId}.json`));
    assert.equal(await registry.find('target'), undefined);
  }
});

test('strict v1/v2 prefix parsing and generation-specific cache identities', async () => {
  const { store, registry, source } = await setup();
  const legacy = { ...source, dataPrefix: 'ns/v/source' };
  delete legacy.generation;
  await store.putObject(registry.volumeKey('source'), JSON.stringify({ version: 1, ...legacy }));
  assert.deepEqual(await registry.get('source'), legacy);
  for (const record of [
    { version: 1, ...source },
    { version: 2, ...legacy },
    { version: 2, ...source, dataPrefix: `${source.dataPrefix}/` },
    { version: 2, ...source, generation: '../source' },
    { version: 2, ...source, dataPrefix: source.dataPrefix.replace('/source/', '/other/') },
    { version: 3, ...source },
  ]) {
    await store.putObject(registry.volumeKey('source'), JSON.stringify(record));
    await assert.rejects(registry.get('source'), { code: 'STORAGE_ERROR' });
  }
  await store.putObject(registry.volumeKey('source'), JSON.stringify({ version: 2, ...source }));
  assert.deepEqual(await registry.get('source'), source);
  await registry.delete('source');
  const recreated = await registry.create({ name: 'source' });
  assert.notEqual(recreated.dataPrefix, source.dataPrefix);
  assert.notEqual(mountIdFor('source', undefined, '/mnt/x', undefined, source.generation), mountIdFor('source', undefined, '/mnt/x', undefined, recreated.generation));
});

test('attach uses stored v1 and v2 prefixes and recreated volumes get distinct cache identities', async () => {
  const { store, registry, source } = await setup();
  const sandbox = new FakeSandbox('vm', [BOOTSTRAP_OK, MOUNT_OK, BOOTSTRAP_OK, MOUNT_OK, BOOTSTRAP_OK, MOUNT_OK]);
  const volumes = new FreestyleVolumes({ storage: { ...storage, prefix: 'ns' }, objectStore: store, sandboxes: fakeResolver([sandbox]) });
  const first = await volumes.attach({ volumeId: 'source', sandboxId: 'vm', mountPath: '/mnt/x' });
  assert.ok(sandbox.calls[1].command.includes(`fsvol:${storage.bucket}/${source.dataPrefix}`));
  await registry.delete('source', { force: true });
  const recreated = await registry.create({ name: 'source' });
  const second = await volumes.attach({ volumeId: 'source', sandboxId: 'vm', mountPath: '/mnt/x' });
  assert.notEqual(first.mountId, second.mountId);
  assert.ok(sandbox.calls[3].command.includes(`fsvol:${storage.bucket}/${recreated.dataPrefix}`));
  const { generation, ...legacy } = recreated;
  await store.putObject(registry.volumeKey('source'), JSON.stringify({ version: 1, ...legacy, dataPrefix: 'ns/v/source' }));
  const third = await volumes.attach({ volumeId: 'source', sandboxId: 'vm', mountPath: '/mnt/x', subpath: 'child' });
  assert.equal(third.mountId, mountIdFor('source', 'child', '/mnt/x', volumes.storage));
  assert.ok(sandbox.calls[5].command.includes(`fsvol:${storage.bucket}/ns/v/source/child`));
});

test('source deletion after selection prevents publication', async () => {
  const { store, registry } = await setup();
  const copy = store.copyObject.bind(store);
  store.copyObject = async (...args) => { await store.deleteObject(args[0]); return copy(...args); };
  await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target' }), { code: 'STORAGE_ERROR' });
  assert.equal(await registry.find('target'), undefined);
});

test('a concurrent ordinary create wins without clone cleanup touching its data', async () => {
  const { store, registry } = await setup();
  const entered = deferred(), release = deferred();
  const copy = store.copyObject.bind(store);
  store.copyObject = async (...args) => { entered.resolve(); await release.promise; return copy(...args); };
  const pending = registry.clone({ sourceVolumeId: 'source', name: 'target' }).catch(e => e);
  await entered.promise;
  const winner = await registry.create({ name: 'target' });
  await store.putObject(`${winner.dataPrefix}/own`, 'keep');
  release.resolve();
  const error = await pending;
  assert.equal(error.code, 'VOLUME_ALREADY_EXISTS');
  assert.deepEqual(await registry.get('target'), winner);
  assert.equal(store.objects.get(`${winner.dataPrefix}/own`), 'keep');
  assert.ok(![...store.objects.keys()].some(k => k.startsWith(`${error.details.destinationPrefix}/`)));
});

test('empty sources publish an isolated empty generation', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  const source = await registry.create({ name: 'source' });
  store.copyObject = async () => assert.fail('empty source needs no copies');
  const result = await registry.clone({ sourceVolumeId: 'source', name: 'target' });
  assert.equal(result.copiedObjects, 0);
  assert.equal(result.copiedBytes, 0);
  assert.notEqual(result.volume.generation, source.generation);
  assert.deepEqual(await registry.get('target'), result.volume);
});

test('both record versions reject cross-namespace, sibling and traversal prefixes', async () => {
  const { store, registry, source } = await setup();
  for (const version of [1, 2]) {
    const record = { version, ...source };
    if (version === 1) delete record.generation;
    for (const dataPrefix of ['ns', 'other/v/source', 'ns/v/other', 'ns/v/source/', 'ns/v/source/../other', `other/v2/source/${source.generation}`, `ns/v2/other/${source.generation}`, `${source.dataPrefix}/../other`]) {
      await store.putObject(registry.volumeKey('source'), JSON.stringify({ ...record, dataPrefix }));
      await assert.rejects(registry.get('source'), { code: 'STORAGE_ERROR' });
    }
  }
});

test('a remote copy completing after rejection and empty cleanup still reports uncertain cleanup', async () => {
  const { store, registry } = await setup();
  const releaseRemote = deferred();
  const copy = store.copyObject.bind(store);
  let remoteCompletion, destinationKey;
  store.copyObject = async (...args) => {
    destinationKey = args[1];
    remoteCompletion = releaseRemote.promise.then(() => copy(...args));
    throw Object.assign(new Error('client timed out but server is still copying'), { name: 'TimeoutError' });
  };
  const error = await registry.clone({ sourceVolumeId: 'source', name: 'target', concurrency: 1 }).catch(e => e);
  assert.equal(error.details.publication, 'not-attempted');
  assert.equal(error.details.cleanupStatus, 'uncertain');
  assert.match(error.message, /remote copies may complete after client failure/);
  assert.match(error.message, /empty listing does not prove cleanup is complete/);
  assert.equal(store.objects.has(destinationKey), false, 'cleanup saw an empty prefix');
  const intentKey = `ns/_operations/${error.details.operationId}.json`;
  assert.ok(store.objects.has(intentKey));
  releaseRemote.resolve();
  await remoteCompletion;
  assert.equal(store.objects.has(destinationKey), true, 'remote side effect outlives the rejected client promise');
  assert.equal(error.details.cleanupStatus, 'uncertain');
  assert.ok(store.objects.has(intentKey), 'ownership intent remains for manual reconciliation');
  assert.equal(await registry.find('target'), undefined);
});

test('manifest count budgets stop synthetic listings before copy/publication, including the default cap', async () => {
  assert.equal(MAX_CLONE_OBJECTS, 100_000);
  for (const maxObjects of [2, undefined]) {
    const { store, registry, source } = await setup();
    const list = store.listObjects.bind(store);
    let yielded = 0, closed = false;
    store.copyObject = async () => assert.fail('over-budget manifest must never start copying');
    store.listObjects = async function* (prefix, options) {
      if (prefix !== `${source.dataPrefix}/`) { yield* list(prefix, options); return; }
      try {
        for (let i = 0; ; i++) { yielded++; yield { key: `${prefix}${i}`, size: 0, etag: '"e"' }; }
      } finally { closed = true; }
    };
    const error = await registry.clone({ sourceVolumeId: 'source', name: 'target', maxObjects }).catch(e => e);
    assert.equal(error.code, 'VALIDATION');
    assert.equal(error.details.budget, 'maxObjects');
    assert.equal(error.details.cleanupStatus, 'not-needed');
    assert.equal(error.details.selectedObjects, maxObjects ?? MAX_CLONE_OBJECTS);
    assert.equal(yielded, (maxObjects ?? MAX_CLONE_OBJECTS) + 1);
    assert.equal(closed, true);
    assert.equal(await registry.find('target'), undefined);
    assert.ok(store.objects.has(`ns/_operations/${error.details.operationId}.json`));
    assert.ok(![...store.objects.keys()].some(k => k.startsWith('ns/v2/target/')));
  }
});

test('manifest UTF-8 JSON budget includes escaping, Unicode, commas and brackets with exact boundaries', async () => {
  const { store, registry, source } = await setup();
  const entries = [
    { key: `${source.dataPrefix}/é😀\ud800\u0000\t\n\\"`, size: 0, etag: '"a"' },
    { key: `${source.dataPrefix}/二\udfff`, size: 123, etag: '"b"' },
  ];
  const exactBytes = Buffer.byteLength(JSON.stringify(entries));
  const list = store.listObjects.bind(store);
  store.listObjects = async function* (prefix, options) {
    if (prefix === `${source.dataPrefix}/`) yield* entries;
    else yield* list(prefix, options);
  };
  let copies = 0;
  store.copyObject = async () => { copies++; };
  const error = await registry.clone({ sourceVolumeId: 'source', name: 'too-small', maxManifestBytes: exactBytes - 1 }).catch(e => e);
  assert.equal(error.details.budget, 'maxManifestBytes');
  assert.equal(error.details.cleanupStatus, 'not-needed');
  assert.equal(copies, 0);
  assert.equal(await registry.find('too-small'), undefined);
  const success = await registry.clone({ sourceVolumeId: 'source', name: 'exact', maxObjects: 2, maxManifestBytes: exactBytes });
  assert.equal(success.copiedObjects, 2);
  assert.equal(copies, 2);
});

test('default 32 MiB budget bounds synthetic large manifests before any copy starts', async () => {
  assert.equal(MAX_CLONE_MANIFEST_BYTES, 32 * 1024 ** 2);
  const { store, registry, source } = await setup();
  const list = store.listObjects.bind(store);
  let yielded = 0;
  store.copyObject = async () => assert.fail('byte-budget rejection must precede copies');
  store.listObjects = async function* (prefix, options) {
    if (prefix !== `${source.dataPrefix}/`) { yield* list(prefix, options); return; }
    while (true) { yielded++; yield { key: `${prefix}${yielded}-${'x'.repeat(900)}`, size: 1, etag: '"e"' }; }
  };
  const error = await registry.clone({ sourceVolumeId: 'source', name: 'target' }).catch(e => e);
  assert.equal(error.code, 'VALIDATION');
  assert.equal(error.details.budget, 'maxManifestBytes');
  assert.ok(error.details.manifestBytes <= MAX_CLONE_MANIFEST_BYTES);
  assert.ok(yielded < MAX_CLONE_OBJECTS);
  assert.equal(await registry.find('target'), undefined);
});

test('manifest caps cannot be bypassed with invalid overrides and tiny budgets reject huge entries', async () => {
  const { store, registry, source } = await setup();
  for (const [key, values] of Object.entries({ maxObjects: [0, -1, 1.5, '2', null, NaN, Infinity, MAX_CLONE_OBJECTS + 1], maxManifestBytes: [0, 1, -1, 2.5, '32', null, NaN, Infinity, MAX_CLONE_MANIFEST_BYTES + 1] })) {
    for (const value of values) {
      await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target', [key]: value }), { code: 'VALIDATION' });
    }
  }
  const list = store.listObjects.bind(store);
  store.copyObject = async () => assert.fail('oversized entry must not be copied');
  store.listObjects = async function* (prefix, options) {
    if (prefix === `${source.dataPrefix}/`) yield { key: `${prefix}${'\u0000'.repeat(1_000_000)}`, size: 0, etag: '"e"' };
    else yield* list(prefix, options);
  };
  await assert.rejects(registry.clone({ sourceVolumeId: 'source', name: 'target', maxManifestBytes: 128 }), e => e.details.budget === 'maxManifestBytes' && e.details.selectedObjects === 0);
  assert.equal(await registry.find('target'), undefined);
});
