import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleSandbox, freestyleSandboxes, createVolumeReadySnapshot, MountError, SandboxError, ValidationError } from '../../dist/index.js';

const BOOTSTRAP_OK = { stdout: 'FSVOL_RESULT rclone=/opt/freestyle-volumes/bin/rclone version=1.75.1 fusermount=/usr/bin/fusermount3 arch=x86_64\n', stderr: '', statusCode: 0 };

// A scripted `Vm` handle of the freestyle SDK: exec pops canned results.
class FakeVm {
  constructor(id, responses = []) {
    this.id = id;
    this.responses = [...responses];
    this.execCalls = [];
    this.snapshotCalls = [];
    this.deleteCalls = 0;
    this.deleteError = undefined;
  }
  async exec(options) {
    this.execCalls.push(options);
    const next = this.responses.shift();
    if (next === undefined) throw new Error(`FakeVm ${this.id}: no canned response`);
    if (next instanceof Error) throw next;
    return next;
  }
  async snapshot(options) {
    this.snapshotCalls.push(options);
    return { snapshotId: 'sh-built', sourceVmId: this.id };
  }
  async delete() {
    this.deleteCalls += 1;
    if (this.deleteError) throw this.deleteError;
  }
}

function fakeFreestyle(vm) {
  const creates = [];
  return {
    creates,
    vms: {
      async create(options) {
        creates.push(options);
        return { vm, vmId: vm.id, data: {}, firewallRules: [], tlsRules: [] };
      },
      ref: () => vm,
    },
  };
}

test('FreestyleSandbox runs scripts as root, clamps timeouts to the exec cap and maps results', async () => {
  const vm = new FakeVm('vm-1', [
    { stdout: 'out', stderr: 'err', statusCode: 3 },
    { stdout: null, statusCode: null },
    { stdout: 'x', stderr: 'y', statusCode: 0 },
  ]);
  const sandbox = new FreestyleSandbox(vm);
  assert.equal(sandbox.id, 'vm-1');
  assert.deepEqual(await sandbox.exec({ command: 'true', timeoutMs: 999_999 }), { stdout: 'out', stderr: 'err', exitCode: 3 });
  assert.deepEqual(vm.execCalls[0], { command: 'true', linuxUser: 'root', timeoutMs: 300_000 });
  assert.deepEqual(await sandbox.exec({ command: 'sleep 9', timeoutMs: 0, env: { A: 'b' } }), { stdout: '', stderr: '', exitCode: null }, 'a killed command reports exitCode null');
  assert.deepEqual(vm.execCalls[1], { command: 'sleep 9', linuxUser: 'root', timeoutMs: 1, env: { A: 'b' } });

  const asUbuntu = new FreestyleSandbox(vm, { linuxUser: 'ubuntu' });
  await asUbuntu.exec({ command: 'id', timeoutMs: 5000 });
  assert.equal(vm.execCalls[2].linuxUser, 'ubuntu');
  assert.equal(Object.hasOwn(vm.execCalls[2], 'env'), false, 'env is only sent when the caller passes one');
});

test('freestyleSandboxes resolves VM ids and slugs through vms.ref without a network call', () => {
  const refs = [];
  const client = { vms: { ref: (id) => { refs.push(id); return new FakeVm(id); } } };
  const sandbox = freestyleSandboxes(client, { linuxUser: 'root' }).get('my-slug');
  assert.ok(sandbox instanceof FreestyleSandbox);
  assert.equal(sandbox.id, 'my-slug');
  assert.deepEqual(refs, ['my-slug']);
});

test('createVolumeReadySnapshot bootstraps a builder VM, snapshots it and deletes the builder', async () => {
  const vm = new FakeVm('vm-builder', [BOOTSTRAP_OK]);
  const freestyle = fakeFreestyle(vm);
  const events = [];
  const result = await createVolumeReadySnapshot(freestyle, {
    baseSnapshotId: 'freestyle/ubuntu-sm',
    slug: 'ubuntu-sm-volumes',
    displayName: 'Ubuntu small with volumes',
    onEvent: (event) => events.push(event.type),
  });

  assert.deepEqual(result, {
    snapshotId: 'sh-built',
    slug: 'ubuntu-sm-volumes',
    builderVmId: 'vm-builder',
    runtime: { rclonePath: '/opt/freestyle-volumes/bin/rclone', rcloneVersion: '1.75.1', fusermountPath: '/usr/bin/fusermount3', arch: 'x86_64' },
    warnings: [],
  });
  assert.deepEqual(freestyle.creates, [{
    snapshotId: 'freestyle/ubuntu-sm',
    displayName: 'freestyle-volumes-snapshot-builder',
    metadata: { 'freestyle-volumes': 'snapshot-builder' },
    ttlSeconds: 3600,
    firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  }]);
  assert.equal(vm.execCalls.length, 1);
  assert.equal(vm.execCalls[0].linuxUser, 'root');
  assert.equal(vm.execCalls[0].timeoutMs, 240_000);
  assert.equal(Object.hasOwn(vm.execCalls[0], 'env'), false, 'the bootstrap never receives storage credentials');
  assert.match(vm.execCalls[0].command, /downloads\.rclone\.org/);
  assert.deepEqual(vm.snapshotCalls, [{ slug: 'ubuntu-sm-volumes', displayName: 'Ubuntu small with volumes' }]);
  assert.equal(vm.deleteCalls, 1);
  assert.deepEqual(events, ['builder.created', 'runtime.ready', 'snapshot.created', 'builder.deleted']);
});

