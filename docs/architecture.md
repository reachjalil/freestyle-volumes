# Architecture

## Components

| Component | File | Responsibility |
| :--- | :--- | :--- |
| `FreestyleVolumes` | `src/volumes.ts` | The public, Daytona-style API. Validates inputs, sequences the steps, never talks to a sandbox or bucket directly. |
| `VolumeRegistry` | `src/registry.ts` | Volume records, advisory attachment records and data prefixes in the bucket. Uses the `ObjectStore` interface. |
| `S3ObjectStore` / `MemoryObjectStore` | `src/storage.ts` | Object operations including atomic `putObjectIfAbsent`, on the AWS SDK or in memory. S3 copy chooses single or multipart server-side requests. Also turns storage config into rclone environment variables. |
| `VolumeGit` / `volumeGit` | `src/git.ts` | Explicit, restricted guest Git operations on healthy managed mounts; requires preinstalled Git and application-enforced single-writer coordination. |
| `RcloneBackend` | `src/rclone.ts` | Generates the guest scripts (bootstrap, mount, inspect, detach), runs them through a `SandboxRuntime`, parses the `FSVOL_*` protocol, maps failures to error codes. |
| `SandboxRuntime` / `SandboxResolver` | `src/sandbox.ts` | The one-method integration interface: run a `sh` script as root with env and a timeout. |
| `freestyleSandboxes` | `src/freestyle.ts` | `SandboxResolver` over the `freestyle` SDK (`vm.exec`). Structural types, so the SDK is an optional peer. |
| `dockerSandboxes` | `src/docker.ts` | `SandboxResolver` over `docker exec`, for local development and the integration suite. |

Storage configuration, sandbox integration and filesystem-process management are separate on purpose: `FreestyleVolumes` can be given a different `ObjectStore`, a different `SandboxResolver`, or later a different backend without touching the others.

## Bucket layout

```
<prefix>/_volumes/<name>.json                     { version, id, name, createdAt, labels, backend, dataPrefix, generation? }
<prefix>/_attachments/<name>/<sandbox>__<mount>.json   advisory: who mounted what, where, when
<prefix>/_operations/<operationId>.json             immutable clone ownership intent (retained)
<prefix>/_leases/<name>.json                         exclusive-writer lease, taken with a conditional create
<prefix>/_deleting/<name>.json                       written before a delete starts, removed when it finishes
<prefix>/_doctor/<uuid>.json                         short-lived checkStorage probe
<prefix>/v/<name>/...                              legacy v1 files and directory markers
<prefix>/v2/<name>/<generation>/...                 new v2 files and directory markers
```

Volume ids are their names (validated DNS-label style). New `create` and `clone` calls write version-2 records with a UUID generation. Valid legacy version-1 records remain supported without migration; attach/delete use the validated stored `dataPrefix`, never a reconstructed v1 path. Older v1-only clients cannot read v2 records, so coordinate upgrades within a shared namespace.

Creation uses atomic `ObjectStore.putObjectIfAbsent(key, body): Promise<boolean>`: true means created; false proves that this call never wrote the key. S3 uses `If-None-Match: *`; a first-attempt precondition failure returns false, but a retry may observe its own earlier successful write, making that outcome ambiguous. Conflicts, unsupported conditions and ambiguous failures throw, with no unconditional PUT fallback. Custom stores must enforce the same contract. Concurrent `ifNotExists` callers read the winning record.

Stored volume records are validated for shape, labels, backend and exact namespace/volume data prefix before use. Attachment records must match their expected volume and key. These checks and atomic creation do not provide distributed lifecycle locking: attachment checks remain advisory, and applications must orchestrate attach/delete and create/delete races.

## Host-only listing and clone

