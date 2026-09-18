# Durability, consistency and failure semantics

This page states exactly what the rclone backend guarantees. Where a guarantee is missing, it says so.

## Durability boundary

A byte written under a mount becomes durable in the bucket only after all of the following:

1. The writing process closed the file (rclone uploads whole files, on close).
2. Either `writeBackSeconds` elapsed since the last close, or `detach()` set the queue item's expiry to zero.
3. rclone's upload finished. Multipart uploads are used for large files; a partially uploaded object is not visible.

Until then the data lives in the sandbox's VFS cache directory. `inspectMount().uploads.queued` and `.inProgress` count what is still pending.

`fsync()` inside the sandbox flushes to the local cache, not to the bucket. Applications that rely on `fsync` for durability are not served by this backend.

## What `detach` promises

Normal `detach()` externally unmounts with `fusermount3 -u`, waits for FUSE serving to stop (`mount/listmounts` reports no serving mounts), then expedites and drains the VFS retained by `rclone rcd`. Only after valid counters report zero queued, zero in-flight and zero errored uploads does it stop the owned process and remove cache/state. A successful result reports `flushed: true`. Checking an empty queue before unmount would leave a race with late writes; RC `mount/unmount` is not used because it shuts down the VFS too early.

If uploads cannot finish within `flushTimeoutMs` (endpoint down, credentials revoked mid-session, throttling), `detach()` throws `FLUSH_FAILED`. The filesystem may already be unmounted, while the uploader, state and cache remain available for retry. Restore storage access and retry detach, optionally with a longer timeout. `inspectMount` can report `stale` for this unmounted but still-running uploader; it does not necessarily mean the process crashed.

`force: true` still attempts normal unmount and drain; if a busy mount needs lazy unmount or drain cannot be verified, a completed forced detach reports `flushed: false` with `pendingUploads` (or `null` when unknown). Cache and recovery state stay in place, and the advisory attachment record is retained. Lazy unmount does not prove open writers have stopped. Force cannot override uncertain process ownership or unsafe cleanup, which can still cause an error. Only a verified-flushed detach removes the advisory record.

Read-only mounts use the same drain and cleanup verification; read-only mode alone is not proof of a durable detach.

## Recovery identity

After `FLUSH_FAILED`, retry detach while the uploader is running. When drain cannot be verified, an explicit forced detach may safely stop the identified process while retaining recovery data. Reattach with the same full storage identity, volume, subpath and mount path to reuse that cache, then detach normally. A rejected reattach must preserve stopped-process evidence and pending cache.

Storage identity includes resolved host and sandbox endpoints, bucket, namespace prefix, region, provider and path-style mode. Mount/cache identity also includes the v2 volume generation when present, so recreated volumes do not reuse an earlier generation's cache. Credentials and request timeouts are excluded. Legacy state lacking process identity or using the old cache identifier is not automatically migrated or rebound; conservative refusal can require operator recovery. Preserve uncertain data rather than removing it to bypass the refusal.

## Failure matrix

| Event | What happens | What you see | Recovery |
| :--- | :--- | :--- | :--- |
| Wrong credentials, wrong endpoint, missing bucket | Detected on the host before any sandbox call | `STORAGE_AUTH`, `STORAGE_UNREACHABLE`, `BUCKET_NOT_FOUND` from `create`/`attach`/`list` | Fix `storage`. Nothing was created in the sandbox. |
| Sandbox cannot reach the endpoint (firewall, DNS) | RC mount creation or readiness fails | `MOUNT_FAILED` with log tail, or `MOUNT_TIMEOUT`; state/cache retained and process may still run | Restore connectivity; explicitly detach the retained process before reattach when required. Changing `sandboxEndpoint` changes cache identity and does not migrate old pending writes. |
| No `/dev/fuse` | Bootstrap stops before installing anything | `FUSE_UNAVAILABLE` | Use a VM image with FUSE; for Docker pass `--device /dev/fuse --cap-add SYS_ADMIN`. |
| `fuse3`/rclone/required tools missing and not installable | Bootstrap fails | `RUNTIME_INSTALL` with the failing step | Use an Ubuntu image, allow HTTPS to downloads.rclone.org, or preinstall rclone ≥ 1.68, fuse3 and required tools including `flock`. |
| Download checksum mismatch | Archive discarded | `RUNTIME_INSTALL` (`checksum-mismatch`) | Retry; investigate if it persists. |
| Mount path already used by another volume or a foreign mount | Refused | `MOUNT_PATH_IN_USE` | Detach the other mount or pick another path. |
| rclone process crashes | Kernel can keep a dead FUSE entry (`Transport endpoint is not connected`); pending files stay in the cache | `inspectMount` → `stale`; normal detach cannot claim a verified drain | Explicit forced detach may remove the stale mount while retaining cache/state. Then reattach with the same full identity and detach normally. Legacy or uncertain identity can require operator recovery. |
| Sandbox restart (stop/start) | Processes and mounts are gone, disk (cache, state) survives | `stale` | Same as a crash. |
| Sandbox pause/resume (Freestyle) | Process preservation and rclone reconnection are expected | Unvalidated | No pause/resume behavior has been verified live. |
| Files open during detach | Normal `fusermount3 -u` can return `EBUSY` | `MOUNT_BUSY`, mount stays | Close the files and retry. Force may lazy-unmount and stop the owned process, retaining uncertain cache/state without promising recovery of every open write. |
| Endpoint unreachable during detach | Filesystem normally unmounts first; retained uploader retries until timeout | `FLUSH_FAILED`; mount may be gone while uploader/cache/state remain | Restore connectivity and retry detach; force gives up the durability guarantee and retains recovery data. |
| Another lifecycle operation owns this guest mount-path lock | Attach/inspect/detach refuses lock contention | `lifecycle-busy` guest error | Retry after the operation finishes. This is not a distributed lock. |
| Mount path or ancestor is a symlink | Rejected before lifecycle locking or state access | Path-in-use guest error | Choose a non-symlink path outside protected roots. |
| Attachment record write fails after a successful mount | Mount is live but its advisory record may be missing | `warnings[]` on the attach result | Account for the live mount in application orchestration; do not rely on a missing record as permission to delete. |
| Sandbox deleted while attached | Nothing runs anymore; the advisory record stays | `delete` → `VOLUME_IN_USE` | `delete({ force: true })`. Unflushed writes from that sandbox are gone with its disk. |

