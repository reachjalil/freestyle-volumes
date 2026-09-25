<h1 align="center">freestyle-volumes</h1>

<p align="center">
  <strong>Daytona-style persistent volumes for <a href="https://www.freestyle.sh">Freestyle</a> VMs, backed by any S3-compatible bucket.</strong><br />
  Create a named volume, mount it into a VM, write files, detach, attach it somewhere else. The data is still there.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/freestyle-volumes"><img src="https://img.shields.io/npm/v/freestyle-volumes?style=flat-square&color=2448ff" alt="npm version" /></a>
  <a href="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml"><img src="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/reachjalil/freestyle-volumes/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2448ff?style=flat-square" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A522-11131b?style=flat-square" alt="Node.js 22 or later" /></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-preview-8b5cf6?style=flat-square" alt="Status: preview" /></a>
</p>

Freestyle VMs are full Linux machines with snapshots and forks, but a VM's disk belongs to that VM. `freestyle-volumes` adds the missing piece for datasets, model weights, build artifacts and agent outputs that should outlive a VM or be shared between VMs: **named volumes** that live in your own bucket (Cloudflare R2, AWS S3, MinIO, ...) and mount into any VM as an ordinary directory.

- **Library and CLI.** A TypeScript API (`create`, `get`, `list`, `clone`, `attach`, `inspect`, `detach`, `delete`) and a `freestyle-volumes` command with the same verbs.
- **Honest durability.** `detach()` returns `flushed: true` only after every pending upload has reached the bucket.
- **Fast attach.** Bake the mount runtime into a Freestyle snapshot once, and VMs booted from it skip the minute-or-two install on first attach.
- **Safe shutdown and preflight.** `detachAll()` drains every mount before a VM is deleted or snapshotted, and `freestyle-volumes doctor` checks your bucket and VMs before the first attach.
- **Nothing extra to run.** The bucket is the only durable store. No metadata server, no daemon on your side.

