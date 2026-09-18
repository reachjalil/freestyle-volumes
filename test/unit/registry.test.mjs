import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolumeRegistry, MemoryObjectStore, VolumeAlreadyExistsError, VolumeNotFoundError, VolumeError } from '../../dist/index.js';

test('create is explicit by default and idempotent with ifNotExists', async () => {
  const registry = new VolumeRegistry(new MemoryObjectStore(), 'ns');
  const created = await registry.create({ name: 'data', labels: { team: 'x' } });
  assert.equal(created.id, 'data');
  assert.equal(created.name, 'data');
  assert.equal(created.dataPrefix, `ns/v2/data/${created.generation}`);
  assert.deepEqual(created.labels, { team: 'x' });
  await assert.rejects(registry.create({ name: 'data' }), VolumeAlreadyExistsError);
  const again = await registry.create({ name: 'data' }, { ifNotExists: true });
  assert.equal(again.createdAt, created.createdAt);
  assert.deepEqual(await registry.get('data'), created);
  await assert.rejects(registry.get('nope'), VolumeNotFoundError);
  assert.equal(await registry.find('nope'), undefined);
});

test('list returns volumes of this namespace only', async () => {
  const store = new MemoryObjectStore();
  const a = new VolumeRegistry(store, 'tenant-a');
  const b = new VolumeRegistry(store, 'tenant-b');
  await a.create({ name: 'shared-name' });
  await a.create({ name: 'alpha' });
  await b.create({ name: 'shared-name' });
  await store.putObject('tenant-a/_volumes/nested/_volumes/alpha.json', 'null');
  assert.deepEqual((await a.list()).map((v) => v.id), ['alpha', 'shared-name']);
  assert.deepEqual((await b.list()).map((v) => v.id), ['shared-name']);
  assert.match((await a.get('shared-name')).dataPrefix, /^tenant-a\/v2\/shared-name\//);
  assert.match((await b.get('shared-name')).dataPrefix, /^tenant-b\/v2\/shared-name\//);
});

test('delete removes only the volume data prefix and refuses while attachments exist', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  const { dataPrefix: own } = await registry.create({ name: 'data' });
  const { dataPrefix: sibling } = await registry.create({ name: 'data-2' });
  await store.putObject(`${own}/`, '');
  await store.putObject(`${own}/file.txt`, 'hello');
  await store.putObject(`${own}/dir/nested.txt`, 'x');
  await store.putObject(`${sibling}/file.txt`, 'keep');
  await registry.putAttachment({ volumeId: 'data', sandboxId: 'vm-1', mountId: 'abc', mountPath: '/mnt/data', subpath: null, readOnly: false, attachedAt: 't' });
  await assert.rejects(registry.delete('data'), (error) => error instanceof VolumeError && error.code === 'VOLUME_IN_USE' && /vm-1:\/mnt\/data/.test(error.message));
  assert.equal(await store.getObject(`${own}/file.txt`), 'hello', 'nothing deleted on refusal');
  await registry.removeAttachment('data', 'vm-1', 'abc');
  const result = await registry.delete('data');
  assert.equal(result.deletedObjects, 3);
  assert.equal(await store.getObject(`${own}/file.txt`), undefined);
  assert.equal(await store.getObject(`${sibling}/file.txt`), 'keep', 'sibling volume untouched');
  assert.equal(await registry.find('data'), undefined);
  await assert.rejects(registry.delete('data'), VolumeNotFoundError);
});

test('delete with force ignores stale attachment records and removes them', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  await registry.create({ name: 'data' });
  await registry.putAttachment({ volumeId: 'data', sandboxId: 'vm-gone', mountId: 'abc', mountPath: '/mnt/data', subpath: null, readOnly: false, attachedAt: 't' });
  const result = await registry.delete('data', { force: true });
  assert.equal(result.attachments.length, 1);
  assert.deepEqual(await registry.listAttachments('data'), []);
});

test('corrupt records surface as storage errors, not crashes', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  await store.putObject('ns/_volumes/bad.json', '{not json');
  await assert.rejects(registry.get('bad'), (error) => error instanceof VolumeError && error.code === 'STORAGE_ERROR');
  await store.putObject('ns/_volumes/other.json', JSON.stringify({ version: 1, id: 'mismatch', dataPrefix: 'x' }));
  await assert.rejects(registry.get('other'), (error) => error instanceof VolumeError && error.code === 'STORAGE_ERROR');
});

const storageError = (error) => error instanceof VolumeError && error.code === 'STORAGE_ERROR';

test('stored prefixes must exactly match the namespace and volume before any operation', async () => {
  for (const dataPrefix of ['ns', 'ns/v', 'ns/v/other', 'other/v/data', 'ns/v/data/', 'ns/v/data/../other', 'ns/v/data-2', '', null, 42]) {
    const store = new MemoryObjectStore();
    const registry = new VolumeRegistry(store, 'ns');
    const volume = await registry.create({ name: 'data' });
    await store.putObject('ns/v/data/file', 'own');
    await store.putObject('ns/v/other/file', 'sibling');
    await store.putObject('other/v/data/file', 'other tenant');
    await store.putObject(registry.volumeKey('data'), JSON.stringify({ version: 2, ...volume, dataPrefix }));
    const snapshot = [...store.objects];
    const listObjects = store.listObjects.bind(store);
    store.listObjects = (prefix, options) => {
      assert.equal(prefix, 'ns/_volumes/', 'invalid volume must not reach attachment or data operations');
      return listObjects(prefix, options);
    };
    await assert.rejects(registry.find('data'), storageError);
    await assert.rejects(registry.get('data'), storageError);
    await assert.rejects(registry.list(), storageError);
    await assert.rejects(registry.create({ name: 'data' }, { ifNotExists: true }), storageError);
    await assert.rejects(registry.delete('data', { force: true }), storageError);
    assert.deepEqual([...store.objects], snapshot, `no mutation for prefix ${JSON.stringify(dataPrefix)}`);
  }
});

