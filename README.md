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

Version 0.1.0, preview. What has and has not been proven, in plain terms:

| Tier | What it proves | Status |
| :--- | :--- | :--- |
| Unit tests (mocked sandbox, in-memory store) | Validation, script generation, error mapping, registry, facade flow | Run on every commit |
| Linux integration tests (Docker + MinIO, real rclone FUSE mounts) | Create, attach, write, flush, detach, reattach in a fresh container, replacement, read-only, namespaces and subpaths, bad credentials, unreachable storage, mount failure and timeout, missing `/dev/fuse`, crash and resume of interrupted writes, busy mounts, flush failure, delete | Passed locally (10/10 plus the bare-Ubuntu bootstrap test); CI runs it on every push. See [docs/evidence/v0.1.md](docs/evidence/v0.1.md) |
| Freestyle live test (two real VMs) | The same round trip on Freestyle's Ubuntu image, writing as the default `ubuntu` user | **Not yet executed.** The test exists ([test/freestyle/live.test.mjs](test/freestyle/live.test.mjs)) and is skipped without credentials. See [docs/freestyle.md](docs/freestyle.md) for what is verified from Freestyle's documentation and SDK types and what remains an assumption. |

Do not read the Docker results as Freestyle results. They prove the mount mechanics on a Linux kernel with FUSE; the Freestyle adapter is proven only by the SDK's type contract until the live test runs.

## How it works

```
your process (Node 22+)                      S3-compatible bucket
┌──────────────────────────┐   HTTPS         ┌─────────────────────────────────┐
│ FreestyleVolumes         │ ──────────────▶ │ <prefix>/_volumes/<name>.json   │  volume records
│  ├ VolumeRegistry        │                 │ <prefix>/_attachments/...       │  advisory attachment records
│  └ RcloneBackend         │                 │ <prefix>/v/<name>/...           │  volume data
└──────────┬───────────────┘                 └───────────────▲─────────────────┘
           │ vm.exec(script, { env: credentials })           │ S3 API (GET/PUT/LIST)
           ▼                                                 │
┌──────────────────────────┐  FUSE            ┌──────────────┴──────────────────┐
│ Freestyle VM / container │ ◀──────────────▶ │ rclone mount (one process/mount)│
│  /mnt/datasets           │                  │ write-back cache on local disk  │
└──────────────────────────┘                  └─────────────────────────────────┘
```

