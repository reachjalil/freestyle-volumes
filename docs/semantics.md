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

`detach()` returns `flushed: true` only when rclone reported zero queued, zero in-flight and zero errored uploads before the unmount. That is the durable detach.

If uploads cannot finish within `flushTimeoutMs` (endpoint down, credentials revoked mid-session, throttling), `detach()` throws `FLUSH_FAILED` and leaves the mount attached. Nothing is discarded; retry later with a longer timeout. `force: true` skips that guarantee: the mount is lazily unmounted, the process stopped, and the result says `flushed: false` with `pendingUploads` (or `null` when unknown). The cache directory stays on disk and the state moves to `orphans/`.

Read-only mounts never have pending writes; their detach is always `flushed: true`.

## Failure matrix

| Event | What happens | What you see | Recovery |
| :--- | :--- | :--- | :--- |
| Wrong credentials, wrong endpoint, missing bucket | Detected on the host before any sandbox call | `STORAGE_AUTH`, `STORAGE_UNREACHABLE`, `BUCKET_NOT_FOUND` from `create`/`attach`/`list` | Fix `storage`. Nothing was created in the sandbox. |
| Sandbox cannot reach the endpoint (firewall, DNS) | rclone exits at start or never answers `ls` | `MOUNT_FAILED` with log tail, or `MOUNT_TIMEOUT` after `readyTimeoutMs`; process killed, mount point removed | Allow outbound traffic from the VM; set `sandboxEndpoint` for private endpoints. |
| No `/dev/fuse` | Bootstrap stops before installing anything | `FUSE_UNAVAILABLE` | Use a VM image with FUSE; for Docker pass `--device /dev/fuse --cap-add SYS_ADMIN`. |
| `fuse3`/rclone missing and not installable | Bootstrap fails | `RUNTIME_INSTALL` with the failing step | Use an Ubuntu image, allow HTTPS to downloads.rclone.org, or preinstall rclone ≥ 1.68 and fuse3. |
| Download checksum mismatch | Archive discarded | `RUNTIME_INSTALL` (`checksum-mismatch`) | Retry; investigate if it persists. |
| Mount path already used by another volume or a foreign mount | Refused | `MOUNT_PATH_IN_USE` | Detach the other mount or pick another path. |
| rclone process crashes | Kernel keeps a dead FUSE entry (`Transport endpoint is not connected`); pending files stay in the cache | `inspectMount` → `stale`; `detach` → `MOUNT_STALE` | `attach` the same volume at the same path: the stale mount is cleared and rclone re-queues the cached files (verified in the integration suite). Then `detach`. |
| Sandbox restart (stop/start) | Processes and mounts are gone, disk (cache, state) survives | `stale` | Same as a crash. |
| Sandbox pause/resume (Freestyle) | Process memory is preserved; rclone reconnects and retries | usually nothing | Expected from Freestyle's documented pause semantics; not yet verified live. |
| Files open during detach | `fusermount3 -u` returns `EBUSY` | `MOUNT_BUSY`, mount stays | Close the files or `force: true` (open files' unflushed data is lost). |
| Endpoint unreachable during detach | Uploads retry until the flush timeout | `FLUSH_FAILED`, mount stays | Restore connectivity and retry, or `force`. |
| Attachment record write fails after a successful mount | Mount is live | `warnings[]` on the attach result | Nothing required; the record only gates `delete`. |
| Sandbox deleted while attached | Nothing runs anymore; the advisory record stays | `delete` → `VOLUME_IN_USE` | `delete({ force: true })`. Unflushed writes from that sandbox are gone with its disk. |

## Concurrent access

- Any number of sandboxes may mount the same volume, read-write or read-only. Nothing enforces a single writer, and this library does not claim to.
- Uploads are whole objects. Two sandboxes writing the same path both upload complete files; the later upload wins. There is no merge and no conflict signal.
- Listings are cached per mount for `dirCacheSeconds` (default 60). A file created by another sandbox shows up after that, or immediately if the path is looked up explicitly and was not cached as missing.
- An already-open file keeps serving the version it opened.
- S3 itself (AWS since 2020, MinIO, R2) is strongly consistent for new objects and overwrites; the staleness comes from the mount cache, not the bucket.
- Attachment records are advisory: written on attach, removed on detach, stale after a crash or a deleted sandbox. They gate `delete` and inform operators; they do not lock anything.

Recommended patterns: one writer and many `readOnly` readers, or one `subpath` per sandbox so writers never share paths.

## Isolation

- A volume's data prefix is `<prefix>/v/<name>/`. Names are validated (`[a-z0-9-]`), so no name can contain `/` or `..`.
- A `subpath` mount makes `<prefix>/v/<name>/<subpath>/` the filesystem root. FUSE has no parent above the root, so `..` at the mount root resolves to the sandbox directory containing the mount point, never to another subpath.
- Different `prefix` values are different namespaces with separate volume lists and records.

## Not supported (by design, rejected rather than emulated)

- Mounting at `/`, `/etc`, `/proc`, `/sys`, `/dev`, `/usr`, `/bin`, `/lib*`, `/run`, `/boot` or inside this library's own directories.
- Mount paths with `..`, empty segments, spaces or quote characters.
- Attaching a volume that does not exist (no implicit create; use `get(name, { create: true })`).
- Attaching to an image without FUSE, `fusermount3` or a way to install them (BusyBox).
- Detaching a stale or busy mount as if it were durable.
- Deleting without `confirm`, or while attachment records exist without `force`.
