// reconcile, removeStaleRecords and removeOrphanGeneration over a namespace with every kind of leftover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FreestyleVolumes, MemoryObjectStore } from '../../dist/index.js';
import { fakeResolver, storage } from '../helpers/fake-sandbox.mjs';

const ns = storage.prefix;
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

async function leftovers() {
  const store = new MemoryObjectStore();
  const volumes = new FreestyleVolumes({ storage, sandboxes: fakeResolver([]), objectStore: store });
  const live = await volumes.create({ name: 'live' });
  store.objects.set(`${live.dataPrefix}/data.txt`, 'live data');
  const cloned = await volumes.clone({ sourceVolumeId: 'live', name: 'cloned' });

  const oldOp = randomUUID();
  const intent = (operationId, destination, createdAt) => JSON.stringify({ version: 1, operationId, source: live, destination: { id: destination, name: destination, createdAt, labels: {}, backend: 'rclone-s3', generation: operationId, dataPrefix: `${ns}/v2/${destination}/${operationId}` } });
  store.objects.set(`${ns}/_operations/${oldOp}.json`, intent(oldOp, 'copy', daysAgo(2)));
  store.objects.set(`${ns}/v2/copy/${oldOp}/data.txt`, 'half a clone');
  const freshOp = randomUUID();
  store.objects.set(`${ns}/_operations/${freshOp}.json`, intent(freshOp, 'fresh', new Date().toISOString()));
  store.objects.set(`${ns}/v2/fresh/${freshOp}/a`, 'a');
  store.objects.set(`${ns}/v2/fresh/${freshOp}/b/`, '');
  const oldGeneration = randomUUID();
  store.objects.set(`${ns}/v2/live/${oldGeneration}/stale.bin`, 'from a deleted, recreated volume');
  store.objects.set(`${ns}/_operations/not-a-uuid.json`, '{}');
  store.objects.set(`${ns}/v/ghost/file`, 'legacy data without a record');

  store.objects.set(`${ns}/_leases/gone.json`, JSON.stringify({ version: 1, volumeId: 'gone', generation: randomUUID(), sandboxId: 'vm-9', mountId: 'm9', mountPath: '/mnt/gone', acquiredAt: daysAgo(1) }));
  store.objects.set(`${ns}/_deleting/gone.json`, JSON.stringify({ version: 1, volumeId: 'gone', generation: randomUUID() }));
  store.objects.set(`${ns}/_deleting/live.json`, JSON.stringify({ version: 1, volumeId: 'live', generation: live.generation }));
  store.objects.set(`${ns}/_attachments/gone/vm-9__m9.json`, JSON.stringify({ version: 1, volumeId: 'gone', sandboxId: 'vm-9', mountId: 'm9', mountPath: '/mnt/gone', subpath: null, readOnly: false, attachedAt: daysAgo(1) }));
  store.objects.set(`${ns}/_doctor/${randomUUID()}.json`, '{"probe":"freestyle-volumes"}');
  store.objects.set(`${ns}/_volumes/broken.json`, 'torn');
  store.objects.set(`${ns}/v2/broken/${randomUUID()}/kept`, 'data of a record that failed validation');
  return { store, volumes, live, cloned, oldOp, freshOp, oldGeneration };
}

