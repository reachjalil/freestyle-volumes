// Opt-in only: pnpm build && node test/bench/registry-clone.mjs --run
// JSON goes to stdout; no production endpoint or credentials are accepted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { FreestyleVolumes, S3ObjectStore, resolveStorage, RCLONE_VERSION } from '../../dist/index.js';
import { Stack, docker, dockerAvailable, MINIO_IMAGE, SANDBOX_IMAGE } from '../helpers/stack.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error('Opt-in benchmark: pnpm build && node test/bench/registry-clone.mjs --run');
  process.exit(2);
}
assert.ok(dockerAvailable(), 'Docker must be available; VOLUMES_SKIP_INTEGRATION must not be 1');

const repetitions = 6;
const registryCount = 1024; // Exercises two S3 listing pages.
const sizes = [0, 4096, 65536, 1048576];
const fixtureCount = 64;
const seed = 0x5eed1234;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const median = xs => {
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}
async function pool(items, fn) {
  let next = 0;
  // Drain all workers on failure before stack cleanup.
  const results = await Promise.allSettled(Array.from({ length: 8 }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
function imageReference(container, requested) {
  const id = docker(['inspect', '--format', '{{.Image}}', container]).stdout.trim();
  const info = JSON.parse(docker(['image', 'inspect', '--format', '{{json .}}', id]).stdout);
  return { requested, id, digests: info.RepoDigests, os: info.Os, architecture: info.Architecture };
}
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  return result.stdout.trim();
}
const stack = new Stack();
let interrupted = false;
// Signals interrupt between operations, allowing finally to clean up only our stack.
const onSignal = () => { interrupted = true; };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
const checkSignal = () => { assert.ok(!interrupted, 'Benchmark interrupted'); };
const report = {
  schema: 1, startedAt: new Date().toISOString(), backend: 'actual local MinIO',
  repetitions, warmupPairs: 1, order: 'warmup 1,8; measured pairs alternate 1,8 and 8,1',
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, v8: process.versions.v8 },
  git: { head: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
  hashes: Object.fromEntries(['src/registry.ts', 'src/storage.ts', 'src/volumes.ts',
    'dist/registry.js', 'dist/storage.js', 'dist/volumes.js', 'pnpm-lock.yaml',
    'test/helpers/stack.mjs', 'test/bench/registry-clone.mjs'].map(path => [path, sha256(readFileSync(`${root}${path}`))])),
  awsSdk: JSON.parse(readFileSync(new URL('../../node_modules/@aws-sdk/client-s3/package.json', import.meta.url))).version,
  registry: { count: registryCount, samples: [] },
  clone: { seed, count: fixtureCount, sizesBytes: sizes, objectsPerSize: fixtureCount / sizes.length, samples: [] },
};

try {
  const start = await timed(() => stack.start());
  report.stackStartMs = start.ms;
  checkSignal();
  // No FUSE mount: rclone version is contextual, not on either measured path.
  const guest = stack.sandbox({ fuse: false });
  const rclone = stack.exec(guest, 'rclone version');
  assert.equal(rclone.status, 0);
  const engine = JSON.parse(docker(['info', '--format', '{{json .}}']).stdout);
  report.docker = { version: engine.ServerVersion, os: engine.OperatingSystem,
    kernel: engine.KernelVersion, architecture: engine.Architecture, cpus: engine.NCPU,
    memoryBytes: engine.MemTotal, storageDriver: engine.Driver };
  report.images = { minio: imageReference(stack.minio, MINIO_IMAGE), rclone: imageReference(guest, SANDBOX_IMAGE) };
  report.rclone = { configuredVersion: RCLONE_VERSION, containerVersion: rclone.stdout.trim(), usedInTimedPath: false };

  const runPrefix = `bench-${stack.id}`;
  function api(suffix) {
    const config = stack.storage(`${runPrefix}/${suffix}`);
    // Reuse stack-owned client; it is destroyed by Stack.stop().
    const store = new S3ObjectStore(resolveStorage(config), stack.s3);
    const volumes = new FreestyleVolumes({ storage: config, objectStore: store,
      sandboxes: { get() { assert.fail('Benchmark must never resolve a guest'); } } });
    return { store, volumes, prefix: config.prefix };
  }
  const registry = api('registry');
  const names = Array.from({ length: registryCount }, (_, i) => `record-${String(i).padStart(4, '0')}`);
  // Fixed valid v1 metadata gives byte-identical records across repetitions (and
  // fixed byte lengths across runs). Only the isolated namespace varies.
  let metadataBytes = 0;
  report.registry.seedMs = (await timed(() => pool(names, async name => {
    const record = JSON.stringify({ version: 1, id: name, name, createdAt: '2026-01-01T00:00:00.000Z',
      labels: { fixture: 'seed-5eed1234' }, backend: 'rclone-s3', dataPrefix: `${registry.prefix}/v/${name}` });
    metadataBytes += Buffer.byteLength(record);
    await registry.store.putObject(`${registry.prefix}/_volumes/${name}.json`, record);
  }))).ms;
  report.registry.metadataBytes = metadataBytes;
  report.registry.recordBytes = metadataBytes / registryCount;
  const baseline = await registry.volumes.list({ concurrency: 1 });
  assert.deepEqual(baseline.map(v => v.name), names);
  for (let pair = -1; pair < repetitions; pair++) {
    checkSignal();
    for (const concurrency of pair < 0 || pair % 2 === 0 ? [1, 8] : [8, 1]) {
      const result = await timed(() => registry.volumes.list({ concurrency }));
      assert.deepEqual(result.value, baseline);
      if (pair >= 0) report.registry.samples.push({ pair, concurrency, totalMs: result.ms });
    }
  }
  // Real LIST-only cost, reported separately; not subtracted from API timings.
  report.registry.listOnlyMs = [];
  for (let i = 0; i < repetitions; i++) {
    const result = await timed(async () => {
      let count = 0;
      for await (const _ of registry.store.listObjects(`${registry.prefix}/_volumes/`)) count++;
      assert.equal(count, registryCount);
    });
    report.registry.listOnlyMs.push(result.ms);
  }

  const clone = api('clone');
  const source = await clone.volumes.create({ name: 'source' });
  let state = seed;
  const fixtures = Array.from({ length: fixtureCount }, (_, i) => {
    const body = Buffer.alloc(sizes[i % sizes.length]);
    for (let j = 0; j < body.length; j++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      body[j] = state & 255;
    }
    return { name: `nested/${String(i).padStart(3, '0')} space +%#é!'().bin`, body, hash: sha256(body) };
  });
  report.clone.bytes = fixtures.reduce((sum, f) => sum + f.body.length, 0);
  report.clone.manifestSha256 = sha256(JSON.stringify(fixtures.map(f => [f.name, f.body.length, f.hash])));
  report.clone.seedMs = (await timed(() => pool(fixtures, f => stack.s3.send(new PutObjectCommand({
    Bucket: stack.bucket, Key: `${source.dataPrefix}/${f.name}`, Body: f.body,
    ContentType: 'application/octet-stream', Metadata: { fixture: 'seed-5eed1234' },
  }))))).ms;
  async function verify(volume) {
    assert.deepEqual(await stack.listKeys(`${volume.dataPrefix}/`), fixtures.map(f => `${volume.dataPrefix}/${f.name}`).sort());
    await pool(fixtures, async f => {
      const response = await stack.s3.send(new GetObjectCommand({ Bucket: stack.bucket, Key: `${volume.dataPrefix}/${f.name}` }));
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      assert.equal(bytes.length, f.body.length);
      assert.equal(sha256(bytes), f.hash);
      assert.equal(response.ContentType, 'application/octet-stream');
      assert.deepEqual(response.Metadata, { fixture: 'seed-5eed1234' });
    });
  }
  await verify(source);
  let metrics;
  const allowedDataCommands = new Set(['HeadObjectCommand', 'GetObjectTaggingCommand',
    'CopyObjectCommand', 'CreateMultipartUploadCommand', 'UploadPartCopyCommand',
    'CompleteMultipartUploadCommand', 'AbortMultipartUploadCommand']);
  const dataGuard = (next, context) => async args => {
    const current = metrics;
    const input = args.input;
    const dataKey = /\/(?:v|v2)\//.test(input.Key ?? '');
    if (current && dataKey) {
      assert.ok(allowedDataCommands.has(context.commandName), 'No payload GET/PUT or unsupported data command during clone');
      assert.equal(input.Bucket, stack.bucket);
      assert.equal(input.Body, undefined, 'No payload upload body during clone');
      if (['HeadObjectCommand', 'GetObjectTaggingCommand'].includes(context.commandName)) {
        assert.ok(input.Key.startsWith(`${source.dataPrefix}/`), 'Metadata reads must target the source');
        if (context.commandName === 'HeadObjectCommand') assert.ok(input.IfMatch, 'HEAD must be ETag conditional');
      } else {
        assert.ok(input.Key.startsWith(`${clone.prefix}/v2/`));
        assert.ok(!input.Key.startsWith(`${source.dataPrefix}/`), 'Do not mutate the source');
      }
      if (['CopyObjectCommand', 'UploadPartCopyCommand'].includes(context.commandName)) {
        assert.ok(input.CopySource, 'Copy must use a server-side source');
        assert.ok(input.CopySourceIfMatch, 'Copy must be ETag conditional');
      }
      current.dataCommands[context.commandName] = (current.dataCommands[context.commandName] ?? 0) + 1;
    }
    const response = await next(args);
    if (current && dataKey && response.output?.Body !== undefined) {
      current.dataResponseBodies++;
      response.output.Body?.destroy?.();
      assert.fail('No data response body or streaming payload may be downloaded during clone');
    }
    return response;
  };
  metrics = { dataCommands: {}, dataResponseBodies: 0 };
  let dispatched = 0;
  const noBody = async () => { dispatched++; return { output: {} }; };
  const sourceInput = { Bucket: stack.bucket, Key: `${source.dataPrefix}/guard-probe`, IfMatch: '"probe"' };
  for (const commandName of ['GetObjectCommand', 'PutObjectCommand', 'UploadPartCommand']) {
    await assert.rejects(dataGuard(noBody, { commandName })({ input: sourceInput }), /No payload GET\/PUT/);
  }
  assert.equal(dispatched, 0);
  for (const commandName of ['HeadObjectCommand', 'GetObjectTaggingCommand']) {
    await dataGuard(noBody, { commandName })({ input: sourceInput });
  }
  assert.equal(dispatched, 2);
  let streamDestroyed = false;
  await assert.rejects(dataGuard(async () => ({ output: { Body: { destroy() { streamDestroyed = true; } } } }),
    { commandName: 'HeadObjectCommand' })({ input: sourceInput }), /No data response body/);
  assert.equal(streamDestroyed, true);
  metrics = undefined;
  report.clone.guardSelfChecksPassed = true;
  stack.s3.middlewareStack.add(dataGuard, { step: 'initialize', name: 'benchmarkDataGuard' });
  const copyObject = clone.store.copyObject.bind(clone.store);
  clone.store.copyObject = async (...args) => {
    assert.ok(args[0].startsWith(`${source.dataPrefix}/`));
    assert.ok(args[1].startsWith(`${clone.prefix}/v2/`));
    const start = performance.now();
    metrics.first ??= start;
    metrics.calls++;
    metrics.active++;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    try { return await copyObject(...args); }
    finally {
      metrics.active--;
      metrics.last = performance.now();
    }
  };
  for (let pair = -1; pair < repetitions; pair++) {
    checkSignal();
    for (const concurrency of pair < 0 || pair % 2 === 0 ? [1, 8] : [8, 1]) {
      metrics = { calls: 0, active: 0, peak: 0, dataCommands: {}, dataResponseBodies: 0 };
      const result = await timed(() => clone.volumes.clone({ sourceVolumeId: source.id,
        name: `target-${pair < 0 ? 'warmup' : pair}-${concurrency}`, concurrency }));
      const measured = metrics;
      metrics = undefined;
      assert.equal(measured.calls, fixtureCount);
      assert.equal(measured.peak, concurrency);
      assert.deepEqual(measured.dataCommands, { HeadObjectCommand: fixtureCount, CopyObjectCommand: fixtureCount });
      assert.equal(measured.dataResponseBodies, 0);
      assert.equal(result.value.copiedObjects, fixtureCount);
      assert.equal(result.value.copiedBytes, report.clone.bytes);
      assert.deepEqual(await clone.volumes.get(result.value.volume.id), result.value.volume);
      const verification = await timed(() => verify(result.value.volume));
      const cleanup = await timed(() => clone.volumes.delete({ volumeId: result.value.volume.id, confirm: result.value.volume.id }));
      assert.equal(cleanup.value.deletedObjects, fixtureCount);
      assert.deepEqual(await stack.listKeys(`${result.value.volume.dataPrefix}/`), []);
      if (pair >= 0) report.clone.samples.push({ pair, concurrency, totalMs: result.ms,
        copyWindowMs: measured.last - measured.first,
        nonCopyMs: result.ms - (measured.last - measured.first),
        verificationMs: verification.ms, destinationDeleteMs: cleanup.ms,
        copyCalls: measured.calls, peakCopies: measured.peak,
        dataCommands: measured.dataCommands, dataResponseBodies: measured.dataResponseBodies });
    }
  }
  report.clone.finalSourceVerificationMs = (await timed(() => verify(source))).ms;
  report.clone.sourceUnchanged = true;
  for (const section of [report.registry, report.clone]) {
    section.medians = [1, 8].map(concurrency => {
      const rows = section.samples.filter(s => s.concurrency === concurrency);
      const fields = Object.keys(rows[0]).filter(k => k.endsWith('Ms'));
      return { concurrency, ...Object.fromEntries(fields.map(k => [k, median(rows.map(r => r[k]))])) };
    });
    section.ratioC1OverC8 = section.medians[0].totalMs / section.medians[1].totalMs;
  }
  report.registry.listOnlyMedianMs = median(report.registry.listOnlyMs);
} finally {
  report.stackStopMs = (await timed(() => stack.stop())).ms;
  // Stack.stop is best-effort; verify every owned resource really disappeared.
  for (const name of [stack.minio, ...stack.sandboxes]) {
    const ids = docker(['ps', '-aq', '--filter', `name=^/${name}$`]).stdout.trim();
    assert.equal(ids, '', `Owned container remains: ${name}`);
  }
  const networks = docker(['network', 'ls', '-q', '--filter', `name=^${stack.network}$`]).stdout.trim();
  assert.equal(networks, '', 'Owned network remains');
  report.cleanupVerified = true;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
report.finishedAt = new Date().toISOString();
console.log(JSON.stringify(report, null, 2));