## Concurrent access

- Any number of sandboxes may mount the same volume, read-write or read-only. Nothing enforces a single writer, and this library does not claim to.
- Uploads are whole objects. Two sandboxes writing the same path both upload complete files; the later upload wins. There is no merge and no conflict signal.
- Listings are cached per mount for `dirCacheSeconds` (default 60). A file created by another sandbox shows up after that, or immediately if the path is looked up explicitly and was not cached as missing.
- An already-open file keeps serving the version it opened.
- S3 itself (AWS since 2020, MinIO, R2) is strongly consistent for new objects and overwrites; the staleness comes from the mount cache, not the bucket.
- Attachment records are advisory: written on attach, removed only after verified-flushed detach, retained after uncertain forced detach, and potentially stale or missing. They gate `delete` and inform operators; they do not lock distributed operations.
- Guest per-path `flock` serializes attach/inspect/detach in one sandbox. Atomic `putObjectIfAbsent` protects volume-record creation only. Neither solves distributed attach/delete or create/delete races; applications must orchestrate them across clients and sandboxes.

Recommended patterns: one writer and many `readOnly` readers, or one `subpath` per sandbox so writers never share paths.

## Clone publication and reconciliation

`clone` selects stored objects, copies each with its source ETag condition into a unique generation, and atomically publishes the destination metadata only after all selected copies are acknowledged. This is **atomic conditional publication**, not a point-in-time snapshot, COW fork or ACID transaction. There is no distributed writer/lifecycle lock: the caller must stop all writers (including direct object-store clients), prevent new attachments and source deletion, close files and require `flushed: true` from all known source mounts before cloning. Hold that coordination through completion. Advisory records can be missing or stale; `allowLiveSource: true` bypasses their check but adds no consistency guarantee.

ETags are opaque per-object preconditions, not guaranteed content hashes. They detect source mismatches at copy time, not all mutations during a tree-wide operation: new keys may be absent from selection and already-copied keys may change afterward. Only stored bytes are copied; local pending cache, open handles and process state are not. Both names are in the same configured namespace/bucket. Direct bucket readers can see staged data before the volume API exposes this operation's generation.

Selection is bounded by 100,000 objects and 32 MiB escaped UTF-8 JSON `{ key, size, etag }` metadata, with lower configurable budgets. Budget overflow or objects larger than the conservative **5 TiB per-object** ceiling fail with `VALIDATION` before any copy/publication; lack of conditional-copy support or ETags fails with `UNSUPPORTED`. The metadata budget is not a bound on payload size or exact process memory.

S3 copy first HEAD-checks selected size/ETag and pins any returned version ID. Objects at or below `storage.multipartCopyThresholdBytes` (default 5 GiB) use single `CopyObject`; larger ones use multipart copy with ETag conditions on **every** part. Parts run sequentially per object, with adaptive size `max(configuredPartSize, ceil(size / 10_000))`: minimum configured 5 MiB, default 128 MiB, at most 10,000 parts; the last may be smaller. Clone concurrency remains the upper bound on simultaneous part copies. Multipart creation preserves HEAD's supported content headers/user metadata and separately read tags, not every source property. Version/ETag checks are not tree snapshots or guards against all metadata/tag changes. See [settings, preservation and permissions](performance.md#single-and-multipart-copy).

On clone failure, a `VolumeError` carries `details.operationId`, `destinationPrefix` when allocated, `publication`, `completionUnknown`, `multipartFailures` and `cleanupStatus`. Copy diagnostics can include `stage` (`head`, `copy`, `tags`, `create`, `part`, `complete`), `uploadId` when known, `completionStatus` (`not-attempted` or `unknown`), `abortStatus` (`not-attempted`, `acknowledged`, `failed`) and sanitized `abortError`. `multipartFailures` gathers upload-ID-bearing/create-stage failures across settled workers; inspect the cause/details too, not only that array. The ownership intent at `<prefix>/_operations/<operationId>.json` remains if it was written, even after a successful clone. It records ownership, not a resumable manifest, durable upload-ID journal or lease.