test('malformed volume records consistently fail with STORAGE_ERROR', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  const volume = { version: 2, ...await registry.create({ name: 'data' }) };
  const malformed = [null, [], false, 1, 'text', {},
    ...Object.keys(volume).map((field) => { const copy = { ...volume }; delete copy[field]; return copy; }),
    ...[{ name: [] }, { createdAt: {} }, { createdAt: 'invalid' }, { labels: null }, { labels: [] },
      { labels: { team: 3 } }, { labels: { 'bad key': 'x' } }, { backend: 'unknown' }].map((fields) => ({ ...volume, ...fields }))];
  for (const record of malformed) {
    await store.putObject(registry.volumeKey('data'), JSON.stringify(record));
    await assert.rejects(registry.get('data'), storageError);
    await assert.rejects(registry.list(), storageError);
    await assert.rejects(registry.delete('data', { force: true }), storageError);
  }
});

// Hold both initial reads until each registry has observed absence. This makes
// the old read-then-unconditional-write implementation fail deterministically.
function racingStore() {
  const store = new MemoryObjectStore();
  const get = store.getObject.bind(store);
  let reads = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  store.getObject = async (key) => {
    const value = await get(key);
    if (++reads <= 2) {
      if (reads === 2) release();
      await barrier;
    }
    return value;
  };
  return store;
}

test('concurrent explicit creates have one winner and preserve its metadata', async () => {
  const store = racingStore();
  const registries = [new VolumeRegistry(store, 'ns'), new VolumeRegistry(store, 'ns')];
  const results = await Promise.allSettled(registries.map((r, i) => r.create({ name: 'data', labels: { owner: String(i) } })));
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof VolumeAlreadyExistsError);
  assert.deepEqual(await registries[0].get('data'), winners[0].value);
});

test('concurrent ifNotExists creates return the same winning metadata', async () => {
  const store = racingStore();
  const registries = [new VolumeRegistry(store, 'ns'), new VolumeRegistry(store, 'ns')];
  const results = await Promise.all(registries.map((r, i) => r.create({ name: 'data', labels: { owner: String(i) } }, { ifNotExists: true })));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await registries[0].get('data'), results[0]);
});

test('create fails closed for stores without atomic writes and ambiguous race outcomes', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  store.putObjectIfAbsent = undefined;
  await assert.rejects(registry.create({ name: 'data' }), storageError);
  assert.equal(store.objects.size, 0);
  store.putObjectIfAbsent = async () => false;
  await assert.rejects(registry.create({ name: 'data' }, { ifNotExists: true }), storageError);
  store.putObjectIfAbsent = async (key) => {
    await store.putObject(key, 'null');
    return false;
  };
  await assert.rejects(registry.create({ name: 'data' }, { ifNotExists: true }), storageError);
});

test('malformed advisory attachments cannot redirect attachment deletion', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  await registry.create({ name: 'data' });
  const valid = { version: 1, volumeId: 'data', sandboxId: 'vm', mountId: 'abc', mountPath: '/mnt/data', subpath: null, readOnly: false, attachedAt: 't' };
  const records = [null, [], {}, { ...valid, volumeId: 'other' }, { ...valid, mountId: '../other' },
    { ...valid, subpath: {} }, { ...valid, attachedAt: [] }, { ...valid, readOnly: 'false' }, valid];
  for (const [i, record] of records.entries()) {
    await store.putObject(`ns/_attachments/data/bad-${i}.json`, JSON.stringify(record));
  }
  await store.putObject('ns/_attachments/data/vm__abc.json', JSON.stringify(valid));
  await store.putObject('ns/_attachments/other/vm__abc.json', 'keep');
  assert.equal((await registry.listAttachments('data')).length, 1);
  await registry.delete('data', { force: true });
  assert.equal(await store.getObject('ns/_attachments/other/vm__abc.json'), 'keep');
  assert.equal(await store.getObject('ns/_attachments/data/vm__abc.json'), undefined);
});

test('metadata listing bounds concurrent reads and keeps sorted results', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  for (const name of ['d', 'c', 'b', 'a']) await registry.create({ name });
  const get = store.getObject.bind(store);
  let active = 0, peak = 0;
  let batch = [];
  store.getObject = async key => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => {
      batch.push(resolve);
      if (batch.length === 2) { const ready = batch; batch = []; ready.forEach(r => r()); }
    });
    active--;
    return get(key);
  };
  assert.deepEqual((await registry.list({ concurrency: 2 })).map(v => v.name), ['a', 'b', 'c', 'd']);
  assert.equal(peak, 2);
  await assert.rejects(registry.list({ concurrency: 0 }), { code: 'VALIDATION' });
});