test('reconcile reports every kind of leftover and nothing that is in use', async () => {
  const { volumes, live, cloned, oldOp, freshOp, oldGeneration } = await leftovers();
  const report = await volumes.reconcile();
  assert.equal(report.prefix, ns);
  assert.equal(report.volumes, 2);
  assert.deepEqual(report.invalidRecords.map((r) => r.volumeId), ['broken']);
  const orphans = Object.fromEntries(report.orphanGenerations.map((o) => [`${o.volumeId}/${o.generation}`, o]));
  assert.deepEqual(Object.keys(orphans).sort(), [`copy/${oldOp}`, `fresh/${freshOp}`, `live/${oldGeneration}`].sort(), 'published generations and unvalidated records are never orphans');
  assert.deepEqual({ ...orphans[`copy/${oldOp}`], startedAt: typeof orphans[`copy/${oldOp}`].startedAt }, { volumeId: 'copy', generation: oldOp, objects: 1, bytes: 12, operationId: oldOp, startedAt: 'string' });
  assert.deepEqual([orphans[`fresh/${freshOp}`].objects, orphans[`live/${oldGeneration}`].operationId], [2, null]);
  assert.deepEqual(report.orphanLegacyData, [{ volumeId: 'ghost', objects: 1, bytes: 28 }]);
  const operations = Object.fromEntries(report.operations.map((o) => [o.operationId, o.status]));
  assert.equal(operations[cloned.operationId], 'published');
  assert.equal(operations[oldOp], 'unpublished');
  assert.equal(operations[freshOp], 'unpublished');
  assert.deepEqual(report.deletingMarkers.map((m) => [m.volumeId, m.volumeExists]).sort(), [['gone', false], ['live', true]]);
  assert.equal(report.deletingMarkers.find((m) => m.volumeId === 'live').generation, live.generation);
  assert.deepEqual(report.staleLeases.map((l) => l.volumeId), ['gone']);
  assert.deepEqual(report.staleAttachments.map((a) => `${a.volumeId}:${a.sandboxId}`), ['gone:vm-9']);
  assert.equal(report.doctorProbes.length, 1);
});

test('removeStaleRecords deletes metadata that points at nothing and keeps interrupted deletes', async () => {
  const { store, volumes } = await leftovers();
  const before = [...store.objects.keys()].filter((key) => key.includes('/v2/') || key.includes('/v/')).sort();
  const removed = await volumes.removeStaleRecords();
  assert.deepEqual(removed, { leases: 1, deletingMarkers: 1, attachments: 1, doctorProbes: 1 });
  assert.ok(store.objects.has(`${ns}/_deleting/live.json`), 'an interrupted delete is finished by delete, not by forgetting it');
  assert.deepEqual([...store.objects.keys()].filter((key) => key.includes('/v2/') || key.includes('/v/')).sort(), before, 'volume data is never touched');
  assert.deepEqual(await volumes.removeStaleRecords(), { leases: 0, deletingMarkers: 0, attachments: 0, doctorProbes: 0 });
});

test('removeOrphanGeneration needs confirmation and refuses published or recent generations', async () => {
  const { store, volumes, live, oldOp, freshOp, oldGeneration } = await leftovers();
  await assert.rejects(volumes.removeOrphanGeneration({ volumeId: 'copy', generation: oldOp, confirm: 'copy' }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(volumes.removeOrphanGeneration({ volumeId: 'live', generation: live.generation, confirm: `live/${live.generation}` }), (error) => error.code === 'VOLUME_IN_USE' && /published/.test(error.message));
  await assert.rejects(volumes.removeOrphanGeneration({ volumeId: 'fresh', generation: freshOp, confirm: `fresh/${freshOp}` }), (error) => error.code === 'VOLUME_IN_USE' && /could still publish/.test(error.message));
  await assert.rejects(volumes.removeOrphanGeneration({ volumeId: 'copy', generation: 'not-a-uuid', confirm: 'copy/not-a-uuid' }), { code: 'VALIDATION' });

  assert.deepEqual(await volumes.removeOrphanGeneration({ volumeId: 'copy', generation: oldOp, confirm: `copy/${oldOp}` }), { volumeId: 'copy', generation: oldOp, deletedObjects: 1, intentRemoved: true });
  assert.equal(store.objects.has(`${ns}/_operations/${oldOp}.json`), false);
  assert.deepEqual(await volumes.removeOrphanGeneration({ volumeId: 'fresh', generation: freshOp, confirm: `fresh/${freshOp}`, minAgeSeconds: 0 }), { volumeId: 'fresh', generation: freshOp, deletedObjects: 2, intentRemoved: true });
  assert.deepEqual(await volumes.removeOrphanGeneration({ volumeId: 'live', generation: oldGeneration, confirm: `live/${oldGeneration}` }), { volumeId: 'live', generation: oldGeneration, deletedObjects: 1, intentRemoved: false });
  assert.equal(store.objects.get(`${live.dataPrefix}/data.txt`), 'live data', 'the published generation is untouched');
  const report = await volumes.reconcile();
  assert.deepEqual(report.orphanGenerations, []);
});
