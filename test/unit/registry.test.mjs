import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolumeRegistry, MemoryObjectStore, VolumeAlreadyExistsError, VolumeNotFoundError, VolumeError } from '../../dist/index.js';

test('create is explicit by default and idempotent with ifNotExists', async () => {
  const registry = new VolumeRegistry(new MemoryObjectStore(), 'ns');
  const created = await registry.create({ name: 'data', labels: { team: 'x' } });
  assert.equal(created.id, 'data');
  assert.equal(created.name, 'data');
  assert.equal(created.dataPrefix, 'ns/v/data');
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
  assert.deepEqual((await a.list()).map((v) => v.id), ['alpha', 'shared-name']);
  assert.deepEqual((await b.list()).map((v) => v.id), ['shared-name']);
  assert.equal((await a.get('shared-name')).dataPrefix, 'tenant-a/v/shared-name');
  assert.equal((await b.get('shared-name')).dataPrefix, 'tenant-b/v/shared-name');
});

test('delete removes only the volume data prefix and refuses while attachments exist', async () => {
  const store = new MemoryObjectStore();
  const registry = new VolumeRegistry(store, 'ns');
  await registry.create({ name: 'data' });
  await registry.create({ name: 'data-2' });
  await store.putObject('ns/v/data/', '');
  await store.putObject('ns/v/data/file.txt', 'hello');
  await store.putObject('ns/v/data/dir/nested.txt', 'x');
  await store.putObject('ns/v/data-2/file.txt', 'keep');
  await registry.putAttachment({ volumeId: 'data', sandboxId: 'vm-1', mountId: 'abc', mountPath: '/mnt/data', subpath: null, readOnly: false, attachedAt: 't' });
  await assert.rejects(registry.delete('data'), (error) => error instanceof VolumeError && error.code === 'VOLUME_IN_USE' && /vm-1:\/mnt\/data/.test(error.message));
  assert.equal(await store.getObject('ns/v/data/file.txt'), 'hello', 'nothing deleted on refusal');
  await registry.removeAttachment('data', 'vm-1', 'abc');
  const result = await registry.delete('data');
  assert.equal(result.deletedObjects, 3);
  assert.equal(await store.getObject('ns/v/data/file.txt'), undefined);
  assert.equal(await store.getObject('ns/v/data-2/file.txt'), 'keep', 'sibling volume untouched');
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
