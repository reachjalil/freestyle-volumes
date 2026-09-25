# Coming from Daytona volumes

[Daytona documents volumes](https://www.daytona.io/docs/en/volumes/) as FUSE-backed mounts over an S3-compatible object store, created by name, mounted into sandboxes at a `mountPath` with an optional `subpath`, and shared between sandboxes with nontransactional, last-write-wins semantics. This library reproduces that developer experience on Freestyle. It does not claim Daytona API compatibility, and some behaviours differ; they are listed below.

## Mapping

| Daytona (TypeScript SDK) | freestyle-volumes |
| :--- | :--- |
| `const daytona = new Daytona()` | `const volumes = new FreestyleVolumes({ storage, sandboxes: freestyleSandboxes(freestyle) })` |
| `await daytona.volume.create('data')` | `await volumes.create({ name: 'data' })` |
| `await daytona.volume.get('data', true)` | `await volumes.get('data', { create: true })` |
| `await daytona.volume.list()` | `await volumes.list()` |
| `await daytona.volume.delete(volume)` | `await volumes.delete({ volumeId: volume.id, confirm: volume.id })` |
| `daytona.create({ volumes: [{ volumeId, mountPath: '/home/daytona/data', subpath: 'tenant-1' }] })` | `createVmWithVolumes(freestyle, volumes, { vm: {...}, mounts: [{ volumeId, mountPath: '/home/ubuntu/data', subpath: 'tenant-1' }] })`, or `freestyle.vms.create({...})` then `volumes.attach(...)` |
| (sandbox deleted → volume detached) | `await volumes.detachAll({ sandboxId })` before deleting the VM; delete it when `flushed` is true |
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
const { flushed } = await volumes.detachAll({ sandboxId: vmId });
if (flushed) await vm.delete();
```

## Differences that matter

1. **Mount after creation, not at creation.** Freestyle's `vms.create` has no volume parameter; `attach` runs once the VM is up, and `createVmWithVolumes` wraps both steps, cleaning up if an attach fails. After a stop/start, `restoreMounts` puts the mounts back. First attach on a fresh VM takes longer (fuse3 install, rclone download) unless the snapshot has them preinstalled: build one with `createVolumeReadySnapshot` (CLI: `freestyle-volumes prepare-snapshot`) and boot VMs from it to skip the bootstrap.
2. **You bring the bucket.** Daytona hosts the object store. Here `storage` is your own S3-compatible bucket and credentials; they are handed to the sandbox as environment variables for the duration of the mount.
3. **Explicit detach with a durability answer.** Daytona unmounts implicitly. Here normal `detach()` externally unmounts, waits for FUSE serving to stop, drains the retained VFS, then stops the process. Require `flushed: true` before deleting a VM if the last writes matter. `FLUSH_FAILED` may leave the filesystem unmounted with the uploader/cache/state retained: restore storage access and retry detach. Forced uncertain detach retains recovery data and makes no durability claim.
4. **Read-only mounts** exist (`readOnly: true`). Daytona's API does not expose that.
5. **Delete is confirmed and advisory-guarded.** `confirm` must equal the volume id, and delete refuses while attachment records exist (`force` overrides). Records can be stale or missing and remain after uncertain forced detach. Applications must orchestrate distributed attach/delete races; the record check is not a lock.
6. **Ids are names.** Anything that stored Daytona UUIDs needs to store names instead.
7. **No volume states or quotas.** No provisioning phase, no per-organization limits from this library; your bucket's limits apply.
8. **Nontransactional sharing, not identical consistency.** Last write wins here, listings are cached, and there are no cross-sandbox file locks. Guest lifecycle `flock` only serializes operations at one mount path; it does not enforce a single writer. Daytona documents nontransactional sharing and immediate visibility; that visibility claim is not inherited by this library.
9. **Object clone, not a workspace snapshot.** `clone({ sourceVolumeId, name })` copies within the configured bucket/namespace with ETag conditions and atomic conditional publication. The caller must quiesce and drain the source; advisory attachment checks are not locks. Single copy is used at or below the configured threshold (default 5 GiB); larger objects use multipart copy up to a conservative 5 TiB per object, with sequential parts and conditional source checks. No COW, ACID, automatic GC or resume. Unknown completion/publication retains data; abort acknowledgment is not proof of destination absence. See [clone limits and recovery](performance.md#clone-api).
10. **Generation-specific data layout.** New records are v2; current clients still support legacy v1 records, but older v1-only clients cannot read v2. Use the returned `dataPrefix`, not a name-derived bucket path. See the [0.2.0 changelog](../CHANGELOG.md#020--2026-09-25).
11. **Explicit Git, separate from object cloning.** The optional [Git helper](git.md) runs preinstalled guest Git: explicit path-selected commits, clean ff-only pull, normal push and directional sync, not automatic commits or GitHub PR/REST operations. It is restricted to trusted, single-writer managed mounts and supported repository layouts; success is guest-local until separately verified detach. Prefer native active worktrees; this is not Daytona Git API compatibility or ACID storage.
