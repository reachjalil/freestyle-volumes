<h1 align="center">freestyle-volumes</h1>

<p align="center">
  <strong>Daytona-style persistent volumes for Freestyle VMs, backed by any S3-compatible bucket.</strong><br />
  Create a named volume, mount it into a sandbox, write files, detach, attach it somewhere else. The data is still there.
</p>

<p align="center">
  <a href="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml"><img src="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/reachjalil/freestyle-volumes/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2448ff?style=flat-square" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A522-11131b?style=flat-square" alt="Node.js 22 or later" /></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-preview-8b5cf6?style=flat-square" alt="Status: preview" /></a>
</p>

Community project. Not affiliated with or endorsed by [Freestyle](https://www.freestyle.sh) or [Daytona](https://www.daytona.io). "Daytona-style" describes the developer experience (named volumes, `mountPath`, `subpath`, shared across sandboxes), not API compatibility or identical filesystem semantics.

```ts
import { Freestyle } from 'freestyle';
import { FreestyleVolumes, freestyleSandboxes } from 'freestyle-volumes';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const volumes = new FreestyleVolumes({
  storage: { endpoint: 'https://<account>.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-volumes',
             accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET! },
  sandboxes: freestyleSandboxes(freestyle),
});

const volume = await volumes.get('datasets', { create: true });
await volumes.attach({ sandboxId: vmId, volumeId: volume.id, mountPath: '/home/ubuntu/datasets', uid: 1000, gid: 1000 });
await vm.exec('echo hello > /home/ubuntu/datasets/hello.txt');
const { flushed } = await volumes.detach({ sandboxId: vmId, mountPath: '/home/ubuntu/datasets' }); // flushed === true: uploads finished
await volumes.attach({ sandboxId: otherVmId, volumeId: volume.id, mountPath: '/mnt/datasets', readOnly: true });
```

## Project status

Version 0.1.0, preview. Final main-run verification results dated **2026-09-18**:

| Tier | What it proves | Status |
| :--- | :--- | :--- |
| Unit tests (mocked sandbox, in-memory store, guest-script harness) | Validation, script execution/generation, error mapping, registry, clone publication/cleanup, mocked large multipart boundaries and Git checks | `pnpm test`: 112 passed, 0 skipped. `pnpm check:types` and `pnpm check:examples` passed. |
| Linux integration tests (Docker + MinIO and real rclone guest regressions) | Lifecycle, isolation, failure recovery, post-unmount drain, small multipart fixture, real-FUSE Git and tuning regressions | `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration`: 26 passed, 0 failed, 0 skipped, including minimum/pinned rclone 1.68.0/1.75.1 and Ubuntu bootstrap. See [docs/evidence/v0.1.md](docs/evidence/v0.1.md). |
| Freestyle live test (two real VMs) | The same round trip on Freestyle's Ubuntu image, writing as the default `ubuntu` user | `pnpm test:freestyle`: **1 skipped**, missing `FREESTYLE_API_KEY`, `VOLUMES_S3_BUCKET`, `VOLUMES_S3_ACCESS_KEY_ID`, and `VOLUMES_S3_SECRET_ACCESS_KEY`. No live round trip or pause/resume validated. See [docs/freestyle.md](docs/freestyle.md). |

Do not read the Docker results as Freestyle results. They exercise mount mechanics and Git on real FUSE; the Freestyle adapter remains checked only against the SDK's type contract until the live test runs. Multipart verification uses a small real fixture plus mocked large-size boundaries, **not an actual 5 TiB copy**. Git verification covers unit tests, local smart HTTP and real FUSE, **not live authenticated GitHub**.

## How it works

```
your process (Node 22+)                      S3-compatible bucket
┌──────────────────────────┐   HTTPS         ┌─────────────────────────────────┐
│ FreestyleVolumes         │ ──────────────▶ │ <prefix>/_volumes/<name>.json   │  volume records
│  ├ VolumeRegistry        │                 │ <prefix>/_attachments/...       │  advisory attachment records
│  └ RcloneBackend         │                 │ <prefix>/v2/<name>/<gen>/...    │  new volume data
└──────────┬───────────────┘                 └───────────────▲─────────────────┘
           │ vm.exec(script, { env: credentials })           │ S3 API (GET/PUT/LIST)
           ▼                                                 │
┌──────────────────────────┐  FUSE            ┌──────────────┴──────────────────┐
│ Freestyle VM / container │ ◀──────────────▶ │ rclone rcd + mount/mount        │
│  /mnt/datasets           │                  │ write-back cache on local disk  │
└──────────────────────────┘                  └─────────────────────────────────┘
```

- **Storage** is an S3-compatible service with atomic conditional PUT support for volume creation (AWS S3, Cloudflare R2, MinIO, etc.; verify your provider's support). The bucket is the only durable store; nothing else has to run. Volume records and data share one namespace `prefix` so several apps or tenants can use separate namespaces in a bucket.
- **The sandbox** runs one [rclone](https://rclone.org) process per mount, started by a POSIX `sh` script through Freestyle's `vm.exec` as `root`. Credentials reach rclone only as environment variables; they are never written to disk or put on a command line. rclone's remote-control socket (a root-only Unix socket) reports the upload queue so `detach` can prove that writes reached the bucket.
- **Bootstrap** installs `fuse3`, `util-linux` when `flock` is missing (apt or apk), and a pinned rclone release (`1.75.1`, SHA-256 verified) when needed, and reuses an existing rclone `>= 1.68`. It never creates buckets or formats anything.

New volumes use generation-specific v2 data prefixes; legacy `<prefix>/v/<name>` records remain supported. Clone ownership intents live at `<prefix>/_operations/<operationId>.json`. Older v1-only clients cannot read v2 records; coordinate upgrades before creating new volumes in a shared namespace.

More detail: [architecture](docs/architecture.md), [performance and cloning](docs/performance.md), and [source-linked Freestyle research](docs/freestyle-research.md). Keep active workspaces on native VM disk and reviewable source in Git; these object-backed volumes complement them with shared datasets and artifacts.

## Install

Not on npm yet. Install from GitHub (the package builds itself on install) and add the Freestyle SDK, which is an optional peer dependency:

```bash
npm install github:reachjalil/freestyle-volumes freestyle
```

Requirements: Node.js 22+. Sandboxes need a Linux kernel with FUSE, root access, and outbound network access to the storage endpoint (plus `downloads.rclone.org` on first use unless rclone is preinstalled).

## Freestyle setup

1. Create a VM from an Ubuntu snapshot with outbound access. Freestyle VMs get no network by default:
   ```ts
   const { vm, vmId } = await freestyle.vms.create({
     snapshotId: 'freestyle/ubuntu-sm',
     firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
   });
   ```
2. Build `FreestyleVolumes` with `sandboxes: freestyleSandboxes(freestyle)`. Scripts run as `root` (`linuxUser` option to change it).
3. Attach with `uid: 1000, gid: 1000` when the VM's default `ubuntu` user should own the files. Mounts use `allowOther` so every user can access them either way.
4. Detach before snapshotting or deleting the VM. A snapshot taken while attached captures the mount process, its environment (credentials) and its write cache.

A complete two-VM example is in [examples/freestyle.ts](examples/freestyle.ts). [docs/freestyle.md](docs/freestyle.md) lists Freestyle-specific facts, limits and the live test procedure.

## Local development without Freestyle

A Docker container with `/dev/fuse` stands in for a sandbox and MinIO for S3; see [examples/local-docker.ts](examples/local-docker.ts) and `freestyle-volumes/docker`. The integration suite (`pnpm test:integration`) uses exactly this setup.

## API

The volume methods below return promises and throw `VolumeError` subclasses with a stable `code`. The separate Git helper uses `VolumeGitError` (see [Git operations](#explicit-git-operations)).

| Method | What it does |
| :--- | :--- |
| `new FreestyleVolumes({ storage, sandboxes, defaults?, onEvent? })` | Validates configuration. `storage` is the bucket; `sandboxes` is `freestyleSandboxes(freestyle)` or `dockerSandboxes()`. |
| `create({ name, labels?, ifNotExists? })` | Atomically creates the volume record only if absent. Concurrent losers get `VOLUME_ALREADY_EXISTS`, or the winner's record with `ifNotExists`. Names are 1-63 chars of `[a-z0-9-]`; the name is the id. |
| `get(name, { create? })` | Fetch, or create when missing (Daytona's `volume.get(name, true)`). |
| `list({ concurrency? }?)` | Volumes in this namespace, sorted by name; metadata-read concurrency defaults to 8 (integer 1–64). Not a snapshot of concurrent changes. |
| `clone({ sourceVolumeId, name, labels?, allowLiveSource?, concurrency?, maxObjects?, maxManifestBytes? })` | Server-side copies within this bucket/namespace, then atomic conditional publication of a new volume. Returns `{ volume, operationId, copiedObjects, copiedBytes }`. Caller must quiesce the source; not a snapshot or COW fork. |
| `attach({ sandboxId, volumeId, mountPath, readOnly?, subpath?, uid?, gid?, umask?, cacheMode?, writeBackSeconds?, dirCacheSeconds?, cacheMaxSize?, bufferSize?, readAhead?, readChunkSize?, readChunkSizeLimit?, transfers?, allowOther?, readyTimeoutMs?, bootstrapTimeoutMs? })` | Checks the bucket, prepares the runtime, starts the mount and waits until it answers a directory listing. A healthy matching storage/mount identity and read-only mode returns `alreadyAttached: true`. Stale mounts or existing processes require explicit detach; failed attach retains recovery state and cache. |
| `inspectMount({ sandboxId, mountPath })` | `status` is `mounted`, `stale` (process or mount gone, cache may hold unflushed writes), `absent`, or `unmanaged` (an rclone mount this library did not create), plus pid, upload queue counts, cache size and the log tail. |
| `detach({ sandboxId, mountPath, flushTimeoutMs?, force? })` | Normally unmounts first, waits for FUSE serving to stop, drains the retained VFS, then stops the process. Removes cache/state and the advisory attachment record only after verified drain. Uncertain forced detach retains them and returns `flushed: false` if cleanup can safely complete. Never deletes volume data. |
| `delete({ volumeId, confirm, force? })` | Destroys the record and every object under the volume's data prefix. `confirm` must equal `volumeId`. Refuses while attachment records exist unless `force`. |

Storage configuration (`storage`):

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `endpoint` | AWS S3 | S3 API URL as seen from your process. |
| `sandboxEndpoint` | `endpoint` | S3 API URL as seen from inside the sandbox (private networks, Docker). |
| `region` | `us-east-1` | `auto` for R2; anything for MinIO. |
| `bucket` | required | Must exist. Never created. |
| `prefix` | `freestyle-volumes` | Namespace inside the bucket. Different prefixes never see each other's volumes. |
| `accessKeyId`, `secretAccessKey`, `sessionToken?` | required | Used by this process (registry) and passed to rclone as environment variables. |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style addressing, needed by MinIO and most self-hosted services. |
| `provider` | `AWS` or `Other` | rclone provider hint (`Minio`, `Cloudflare`, `Ceph`, ...). |
| `requestTimeoutMs` | `15000` | Per-request timeout for host-side storage calls, including each multipart stage; not a whole-clone deadline. |
| `multipartCopyThresholdBytes` | 5 GiB | Integer bytes, 5 MiB–5 GiB. Single copy at or below this threshold; multipart above it. |
| `multipartCopyPartSizeBytes` | 128 MiB | Integer bytes, 5 MiB–5 GiB. Adaptively increased to keep at most 10,000 parts; final part may be smaller. |

Mount defaults: `cacheMode` (`writes`), `writeBackSeconds` (5), `dirCacheSeconds` (60), `allowOther` (true), `uid`/`gid`/`umask` (unset), `cacheMaxSize` (unbounded), `readyTimeoutMs` (30000), `flushTimeoutMs` (60000), `bootstrapTimeoutMs` (240000), `inspectTimeoutMs` (30000). Set them in constructor `defaults`; per-attach overrides exclude flush/inspect timeouts. Freestyle caps one exec at five minutes; every guest step stays under it.

Optional `bufferSize`, `readAhead`, `readChunkSize`, `readChunkSizeLimit` and `transfers` leave rclone defaults unchanged when omitted. The four sizes require explicit units (such as `'0B'`, `'16M'`, `'1GiB'`); only `readChunkSizeLimit` also accepts `'off'`. `transfers` is an integer 1–64. `readAhead` is effective only with `cacheMode: 'full'` and does not enable it. Existing mounts are not retuned by idempotent attach. See [validation, tradeoffs and examples](docs/performance.md).

Error codes: `VALIDATION`, `VOLUME_NOT_FOUND`, `VOLUME_ALREADY_EXISTS`, `VOLUME_IN_USE`, `CONFIRMATION_REQUIRED`, `STORAGE_AUTH`, `STORAGE_UNREACHABLE`, `BUCKET_NOT_FOUND`, `STORAGE_ERROR`, `SANDBOX_EXEC`, `SANDBOX_EXEC_TIMEOUT`, `FUSE_UNAVAILABLE`, `RUNTIME_INSTALL`, `MOUNT_FAILED`, `MOUNT_TIMEOUT`, `MOUNT_PATH_IN_USE`, `MOUNT_STALE`, `MOUNT_BUSY`, `MOUNT_UNMANAGED`, `FLUSH_FAILED`, `UNSUPPORTED`. Each error carries a `hint` with the next step and `details` (log tail, mount path, sandbox id). Messages never contain credentials.

## Explicit Git operations

`VolumeGit`, `volumeGit`, `VolumeGitError` and Git types are exported from both the package root and `freestyle-volumes/git`. Git must be preinstalled in the trusted guest; mount bootstrap does not install it. Prefer **native VM disk for active worktrees**: the helper requires a healthy managed mount and deliberately restricted repositories, not blanket Git-on-S3 compatibility.

```ts
import { volumeGit } from 'freestyle-volumes/git';

const git = volumeGit({ volumes, sandboxes });
const location = { sandboxId: vmId, mountPath: '/mnt/source', repoPath: 'repo' };
await git.clone({ ...location, remote: 'owner/name', branch: 'main', token });
const status = await git.status(location);
```

After caller-authored edits, explicitly `commit({ ...location, paths: ['README.md'], message: 'Update overview', identity: { name: 'Example Author', email: 'author@example.com' } })`; prior staged changes are rejected. Pull requires a clean repo and is ff-only; push is normal/non-force. `sync({ ...location, remote: 'owner/name', branch: 'main', token, direction: 'push' })` chooses just one direction, never creates a commit. There are no PR/GitHub REST operations.

Use credential-free HTTPS URLs or GitHub `owner/name`; tokens travel only via exec environment and temporary root-only askpass for credentialed calls, not persistent URLs/config. Never log `exec.env`; trust the adapter, guest and Git installation. Hooks are disabled; configured filters, submodules, linked worktrees, filesystem symlinks/hardlinks and other unsafe layouts/configuration are rejected. Enforce a single writer and prevent detach/replacement during calls. A returned commit is `guest-local`, not S3-durable or ACID; normal detach with `flushed: true` is a separate requirement, even after a successful push. Failures/timeouts may leave partial state: inspect before retrying. See [full API and trust boundary](docs/git.md) and [explicit workflow example](examples/git.ts).

## Coming from Daytona

| Daytona | freestyle-volumes | Difference |
| :--- | :--- | :--- |
| `daytona.volume.create('name')` | `volumes.create({ name })` | Same. Id equals name here. |
| `daytona.volume.get('name', true)` | `volumes.get('name', { create: true })` | Same. |
| `daytona.volume.list()` | `volumes.list()` | Scoped to the `prefix` namespace. |
| `daytona.volume.delete(volume)` | `volumes.delete({ volumeId, confirm: volumeId })` | Explicit confirmation; refuses while attachments are recorded. |
| `daytona.create({ volumes: [{ volumeId, mountPath, subpath }] })` | `volumes.attach({ sandboxId, volumeId, mountPath, subpath })` | Mounted after the sandbox exists, not at creation. Add `readOnly`. |
| implicit unmount on sandbox delete | `volumes.detach(...)` | Detach explicitly to get a durability answer (`flushed`). |
| `volume.state` (`pending`, `ready`, ...) | none | A created volume is immediately usable. |

The full mapping with code samples: [docs/daytona-migration.md](docs/daytona-migration.md).

## Semantics you should know

Details and the failure matrix live in [docs/semantics.md](docs/semantics.md).

**When is a write durable?** A file is durable in the bucket only after it has been closed and rclone's upload completed. `detach()` normally unmounts externally, waits for FUSE serving to stop, then expedites and drains the VFS retained by `rclone rcd`. It returns `flushed: true` only after verified zero queued, in-flight and errored uploads and process cleanup. `FLUSH_FAILED` can mean the filesystem is already unmounted: the uploader, state and cache remain available. Restore storage access and retry detach, optionally with a larger `flushTimeoutMs`. Forced uncertain detach makes no durability claim and retains cache, recovery state and the advisory attachment record; unsafe process cleanup can still fail even with `force`.

**Crashes and restarts.** `stale` can mean a crashed mount or an unmounted uploader awaiting drain. Retry detach when the uploader is still running. If drain cannot be verified, explicit forced detach may stop the identified process while retaining recovery data. Reattach with the same storage identity, volume, subpath and mount path to reuse that cache, then detach normally. Legacy state lacking process identity or using the old cache identifier is not automatically migrated or rebound; recovery may require operator intervention. Preserve it rather than deleting uncertain writes. Freestyle pause/resume behavior has not been validated.

**Concurrent access.** Several sandboxes may mount one volume. There are no distributed locks or single-writer enforcement: uploads are whole objects, the last upload of a path wins, and visibility depends on directory caches (`dirCacheSeconds`). Use `readOnly` on every sandbox but one, or separate `subpath`s. Guest `flock` serializes attach/inspect/detach at one mount path; atomic creation protects only volume-record creation. Attachment records remain advisory, can be stale or missing, and do not close distributed attach/delete or create/delete races. Applications must orchestrate these operations across clients and sandboxes.

**Clone publication, not snapshots.** `clone` HEAD-validates source size/ETag, pins a version when available, copies to an isolated generation, then conditionally publishes the destination record. At or below the configured threshold (default 5 GiB) it uses single copy; larger objects use multipart copy up to a conservative **5 TiB per object**. Parts are sequential per object, with adaptive sizing (minimum configured 5 MiB, default 128 MiB, at most 10,000 parts), so clone concurrency also bounds concurrent part copies. Every part uses the source ETag condition; multipart creation preserves supported HEAD metadata and separately read tags, requiring corresponding version/tag/multipart/abort permissions. Source attachment checks are advisory: coordinate writers, verified drain and source lifecycle; `allowLiveSource` only bypasses that check. Selection caps remain 100,000 objects and 32 MiB UTF-8 JSON metadata. Unknown completion or publication retains data; other copy/cleanup failures remain uncertain even after an empty listing or acknowledged abort. Reconcile upload IDs, abort failures and late objects; ownership intents are retained, with no automatic GC/resume. Configure incomplete-MPU lifecycle cleanup, not age-based generation deletion. See [API, permissions and constants](docs/performance.md#clone-api), [reconciliation](docs/semantics.md#clone-publication-and-reconciliation) and [example](examples/clone.ts).

**Storage and cache identity.** Mount/cache ids include resolved host and sandbox endpoints, bucket, namespace prefix, region, provider and path-style mode, plus volume, generation (v2), subpath and mount path. Credentials and request timeouts are excluded, so credential rotation does not change cache identity. Custom `ObjectStore` implementations must implement atomic `putObjectIfAbsent(key, body): Promise<boolean>`: false proves this call never wrote; ambiguous outcomes must throw, not fall back to overwrite. Clone additionally needs source ETags and conditional server-side `copyObject`; it never silently downloads and re-uploads payloads.

**Object-store mount, not a POSIX filesystem.** rclone presents the bucket as files with a local write-back cache. That gives you random writes and normal tools inside a sandbox, but a changed file is re-uploaded whole on close, rename is copy plus delete, there are no hard links, no cross-sandbox locks, and empty directories are kept as zero-byte `dir/` marker objects. Databases and anything that needs block-level or transactional semantics do not belong on a volume; the same is true of Daytona volumes.

## Why rclone, and what about JuiceFS

This is a shortlist of design tradeoffs for this preview, not an exhaustive or benchmark-ranked market comparison. See [source-linked research](docs/freestyle-research.md) for the workspace/artifact boundary.

| Backend | Kind | License | Random writes | Metadata / extra service | Verdict for 0.1 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **rclone mount** (chosen) | object-store mount with local write-back cache | MIT | Yes, buffered locally; whole object re-uploaded on close | Object listing only; empty dirs via markers; **no extra service** | Single static binary, S3-compatible endpoint/path-style support (verify your provider), and an RC API used by our verified-drain protocol. Similar object-backed category to Daytona's documented volumes. |
| JuiceFS | POSIX-like distributed filesystem (chunked data in S3) | Apache-2.0 | Yes, chunk-level, no full rewrite; atomic rename, locks, xattr | **Requires a metadata engine** (Redis, MySQL, PostgreSQL, TiKV, SQLite) reachable by every sandbox; S3 alone is not the durable store | Candidate when POSIX semantics justify an additional metadata service. Planned as a second backend behind the same `RcloneBackend`-shaped interface; not implemented. |
| s3fs-fuse | object-store mount | GPL-2.0 | Whole-object rewrite | Object listing | Mature but GPL, no flush API, weaker rename semantics. |
| Mountpoint for Amazon S3 | object-store mount, sequential writes only | Apache-2.0 | No edits of existing objects, no append | Object listing | Read-mostly workloads on AWS only. |
| geesefs | object-store mount | Apache-2.0 | Partial (server-side part copies) | Object listing | Smaller community; kept as a candidate. |

The choice is deliberate: for a first release that people can point at any bucket without running a database, an object-store mount with honest, documented semantics beats a POSIX filesystem with a hidden dependency. The mount logic is isolated in [src/rclone.ts](src/rclone.ts) so a JuiceFS backend can slot in.

## Compatibility and limitations

| Environment | Supported | Notes |
| :--- | :--- | :--- |
| Freestyle `freestyle/ubuntu*` (Ubuntu 24.04) | Expected | Full Linux docs and a public Mesa FUSE example support feasibility, not validation of this backend. `vm.exec` as root; bootstrap uses apt. Live test pending. |
| Freestyle `freestyle/busybox` | No | No package manager for `fuse3`; attach fails with `RUNTIME_INSTALL`. |
| Docker container | Yes | Needs `--device /dev/fuse --cap-add SYS_ADMIN` (and `--security-opt apparmor:unconfined` where AppArmor is enforced). Verified in CI and locally. |
| gVisor / containers without `/dev/fuse` | No | `FUSE_UNAVAILABLE`, detected before anything is installed. |
| CPU | x86_64, aarch64 | Pinned rclone builds for both. |

| Limitation | Detail |
| :--- | :--- |
| Whole-object uploads | Editing one byte of a large file re-uploads the file on close. Keep large append-only logs elsewhere. |
| Rename | Copy then delete; not atomic; slow for large files or trees. |
| Locks, hard links, inotify | Not supported across sandboxes. `flock` only matters inside one sandbox. |
| Visibility across sandboxes | Delayed by `dirCacheSeconds` and by each sandbox's open file handles. |
| Write cache lives on the sandbox disk | `cacheMaxSize` is an eviction target, not a hard quota; retain headroom for dirty/open files. `freestyle/ubuntu-sm` has a 16 GB disk. |
| Versioned buckets | `delete` removes current versions only. |
| Credentials in the sandbox | Present in the rclone process environment while attached (readable by root). Detach before snapshotting. |
| Exec cap | Freestyle limits one exec to 300 s; timeouts are bounded accordingly. |

## Tests

```bash
pnpm test                # unit tests (no network, no Docker)
pnpm test:integration    # Docker + MinIO, real FUSE mounts; VOLUMES_TEST_BOOTSTRAP=1 adds the bare-Ubuntu bootstrap test
pnpm test:freestyle      # two real Freestyle VMs; needs FREESTYLE_API_KEY and VOLUMES_S3_* (billed)
pnpm check:types         # the real `freestyle` SDK satisfies the adapter's structural types
pnpm check:examples      # type-check example sources without emitting code
```

The current-code Docker/MinIO rerun on **2026-09-18** observed **2.86x metadata-list** and **2.97x clone** ratios of elapsed medians at concurrency 1 versus 8, including mandatory source HEAD checks. These are fixture-specific local host API measurements using small single-copy objects, not multipart throughput, Git, FUSE or Freestyle performance, and not general speedup guarantees. [Exact medians, methodology and raw evidence](docs/evidence/performance-local.md).

## Security notes

- Storage credentials and Git tokens travel to the sandbox as environment variables on a root exec, never embedded in command arguments, config or helper files. Git's temporary askpass helper reads the token from env; the adapter and guest must be trusted and must never log `exec.env`. Root can read process environments; avoid snapshots during credentialed Git operations and detach mounts before snapshotting.
- Every value that reaches a shell script is validated against a strict character set and single-quoted; mount paths cannot contain `..`, empty segments, spaces or quotes, and cannot target `/`, `/etc`, `/proc`, `/usr` and similar directories. Guest lifecycle operations also reject symlink mount paths and ancestors before locking or accessing state.
- Volumes are isolated by prefix. A subpath mount roots the FUSE filesystem at the subpath, so `..` cannot reach a sibling tenant.
- Nothing destructive happens implicitly: detach keeps data, delete needs `confirm`, and existing buckets are never created, formatted or emptied outside a confirmed delete.

## License

MIT. rclone (MIT) is downloaded from rclone.org inside the sandbox; the AWS SDK for JavaScript (Apache-2.0) is a dependency.