| `cleanupStatus` | Meaning and operator action |
| :--- | :--- |
| `not-needed` | No copy cleanup was needed (for example selection failed before copying). An ownership intent can still remain. |
| `completed` | Acknowledged copies were cleaned from this operation's prefix, with no copy failure; for example another create won publication. It does not authorize deleting other generations or the retained intent by age. |
| `uncertain` | At least one copy failed or cleanup failed. Remote copies may complete after their client promises reject, even after cleanup sees an empty prefix. Keep the operation identity and reconcile outstanding remote work manually. |
| `retained` | Publication outcome is `unknown`, or at least one copy reports unknown completion (`completionUnknown: true`). The record or copied object may exist despite a lost/invalid response. Destination data is retained even when publication was never attempted. Reconcile before retrying; a later missing record is not deletion authorization. |

Client workers settling proves neither remote request cancellation nor eventual absence of objects. On copy failure, S3 attempts abort when an upload ID is known. Abort failure is recorded, not hidden; **abort acknowledgment does not prove all remote work stopped or that a completed object is absent**. Lost/malformed create responses may leave an upload without a known ID. Lost/malformed completion responses can mean completion succeeded; invalid part/completion ETags are errors, never fabricated success. Other failed copy requests can also finish late even when `completionUnknown` is false: that flag is not proof of non-completion.

Cleanup, when allowed, is scoped only to the isolated operation generation, never the source or a competing winner. Unknown completion or publication forbids automatic data cleanup. There is **no automatic GC, resume or transaction rollback**. Under application coordination:

1. Preserve the operation ID, intent, error details and destination generation; establish that the original caller/workers are no longer active.
2. Reconcile destination metadata against the intent and any competing winner. Check provider request outcomes, completed objects and late arrivals; a missing metadata record or empty object listing alone does not prove deletion safety.
3. Inspect provider multipart-upload and part listings for the destination prefix/upload IDs. Resolve or abort outstanding uploads with operator permissions; unknown IDs and abort failures need provider-side investigation. Repeat verification as appropriate rather than assuming client cancellation stopped the server.
4. Retry or remove only data proven to belong to an unpublished, inactive operation with resolved remote outcomes. Do not delete retained data to clear an error or use intent age as authorization.

Configure a provider **incomplete multipart upload lifecycle rule** with a recovery window suited to operations. It limits orphaned-part cost, including uploads whose IDs were lost; it neither rolls back completed objects/publication nor justifies age-based generation/intent deletion. Provider support and permission requirements are listed in [performance](performance.md#provider-support-and-permissions).

New `create` and `clone` calls publish version-2 records at generation-specific prefixes. Current clients continue to read, attach and delete valid legacy v1 records without migration. Older v1-only clients cannot read v2 records; upgrade shared-namespace clients before writing v2, and do not rewrite metadata to v1 as a downgrade shortcut.

## Git is a separate durability boundary

[`VolumeGit`](git.md) offers explicit clone/status/commit/ff-only pull/normal push and directional sync on a healthy managed mount, not automatic commits or PRs. Require one application-coordinated writer and prevent detach/replacement during calls; mount inspection and local Git locks are not distributed locks. A returned commit is `durability: 'guest-local'`, not a durable S3 repository. Push acknowledges the Git remote, not uncommitted work or S3 drain. Normally detach and require `flushed: true` before discarding guest cache; this is still not an atomic transaction across Git refs/objects or an ACID filesystem. Partial operations/timeouts need repository and remote reconciliation, not blind retry. Active worktrees remain better suited to native VM disk.

## Isolation

- New volumes use `<prefix>/v2/<name>/<generation>/`; legacy v1 volumes use `<prefix>/v/<name>/`. Names and exact prefixes are validated, and v2 generations must be UUIDs. Use `volume.dataPrefix`, not a hardcoded v1 path.
- A `subpath` mount makes `<volume.dataPrefix>/<subpath>/` the filesystem root. FUSE has no parent above the root, so `..` at the mount root resolves to the sandbox directory containing the mount point, never to another volume subpath through that mount.
- Different `prefix` values are different namespaces with separate volume lists and records. This is mount/API isolation, not an IAM boundary against a root user holding broader bucket credentials.

## Not supported (by design, rejected rather than emulated)

- Mounting at `/`, `/etc`, `/proc`, `/sys`, `/dev`, `/usr`, `/bin`, `/lib*`, `/run`, `/boot` or inside this library's own directories.
- Mount paths with `..`, empty segments, spaces or quote characters.
- Symlink mount paths or ancestors, and lifecycle operations without `flock`.
- Attaching a volume that does not exist (no implicit create; use `get(name, { create: true })`).
- Attaching to an image without FUSE, `fusermount3` or a way to install them (BusyBox).
- Detaching a stale or busy mount as if it were durable.
- Deleting without `confirm`, or while attachment records exist without `force`.