Community project. Not affiliated with or endorsed by [Freestyle](https://www.freestyle.sh) or [Daytona](https://www.daytona.io). "Daytona-style" describes the developer experience (named volumes, `mountPath`, `subpath`, shared across sandboxes), not API compatibility or identical filesystem semantics.

## Install

```bash
npm install freestyle-volumes freestyle
```

`freestyle` is the official Freestyle SDK, an optional peer dependency (the Docker adapter works without it). Requires Node.js 22 or later; the package is ESM with TypeScript types included.

## Quick start

You need a Freestyle API key and an existing bucket with S3 credentials.

```ts
import { Freestyle, type FirewallSpec } from 'freestyle';
import { FreestyleVolumes, freestyleSandboxes } from 'freestyle-volumes';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const volumes = new FreestyleVolumes({
  storage: {
    endpoint: 'https://<account>.r2.cloudflarestorage.com', // omit for AWS S3
    region: 'auto',
    bucket: 'my-volumes',
    accessKeyId: process.env.VOLUMES_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.VOLUMES_S3_SECRET_ACCESS_KEY!,
  },
  sandboxes: freestyleSandboxes(freestyle),
});

// Freestyle VMs get no network by default; the mount has to reach the bucket.
const firewall: FirewallSpec = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };
const volume = await volumes.get('datasets', { create: true });

const { vm, vmId } = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: vmId, volumeId: volume.id, mountPath: '/home/ubuntu/datasets', uid: 1000, gid: 1000 });
await vm.exec('echo hello > /home/ubuntu/datasets/hello.txt');
const { flushed } = await volumes.detach({ sandboxId: vmId, mountPath: '/home/ubuntu/datasets' }); // true: uploads finished
await vm.delete();

// Later, on any other VM:
const other = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: other.vmId, volumeId: volume.id, mountPath: '/mnt/datasets', readOnly: true });
console.log((await other.vm.exec('cat /mnt/datasets/hello.txt')).stdout); // hello
```

The first attach on a fresh VM installs `fuse3` and a pinned, checksum-verified rclone, which takes a minute or two. [Prepare a snapshot](#fast-attach-with-a-volume-ready-snapshot) to skip that. The complete example is [examples/freestyle.ts](examples/freestyle.ts).

Freestyle checklist:

0. Run `npx freestyle-volumes doctor --vm <vm-id>` once: it checks the bucket from your machine and the VM from the inside. See [preflight](#preflight-with-doctor).
1. Boot from an Ubuntu base (`freestyle/ubuntu*`) or a snapshot of one. `freestyle/busybox` has no package manager and fails with `RUNTIME_INSTALL`.
2. Allow outbound traffic to the storage endpoint, plus `downloads.rclone.org` and the apt mirrors on first use. The broad rule above is a starting point, not least privilege.
3. Attach with `uid: 1000, gid: 1000` when the VM's default `ubuntu` user should own the files. Mounts use `allowOther`, so every user can reach them either way.
4. Detach before snapshotting or deleting a VM: `await volumes.detachAll({ sandboxId: vmId })` drains every mount and reports `flushed: true` when nothing is left behind. A snapshot taken while attached captures the mount process, its credentials (in its environment) and its write cache.

## Fast attach with a volume-ready snapshot

Install the runtime once and snapshot it:

```ts
import { createVolumeReadySnapshot } from 'freestyle-volumes';

await createVolumeReadySnapshot(freestyle, {
  baseSnapshotId: 'freestyle/ubuntu-sm', // VMs booted from the result get this size
  slug: 'ubuntu-sm-volumes',
});

const { vmId } = await freestyle.vms.create({ snapshotId: 'ubuntu-sm-volumes', firewall });
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/mnt/datasets' }); // no installs
```

It boots a temporary builder VM, runs the same bootstrap `attach` would (fuse3, flock, rclone `1.75.1` with SHA-256 verification), snapshots it and deletes the builder. No storage credentials are involved, so none can end up in the snapshot. The builder VM also gets a one-hour TTL in case your process dies first. Build one snapshot per VM size you boot. Any rclone `>= 1.68` in the snapshot keeps being reused across library upgrades. The CLI equivalent is `freestyle-volumes prepare-snapshot --base freestyle/ubuntu-sm --slug ubuntu-sm-volumes`.

## Command line

The package ships a `freestyle-volumes` command with the same verbs. It reads the bucket and credentials from `VOLUMES_S3_*` variables (see [.env.example](.env.example)) and prints JSON, so it composes with `jq`.

```bash
export VOLUMES_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com VOLUMES_S3_REGION=auto
export VOLUMES_S3_BUCKET=my-volumes VOLUMES_S3_ACCESS_KEY_ID=... VOLUMES_S3_SECRET_ACCESS_KEY=...
export FREESTYLE_API_KEY=...

npx freestyle-volumes create datasets --label team=ml
npx freestyle-volumes attach <vm-id> datasets /home/ubuntu/datasets --uid 1000 --gid 1000
npx freestyle-volumes inspect <vm-id> /home/ubuntu/datasets
npx freestyle-volumes detach <vm-id> /home/ubuntu/datasets
npx freestyle-volumes list | jq -r '.[].name'
npx freestyle-volumes delete datasets --confirm datasets
```

| Command | What it does |
| :--- | :--- |
| `list`, `get <volume>`, `attachments <volume>` | Read volumes and their advisory attachment records. |
| `create <volume> [--label k=v]... [--if-not-exists]` | Create a volume. |
| `clone <source> <volume> [--label k=v]... [--concurrency n] [--allow-live-source]` | Server-side copy of a quiesced volume. |
| `delete <volume> --confirm <volume> [--force]` | Delete a volume and all of its data. |
| `attach <vm> <volume> <mountPath> [--read-only] [--subpath dir] [--uid n] [--gid n] ...` | Mount a volume. [Mount options](#mount-options) are flags such as `--cache-mode full` or `--write-back 10`; see `--help`. |
| `inspect <vm> <mountPath>` | `mounted`, `stale`, `absent` or `unmanaged`, with the upload queue and log tail. |
| `detach <vm> <mountPath> [--flush-timeout ms] [--force]` | Unmount after verifying the drain. |
| `mounts <vm>` | Every mount this library manages in the VM, healthy or stale, plus rclone mounts it did not create. |
| `detach-all <vm> [--flush-timeout ms] [--force]` | Detach every managed mount; exits 1 if any could not be detached. Use it before deleting a VM. |
| `doctor [--vm <vm>]` | [Preflight](#preflight-with-doctor) the bucket and optionally a VM; exits 1 if any check fails. |
| `prepare-snapshot [--base id] [--slug slug] [--name label]` | Build a [volume-ready snapshot](#fast-attach-with-a-volume-ready-snapshot). |

Global options: `--env-file <path>` (variables already set win), `--prefix <namespace>`, `--docker` (treat `<vm>` as a local container), `--quiet`. Progress goes to stderr. Exit codes: `0` success, `1` the operation failed (the error code and details are on stderr), `2` usage or configuration error. Commands that touch a VM need the `freestyle` SDK installed next to `freestyle-volumes`; for a one-off run outside a project, use `npx -p freestyle -p freestyle-volumes freestyle-volumes ...`.

## Preflight with doctor

Most first-attach failures are configuration: a firewall that blocks the bucket, a provider without conditional writes, an image without FUSE. `doctor` finds them up front. From your machine it probes the bucket: reachability, listing, atomic conditional creates (it writes one probe object twice and expects the second write to be rejected, then deletes it), read-back and delete. With `--vm`, it also checks inside the VM: CPU, root, `/dev/fuse`, `fusermount3`, `flock`, rclone, whether the VM itself can list the bucket with your credentials, and free disk for the write cache. The VM check installs and changes nothing.

```text
$ npx freestyle-volumes doctor --vm <vm-id>
ok   storage bucket: The bucket exists and these credentials can reach it.
ok   storage list: Listing freestyle-volumes/ works.
ok   storage conditional-create: Conditional creates are enforced: a second create of the same key was rejected.
ok   storage read: The probe object read back unchanged.
ok   storage delete: Deleting the probe object works.
ok   <vm-id> arch: aarch64
ok   <vm-id> root: scripts run as uid 0
FAIL <vm-id> fuse-device: /dev/fuse is missing
     Freestyle Ubuntu VMs expose /dev/fuse. A Docker container needs --device /dev/fuse --cap-add SYS_ADMIN.
warn <vm-id> fusermount: not installed; attach installs fuse3 with apt-get
ok   <vm-id> flock: /usr/bin/flock
warn <vm-id> rclone: no rclone >= 1.68.0; attach downloads 1.75.1 from downloads.rclone.org
     Boot from a volume-ready snapshot (createVolumeReadySnapshot or `freestyle-volumes prepare-snapshot`) to skip the download on attach.
...
```

That output comes from a bare `ubuntu:24.04` container without FUSE. `warn` lines are things attach will install, or could not be tested yet; only `FAIL` lines block an attach. The same checks are available as `volumes.checkStorage()` and `volumes.checkSandbox({ sandboxId })`, and the JSON report goes to stdout.

## Recipe: agent runs

A common Freestyle pattern is one VM per agent run, with shared inputs and collected outputs. Keep the agent's working directory on the VM's own disk and put only inputs and finished artifacts on volumes:

```ts
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/home/ubuntu/data', readOnly: true });
await volumes.attach({ sandboxId: vmId, volumeId: 'runs', subpath: runId, mountPath: '/home/ubuntu/out', uid: 1000, gid: 1000 });
// ... the agent runs ...
const { flushed } = await volumes.detachAll({ sandboxId: vmId });
if (flushed) await vm.delete(); // otherwise keep the VM: its cache still holds unuploaded writes
```

Read-only inputs cannot be damaged by a run, and each run's `subpath` keeps its outputs apart from every other run in one volume. The complete version is [examples/agent-run.ts](examples/agent-run.ts).

To seed a volume without a VM, write straight into its data prefix with any S3 tool; mounts see new files after their directory cache (`dirCacheSeconds`) expires:

```bash
aws s3 sync ./data "s3://my-volumes/$(npx freestyle-volumes get datasets | jq -r .dataPrefix)/"
```

Add `--endpoint-url` for R2 or MinIO. The same prefix is where finished outputs can be read back.

## How it works

```
your process (Node 22+)                      S3-compatible bucket
┌──────────────────────────┐   HTTPS         ┌─────────────────────────────────┐
│ FreestyleVolumes         │ ──────────────▶ │ <prefix>/_volumes/<name>.json   │  volume records
│  ├ VolumeRegistry        │                 │ <prefix>/_attachments/...       │  advisory attachment records
│  └ RcloneBackend         │                 │ <prefix>/v2/<name>/<gen>/...    │  volume data
└──────────┬───────────────┘                 └───────────────▲─────────────────┘
           │ vm.exec(script, { env: credentials })           │ S3 API (GET/PUT/LIST)
           ▼                                                 │
┌──────────────────────────┐  FUSE            ┌──────────────┴──────────────────┐
│ Freestyle VM / container │ ◀──────────────▶ │ rclone rcd + mount/mount        │
│  /mnt/datasets           │                  │ write-back cache on local disk  │
└──────────────────────────┘                  └─────────────────────────────────┘
```

- **Storage** is an S3-compatible service with atomic conditional PUT support for volume creation (AWS S3, Cloudflare R2, MinIO, etc.; verify your provider's support). Volume records and data share one namespace `prefix`, so several apps or tenants can use separate namespaces in one bucket.
- **The VM** runs one [rclone](https://rclone.org) process per mount, started by a POSIX `sh` script through Freestyle's `vm.exec` as `root`. Credentials reach rclone only as environment variables; they are never written to disk or put on a command line. rclone's remote-control socket (root-only, Unix) reports the upload queue, so `detach` can prove that writes reached the bucket.
- **Bootstrap** installs `fuse3`, `util-linux` when `flock` is missing (apt or apk) and a pinned rclone release (`1.75.1`, SHA-256 verified) when needed, and reuses an existing rclone `>= 1.68`. It never creates buckets or formats anything.

New volumes use generation-specific v2 data prefixes; legacy `<prefix>/v/<name>` records remain supported. Clone ownership intents live at `<prefix>/_operations/<operationId>.json`. Clients older than 0.2 cannot read v2 records, so upgrade every participant in a shared namespace before creating new volumes.

More detail: [architecture](docs/architecture.md), [performance and cloning](docs/performance.md), [Freestyle specifics](docs/freestyle.md) and [source-linked Freestyle research](docs/freestyle-research.md). Keep active workspaces on native VM disk and reviewable source in Git; these object-backed volumes complement them with shared datasets and artifacts.

## API

The volume methods return promises and throw `VolumeError` subclasses with a stable `code`. The separate Git helper uses `VolumeGitError` (see [Git operations](#explicit-git-operations)).

| Method | What it does |
| :--- | :--- |
| `new FreestyleVolumes({ storage, sandboxes, defaults?, onEvent? })` | Validates configuration. `storage` is the bucket; `sandboxes` is `freestyleSandboxes(freestyle)` or `dockerSandboxes()`. |
| `create({ name, labels?, ifNotExists? })` | Atomically creates the volume record only if absent. Concurrent losers get `VOLUME_ALREADY_EXISTS`, or the winner's record with `ifNotExists`. Names are 1-63 chars of `[a-z0-9-]`; the name is the id. |
| `get(name, { create? })` | Fetch, or create when missing (Daytona's `volume.get(name, true)`). |
| `list({ concurrency? }?)` | Volumes in this namespace, sorted by name; metadata-read concurrency defaults to 8 (integer 1–64). Not a snapshot of concurrent changes. |
| `clone({ sourceVolumeId, name, labels?, allowLiveSource?, concurrency?, maxObjects?, maxManifestBytes? })` | Server-side copies within this bucket/namespace, then atomic conditional publication of a new volume. Returns `{ volume, operationId, copiedObjects, copiedBytes }`. Caller must quiesce the source; not a snapshot or COW fork. |
| `attach({ sandboxId, volumeId, mountPath, readOnly?, subpath?, ...mountOptions })` | Checks the bucket, prepares the runtime, starts the mount and waits until it answers a directory listing. A healthy matching mount returns `alreadyAttached: true`. Stale mounts or existing processes require explicit detach; failed attach retains recovery state and cache. |
| `inspectMount({ sandboxId, mountPath })` | `status` is `mounted`, `stale` (process or mount gone, cache may hold unflushed writes), `absent`, or `unmanaged` (an rclone mount this library did not create), plus pid, upload queue counts, cache size and the log tail. |
| `detach({ sandboxId, mountPath, flushTimeoutMs?, force? })` | Unmounts first, waits for FUSE serving to stop, drains the retained VFS, then stops the process. Removes cache/state and the advisory attachment record only after a verified drain. Uncertain forced detach retains them and returns `flushed: false`. Never deletes volume data. |
| `delete({ volumeId, confirm, force? })` | Destroys the record and every object under the volume's data prefix. `confirm` must equal `volumeId`. Refuses while attachment records exist unless `force`. |
| `listMounts({ sandboxId })` | Every mount this library manages in the sandbox (`mounted` or `stale`, with volume, subpath, mode and pid) plus `unmanaged` rclone mounts. A point-in-time view; takes no locks. |
| `detachAll({ sandboxId, flushTimeoutMs?, force? })` | Detaches every managed mount in turn. Never throws for one mount: failures are listed in `results` with their recovery data retained, and `flushed` is true only when nothing unflushed is left. Unmanaged mounts are left alone. |
| `checkStorage()` | Preflight of the bucket from this process, including whether the provider enforces conditional creates. Returns `{ ok, checks }`; never throws for a failed check. |
| `checkSandbox({ sandboxId, timeoutMs? })` | Read-only preflight inside a sandbox: runtime, FUSE, whether it can list the bucket with these credentials, cache disk. Returns `{ ok, checks }` with a hint for each warning or failure. |
| `createVolumeReadySnapshot(freestyle, { baseSnapshotId?, slug?, displayName?, firewall?, bootstrapTimeoutMs?, builderTtlSeconds?, onEvent? })` | Builds a Freestyle snapshot with the mount runtime preinstalled. Returns `{ snapshotId, slug, builderVmId, runtime, warnings }`. |

### Storage configuration

`storageConfigFromEnv(env = process.env)` builds this object from the `VOLUMES_S3_*` variables the CLI uses (see [.env.example](.env.example)), and throws a `VALIDATION` error that names any missing required variable.

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `endpoint` | AWS S3 | S3 API URL as seen from your process. |
| `sandboxEndpoint` | `endpoint` | S3 API URL as seen from inside the VM (private networks, Docker). |
| `region` | `us-east-1` | `auto` for R2; anything for MinIO. |
| `bucket` | required | Must exist. Never created. |
| `prefix` | `freestyle-volumes` | Namespace inside the bucket. Different prefixes never see each other's volumes. |
| `accessKeyId`, `secretAccessKey`, `sessionToken?` | required | Used by this process (registry) and passed to rclone as environment variables. |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style addressing, needed by MinIO and most self-hosted services. |
| `provider` | `AWS` or `Other` | rclone provider hint (`Minio`, `Cloudflare`, `Ceph`, ...). |
| `requestTimeoutMs` | `15000` | Per-request timeout for host-side storage calls, including each multipart stage; not a whole-clone deadline. |
| `multipartCopyThresholdBytes` | 5 GiB | Integer bytes, 5 MiB–5 GiB. Single copy at or below this threshold; multipart above it. |
| `multipartCopyPartSizeBytes` | 128 MiB | Integer bytes, 5 MiB–5 GiB. Adaptively increased to keep at most 10,000 parts; final part may be smaller. |

### Mount options

Defaults: `cacheMode` (`writes`), `writeBackSeconds` (5), `dirCacheSeconds` (60), `allowOther` (true), `uid`/`gid`/`umask` (unset), `cacheMaxSize` (unbounded), `readyTimeoutMs` (30000), `flushTimeoutMs` (60000), `bootstrapTimeoutMs` (240000), `inspectTimeoutMs` (30000). Set them in the constructor's `defaults`; per-attach overrides exclude the flush and inspect timeouts. Freestyle caps one exec at five minutes, and every guest step stays under it.

Optional `bufferSize`, `readAhead`, `readChunkSize`, `readChunkSizeLimit` and `transfers` leave rclone defaults unchanged when omitted. The four sizes require explicit units (such as `'0B'`, `'16M'`, `'1GiB'`); only `readChunkSizeLimit` also accepts `'off'`. `transfers` is an integer 1–64. `readAhead` is effective only with `cacheMode: 'full'` and does not enable it. Existing mounts are not retuned by idempotent attach. See [validation, tradeoffs and examples](docs/performance.md).

### Errors

Codes: `VALIDATION`, `VOLUME_NOT_FOUND`, `VOLUME_ALREADY_EXISTS`, `VOLUME_IN_USE`, `CONFIRMATION_REQUIRED`, `STORAGE_AUTH`, `STORAGE_UNREACHABLE`, `BUCKET_NOT_FOUND`, `STORAGE_ERROR`, `SANDBOX_EXEC`, `SANDBOX_EXEC_TIMEOUT`, `FUSE_UNAVAILABLE`, `RUNTIME_INSTALL`, `MOUNT_FAILED`, `MOUNT_TIMEOUT`, `MOUNT_PATH_IN_USE`, `MOUNT_STALE`, `MOUNT_BUSY`, `MOUNT_UNMANAGED`, `FLUSH_FAILED`, `UNSUPPORTED`. Each error carries a `hint` with the next step and `details` (log tail, mount path, sandbox id). Messages never contain credentials.

```ts
import { isVolumeError } from 'freestyle-volumes';

try {
  await volumes.detach({ sandboxId: vmId, mountPath: '/mnt/datasets' });
} catch (error) {
  if (isVolumeError(error, 'FLUSH_FAILED')) {
    // The uploader and its cache are still there: restore storage access, then retry detach.
  }
  throw error;
}
```

## Local development without Freestyle

A Docker container with `/dev/fuse` stands in for a VM and MinIO for S3; see [examples/local-docker.ts](examples/local-docker.ts) and `freestyle-volumes/docker`. The integration suite uses exactly this setup, and the CLI's `--docker` flag targets such a container.

## Explicit Git operations

`VolumeGit`, `volumeGit`, `VolumeGitError` and Git types are exported from both the package root and `freestyle-volumes/git`. Git must be preinstalled in the trusted guest; mount bootstrap does not install it. Prefer **native VM disk for active worktrees**: the helper requires a healthy managed mount and deliberately restricted repositories, not blanket Git-on-S3 compatibility.

```ts
import { volumeGit } from 'freestyle-volumes/git';

const git = volumeGit({ volumes, sandboxes });
const location = { sandboxId: vmId, mountPath: '/mnt/source', repoPath: 'repo' };
await git.clone({ ...location, remote: 'owner/name', branch: 'main', token });
const status = await git.status(location);
```

After caller-authored edits, explicitly `commit({ ...location, paths: ['README.md'], message: 'Update overview', identity: { name: 'Example Author', email: 'author@example.com' } })`; prior staged changes are rejected. Pull requires a clean repo and is ff-only; push is normal/non-force. `sync({ ...location, remote: 'owner/name', branch: 'main', token, direction: 'push' })` chooses just one direction and never creates a commit. There are no PR or GitHub REST operations.

Use credential-free HTTPS URLs or GitHub `owner/name`; tokens travel only via exec environment and a temporary root-only askpass, never persistent URLs or config. Never log `exec.env`; trust the adapter, guest and Git installation. Hooks are disabled; configured filters, submodules, linked worktrees, filesystem symlinks/hardlinks and other unsafe layouts are rejected. Enforce a single writer and prevent detach or replacement during calls. A returned commit is `guest-local`, not S3-durable or ACID: a normal detach with `flushed: true` is a separate requirement, even after a successful push. See the [full API and trust boundary](docs/git.md) and the [workflow example](examples/git.ts).

## Coming from Daytona

| Daytona | freestyle-volumes | Difference |
| :--- | :--- | :--- |
| `daytona.volume.create('name')` | `volumes.create({ name })` | Same. Id equals name here. |
| `daytona.volume.get('name', true)` | `volumes.get('name', { create: true })` | Same. |
| `daytona.volume.list()` | `volumes.list()` | Scoped to the `prefix` namespace. |
| `daytona.volume.delete(volume)` | `volumes.delete({ volumeId, confirm: volumeId })` | Explicit confirmation; refuses while attachments are recorded. |
| `daytona.create({ volumes: [{ volumeId, mountPath, subpath }] })` | `volumes.attach({ sandboxId, volumeId, mountPath, subpath })` | Mounted after the VM exists, not at creation. Adds `readOnly`. |
| implicit unmount on sandbox delete | `volumes.detach(...)` | Detach explicitly to get a durability answer (`flushed`). |
| `volume.state` (`pending`, `ready`, ...) | none | A created volume is immediately usable. |
| `daytona volume ...` CLI | `freestyle-volumes ...` CLI | Same verbs, JSON output. |

The full mapping with code samples: [docs/daytona-migration.md](docs/daytona-migration.md).

## Semantics you should know

Details and the failure matrix live in [docs/semantics.md](docs/semantics.md).

**When is a write durable?** A file is durable in the bucket only after it has been closed and rclone's upload completed. `detach()` normally unmounts, waits for FUSE serving to stop, then expedites and drains the VFS retained by `rclone rcd`. It returns `flushed: true` only after verified zero queued, in-flight and errored uploads and process cleanup. `FLUSH_FAILED` can mean the filesystem is already unmounted while the uploader, state and cache remain: restore storage access and retry detach, optionally with a larger `flushTimeoutMs`. A forced uncertain detach makes no durability claim and retains cache, recovery state and the advisory attachment record.

**Crashes and restarts.** `stale` can mean a crashed mount or an unmounted uploader awaiting drain. Retry detach when the uploader is still running. If drain cannot be verified, an explicit forced detach may stop the identified process while retaining recovery data. Reattach with the same storage identity, volume, subpath and mount path to reuse that cache, then detach normally. Freestyle pause/resume behavior has not been validated.

**Concurrent access.** Several VMs may mount one volume. There are no distributed locks or single-writer enforcement: uploads are whole objects, the last upload of a path wins, and visibility depends on directory caches (`dirCacheSeconds`). Use `readOnly` on every VM but one, or separate `subpath`s. Guest `flock` serializes attach/inspect/detach at one mount path; atomic creation protects only volume-record creation. Attachment records are advisory and do not close distributed attach/delete or create/delete races; applications must orchestrate those.

**Clone publication, not snapshots.** `clone` HEAD-validates source size and ETag, pins a version when available, copies to an isolated generation, then conditionally publishes the destination record. At or below the configured threshold (default 5 GiB) it uses single copy; larger objects use multipart copy up to a conservative **5 TiB per object**. Source attachment checks are advisory: coordinate writers and verified drain yourself; `allowLiveSource` only bypasses that check. Selection caps are 100,000 objects and 32 MiB of UTF-8 JSON metadata. Unknown completion or publication retains data, and ownership intents are retained with no automatic GC or resume. See the [API, permissions and constants](docs/performance.md#clone-api), [reconciliation](docs/semantics.md#clone-publication-and-reconciliation) and [example](examples/clone.ts).

**Storage and cache identity.** Mount and cache ids include the resolved host and sandbox endpoints, bucket, namespace prefix, region, provider and path-style mode, plus volume, generation, subpath and mount path. Credentials and request timeouts are excluded, so credential rotation does not change cache identity. Custom `ObjectStore` implementations must implement atomic `putObjectIfAbsent(key, body): Promise<boolean>`: `false` proves this call never wrote, and ambiguous outcomes must throw rather than fall back to overwriting.

**Object-store mount, not a POSIX filesystem.** rclone presents the bucket as files with a local write-back cache. That gives you random writes and normal tools inside a VM, but a changed file is re-uploaded whole on close, rename is copy plus delete, there are no hard links, no cross-VM locks, and empty directories are kept as zero-byte `dir/` marker objects. Databases and anything that needs block-level or transactional semantics do not belong on a volume; the same is true of Daytona volumes.

## Compatibility and limitations

| Environment | Supported | Notes |
| :--- | :--- | :--- |
| Freestyle `freestyle/ubuntu*` (Ubuntu 24.04) | Expected | `vm.exec` as root; bootstrap uses apt. Type-checked against the Freestyle SDK; the live test is pending (see [project status](#project-status)). |
| Freestyle `freestyle/busybox` | No | No package manager for `fuse3`; attach fails with `RUNTIME_INSTALL`. |
| Docker container | Yes | Needs `--device /dev/fuse --cap-add SYS_ADMIN` (and `--security-opt apparmor:unconfined` where AppArmor is enforced). Verified in CI and locally. |
| gVisor / containers without `/dev/fuse` | No | `FUSE_UNAVAILABLE`, detected before anything is installed. |
| CPU | x86_64, aarch64 | Pinned rclone builds for both. |

| Limitation | Detail |
| :--- | :--- |
| Whole-object uploads | Editing one byte of a large file re-uploads the file on close. Keep large append-only logs elsewhere. |
| Rename | Copy then delete; not atomic; slow for large files or trees. |
| Locks, hard links, inotify | Not supported across VMs. `flock` only matters inside one VM. |
| Visibility across VMs | Delayed by `dirCacheSeconds` and by each VM's open file handles. |
| Write cache lives on the VM disk | `cacheMaxSize` is an eviction target, not a hard quota; keep headroom for dirty and open files. `freestyle/ubuntu-sm` has a 16 GB disk. |
| Versioned buckets | `delete` removes current versions only. |
| Credentials in the VM | Present in the rclone process environment while attached (readable by root). Detach before snapshotting. |
| Exec cap | Freestyle limits one exec to 300 s; timeouts are bounded accordingly. |

## Why rclone, and what about JuiceFS

This is a shortlist of design tradeoffs for this preview, not an exhaustive or benchmark-ranked comparison. See the [source-linked research](docs/freestyle-research.md) for the workspace/artifact boundary.

| Backend | Kind | License | Random writes | Metadata / extra service | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **rclone mount** (chosen) | object-store mount with local write-back cache | MIT | Yes, buffered locally; whole object re-uploaded on close | Object listing only; empty dirs via markers; **no extra service** | Single static binary, S3-compatible endpoint/path-style support, and an RC API used by the verified-drain protocol. Similar category to Daytona's documented volumes. |
| JuiceFS | POSIX-like distributed filesystem (chunked data in S3) | Apache-2.0 | Yes, chunk-level; atomic rename, locks, xattr | **Requires a metadata engine** (Redis, MySQL, PostgreSQL, TiKV, SQLite) reachable by every VM | Candidate when POSIX semantics justify an extra service. Planned as a second backend behind the same interface; not implemented. |
| s3fs-fuse | object-store mount | GPL-2.0 | Whole-object rewrite | Object listing | Mature but GPL, no flush API, weaker rename semantics. |
| Mountpoint for Amazon S3 | object-store mount, sequential writes only | Apache-2.0 | No edits of existing objects, no append | Object listing | Read-mostly workloads on AWS only. |
| geesefs | object-store mount | Apache-2.0 | Partial (server-side part copies) | Object listing | Smaller community; kept as a candidate. |

For a first release that people can point at any bucket without running a database, an object-store mount with honest, documented semantics beats a POSIX filesystem with a hidden dependency. The mount logic is isolated in [src/rclone.ts](src/rclone.ts) so a JuiceFS backend can slot in.

## Project status

Preview (`0.x`): the API can change between minor versions, and each change is listed in the [changelog](CHANGELOG.md). What has been verified, and where:

| Tier | What it proves | Latest result (0.2.0, 2026-09-25) |
| :--- | :--- | :--- |
| Unit tests (mocked VM, in-memory store, guest scripts run in a local shell) | Validation, script generation, error mapping, registry, clone, Git checks, CLI, snapshot helper, mount listing, preflight checks | `pnpm test`: 146 passed, 0 skipped. SDK and example type checks passed. |
| Package smoke test | The packed tarball installs and works: ESM and `require()`, the CLI bin, TypeScript under nodenext, bundler and node10 | `pnpm test:package`: passed. |
| Linux integration (Docker + MinIO, real rclone FUSE) | Lifecycle, isolation, failure recovery, post-unmount drain, `detachAll` with crashed and unmanaged mounts, preflight checks, Git on FUSE, the CLI end to end, bare Ubuntu bootstrap, minimum and pinned rclone | `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration`: 33 passed, 0 skipped (local Docker, linux/arm64). CI runs the same suite on linux/amd64. |
| Freestyle live (real VMs, billed) | The round trip and the snapshot build on Freestyle's Ubuntu image | **Not yet run**: 2 skipped without credentials. Needs a Freestyle API key and a bucket: run the manual [Freestyle live test](.github/workflows/freestyle-live.yml) workflow or `pnpm test:freestyle`. |

Docker results are not Freestyle results: they exercise the mount mechanics on real FUSE, while the Freestyle adapter is checked against the SDK's types until the live test runs. Multipart copy is verified with a small real fixture plus mocked large-size boundaries, not an actual 5 TiB copy; Git with local smart HTTP on real FUSE, not live authenticated GitHub. Details and history: [docs/evidence](docs/evidence/v0.2.md).

## Security notes

- Storage credentials and Git tokens travel to the VM as environment variables on a root exec, never embedded in command arguments, config or helper files. Root can read process environments; detach mounts before snapshotting and avoid snapshots during credentialed Git operations.
- Every value that reaches a shell script is validated against a strict character set and single-quoted. Mount paths cannot contain `..`, empty segments, spaces or quotes, and cannot target `/`, `/etc`, `/proc`, `/usr` and similar directories. Guest lifecycle operations also reject symlinked mount paths and ancestors before locking or touching state.
- Volumes are isolated by prefix. A subpath mount roots the FUSE filesystem at the subpath, so `..` cannot reach a sibling tenant.
- Nothing destructive happens implicitly: detach keeps data, delete needs `confirm`, and buckets are never created, formatted or emptied outside a confirmed delete.

## Development

```bash
pnpm install
pnpm test                # unit tests (no network, no Docker)
pnpm test:integration    # Docker + MinIO, real FUSE mounts; VOLUMES_TEST_BOOTSTRAP=1 adds the bare-Ubuntu bootstrap test
pnpm test:package        # pack, install into a fresh project, import, run the CLI, type-check
pnpm test:freestyle      # real Freestyle VMs (billed); needs FREESTYLE_API_KEY and VOLUMES_S3_*
pnpm check:types         # the real `freestyle` SDK satisfies the adapter's structural types
pnpm check:examples      # type-check the examples
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [docs/release.md](docs/release.md) for publishing to npm.

## License

MIT. rclone (MIT) is downloaded from rclone.org inside the VM; the AWS SDK for JavaScript (Apache-2.0) is a dependency.
