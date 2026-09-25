# API reference

This page lists everything `freestyle-volumes` exports, with its options, results and errors. For a guided introduction, start with the [README](../README.md). For exact durability and failure behavior, see [semantics](semantics.md).

Every method below is on a `FreestyleVolumes` instance unless it is marked as a standalone function. All methods return promises. Failures throw a [`VolumeError`](#errors) with a stable `code`.

- **Setup:** [`new FreestyleVolumes`](#new-freestylevolumes) · [storage configuration](#storage-configuration) · [mount options](#mount-options) · [sandbox credentials](#sandbox-credentials)
- **Volumes:** [`create`](#create) · [`get`](#get) · [`list`](#list) · [`usage`](#usage) · [`clone`](#clone) · [`delete`](#delete)
- **Mounts:** [`attach`](#attach) · [`detach`](#detach) · [`detachAll`](#detachall) · [`inspectMount`](#inspectmount) · [`listMounts`](#listmounts) · [`flush`](#flush) · [`flushAll`](#flushall) · [`restoreMounts`](#restoremounts) · [`discardMount`](#discardmount)
- **Leases and cleanup:** [`getLease`](#getlease) · [`releaseLease`](#releaselease) · [`reconcile`](#reconcile) · [`removeStaleRecords`](#removestalerecords) · [`removeOrphanGeneration`](#removeorphangeneration)
- **Preflight:** [`checkStorage`](#checkstorage) · [`checkSandbox`](#checksandbox)
- **Freestyle helpers:** [`freestyleSandboxes`](#freestylesandboxes) · [`createVmWithVolumes`](#createvmwithvolumes) · [`createVolumeReadySnapshot`](#createvolumereadysnapshot)
- **Other entry points:** [Docker](#dockersandboxes) · [Git](#volumegit) · [custom sandboxes](#custom-sandboxes) · [custom object stores](#custom-object-stores)
- [Events](#events) · [Errors](#errors)

## Setup

### new FreestyleVolumes

```ts
import { FreestyleVolumes, freestyleSandboxes, storageConfigFromEnv } from 'freestyle-volumes';

const volumes = new FreestyleVolumes({ storage: storageConfigFromEnv(), sandboxes: freestyleSandboxes(freestyle) });
```

| Option | Type | What it does |
| :--- | :--- | :--- |
| `storage` | `StorageConfig` | **Required.** The bucket and keys. See [storage configuration](#storage-configuration). |
| `sandboxes` | `SandboxResolver` | **Required.** How to run scripts in a VM: [`freestyleSandboxes(freestyle)`](#freestylesandboxes), [`dockerSandboxes()`](#dockersandboxes), or [your own](#custom-sandboxes). |
| `defaults` | `Partial<MountDefaults>` | Default [mount options](#mount-options) for every attach. |
| `sandboxCredentials` | `SandboxCredentials \| SandboxCredentialsProvider` | Keys for rclone in each VM, instead of `storage`'s keys. See [sandbox credentials](#sandbox-credentials). |
| `onEvent` | `(event: VolumeEvent) => void` | Progress [events](#events). An exception thrown by the handler is ignored. |
| `objectStore` | `ObjectStore` | Replaces the S3 client, for tests or another store. See [custom object stores](#custom-object-stores). |
| `backend` | `RcloneBackend` | Replaces the mount backend, for example to change the guest paths. |

The constructor validates every option and throws `VALIDATION` on bad input. It makes no network calls.

### Storage configuration

`storageConfigFromEnv(env = process.env)` builds a `StorageConfig` from the variables below and throws `VALIDATION` that names any missing required variable. The CLI uses the same function.

| Field | Variable | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `bucket` | `VOLUMES_S3_BUCKET` | required | The bucket that holds the volumes. It must exist; it is never created. |
| `accessKeyId`, `secretAccessKey` | `VOLUMES_S3_ACCESS_KEY_ID`, `VOLUMES_S3_SECRET_ACCESS_KEY` | required | Used by your process, and by rclone in the VM unless `sandboxCredentials` is set. |
| `sessionToken` | `VOLUMES_S3_SESSION_TOKEN` | none | For temporary credentials. |
| `endpoint` | `VOLUMES_S3_ENDPOINT` | AWS S3 | The S3 API URL as your process reaches it. |
| `sandboxEndpoint` | `VOLUMES_S3_SANDBOX_ENDPOINT` | `endpoint` | The S3 API URL as the VM reaches it, when that differs (private networks, Docker). |
| `region` | `VOLUMES_S3_REGION` | `us-east-1` | `auto` for Cloudflare R2; any value for MinIO. |
| `prefix` | `VOLUMES_S3_PREFIX` | `freestyle-volumes` | The namespace inside the bucket. Different prefixes never see each other's volumes. |
| `provider` | `VOLUMES_S3_PROVIDER` | `AWS`, or `Other` with an endpoint | rclone's provider hint: `Cloudflare`, `Minio`, `Ceph`, ... |
| `forcePathStyle` | `VOLUMES_S3_FORCE_PATH_STYLE` | `true` with an endpoint | Path-style addressing, which MinIO and most self-hosted services need. |
| `serverSideEncryption`, `sseKmsKeyId` | `VOLUMES_S3_SSE`, `VOLUMES_S3_SSE_KMS_KEY_ID` | bucket default | `AES256` or `aws:kms` (with an optional KMS key) on every object this library and rclone write, for buckets whose policy requires the header. Leave unset on Cloudflare R2, which always encrypts. |
| `storageClass` | `VOLUMES_S3_STORAGE_CLASS` | bucket default | Storage class for volume data (rclone uploads and clone copies), such as `STANDARD_IA`. Small records keep the default. |
| `requestTimeoutMs` | none | `15000` | Timeout of each storage request from your process, including each stage of a multipart copy. It is not a deadline for a whole clone. |
| `multipartCopyThresholdBytes` | none | 5 GiB | `clone` copies objects up to this size with one request and larger ones in parts. Integer bytes, 5 MiB to 5 GiB. |
| `multipartCopyPartSizeBytes` | none | 128 MiB | Part size of multipart copies, raised as needed to stay within 10,000 parts. Integer bytes, 5 MiB to 5 GiB. |

`sandboxCredentialsFromEnv(env = process.env)` reads `VOLUMES_S3_SANDBOX_ACCESS_KEY_ID`, `VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY` and `VOLUMES_S3_SANDBOX_SESSION_TOKEN`. It returns `undefined` when neither key is set and throws `VALIDATION` when only one is.

### Mount options

Set mount options for every attach with the constructor's `defaults`, or per call in `attach`. The flush and inspect timeouts are defaults only; `detach`, `flush` and `inspectMount` also take their own timeout.

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `cacheMode` | `'writes'` | `'writes'` buffers writes on the VM disk; `'full'` also caches reads. |
| `writeBackSeconds` | `5` | Seconds a closed file waits before its upload starts. Detach and flush start pending uploads at once. |
| `dirCacheSeconds` | `60` | Seconds directory listings are cached. Changes made by other VMs show up after this. |
| `allowOther` | `true` | Let users other than root use the mount. |
| `uid`, `gid` | unset (root) | The owner reported for every file. `1000` is the `ubuntu` user on Freestyle images. |
| `umask` | unset | Permission mask, such as `'022'`. |
| `cacheMaxSize` | unbounded | Eviction target for the cache, such as `'10G'`, or `'off'`. Files waiting to upload are never evicted. |
| `cacheMinFreeSpace` | `'1G'` | Evict clean cached files when the VM disk has less free space than this, or `'off'`. It protects the disk from read caching, not from writing faster than the bucket accepts. |
| `bufferSize` | rclone default | Memory buffer per open file, such as `'16M'` or `'0B'`. |
| `readAhead` | rclone default | Extra read-ahead. Takes effect only with `cacheMode: 'full'`, and does not turn it on. |
| `readChunkSize` | rclone default | Initial size of ranged reads, such as `'128M'`. |
| `readChunkSizeLimit` | rclone default | Maximum size of ranged reads, or `'off'`. |
| `transfers` | rclone default | Parallel uploads of the mount's rclone process, an integer from 1 to 64. |
| `readyTimeoutMs` | `30000` | How long attach waits for the mount to answer a directory listing. At most 270000. |
| `bootstrapTimeoutMs` | `240000` | How long installing fuse3 and rclone may take. At most 300000. |
| `flushTimeoutMs` | `60000` | How long detach and flush wait for uploads. At most 260000. |
| `inspectTimeoutMs` | `30000` | Timeout of `inspectMount` and `listMounts`. |

Sizes need explicit units (`'0B'`, `'16M'`, `'1GiB'`), because rclone reads a bare number as KiB. Freestyle limits one exec call to 300 s, and every timeout keeps each step within that limit. Attaching an already-mounted volume again does not change its options. For tuning advice, see [performance](performance.md#opt-in-mount-tuning).

### Sandbox credentials

By default, rclone in each VM gets the same keys as your process. `sandboxCredentials` replaces them with narrower ones; your process keeps using `storage`'s keys for volume records.

```ts
type SandboxCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: string | Date };
type SandboxCredentialsProvider = (request: SandboxCredentialsRequest) => SandboxCredentials | Promise<SandboxCredentials>;
```

Pass fixed keys, or a provider function. The provider is called for every attach (`purpose: 'mount'`) and every `checkSandbox` (`purpose: 'check'`) with the scope the keys must cover:

| Field | Meaning |
| :--- | :--- |
| `purpose` | `'mount'` or `'check'`. |
| `sandboxId`, `bucket`, `prefix` | The VM, the bucket and the namespace. |
| `keyPrefix` | The key prefix the keys must reach, without a trailing slash: the volume's data prefix plus any subpath for a mount, the namespace for a check. |
| `readOnly` | `true` for read-only mounts and for checks. |
| `volumeId`, `subpath`, `mountPath` | The mount's details; `null` for a check. |

`scopedPolicy({ bucket, keyPrefix, readOnly })` returns an IAM policy document that allows listing and reading `keyPrefix` and, unless `readOnly`, writing and deleting under it. Use it as the session policy of STS `AssumeRole` or `GetFederationToken`, or as the policy of a MinIO user. The [README](../README.md#give-each-vm-a-key-for-its-volume-only) has a complete STS example.

- If the provider throws, the attach fails. Your process's keys are never used as a fallback.
- With sandbox credentials, mounts skip rclone's request for the mount root (`no_head_object`), which a key limited to a prefix may not be allowed to make.
- rclone cannot refresh keys inside a running mount. `expiresAt` is recorded with the mount and shown by `inspectMount` and `listMounts`, and attach warns when it is less than 15 minutes away. Detach, or reattach with fresh keys, before then.

## Volumes

### create

```ts
create(options: { name: string; labels?: Record<string, string>; ifNotExists?: boolean }): Promise<Volume>
```

Creates a volume with a conditional write, so of two concurrent creates of one name, exactly one succeeds. The other fails with `VOLUME_ALREADY_EXISTS`, or with `ifNotExists: true` returns the existing volume.

- **Names** are 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. The name is also the volume's id.
- **Labels** are up to 32 string pairs. Keys are 1 to 63 characters of letters, digits, `.`, `_`, `/` and `-`, starting with a letter or digit; values are at most 256 characters.

```ts
interface Volume {
  id: string;           // same as name
  name: string;
  createdAt: string;    // ISO 8601
  labels: Record<string, string>;
  backend: 'rclone-s3';
  dataPrefix: string;   // where the files live in the bucket, e.g. freestyle-volumes/v2/datasets/<generation>
  generation?: string;  // absent only for volumes created before 0.2
}
```

### get

```ts
get(name: string, options?: { create?: boolean }): Promise<Volume>
```

Returns the volume, or throws `VOLUME_NOT_FOUND`. With `create: true`, creates it when it is missing, like Daytona's `volume.get(name, true)`.

### list

```ts
list(options?: { concurrency?: number; skipInvalid?: boolean; onInvalid?: (name: string, error: VolumeError) => void }): Promise<Volume[]>
```

Returns the volumes in the namespace, sorted by name. `concurrency` (1 to 64, default 8) limits parallel record reads. With `skipInvalid`, a malformed record is passed to `onInvalid` and skipped instead of failing the whole listing; storage errors still throw. The listing is not a snapshot: volumes created or deleted meanwhile may or may not appear.

### usage

```ts
usage(name: string): Promise<{ volumeId: string; dataPrefix: string; objects: number; bytes: number; directoryMarkers: number }>
```

Counts what is stored under the volume's data prefix, with one listing. `objects` includes the zero-byte `dir/` markers that rclone keeps for directories, which `directoryMarkers` counts separately.

### clone

```ts
clone(options: {
  sourceVolumeId: string;
  name: string;
  labels?: Record<string, string>;
  allowLiveSource?: boolean;  // skip the attachment check; adds no consistency
  concurrency?: number;       // parallel copies, 1 to 64, default 8
  maxObjects?: number;        // at most 100,000
  maxManifestBytes?: number;  // at most 32 MiB
}): Promise<{ volume: Volume; operationId: string; copiedObjects: number; copiedBytes: number }>
```

Copies every object of the source volume inside the bucket, without downloading anything, then publishes the new volume with a conditional write once every copy succeeded.

- **It is not a snapshot.** Stop all writers of the source and detach them with `flushed: true` before cloning. It refuses while the source has attachment records or a writer lease, unless `allowLiveSource`, and while the source is being deleted.
- **Limits:** 100,000 objects, 32 MiB of object metadata, and 5 TiB per object. Objects above 5 GiB are copied in parts.
- **Failures** carry `details.operationId` and `details.cleanupStatus`. Nothing is cleaned up when the outcome is uncertain; `reconcile` finds what a failed clone left behind.

See [clone semantics and recovery](semantics.md#clone-publication-and-reconciliation), and [copy settings and permissions](performance.md#clone-api).

### delete

```ts
delete(options: { volumeId: string; confirm: string; force?: boolean }): Promise<{ volumeId: string; deletedObjects: number; attachments: AttachmentRecord[] }>
```

Deletes every object under the volume's data prefix, then its attachment records, its lease and its record.

- `confirm` must equal `volumeId`, or it throws `CONFIRMATION_REQUIRED`.
- It refuses with `VOLUME_IN_USE` while attachment records or a writer lease exist, unless `force: true`.
- It writes a deleting marker first, so attaches and clones of the volume fail with `VOLUME_DELETING` until it finishes. If a delete is interrupted, run it again to finish it.
- On a versioned bucket, only current versions are deleted.

## Mounts

### attach

```ts
attach(options: {
  sandboxId: string;
  volumeId: string;
  mountPath: string;    // absolute; created if missing; must be empty
  readOnly?: boolean;
  subpath?: string;     // mount only this folder of the volume
  exclusive?: boolean;  // take the writer lease (writable mounts only)
  // ...and any mount option except flushTimeoutMs and inspectTimeoutMs
}): Promise<VolumeAttachment>
```

Mounts a volume into a VM and waits until the mount answers a directory listing. In order, it:

1. Checks the bucket from your process. Wrong keys, a missing bucket or an unreachable endpoint fail here, before anything happens in the VM.
2. Refuses with `VOLUME_DELETING` if a delete has started, and with `VOLUME_IN_USE` if another mount holds the writer lease (for writable mounts). With `exclusive: true`, takes the lease.
3. Installs fuse3, flock and rclone in the VM if needed, then starts the mount.

```ts
interface VolumeAttachment {
  sandboxId: string;
  volumeId: string;
  mountPath: string;
  subpath: string | null;
  readOnly: boolean;
  exclusive: boolean;                 // this mount holds the writer lease
  mountId: string;
  pid: number;
  alreadyAttached: boolean;           // the same volume was already mounted and healthy at this path
  cacheFreeBytes: number | null;      // free space on the VM disk that holds the cache
  credentialsExpireAt: string | null; // from sandboxCredentials, when the provider said
  warnings: string[];                 // for example low disk space or keys that expire soon
}
```

- **Repeating an attach is safe.** The same volume at the same path returns `alreadyAttached: true` without changing the mount.
- **A path that is still in use is refused.** If a stale mount or a still-running uploader is at the path, attach fails with `MOUNT_PATH_IN_USE`; `restoreMounts` handles that case.
- **A failed attach keeps its recovery state and cache**, and a lease it took is released only if no mount could have started (`details.leaseRetained` says so).
- Attach warns when the VM disk has less than 2 GiB free for the cache.
- `exclusive: true` with `readOnly: true` throws `VALIDATION`.

### detach

```ts
detach(options: { sandboxId: string; mountPath: string; flushTimeoutMs?: number; force?: boolean }): Promise<{
  status: 'detached' | 'absent';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  flushed: boolean;              // true only after every pending upload finished
  pendingUploads: number | null; // null when unknown
  warnings: string[];
}>
```

Unmounts, waits until FUSE stops serving, uploads everything still pending, then stops rclone and removes the cache. Only after `flushed: true` are the attachment record removed and a lease this mount held released. Detach never deletes volume data.

- **`FLUSH_FAILED`**: uploads did not finish within `flushTimeoutMs`. The directory may already be unmounted, but the uploader, cache and state remain. Restore bucket access and call `detach` again, optionally with a longer timeout.
- **`MOUNT_BUSY`**: a process in the VM still has files open. Close them and retry.
- **`force: true`**: detaches even when uploads cannot be confirmed. It then returns `flushed: false` with `pendingUploads`, and keeps the cache, state, attachment record and lease so the writes can still be recovered by attaching again.

### detachAll

```ts
detachAll(options: { sandboxId: string; flushTimeoutMs?: number; force?: boolean }): Promise<{
  sandboxId: string;
  flushed: boolean;                            // nothing unflushed is left in the VM
  results: Array<DetachResult | MountFailure>; // one per managed mount
  unmanaged: string[];                         // rclone mounts this library did not create; left alone
}>
```

Detaches every managed mount in the VM, one at a time. It never throws because of one mount: a mount it could not detach appears in `results` as `{ status: 'failed', error: { code, message } }`, with its recovery data kept. Call it before deleting or snapshotting a VM, and delete the VM only when `flushed` is true.

### inspectMount

```ts
inspectMount(options: { sandboxId: string; mountPath: string; timeoutMs?: number }): Promise<MountInspection>
```

Reports one mount's `status`:

| Status | Meaning |
| :--- | :--- |
| `mounted` | Healthy. |
| `stale` | This library attached something here, but the mount or its process is gone (a crash or restart), or an unmounted uploader is still draining. The cache may hold unflushed writes. |
| `absent` | Nothing this library manages is at this path. |
| `unmanaged` | An rclone mount that this library did not create. |

It also returns `volumeId`, `subpath`, `readOnly`, `exclusive`, `pid`, `responsive` (the mount answered within 5 seconds), `uploads` (`{ queued, inProgress, errored }`), `cacheBytes`, `startedAt`, `credentialsExpireAt` and `logTail`.

### listMounts

```ts
listMounts(options: { sandboxId: string; timeoutMs?: number }): Promise<{ sandboxId: string; mounts: MountSummary[]; unmanaged: string[] }>
```

Lists every mount this library manages in the VM, `mounted` or `stale`, sorted by path. Each entry has the volume, subpath, mode, pid, upload queue, cache size and key expiry. It takes no locks, so it shows progress while a detach or flush is running. `unmanaged` lists rclone mounts this library did not create.

### flush

```ts
flush(options: { sandboxId: string; mountPath: string; flushTimeoutMs?: number }): Promise<{
  status: 'flushed' | 'pending';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  flushed: boolean;              // every file closed before the call is in the bucket
  pendingUploads: number | null;
  erroredUploads: number | null;
  mounted: boolean;              // false when only an unmounted uploader was left to drain
}>
```

Uploads every file closed before the call and keeps the mount, like saving a checkpoint. A timeout returns `flushed: false` rather than throwing. A file that is still open for writing is uploaded when it is closed, so it is not covered.

It throws `MOUNT_NOT_FOUND` when nothing managed is mounted at the path, `MOUNT_STALE` when the uploader is gone (call `restoreMounts` first), and `MOUNT_BUSY` while another operation holds the path.

### flushAll

```ts
flushAll(options: { sandboxId: string; flushTimeoutMs?: number }): Promise<{ sandboxId: string; flushed: boolean; results: Array<FlushResult | MountFailure> }>
```

Flushes every managed mount in the VM. `flushed` is true when all of them flushed completely. Failures are listed in `results` rather than thrown.

### restoreMounts

```ts
restoreMounts(options: { sandboxId: string }): Promise<{
  sandboxId: string;
  restored: VolumeAttachment[]; // mounted again, pending uploads resumed
  alreadyMounted: string[];     // mount paths that were healthy
  failed: MountFailure[];
}>
```

After a VM stop/start or a crash, mounts every stale managed mount again with the options it was attached with, reusing its cache so the pending uploads resume. The options come from the state saved in the VM, which never includes keys; keys come from `sandboxCredentials` or `storage`, as for any attach. A mount that fails is listed in `failed`, and the others still proceed.

### discardMount

```ts
discardMount(options: { sandboxId: string; mountPath: string; confirm: string }): Promise<{
  status: 'discarded' | 'absent';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  discardedCacheBytes: number | null;
  warnings: string[];
}>
```

Deletes the cache and state that a forced or failed detach kept, along with the attachment record and lease they guarded. Writes in that cache that never reached the bucket are lost, so `confirm` must repeat `mountPath`. It refuses with `MOUNT_PATH_IN_USE` while the path is mounted or its uploader is still running.

## Leases and cleanup

### getLease

```ts
getLease(volumeId: string): Promise<LeaseRecord | null>
// LeaseRecord: { volumeId, generation, sandboxId, mountId, mountPath, acquiredAt }
```

Returns the holder of the volume's exclusive-writer lease, or `null`.

### releaseLease

```ts
releaseLease(options: { volumeId: string; confirm: string }): Promise<{ volumeId: string; released: boolean }>
```

Removes the lease, for example when the VM that held it was deleted. `confirm` must equal `volumeId`, because releasing lets other writers attach even if the old holder is still writing.

### reconcile

```ts
reconcile(): Promise<ReconcileReport>
```

Surveys the namespace without changing anything, and reports:

| Field | What it lists |
| :--- | :--- |
| `orphanGenerations` | Clone copies that no volume points at, with their size and the clone that owns them. |
| `orphanLegacyData` | Pre-0.2 data without a record. Remove it with your own S3 tools. |
| `operations` | Clone operations, and whether each one was published. |
| `deletingMarkers` | Interrupted deletes (`volumeExists: true`: run `delete` again to finish). |
| `staleLeases`, `staleAttachments` | Leases and attachment records of volumes that no longer exist. |
| `doctorProbes` | Probe objects that an interrupted `checkStorage` left behind. |
| `invalidRecords` | Volume records that fail validation. |

### removeStaleRecords

```ts
removeStaleRecords(): Promise<{ leases: number; deletingMarkers: number; attachments: number; doctorProbes: number }>
```

Deletes the records `reconcile` found that point at nothing: leases and attachment records of volumes that no longer exist, deleting markers whose volume is already gone, and leftover doctor probes. It returns how many of each it removed, and it never deletes volume data. A deleting marker whose volume still exists is left alone; finish that delete with `delete`.

### removeOrphanGeneration

```ts
removeOrphanGeneration(options: { volumeId: string; generation: string; confirm: string; minAgeSeconds?: number }): Promise<{
  volumeId: string;
  generation: string;
  deletedObjects: number;
  intentRemoved: boolean;
}>
```

Deletes the data of one clone copy that `reconcile` reported in `orphanGenerations`. `confirm` must be `<volumeId>/<generation>`. It refuses the generation a volume currently uses, and generations whose clone started less than `minAgeSeconds` ago (default 86400, one day), because that clone might still publish.

## Preflight

### checkStorage

```ts
checkStorage(): Promise<CheckReport>
// CheckReport: { ok: boolean; checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint?: string }> }
```

Checks the bucket from your process: that it exists and the keys reach it, that listing works, that the provider enforces conditional creates, and that a probe object reads back and deletes. The conditional-create check writes one probe object under `<prefix>/_doctor/` twice, expects the second write to be rejected, then deletes it. `ok` is false when any check failed; it never throws because of a failed check.

### checkSandbox

```ts
checkSandbox(options: { sandboxId: string; timeoutMs?: number }): Promise<CheckReport>
```

Checks a VM from the inside without installing or changing anything: CPU architecture, root, `/dev/fuse`, `fusermount3`, `flock`, rclone (and whether one can be downloaded), whether the VM can list the bucket with the keys its mounts would get, and free disk space for the cache. `warn` results are things attach installs for you, or checks that cannot run yet. Each warning and failure has a `hint`. The default timeout is 120000 ms.

## Freestyle helpers

### freestyleSandboxes

```ts
freestyleSandboxes(freestyle, options?: { linuxUser?: string }): SandboxResolver
```

Standalone function. Runs scripts in Freestyle VMs through `freestyle.vms.ref(vmId).exec(...)`, as `root` unless `linuxUser` says otherwise. The `sandboxId` you pass to the other methods is a VM id or slug. The adapter relies on types it defines itself rather than importing the `freestyle` SDK, so the SDK stays an optional peer dependency.

### createVmWithVolumes

```ts
createVmWithVolumes(freestyle, volumes, options: {
  vm: CreateVmOptions;            // passed to freestyle.vms.create; include a firewall rule that reaches the bucket
  mounts: VolumeMountSpec[];      // attach options without sandboxId, attached in order
  deleteOnFailure?: boolean;      // default true
}): Promise<{ vm: Vm; vmId: string; attachments: VolumeAttachment[] }>
```

Standalone function. Creates a VM, then attaches each mount in order, like Daytona's `create({ volumes })`. If an attach fails, it detaches what was already attached and deletes the VM, unless unflushed writes remain in it. With `deleteOnFailure: false`, it leaves the VM and its mounts as they are. Either way, it rethrows the error.

### createVolumeReadySnapshot

```ts
createVolumeReadySnapshot(freestyle, options?: {
  baseSnapshotId?: string;      // for example freestyle/ubuntu-sm; default: Freestyle's default image
  slug?: string;                // name to boot from: vms.create({ snapshotId: slug })
  displayName?: string;
  firewall?: FirewallSpec;      // for the builder VM; default: outbound to the public internet
  bootstrapTimeoutMs?: number;  // default 240000, at most 300000
  builderTtlSeconds?: number;   // default 3600 (600 to 86400)
  onEvent?: (event: { type: 'builder.created' | 'runtime.ready' | 'snapshot.created' | 'builder.deleted' | 'warning'; vmId: string; message?: string }) => void;
  backend?: RcloneBackend;      // only when your FreestyleVolumes uses a custom backend
}): Promise<{ snapshotId: string; slug: string | null; builderVmId: string; runtime: RuntimeInfo; warnings: string[] }>
```

Standalone function. Boots a temporary builder VM, runs the same install that attach would (fuse3, flock, and rclone 1.75.1 verified with SHA-256), takes a snapshot, and deletes the builder. It took 22.6 s on `freestyle/ubuntu-sm` in the live test.

- No storage keys are involved, so none can end up in the snapshot.
- Freestyle deletes the builder VM after `builderTtlSeconds` even if your process dies first. If the final delete fails, `warnings` says so.
- VMs booted from the snapshot keep the base snapshot's CPU, memory and disk, so build one snapshot per VM size you use.
- Any rclone of version 1.68 or later in a snapshot keeps being used after library upgrades.

## Other entry points

### dockerSandboxes

```ts
dockerSandboxes(options?: { dockerBinary?: string; user?: string }): SandboxResolver
```

```ts
import { dockerSandboxes } from 'freestyle-volumes/docker';

const volumes = new FreestyleVolumes({ storage, sandboxes: dockerSandboxes() });
```

Uses local Docker containers in place of VMs, through `docker exec`; the `sandboxId` is the container name or id. `dockerBinary` defaults to `docker`, and `user` to the container's configured user. The container needs `--device /dev/fuse --cap-add SYS_ADMIN`, and `--security-opt apparmor:unconfined` where AppArmor is enforced. The integration suite uses this adapter, and so does the CLI's `--docker` flag. See [examples/local-docker.ts](../examples/local-docker.ts).

### volumeGit

```ts
import { volumeGit } from 'freestyle-volumes/git';

const git = volumeGit({ volumes, sandboxes });
await git.clone({ sandboxId: vmId, mountPath: '/mnt/source', repoPath: 'repo', remote: 'owner/name', branch: 'main', token });
```

Explicit Git operations on a healthy managed mount: clone, status, commit, fast-forward pull, normal push, and one-direction sync. Git must already be installed in the VM. Failures throw `VolumeGitError`. The complete API and its trust boundary are in [git.md](git.md).

### Custom sandboxes

Any platform that can run a shell script as root can host mounts. Implement `SandboxResolver`:

```ts
interface SandboxResolver {
  get(sandboxId: string): SandboxRuntime | Promise<SandboxRuntime>;
}
interface SandboxRuntime {
  readonly id: string;
  exec(input: { command: string; env?: Record<string, string>; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}
```

`command` is a POSIX `sh` script that never contains keys; `env` is how keys reach the guest, so never log it. Return `exitCode: null` when the command was killed by its timeout. The guest needs `/dev/fuse`, and either apt or apk to install fuse3 and rclone, or both preinstalled.

### Custom object stores

`objectStore` replaces the S3 client. An `ObjectStore` must implement an atomic `putObjectIfAbsent(key, body): Promise<boolean>`: `true` means this call created the key, and `false` must prove that this call never wrote it. Ambiguous outcomes must throw rather than fall back to an unconditional write. `MemoryObjectStore` is an in-memory implementation for tests.

## Events

`onEvent` receives `{ type, sandboxId?, volumeId?, mountPath?, message? }`. Events never contain keys.

| Type | When |
| :--- | :--- |
| `volume.created` | `create`, or `get` with `create: true`, made a new volume. |
| `volume.deleted` | `delete` finished. |
| `attach.bootstrap` | Attach is checking or installing the runtime. |
| `attach.mount` | Attach is starting the mount. |
| `attach.done` | The mount answered. |
| `detach.start`, `detach.done` | A detach began or finished. |
| `flush.done` | A flush finished. |
| `mount.discarded` | `discardMount` deleted a cache. |
| `warning` | Something needs attention, such as low disk space or keys that expire soon. |

## Errors

Every failure is a `VolumeError`. Its subclasses (`ValidationError`, `VolumeNotFoundError`, `VolumeAlreadyExistsError`, `StorageError`, `SandboxError`, `MountError`, `FlushError`) share these fields:

- `code`: a stable string from the table below.
- `message`: what happened.
- `hint`: the next step, when there is one.
- `details`: context such as the mount path, the sandbox id or rclone's log tail.

Messages, hints and details never contain credentials. `isVolumeError(error, code?)` tells you whether a value is a `VolumeError`, optionally with a specific code.

```ts
import { isVolumeError } from 'freestyle-volumes';

try {
  await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/mnt/datasets' });
} catch (error) {
  if (isVolumeError(error)) console.error(`${error.code}: ${error.message}\n${error.hint ?? ''}`);
  throw error;
}
```

| Code | Meaning | What to do |
| :--- | :--- | :--- |
| `VALIDATION` | An argument or configuration value is invalid. | Fix the value the message names. |
| `VOLUME_NOT_FOUND` | No volume has that name in this namespace. | Create it, or check `prefix`. |
| `VOLUME_ALREADY_EXISTS` | The name is taken. | Pass `ifNotExists: true`, or pick another name. |
| `VOLUME_IN_USE` | Attachment records or a writer lease block the operation, or another mount holds the lease. | Detach the holders. When they are gone for good, use `force` or `releaseLease`. |
| `VOLUME_DELETING` | A delete of this volume has started. | Wait for it, or run `delete` again to finish an interrupted one. |
| `CONFIRMATION_REQUIRED` | A destructive call is missing its `confirm` value. | Repeat the target in `confirm`. |
| `STORAGE_AUTH` | The bucket rejected the keys. | Check the keys and their permissions. |
| `STORAGE_UNREACHABLE` | The storage endpoint cannot be reached. | Check `endpoint`, DNS and the network. |
| `BUCKET_NOT_FOUND` | The bucket does not exist. | Create it; this library never does. |
| `STORAGE_ERROR` | Another storage failure, or a malformed record. | See `details`. |
| `SANDBOX_EXEC` | Running a script in the VM failed. | Check that the VM exists and is running. |
| `SANDBOX_EXEC_TIMEOUT` | A script in the VM hit its time limit. | Check the VM's network, or raise the relevant timeout. |
| `FUSE_UNAVAILABLE` | The VM has no `/dev/fuse`. | Use a Freestyle Ubuntu image. For Docker, add `--device /dev/fuse --cap-add SYS_ADMIN`. |
| `RUNTIME_INSTALL` | Installing fuse3, flock or rclone failed. | Use an Ubuntu image, allow `downloads.rclone.org` and the apt mirrors, or boot from a volume-ready snapshot. |
| `MOUNT_FAILED` | rclone could not start the mount. | Read `details.logTail`. Usually the VM cannot reach the bucket. |
| `MOUNT_TIMEOUT` | The mount did not answer within `readyTimeoutMs`. | Check the VM's route to the bucket, then detach the leftover mount before retrying. |
| `MOUNT_PATH_IN_USE` | Another mount, a stale mount or state kept for recovery occupies the path. | Detach it, run `restoreMounts`, run `discardMount`, or pick another path. |
| `MOUNT_STALE` | The mount's process is gone, or its state cannot be read, so uploads cannot be confirmed. | Run `restoreMounts`, then detach. |
| `MOUNT_BUSY` | Files are open on the mount, or another operation is using the path. | Close the files or wait, then retry. |
| `MOUNT_UNMANAGED` | An rclone mount that this library did not create is at the path. | It is left alone: unmount it yourself, or pick another path. |
| `MOUNT_NOT_FOUND` | Nothing this library manages is mounted at the path. | Check the path with `listMounts`. |
| `FLUSH_FAILED` | Uploads did not finish in time. Nothing is lost yet: they are still queued in the VM. | Restore bucket access, then retry `detach`, optionally with a longer `flushTimeoutMs`. |
| `UNSUPPORTED` | The storage provider lacks something `clone` needs, such as conditional copies or ETags. | Use a provider that passes `doctor`, or copy the data yourself. |

The failure matrix in [semantics](semantics.md#failure-matrix) shows which events lead to which codes, and how to recover from each.
