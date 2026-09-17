# Coming from Daytona volumes

Daytona documents volumes as FUSE-backed mounts over an S3-compatible object store, created by name, mounted into sandboxes at a `mountPath` with an optional `subpath`, shared between sandboxes with last-write-wins semantics, and slower than local disk. This library reproduces that developer experience on Freestyle. It does not claim Daytona API compatibility, and some behaviours differ; they are listed below.

## Mapping

| Daytona (TypeScript SDK) | freestyle-volumes |
| :--- | :--- |
| `const daytona = new Daytona()` | `const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle) })` |
| `await daytona.volume.create('data')` | `await volumes.create({ name: 'data' })` |
| `await daytona.volume.get('data', true)` | `await volumes.get('data', { create: true })` |
| `await daytona.volume.list()` | `await volumes.list()` |
| `await daytona.volume.delete(volume)` | `await volumes.delete({ volumeId: volume.id, confirm: volume.id })` |
| `daytona.create({ volumes: [{ volumeId, mountPath: '/home/daytona/data', subpath: 'tenant-1' }] })` | `freestyle.vms.create({...})` then `volumes.attach({ sandboxId: vmId, volumeId, mountPath: '/home/ubuntu/data', subpath: 'tenant-1' })` |
| (sandbox deleted → volume detached) | `await volumes.detach({ sandboxId, mountPath })` before deleting the VM |
| `volume.id` (UUID) and `volume.name` | `volume.id === volume.name` |
| `volume.state` (`pending`, `ready`, `error`, ...) | not present; a created volume is ready |

## Before and after

Daytona:

```ts
const daytona = new Daytona();
const volume = await daytona.volume.get('models', true);
const sandbox = await daytona.create({ volumes: [{ volumeId: volume.id, mountPath: '/home/daytona/models' }] });
await sandbox.process.executeCommand('ls /home/daytona/models');
await daytona.delete(sandbox);
```

Freestyle with freestyle-volumes:

```ts
const freestyle = new Freestyle({ apiKey });
const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle) });
const volume = await volumes.get('models', { create: true });
const { vm, vmId } = await freestyle.vms.create({
  snapshotId: 'freestyle/ubuntu-sm',
  firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
});
await volumes.attach({ sandboxId: vmId, volumeId: volume.id, mountPath: '/home/ubuntu/models', uid: 1000, gid: 1000 });
await vm.exec('ls /home/ubuntu/models');
await volumes.detach({ sandboxId: vmId, mountPath: '/home/ubuntu/models' });
await vm.delete();
```

## Differences that matter

1. **Mount after creation, not at creation.** Freestyle's `vms.create` has no volume parameter; `attach` runs once the VM is up. First attach on a fresh VM takes longer (fuse3 install, rclone download) unless the snapshot has them preinstalled. Snapshot a prepared VM and boot clones from it to skip the bootstrap.
2. **You bring the bucket.** Daytona hosts the object store. Here `storage` is your own S3-compatible bucket and credentials; they are handed to the sandbox as environment variables for the duration of the mount.
3. **Explicit detach with a durability answer.** Daytona unmounts implicitly. `detach()` here waits for pending uploads and tells you whether they finished. Call it before deleting a VM if the last writes matter.
4. **Read-only mounts** exist (`readOnly: true`). Daytona's API does not expose that.
5. **Delete is confirmed and guarded.** `confirm` must equal the volume id, and delete refuses while attachment records exist (`force` overrides).
6. **Ids are names.** Anything that stored Daytona UUIDs needs to store names instead.
7. **No volume states or quotas.** No provisioning phase, no per-organization limits from this library; your bucket's limits apply.
8. **Same sharing semantics, stated plainly.** Last write wins, listings are cached, no locks. Daytona documents the same caveat for its FUSE volumes.