- **Storage** is any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Ceph, Wasabi, ...). The bucket is the only durable store; nothing else has to run. Volume records and data share one namespace `prefix` so several apps or tenants can share a bucket without seeing each other.
- **The sandbox** runs one [rclone](https://rclone.org) process per mount, started by a POSIX `sh` script through Freestyle's `vm.exec` as `root`. Credentials reach rclone only as environment variables; they are never written to disk or put on a command line. rclone's remote-control socket (a root-only Unix socket) reports the upload queue so `detach` can prove that writes reached the bucket.
- **Bootstrap** installs `fuse3` (apt or apk) and a pinned rclone release (`1.75.1`, SHA-256 verified) when the sandbox lacks them, and reuses an existing rclone `>= 1.68`. It never creates buckets or formats anything.

More detail: [docs/architecture.md](docs/architecture.md).

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

All methods return promises and throw `VolumeError` subclasses with a stable `code` (table below).

| Method | What it does |
| :--- | :--- |
| `new FreestyleVolumes({ storage, sandboxes, defaults?, onEvent? })` | Validates configuration. `storage` is the bucket; `sandboxes` is `freestyleSandboxes(freestyle)` or `dockerSandboxes()`. |
| `create({ name, labels?, ifNotExists? })` | Writes the volume record. Fails with `VOLUME_ALREADY_EXISTS` unless `ifNotExists`. Names are 1-63 chars of `[a-z0-9-]`; the name is the id. |
| `get(name, { create? })` | Fetch, or create when missing (Daytona's `volume.get(name, true)`). |
| `list()` | Volumes in this namespace. |
| `attach({ sandboxId, volumeId, mountPath, readOnly?, subpath?, uid?, gid?, umask?, cacheMode?, writeBackSeconds?, dirCacheSeconds?, cacheMaxSize?, readyTimeoutMs?, bootstrapTimeoutMs? })` | Checks the bucket, prepares the runtime, starts the mount and waits until the mount answers a directory listing. Idempotent: a healthy identical mount returns `alreadyAttached: true`; a stale one is cleaned up and remounted, resuming pending uploads. |
| `inspectMount({ sandboxId, mountPath })` | `status` is `mounted`, `stale` (process or mount gone, cache may hold unflushed writes), `absent`, or `unmanaged` (an rclone mount this library did not create), plus pid, upload queue counts, cache size and the log tail. |
| `detach({ sandboxId, mountPath, flushTimeoutMs?, force? })` | Expedites and waits for every pending upload, unmounts, stops the process, removes the cache. `flushed: true` only when the queue drained. Never deletes volume data. |
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
| `requestTimeoutMs` | `15000` | Timeout for host-side storage calls. |

Mount defaults (`defaults`, overridable per `attach`): `cacheMode` (`writes`), `writeBackSeconds` (5), `dirCacheSeconds` (60), `allowOther` (true), `uid`/`gid`/`umask` (unset), `cacheMaxSize` (unbounded), `readyTimeoutMs` (30000), `flushTimeoutMs` (60000), `bootstrapTimeoutMs` (240000). Freestyle caps one exec at five minutes; every step stays under it.

Error codes: `VALIDATION`, `VOLUME_NOT_FOUND`, `VOLUME_ALREADY_EXISTS`, `VOLUME_IN_USE`, `CONFIRMATION_REQUIRED`, `STORAGE_AUTH`, `STORAGE_UNREACHABLE`, `BUCKET_NOT_FOUND`, `STORAGE_ERROR`, `SANDBOX_EXEC`, `SANDBOX_EXEC_TIMEOUT`, `FUSE_UNAVAILABLE`, `RUNTIME_INSTALL`, `MOUNT_FAILED`, `MOUNT_TIMEOUT`, `MOUNT_PATH_IN_USE`, `MOUNT_STALE`, `MOUNT_BUSY`, `MOUNT_UNMANAGED`, `FLUSH_FAILED`, `UNSUPPORTED`. Each error carries a `hint` with the next step and `details` (log tail, mount path, sandbox id). Messages never contain credentials.

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

**When is a write durable?** A file is durable in the bucket only after it has been closed, its write-back delay has elapsed (or `detach` expedited it), and rclone's upload completed. `inspectMount().uploads` shows what is still pending. `detach()` forces every queued upload, waits up to `flushTimeoutMs`, and returns `flushed: true` only when rclone reports zero queued, zero in-flight and zero errored uploads. If it cannot, it throws `FLUSH_FAILED` and leaves the mount attached; `force: true` detaches anyway and answers `flushed: false`. Read-only mounts have nothing to flush.

**Crashes and restarts.** If the rclone process dies or the VM reboots, `inspectMount` reports `stale`, and files that were still in the write-back cache are not in the bucket. Attaching the same volume at the same path again resumes those uploads from the cache on the sandbox disk (verified in the integration suite); a plain `detach` of a stale mount refuses so nobody mistakes it for a durable detach. Pausing and resuming a Freestyle VM keeps the process alive; rclone reconnects on its own (expected, not yet verified live).

**Concurrent access.** Several sandboxes may mount one volume. There is no locking and no single-writer enforcement: uploads are whole objects, the last upload of a path wins, and other sandboxes see new files only after their directory cache expires (`dirCacheSeconds`). Use `readOnly` on every sandbox but one, or give each sandbox its own `subpath`. Attachment records in the bucket are advisory (they can be stale after a sandbox dies) and only gate `delete`.

**Object-store mount, not a POSIX filesystem.** rclone presents the bucket as files with a local write-back cache. That gives you random writes and normal tools inside a sandbox, but a changed file is re-uploaded whole on close, rename is copy plus delete, there are no hard links, no cross-sandbox locks, and empty directories are kept as zero-byte `dir/` marker objects. Databases and anything that needs block-level or transactional semantics do not belong on a volume; the same is true of Daytona volumes.

## Why rclone, and what about JuiceFS

| Backend | Kind | License | Random writes | Metadata / extra service | Verdict for 0.1 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **rclone mount** (chosen) | object-store mount with local write-back cache | MIT | Yes, buffered locally; whole object re-uploaded on close | Object listing only; empty dirs via markers; **no extra service** | Single static binary, works against every S3-compatible endpoint with path-style addressing, has an rc API to prove flushes. Closest to what Daytona documents. |
| JuiceFS | POSIX-like distributed filesystem (chunked data in S3) | Apache-2.0 | Yes, chunk-level, no full rewrite; atomic rename, locks, xattr | **Requires a metadata engine** (Redis, MySQL, PostgreSQL, TiKV, SQLite) reachable by every sandbox; S3 alone is not the durable store | Best choice when POSIX semantics matter. Planned as a second backend behind the same `RcloneBackend`-shaped interface; not implemented. |
| s3fs-fuse | object-store mount | GPL-2.0 | Whole-object rewrite | Object listing | Mature but GPL, no flush API, weaker rename semantics. |
| Mountpoint for Amazon S3 | object-store mount, sequential writes only | Apache-2.0 | No edits of existing objects, no append | Object listing | Read-mostly workloads on AWS only. |
| geesefs | object-store mount | Apache-2.0 | Partial (server-side part copies) | Object listing | Smaller community; kept as a candidate. |

The choice is deliberate: for a first release that people can point at any bucket without running a database, an object-store mount with honest, documented semantics beats a POSIX filesystem with a hidden dependency. The mount logic is isolated in [src/rclone.ts](src/rclone.ts) so a JuiceFS backend can slot in.

## Compatibility and limitations

| Environment | Supported | Notes |
| :--- | :--- | :--- |
| Freestyle `freestyle/ubuntu*` (Ubuntu 24.04) | Expected | FUSE is listed among Freestyle's VM capabilities; `vm.exec` as root; bootstrap uses apt. Live test pending. |
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
| Write cache lives on the sandbox disk | Bound it with `cacheMaxSize`; Freestyle disks start at 16 GB. |
| Versioned buckets | `delete` removes current versions only. |
| Credentials in the sandbox | Present in the rclone process environment while attached (readable by root). Detach before snapshotting. |
| Exec cap | Freestyle limits one exec to 300 s; timeouts are bounded accordingly. |

## Tests

```bash
pnpm test                # unit tests (no network, no Docker)
pnpm test:integration    # Docker + MinIO, real FUSE mounts; VOLUMES_TEST_BOOTSTRAP=1 adds the bare-Ubuntu bootstrap test
pnpm test:freestyle      # two real Freestyle VMs; needs FREESTYLE_API_KEY and VOLUMES_S3_* (billed)
pnpm check:types         # the real `freestyle` SDK satisfies the adapter's structural types
```

## Security notes

- Credentials travel to the sandbox only as environment variables on a root exec, never as command arguments, files or log lines. The library never logs them and error messages never include them.
- Every value that reaches a shell script is validated against a strict character set and single-quoted; mount paths cannot contain `..`, empty segments, spaces or quotes, and cannot target `/`, `/etc`, `/proc`, `/usr` and similar directories.
- Volumes are isolated by prefix. A subpath mount roots the FUSE filesystem at the subpath, so `..` cannot reach a sibling tenant.
- Nothing destructive happens implicitly: detach keeps data, delete needs `confirm`, and existing buckets are never created, formatted or emptied outside a confirmed delete.

## License

MIT. rclone (MIT) is downloaded from rclone.org inside the sandbox; the AWS SDK for JavaScript (Apache-2.0) is a dependency.