test('createVolumeReadySnapshot uses the platform default snapshot and custom firewall when asked', async () => {
  const vm = new FakeVm('vm-builder', [BOOTSTRAP_OK]);
  const freestyle = fakeFreestyle(vm);
  const firewall = { rules: [{ action: 'allow', source: {}, destination: { public: true, port: 443, protocol: 'tcp' } }] };
  const result = await createVolumeReadySnapshot(freestyle, { firewall, bootstrapTimeoutMs: 300_000, builderTtlSeconds: 900, onEvent: () => { throw new Error('observer bug'); } });
  assert.equal(result.slug, null);
  assert.equal(Object.hasOwn(freestyle.creates[0], 'snapshotId'), false);
  assert.equal(freestyle.creates[0].firewall, firewall);
  assert.equal(freestyle.creates[0].ttlSeconds, 900);
  assert.equal(vm.execCalls[0].timeoutMs, 300_000);
  assert.deepEqual(vm.snapshotCalls, [{}]);
});

test('createVolumeReadySnapshot deletes the builder and takes no snapshot when the bootstrap fails', async () => {
  const noFuse = new FakeVm('vm-nofuse', [{ stdout: 'FSVOL_ERR no-dev-fuse\n', stderr: '', statusCode: 12 }]);
  await assert.rejects(createVolumeReadySnapshot(fakeFreestyle(noFuse)), (error) => error instanceof MountError && error.code === 'FUSE_UNAVAILABLE');
  assert.deepEqual(noFuse.snapshotCalls, []);
  assert.equal(noFuse.deleteCalls, 1);

  const slow = new FakeVm('vm-slow', [{ stdout: '', stderr: '', statusCode: null }]);
  await assert.rejects(createVolumeReadySnapshot(fakeFreestyle(slow)), (error) => error instanceof SandboxError && error.code === 'SANDBOX_EXEC_TIMEOUT');
  assert.equal(slow.deleteCalls, 1);
});

test('createVolumeReadySnapshot reports a builder it could not delete instead of failing the build', async () => {
  const vm = new FakeVm('vm-stuck', [BOOTSTRAP_OK]);
  vm.deleteError = new Error('503 Service Unavailable');
  const events = [];
  const result = await createVolumeReadySnapshot(fakeFreestyle(vm), { onEvent: (event) => events.push(event) });
  assert.equal(result.snapshotId, 'sh-built');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /vm-stuck.*503 Service Unavailable.*3600 s/);
  assert.equal(events.at(-1).type, 'warning');
});

test('createVolumeReadySnapshot validates options before booting anything', async () => {
  const vm = new FakeVm('vm-never', []);
  const freestyle = fakeFreestyle(vm);
  for (const slug of ['', 'Upper', 'under_score', '-lead', 'trail-', 'double--hyphen', 'a'.repeat(64), 42]) {
    await assert.rejects(createVolumeReadySnapshot(freestyle, { slug }), ValidationError, `slug ${JSON.stringify(slug)}`);
  }
  await assert.rejects(createVolumeReadySnapshot(freestyle, { bootstrapTimeoutMs: 300_001 }), ValidationError);
  await assert.rejects(createVolumeReadySnapshot(freestyle, { bootstrapTimeoutMs: 1.5 }), ValidationError);
  await assert.rejects(createVolumeReadySnapshot(freestyle, { builderTtlSeconds: 599 }), ValidationError);
  assert.deepEqual(freestyle.creates, []);

  for (const slug of ['a', 'ubuntu-sm-volumes', 'v2', 'a'.repeat(63)]) {
    const ok = new FakeVm('vm-ok', [BOOTSTRAP_OK]);
    assert.equal((await createVolumeReadySnapshot(fakeFreestyle(ok), { slug })).slug, slug);
  }
});