[`VolumeRegistry.list`](../src/registry.ts#L311) streams volume-record keys and reads metadata in bounded batches (default 8, configurable integer 1–64), validates results and sorts by name. It skips records removed before their GET, surfaces malformed records/read failures and does not provide a snapshot of concurrent changes.

[`VolumeRegistry.clone`](../src/registry.ts#L185) and [`S3ObjectStore.copyObject`](../src/storage.ts#L231) implement the following without sandbox execution or payload downloads:

1. Validate names, destination labels, copy concurrency (1–64, default 8) and selection budgets. Require conditional-copy and atomic-publication support; refuse an existing destination.
2. Read the source and check advisory attachments. Any recorded attachment, even read-only, refuses cloning unless `allowLiveSource: true`. The caller must coordinate writer quiescence, verified source drain and source lifecycle; the override provides no isolation.
3. Conditionally write an immutable ownership intent containing the source and destination records. Its operation UUID is also the new destination generation.
4. Select an in-memory `{ key, size, etag }` manifest under the source's validated prefix. Hard limits are 100,000 objects and 32 MiB escaped UTF-8 JSON metadata (lower configurable). Require ETags and object sizes at most a conservative 5 TiB per object. Selection failure occurs before copies start.
5. Copy into this operation's unique generation prefix using bounded object workers. HEAD checks source size/ETag; any returned version ID is pinned. At or below `multipartCopyThresholdBytes` (default 5 GiB), issue `CopyObject`; above it, read version-pinned tags, create a multipart upload with supported HEAD headers/user metadata and tags, copy sequential ranged parts, and complete with ordered part ETags. Every single/part copy uses `CopySourceIfMatch`. Part size is `max(multipartCopyPartSizeBytes, ceil(size / 10_000))`, configured minimum 5 MiB/default 128 MiB, final part possibly smaller. There are at most 10,000 parts; sequential per-object requests keep clone concurrency an upper bound on concurrent part copies. No client-payload fallback exists.
6. After all selected copies return valid completion ETags, conditionally publish the destination record with `If-None-Match: *`. Only this record makes this operation's generation visible through the volume API; a concurrent ordinary create or clone can win the name instead.
7. On copy failure, attempt abort for known upload IDs and retain safe stage/completion/abort diagnostics (including abort failures). Wait for client workers to settle. Unknown completion or publication retains data (`cleanupStatus: 'retained'`); otherwise clean only the operation-owned prefix when publication was not attempted or definitively rejected. Failed copies can still complete remotely later, so cleanup remains `uncertain` even after an empty listing. Abort acknowledgment does not prove destination absence or cessation of remote work. Unknown upload IDs require provider-side reconciliation. Ownership intents remain on success and failure; no automatic GC/resume exists.

This is atomic conditional publication, not an ACID transaction, point-in-time snapshot or COW fork. Listings and per-object copies span time. Direct bucket readers can see staged data, and source mutation can produce a mixed tree despite individual ETag conditions. See [clone API and limits](performance.md#clone-api) and [failure reconciliation](semantics.md#clone-publication-and-reconciliation).

Clone credentials need source HEAD/read/version/tag access, destination multipart/copy/tagging writes and abort/cleanup permissions, plus normal registry operations. Verify provider-specific behavior; supported HEAD metadata/tag preservation is not preservation of ACLs, storage class or encryption settings. Recommend a provider incomplete-MPU lifecycle rule for orphaned parts, not age-based deletion of completed generations. [Permissions and constants](performance.md#provider-support-and-permissions) describe the public storage exports and exact bounds.

## Explicit guest Git helper

`VolumeGit` and the `volumeGit` factory are exported at the package root and `/git`, along with `VolumeGitError` and Git types. They inspect a healthy managed mount, then run an isolated shell/Git invocation through the supplied `SandboxResolver`. Git must already be installed. Operations are explicit clone, status, path-selected commit with caller identity, clean ff-only pull, normal push and single-direction sync; there is no automatic commit, PR or GitHub REST integration.

The helper accepts credential-free HTTPS remotes (or GitHub `owner/name`), supplies tokens only through exec environment and a temporary mode-0700 askpass helper outside the mount, and requires root for token use. Tokens never enter persistent URLs/config/arguments or helper content; a credential-free origin URL can persist. The adapter/guest must be trusted and must not log `exec.env`. Hooks are disabled, non-allowlisted configuration (including filters) is rejected, and checks refuse submodules, linked worktrees, filesystem symlinks/hardlinks, alternates and in-progress operation state. This is restricted support, not arbitrary-repository compatibility.

There is no lock spanning inspection, Git and detach: the caller enforces single-writer access and prevents lifecycle changes. `GitResult.durability` is `guest-local`; Git commits and successful pushes do not prove S3 drain or ACID semantics. Close files, detach normally and require `flushed: true`. Partial failures/timeouts can leave work/index/ref changes or unknown remote outcomes; inspect before retrying. Prefer native VM disk for active worktrees. See [Git API, trust and recovery](git.md).

## Sandbox layout

```
/opt/freestyle-volumes/bin/rclone                 pinned rclone, only when the image has none >= 1.68
/var/lib/freestyle-volumes/mounts/<mountId>/       mount.json, remote, driver, pid, pid.start, pid.exe,
                                                run.sh, logs, quiesced/stopped markers as applicable
/var/lib/freestyle-volumes/locks/<pathHash>.lock   persistent per-mount-path lifecycle lock
/var/cache/freestyle-volumes/<mountId>/            rclone VFS cache; pending uploads live here
/run/freestyle-volumes/<mountId>.sock              rclone remote-control socket (root only)
```

`mountId` is the first 16 hex chars of SHA-256 over a versioned identity containing resolved host endpoint, sandbox endpoint, bucket, prefix, region, provider, path-style mode, volume id, subpath and mount path, with the v2 generation appended when present. Recreated same-name volumes therefore get different cache identities. Credentials and request timeouts are excluded. Only the same identity reuses a cache; a matching S3 path on another endpoint is not enough. The exported three-argument `mountIdFor` retains its legacy calculation, but the facade always supplies storage identity.

Uncertain forced detaches retain state in `mounts/` alongside the cache, rather than moving it to `orphans/`. Legacy state without process identity or with the old cache id is not automatically migrated: conservative refusal can require operator recovery. Never assume a legacy PID alone authorizes signaling or that an old cache can safely be rebound.

## Attach sequence

1. Validate `sandboxId`, `volumeId`, `mountPath` (absolute, clean, outside protected roots), `subpath`, options.
2. `GET` the volume record and refuse if its deleting marker matches (`VOLUME_DELETING`); `LIST` one key under the data prefix. Wrong credentials, a missing bucket or an unreachable endpoint fail here, before any sandbox call. An `exclusive` attach then takes the writer lease with a conditional create; a plain writable attach refuses while another mount holds it.
3. With `sandboxCredentials`, ask for keys covering the mount's data prefix (read-only for read-only mounts). A provider failure stops the attach; the host's keys are never used as a fallback. These mounts set rclone's `no_head_object`, since a prefix-limited key may not HEAD the mount root.
4. Bootstrap script (no credentials): check `/dev/fuse`, install `fuse3`, rclone and `util-linux` when `flock` is missing, and verify tools. The bootstrap lock is used when `flock` is available; lifecycle scripts require it.
5. Mount script (credentials in `env`):
   - Reject symlink mount paths or ancestors, then take a nonblocking `flock` keyed by mount path, shared by attach, inspect and detach. Contention reports `lifecycle-busy`; persistent lock files are never unlinked.
   - A healthy mount must match stored mount identity, remote path and read-only mode, with verified process ownership, before returning `already=1`.
   - Refuse foreign identities, stale mounts or existing processes requiring detach; do not silently kill and replace them.
   - Require an empty, unmounted directory before clearing stopped/PID evidence. Write state and start `rclone rcd` with `setsid`, detached stdio and the lifecycle lock descriptor closed.
   - Record PID, process start time and executable; ownership also requires the expected Unix socket argument. Never signal by PID alone.
   - Create the FUSE mount via RC `mount/mount` with `mountType=mount`. Poll for owned process, `fuse.rclone` entry and a successful directory listing within the readiness deadline.
   - On process exit, mount creation failure or timeout, report failure while retaining recovery state/cache; the process may still be running.
6. Write the advisory attachment record (failure is a warning, the mount is already live). The mount's options, lease flag and credential expiry go into its guest `mount.json`, so `restoreMounts` can reattach with the same settings. A lease taken by this call is released again if the attach failed before any mount could start, and kept (`details.leaseRetained`) when a mount may still come up.

## Detach sequence

1. Reject symlink paths/ancestors, take the mount-path lifecycle lock, and find the state directory whose `mount.json` names this mount path.
2. No state and no mount: `absent`. No state but an rclone mount: `unmanaged` (refuse).
3. Verify the mounted remote against retained state. Normally unmount externally with `fusermount3 -u` first, to quiesce writers. Busy mounts report `MOUNT_BUSY`; force may lazy-unmount, but that path cannot claim durability.
4. For an owned `rcd` process, record quiescence after normal unmount. Wait for RC `mount/listmounts` to report no serving mounts, so the final FUSE release cannot race an empty-queue observation. The VFS remains alive in `rcd`; RC `mount/unmount` is deliberately not used because it shuts down that VFS too early.
5. Expedite `vfs/queue` entries and poll `vfs/stats` within the flush deadline. All three counters (queued, in-progress, errored) must be valid and zero. Missing or malformed counters are not proof of drain. This verification is required for read-only mounts too.
6. `FLUSH_FAILED` may leave the filesystem unmounted with uploader, state and cache intact. Restore storage access and retry detach; an already-unmounted, quiesced uploader can still drain. Unverifiable drain reports stale unless force is requested.
7. After verified drain, stop only the owned process (SIGTERM, then SIGKILL if necessary), verify mount/process cleanup, and remove cache/state. If cleanup is uncertain, refuse rather than discard evidence.
8. Forced uncertain detach retains cache/state in place and marks the process stopped only after verified cleanup, returning `flushed: false`. The facade retains the advisory attachment record and any writer lease. Only a detached, verified-flushed result removes that record and releases the lease this mount held. Reattach with the same identity can resume retained uploads; rejected preflight must preserve recovery evidence.

## Flush, listing and discard

- `flush` takes the mount-path lock, requires the verified owned uploader, expedites `vfs/queue` and polls `vfs/stats` until queued, in-flight and errored uploads are all zero or the deadline passes. It never unmounts or signals anything.
- The listing script takes no lock. For each managed state record it reports mount and process status and, for a running uploader, its `vfs/stats` (`FSVOL_MSTATS`), so progress is visible while a detach or flush holds the lock.
- `discard` takes the lock and refuses while the path is mounted, while the owned uploader runs, or while a live PID has no identity record; otherwise it deletes the state directory, the cache and the socket. The host then removes the attachment record and releases the lease that mount held.
- `restoreMounts` lists stale mounts and attaches each with its saved options. A refusal because of a dead FUSE entry leads to a forced detach that keeps the cache, and one because of a still-running uploader leads to a normal, verified detach; then it attaches again.

## Guest protocol

Scripts print `FSVOL_RESULT key=value ...` on success, `FSVOL_ERR <code> <detail>` on failure, and optional blocks `FSVOL_LOG_BEGIN ... FSVOL_LOG_END`, `FSVOL_STATE_BEGIN ... END` (mount.json), `FSVOL_STATS_BEGIN ... END` (rclone `vfs/stats` JSON) and `FSVOL_STDERR_BEGIN ... END`. The host parses these with `parseGuestOutput` and never interprets free-form stdout. Exit codes are secondary; the `FSVOL_ERR` code decides the error class.

## rclone invocation

```
rclone rcd \
  --cache-dir /var/cache/freestyle-volumes/<mountId> \
  --rc-addr unix:///run/freestyle-volumes/<mountId>.sock --rc-no-auth \
  --log-file .../rclone.log --log-level INFO
```

The guest then calls `rclone rc --unix-socket ... mount/mount` with `fs`, `mountPoint`, `mountType=mount`, and JSON `mountOpt`/`vfsOpt`. These carry allow-other, cache mode (`writes` = 2, `full` = 3), write-back and directory-cache durations, disabled polling, read-only mode and optional ownership, umask and cache size. Optional `readAhead`, `readChunkSize` and `readChunkSizeLimit` map to `vfsOpt.ReadAhead`, `ChunkSize` and `ChunkSizeLimit`. `bufferSize` and `transfers` instead become daemon flags `--buffer-size` and `--transfers`; they are not VFS fields. Omitted tuning fields preserve rclone defaults, and read-ahead only takes effect in full-cache mode. A matching existing mount is reused, not retuned. One `rcd` process serves each managed mount and retains its VFS after external unmount for draining. See [performance validation and tradeoffs](performance.md#opt-in-mount-tuning).

The `fsvol` remote is defined entirely by `RCLONE_CONFIG_FSVOL_*` environment variables (`type=s3`, provider, endpoint, region, credentials, `force_path_style`, `no_check_bucket=true`, `directory_markers=true`) with `RCLONE_CONFIG=/dev/null`, so no config file exists. `--rc-no-auth` is safe because the socket lives in a root-only directory; anything that can reach it is already root.

`--daemon` is deliberately not used: rclone's daemon mode binds the rc socket in both the parent and the child and fails with "address already in use". Backgrounding with `setsid` plus a pid file written by the wrapper script (`echo $$` then `exec rclone`) gives an exact pid regardless of how the guest shell handles job control.

## Timeouts

| Step | Default | Bound |
| :--- | :--- | :--- |
| Host storage call | 15 s | `storage.requestTimeoutMs`, per request including multipart stages, not per clone |
| Git exec | 120 s | Git location `timeoutMs`, 1–300 s; separate from mount inspection and detach |
| Bootstrap | 240 s | `bootstrapTimeoutMs` ≤ 300 s |
| Mount readiness | 30 s | `readyTimeoutMs` ≤ 270 s; exec limit is `readyTimeoutMs + 30 s` |
| Inspect | 30 s | `inspectTimeoutMs` |
| Flush | 60 s | `flushTimeoutMs` ≤ 260 s; exec limit is `flushTimeoutMs + 40 s` |

Every exec stays within Freestyle's 300 s cap. A timed-out volume-runtime exec (`statusCode === null`) surfaces as `SANDBOX_EXEC_TIMEOUT`; the Git helper instead reports `GIT_TIMEOUT` and requires inspection before retrying.

## Why rclone

This is a shortlist of design tradeoffs for this preview, not an exhaustive or benchmark-ranked comparison. See the [source-linked research](freestyle-research.md) for the boundary between workspaces and artifacts.

| Backend | Kind | License | Random writes | Metadata / extra service | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **rclone mount** (chosen) | object-store mount with local write-back cache | MIT | Yes, buffered locally; whole object re-uploaded on close | Object listing only; empty dirs via markers; **no extra service** | Single static binary, S3-compatible endpoint/path-style support, and an RC API used by the verified-drain protocol. Similar category to Daytona's documented volumes. |
| JuiceFS | POSIX-like distributed filesystem (chunked data in S3) | Apache-2.0 | Yes, chunk-level; atomic rename, locks, xattr | **Requires a metadata engine** (Redis, MySQL, PostgreSQL, TiKV, SQLite) reachable by every VM | Candidate when POSIX semantics justify an extra service. Planned as a second backend behind the same interface; not implemented. |
| s3fs-fuse | object-store mount | GPL-2.0 | Whole-object rewrite | Object listing | Mature but GPL, no flush API, weaker rename semantics. |
| Mountpoint for Amazon S3 | object-store mount, sequential writes only | Apache-2.0 | No edits of existing objects, no append | Object listing | Read-mostly workloads on AWS only. |
| geesefs | object-store mount | Apache-2.0 | Partial (server-side part copies) | Object listing | Smaller community; kept as a candidate. |

For a first release that people can point at any bucket without running a database, an object-store mount with honest, documented semantics beats a POSIX filesystem with a hidden dependency. The mount logic is isolated in [src/rclone.ts](../src/rclone.ts) so a JuiceFS backend can slot in.
