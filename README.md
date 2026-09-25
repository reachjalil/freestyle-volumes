<h1 align="center">freestyle-volumes</h1>

<p align="center">
  <strong>Persistent volumes for <a href="https://www.freestyle.sh">Freestyle</a> VMs, stored in your own S3-compatible bucket.</strong><br />
  Create a named volume, mount it into any VM, and your files outlive the VM.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/freestyle-volumes"><img src="https://img.shields.io/npm/v/freestyle-volumes?style=flat-square&color=2448ff" alt="npm version" /></a>
  <a href="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml"><img src="https://github.com/reachjalil/freestyle-volumes/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/reachjalil/freestyle-volumes/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2448ff?style=flat-square" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A522-11131b?style=flat-square" alt="Node.js 22 or later" /></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-preview-8b5cf6?style=flat-square" alt="Status: preview" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#common-tasks">Common tasks</a> ·
  <a href="#command-line">CLI</a> ·
  <a href="https://github.com/reachjalil/freestyle-volumes/blob/main/docs/api.md">API reference</a> ·
  <a href="#faq">FAQ</a>
</p>

A Freestyle VM's disk belongs to that VM. When you delete the VM, its files go with it, and no other VM can see them. `freestyle-volumes` adds **named volumes**: folders that live in your bucket (Cloudflare R2, AWS S3, MinIO, ...) and mount into any VM as an ordinary directory. Write in one VM, detach, and read the same files in another VM, today or next month.

```ts
await volumes.get('datasets', { create: true });
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/mnt/datasets' });
// ... programs in the VM read and write /mnt/datasets like any other directory ...
const { flushed } = await volumes.detach({ sandboxId: vmId, mountPath: '/mnt/datasets' });
// flushed === true: every write is safely in the bucket
```

- **Your bucket, nothing else to run.** Volumes are plain objects in a bucket you own. No metadata server, no daemon, no database.
- **Mount anywhere, share safely.** Attach one volume to many VMs, read-write or read-only, whole or just one folder of it.
- **Know when your data is safe.** `detach()` reports `flushed: true` only after every write has reached the bucket.
- **Built for agents and pipelines.** Save progress with `flush()`, recover after a restart with `restoreMounts()`, allow a single writer with `exclusive`, and clean up with `reconcile()`.
- **Least privilege.** Give each mount a key that can reach only its own volume.
- **Fast to attach.** From a volume-ready snapshot, attach takes about 1.5 s instead of 15 s.
- **Library and CLI.** A typed TypeScript API, and a `freestyle-volumes` command that prints JSON.

> This is a community project, not affiliated with or endorsed by [Freestyle](https://www.freestyle.sh) or [Daytona](https://www.daytona.io). "Daytona-style" describes the developer experience (named volumes, `mountPath`, `subpath`, shared across sandboxes), not API compatibility.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Common tasks](#common-tasks)
- [Setting up storage](#setting-up-storage)
- [Command line](#command-line)
- [API at a glance](#api-at-a-glance)
- [Guarantees and limits](#guarantees-and-limits)
- [FAQ](#faq)
- [Project status](#project-status)
- [Security](#security)
- [Contributing](#contributing)

## How it works

```text
 Your code or the CLI                     Your bucket (R2, S3, MinIO, ...)
 ┌─────────────────────┐  volume records  ┌──────────────────────────────┐
 │  FreestyleVolumes   │ ───────────────> │ freestyle-volumes/           │
 └──────────┬──────────┘                  │   _volumes/datasets.json     │
            │ vm.exec (as root)           │   v2/datasets/<gen>/...      │
            v                             └──────────────^───────────────┘
 ┌─────────────────────────────────────────┐             │
 │ Freestyle VM                            │             │ S3 API
 │  /mnt/datasets <─ FUSE ─> rclone mount ─┼─────────────┘
 │                           (write cache) │
 └─────────────────────────────────────────┘
```

1. **Your process** keeps one small JSON record per volume in the bucket. Creating, listing, cloning and deleting volumes never touch a VM.
2. **`attach`** runs a short shell script inside the VM through Freestyle's `vm.exec`. If the VM needs them, it installs `fuse3` and a pinned, checksum-verified [rclone](https://rclone.org), then mounts the volume's folder of the bucket at `mountPath`.
3. **Writes** go to a cache on the VM's disk and upload to the bucket a few seconds after each file is closed.
4. **`detach`** unmounts, waits until the upload queue is empty, and only then reports `flushed: true`.

Storage keys reach the VM only as environment variables of the rclone process. They are never written to its disk or put on a command line. For the full picture, see [architecture](docs/architecture.md).

## Quick start

**You need** Node.js 22 or later, a [Freestyle](https://www.freestyle.sh) API key, and an existing bucket with S3 credentials. Cloudflare R2 takes [four steps](#cloudflare-r2).

**1. Install** the library and the official Freestyle SDK. The package is ESM and ships TypeScript types.

```bash
npm install freestyle-volumes freestyle
```

**2. Configure** your bucket and keys. The library and the CLI read the same variables:

```bash
export FREESTYLE_API_KEY=...
export VOLUMES_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com  # omit for AWS S3
export VOLUMES_S3_REGION=auto
export VOLUMES_S3_BUCKET=my-volumes
export VOLUMES_S3_ACCESS_KEY_ID=...
export VOLUMES_S3_SECRET_ACCESS_KEY=...
```

Check the bucket before going further. Every line should start with `ok`:

```bash
npx freestyle-volumes doctor
```

**3. Write in one VM, read in another:**

```ts
import { Freestyle, type FirewallSpec } from 'freestyle';
import { FreestyleVolumes, freestyleSandboxes, storageConfigFromEnv } from 'freestyle-volumes';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const volumes = new FreestyleVolumes({
  storage: storageConfigFromEnv(), // the VOLUMES_S3_* variables
  sandboxes: freestyleSandboxes(freestyle),
});

// Freestyle VMs start without network access; the mount has to reach the bucket.
const firewall: FirewallSpec = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };

await volumes.get('datasets', { create: true });

// The first VM writes a file, then goes away.
const first = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: first.vmId, volumeId: 'datasets', mountPath: '/home/ubuntu/datasets', uid: 1000, gid: 1000 });
await first.vm.exec('echo hello > /home/ubuntu/datasets/hello.txt');
const { flushed } = await volumes.detach({ sandboxId: first.vmId, mountPath: '/home/ubuntu/datasets' });
console.log(flushed); // true: the file is in the bucket
await first.vm.delete();

// A second VM reads it back.
const second = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: second.vmId, volumeId: 'datasets', mountPath: '/mnt/datasets', readOnly: true });
console.log((await second.vm.exec('cat /mnt/datasets/hello.txt')).stdout); // hello
await volumes.detach({ sandboxId: second.vmId, mountPath: '/mnt/datasets' });
await second.vm.delete();
```

The first attach on a fresh VM installs fuse3 and rclone, which takes about 15 s. A [volume-ready snapshot](#make-attach-fast-with-a-snapshot) cuts that to about 1.5 s. A runnable version is in [examples/freestyle.ts](examples/freestyle.ts).

## Core concepts

| Concept | What it means |
| :--- | :--- |
| **Volume** | A named folder tree in your bucket, such as `datasets`. The name is also its id: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. |
| **Namespace** | The folder of the bucket that holds your volumes: `prefix`, `freestyle-volumes` by default. Apps or tenants with different prefixes never see each other's volumes. |
| **Attach and detach** | Mount a volume into a VM at a `mountPath`, and unmount it again. One VM can mount many volumes, and many VMs can mount the same volume. |
| **Flushed** | Every write has reached the bucket. `detach`, `detachAll` and `flush` report it. Delete a VM only after its volumes report `flushed: true`. |
| **Read-only** | `readOnly: true`: the VM can read the volume but cannot change it. |
| **Subpath** | `subpath: 'run-42'`: mount a single folder of a volume, such as one per run or per customer. |
| **Exclusive** | `exclusive: true`: take the volume's writer lease, so no other writable attach can start until this mount detaches. |
| **Volume-ready snapshot** | A Freestyle snapshot with fuse3 and rclone preinstalled, so attach skips the install. |

## Common tasks

| I want to... | Use |
| :--- | :--- |
| [Share a dataset with many VMs](#share-a-dataset-with-many-vms) | `attach({ readOnly: true })` |
| [Give every run its own output folder](#give-every-run-its-own-output-folder) | `attach({ subpath })`, `detachAll()` |
| [Create a VM with volumes attached](#create-a-vm-with-volumes-attached) | `createVmWithVolumes()` |
| [Make attach fast](#make-attach-fast-with-a-snapshot) | `createVolumeReadySnapshot()` |
| [Save progress during a long job](#save-progress-during-a-long-job) | `flush()` |
| [Recover after a VM restart](#recover-after-a-vm-restart) | `restoreMounts()` |
| [Allow only one writer](#allow-only-one-writer) | `attach({ exclusive: true })` |
| [Give each VM a key for its volume only](#give-each-vm-a-key-for-its-volume-only) | `sandboxCredentials`, `scopedPolicy()` |
| [Load data without a VM](#load-data-without-a-vm) | any S3 tool and the volume's `dataPrefix` |
| [Shut down a VM without losing writes](#shut-down-a-vm-without-losing-writes) | `detachAll()` |
| [Check a setup before the first attach](#check-your-setup) | `freestyle-volumes doctor` |
| [Copy, measure and clean up volumes](#copy-measure-and-clean-up-volumes) | `clone()`, `usage()`, `reconcile()` |
| [Handle errors](#handle-errors) | `isVolumeError()` |

### Share a dataset with many VMs

```ts
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/mnt/datasets', readOnly: true });
```

Any number of VMs can mount the same volume at once. A read-only mount cannot change it, so a buggy run cannot damage your inputs.

### Give every run its own output folder

One VM per agent run is a common Freestyle pattern. Mount the shared inputs read-only, and give each run its own folder of an outputs volume:

```ts
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/home/ubuntu/data', readOnly: true });
await volumes.attach({ sandboxId: vmId, volumeId: 'runs', subpath: runId, mountPath: '/home/ubuntu/out', uid: 1000, gid: 1000 });

// ... the agent works on the VM's own disk and saves its results to /home/ubuntu/out ...

const { flushed } = await volumes.detachAll({ sandboxId: vmId });
if (flushed) await vm.delete(); // otherwise keep the VM: its disk still holds writes that did not upload
```

The VM sees only `runs/<runId>/` at `/home/ubuntu/out`, so runs never overwrite each other. `uid: 1000, gid: 1000` makes the VM's `ubuntu` user the owner of the files. The complete version is [examples/agent-run.ts](examples/agent-run.ts).

### Create a VM with volumes attached

```ts
import { createVmWithVolumes } from 'freestyle-volumes';

const { vm, vmId } = await createVmWithVolumes(freestyle, volumes, {
  vm: { snapshotId: 'ubuntu-sm-volumes', firewall },
  mounts: [
    { volumeId: 'datasets', mountPath: '/home/ubuntu/data', readOnly: true },
    { volumeId: 'runs', subpath: runId, mountPath: '/home/ubuntu/out', uid: 1000, gid: 1000 },
  ],
});
```

This is the counterpart of Daytona's `create({ volumes })`. If an attach fails, it detaches what was already attached, deletes the VM unless that would lose unflushed writes, and rethrows the error.

### Make attach fast with a snapshot

Install the runtime once, snapshot the VM, and boot new VMs from that snapshot:

```ts
import { createVolumeReadySnapshot } from 'freestyle-volumes';

await createVolumeReadySnapshot(freestyle, { baseSnapshotId: 'freestyle/ubuntu-sm', slug: 'ubuntu-sm-volumes' });

const { vmId } = await freestyle.vms.create({ snapshotId: 'ubuntu-sm-volumes', firewall });
await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/mnt/datasets' }); // nothing to install
```

It boots a temporary builder VM, installs fuse3, flock and rclone 1.75.1 (SHA-256 verified), takes the snapshot and deletes the builder. No storage keys are involved, so none can end up in the snapshot. VMs keep the size of the base snapshot, so build one snapshot per VM size you use. From the command line: `npx freestyle-volumes prepare-snapshot --base freestyle/ubuntu-sm --slug ubuntu-sm-volumes`.

### Save progress during a long job

```ts
const { flushed } = await volumes.flush({ sandboxId: vmId, mountPath: '/home/ubuntu/out' });
```

`flush` uploads every file that was closed before the call and leaves the mount in place, like saving a checkpoint. `flushed: true` means those files are in the bucket. Files that are still open are uploaded once they are closed.

### Recover after a VM restart

```ts
const { restored, failed } = await volumes.restoreMounts({ sandboxId: vmId });
```

Stopping and starting a VM, or a crash, ends its mounts but keeps its disk, including writes that had not uploaded yet. `restoreMounts` mounts each of those volumes again with its original options, and the pending uploads resume. Pausing and resuming a Freestyle VM needs nothing: the mounts keep running (verified live).

### Allow only one writer

```ts
await volumes.attach({ sandboxId: vmId, volumeId: 'reports', mountPath: '/mnt/reports', exclusive: true });
```

While this mount holds the volume's writer lease, other writable attaches fail with `VOLUME_IN_USE`, and read-only attaches still work. A detach that reports `flushed: true` releases the lease. If the VM is gone, release it yourself with `volumes.releaseLease({ volumeId: 'reports', confirm: 'reports' })`. The lease binds only attaches made through this library, not other programs writing to the bucket.

### Give each VM a key for its volume only

By default, rclone in each VM uses the same key as your process, and anyone with root in the VM can read it. Give VMs narrower keys with `sandboxCredentials`; your process keeps its own key for volume records.

- **Fixed keys**, for example a key limited to your namespace: `sandboxCredentials: { accessKeyId, secretAccessKey }`. The CLI reads them from `VOLUMES_S3_SANDBOX_ACCESS_KEY_ID` and `VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY`.
- **A new key for every mount:** pass a function. `scopedPolicy(scope)` builds an IAM policy that reaches exactly that volume (and subpath), read-only for read-only mounts:

```ts
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { FreestyleVolumes, freestyleSandboxes, scopedPolicy } from 'freestyle-volumes';

const sts = new STSClient({ region: 'us-east-1' });
const volumes = new FreestyleVolumes({
  storage,
  sandboxes: freestyleSandboxes(freestyle),
  sandboxCredentials: async (scope) => {
    const { Credentials: keys } = await sts.send(new AssumeRoleCommand({
      RoleArn: 'arn:aws:iam::123456789012:role/volume-mounts', // a role that may use the bucket
      RoleSessionName: `volume-${scope.volumeId ?? 'check'}`,
      Policy: JSON.stringify(scopedPolicy(scope)), // narrows this session to one volume
      DurationSeconds: 12 * 3600,
    }));
    return { accessKeyId: keys!.AccessKeyId!, secretAccessKey: keys!.SecretAccessKey!, sessionToken: keys!.SessionToken, expiresAt: keys!.Expiration };
  },
});
```

rclone cannot refresh keys inside a running mount. Attach records `expiresAt`, `inspectMount` and `listMounts` show it, and attach warns when it is less than 15 minutes away; detach or reattach before then. On MinIO, a user whose policy is the `scopedPolicy()` document works the same way, and the integration suite proves it. On Cloudflare R2, use a token per bucket, or R2 temporary credentials limited to the volume's prefix.

### Load data without a VM

Each volume is a plain folder in your bucket, so any S3 tool can fill it or read results back:

```bash
aws s3 sync ./data "s3://my-volumes/$(npx freestyle-volumes get datasets | jq -r .dataPrefix)/"
```

Add `--endpoint-url` for R2 or MinIO. VMs that already mount the volume see new files once their directory cache expires (`dirCacheSeconds`, 60 s by default). This is also the fastest way to load a large dataset, because nothing passes through a VM's disk.

### Shut down a VM without losing writes

```ts
const { flushed } = await volumes.detachAll({ sandboxId: vmId });
if (flushed) await vm.delete();
```

Detach every volume before you delete or snapshot a VM. Deleting a VM with unflushed writes loses those writes. A snapshot taken while a volume is attached captures the mount process, its storage key and its write cache.

### Check your setup

```text
$ npx freestyle-volumes doctor --vm <vm-id>
ok   storage bucket: The bucket exists and these credentials can reach it.
ok   storage conditional-create: Conditional creates are enforced: a second create of the same key was rejected.
ok   <vm-id> root: scripts run as uid 0
FAIL <vm-id> fuse-device: /dev/fuse is missing
     Freestyle Ubuntu VMs expose /dev/fuse. A Docker container needs --device /dev/fuse --cap-add SYS_ADMIN.
warn <vm-id> rclone: no rclone >= 1.68.0; attach downloads 1.75.1 from downloads.rclone.org
...
```

`doctor` checks the bucket from your machine: reachability, listing, conditional creates, read-back and delete. With `--vm`, it also checks the VM from the inside without changing anything: CPU, root, `/dev/fuse`, the FUSE tools, rclone, whether the VM can reach the bucket, and free disk space. Only `FAIL` lines block an attach; `warn` lines are things attach installs for you. (The output above comes from a Docker container without FUSE.) In code, the same checks are `volumes.checkStorage()` and `volumes.checkSandbox({ sandboxId })`.

### Copy, measure and clean up volumes

```bash
npx freestyle-volumes usage datasets              # objects and bytes stored
npx freestyle-volumes clone datasets datasets-v2  # copy inside the bucket; stop writers first
npx freestyle-volumes reconcile                   # what failed clones and deletes left behind
```

`clone` copies objects inside the bucket, without downloading them, and publishes the new volume only after every copy succeeded. It is not a point-in-time snapshot, so stop and detach every writer first. `reconcile` only reports; `reconcile --remove-stale` and `remove-orphan` clean up what it found. See [clone and its limits](docs/performance.md#clone-api).

### Handle errors

Every failure is a `VolumeError` with a stable `code`, a `hint` that names the next step, and `details` such as the log tail. Messages never contain credentials.

```ts
import { isVolumeError } from 'freestyle-volumes';

try {
  await volumes.detach({ sandboxId: vmId, mountPath: '/mnt/datasets' });
} catch (error) {
  if (isVolumeError(error, 'FLUSH_FAILED')) {
    // Nothing is lost: the uploads are still queued in the VM. Restore bucket access, then retry detach.
  }
  throw error;
}
```

All 23 codes, and what to do about each one, are in the [error reference](docs/api.md#errors).

## Setting up storage

### Cloudflare R2

The live tests run on R2. It enforces the conditional writes this library relies on, and a token scoped to one bucket is enough for everything.

1. Create a bucket: `npx wrangler r2 bucket create my-volumes`.
2. In the Cloudflare dashboard, open **R2 Object Storage → Manage API tokens → Create Account API token**. Choose **Object Read & Write**, apply it to this bucket only, and copy the Access Key ID and Secret Access Key. (Wrangler cannot create S3 keys.)
3. Set the variables, using your account id from `npx wrangler whoami`:

   ```bash
   VOLUMES_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   VOLUMES_S3_REGION=auto
   VOLUMES_S3_PROVIDER=Cloudflare
   VOLUMES_S3_BUCKET=my-volumes
   VOLUMES_S3_ACCESS_KEY_ID=...
   VOLUMES_S3_SECRET_ACCESS_KEY=...
   ```

4. Run `npx freestyle-volumes doctor`. Every storage check should pass.

### AWS S3, MinIO and others

- **AWS S3:** leave out the endpoint and set `VOLUMES_S3_REGION`. If a bucket policy requires encryption headers, set `VOLUMES_S3_SSE` to `AES256` or `aws:kms` (with `VOLUMES_S3_SSE_KMS_KEY_ID`).
- **MinIO:** set the endpoint and `VOLUMES_S3_PROVIDER=Minio`. The integration suite runs on MinIO.
- **Any other S3-compatible service:** run `doctor` first. It fails when the service does not enforce conditional creates, which volume creation depends on.

Every variable is listed in [.env.example](.env.example). In code, `storageConfigFromEnv()` reads them, and the [storage reference](docs/api.md#storage-configuration) describes each field.

### What the VM needs

1. **An Ubuntu image:** `freestyle/ubuntu*`, or a snapshot of one. `freestyle/busybox` has no package manager and fails with `RUNTIME_INSTALL`.
2. **Network access:** Freestyle VMs start without network access. Allow outbound traffic to your storage endpoint, and to `downloads.rclone.org` and the apt mirrors unless you boot from a [volume-ready snapshot](#make-attach-fast-with-a-snapshot). The broad rule in the quick start works; narrow it for production.
3. **File ownership:** attach with `uid: 1000, gid: 1000` when the VM's `ubuntu` user should own the files. Every user in the VM can use the mount either way.
4. **A clean shutdown:** [detach before deleting or snapshotting](#shut-down-a-vm-without-losing-writes) a VM.

## Command line

The `freestyle-volumes` command offers the same operations as the library. It reads the `VOLUMES_S3_*` variables (or a file passed with `--env-file`), prints JSON to stdout and progress to stderr, so it composes with `jq`.

```bash
npx freestyle-volumes create datasets --label team=ml
npx freestyle-volumes attach <vm-id> datasets /home/ubuntu/datasets --uid 1000 --gid 1000
npx freestyle-volumes inspect <vm-id> /home/ubuntu/datasets
npx freestyle-volumes detach <vm-id> /home/ubuntu/datasets
npx freestyle-volumes list | jq -r '.[].name'
npx freestyle-volumes delete datasets --confirm datasets
```

| Command | What it does |
| :--- | :--- |
| **Volumes** | |
| `list [--skip-invalid]` | List the volumes in the namespace. |
| `get <volume>` | Show one volume, including where its files live in the bucket (`dataPrefix`). |
| `create <volume> [--label k=v]... [--if-not-exists]` | Create a volume. |
| `clone <source> <volume> [--label k=v]... [--allow-live-source]` | Copy a volume inside the bucket. Stop its writers first. |
| `delete <volume> --confirm <volume> [--force]` | Delete a volume and all of its data. |
| `usage <volume>` | Count the objects and bytes stored. |
| `attachments <volume>` | Show where the volume is recorded as attached. |
| **Mounts** | |
| `attach <vm> <volume> <mountPath> [options]` | Mount a volume. Options include `--read-only`, `--exclusive`, `--subpath`, `--uid` and `--gid`, plus every [mount option](docs/api.md#mount-options); see `--help`. |
| `detach <vm> <mountPath> [--force]` | Unmount once every upload has finished. |
| `detach-all <vm> [--force]` | Detach every volume in a VM; exits 1 if any could not be detached. |
| `inspect <vm> <mountPath>` | Show a mount's status, pending uploads and log tail. |
| `mounts <vm>` | List every mount in a VM, healthy or stale. |
| `flush <vm> <mountPath>`, `flush-all <vm>` | Upload now and keep the mount; exits 1 while uploads are still pending. |
| `restore <vm>` | Mount stale volumes again after a restart or crash. |
| `discard <vm> <mountPath> --confirm <mountPath>` | Delete the cache a forced detach kept. Writes that never uploaded are lost. |
| **Maintenance and setup** | |
| `lease <volume>`, `release-lease <volume> --confirm <volume>` | Show or release the exclusive-writer lease. |
| `reconcile [--remove-stale]` | Report leftovers of failed operations; optionally remove records that point at nothing. |
| `remove-orphan <volume> <generation> --confirm <volume>/<generation>` | Delete one unpublished clone copy that `reconcile` reported. |
| `doctor [--vm <vm>]` | Check the bucket, and optionally a VM; exits 1 if a check fails. |
| `prepare-snapshot [--base <id>] [--slug <slug>] [--name <label>]` | Build a volume-ready snapshot. |

**Global options:** `--env-file <path>` (variables that are already set win), `--prefix <namespace>`, `--docker` (treat `<vm>` as a local Docker container), `--quiet`. `detach`, `detach-all`, `flush` and `flush-all` also take `--flush-timeout <ms>`.

**Exit codes:** `0` success, `1` the operation failed (the error code and details go to stderr), `2` usage or configuration error.

Commands that touch a VM need the `freestyle` package installed next to `freestyle-volumes`. For a one-off run outside a project, use `npx -p freestyle -p freestyle-volumes freestyle-volumes <command>`.

## API at a glance

```ts
import { FreestyleVolumes, freestyleSandboxes } from 'freestyle-volumes';

const volumes = new FreestyleVolumes({
  storage,                                  // your bucket and keys
  sandboxes: freestyleSandboxes(freestyle), // how to run commands in a VM
  defaults: { dirCacheSeconds: 30 },        // optional: mount defaults for every attach
  sandboxCredentials,                       // optional: narrower keys for the VMs
  onEvent: (event) => console.log(event),   // optional: progress events
});
```

| Method | What it does |
| :--- | :--- |
| **Volumes** | |
| `create({ name, labels?, ifNotExists? })` | Create a volume. Fails with `VOLUME_ALREADY_EXISTS` if the name is taken, unless `ifNotExists`. |
| `get(name, { create? })` | Fetch a volume, or create it when it is missing. |
| `list()` | List the volumes in the namespace, sorted by name. |
| `usage(name)` | Count the objects and bytes stored. |
| `clone({ sourceVolumeId, name })` | Copy a stopped volume inside the bucket. |
| `delete({ volumeId, confirm })` | Delete a volume and all of its data. |
| **Mounts** | |
| `attach({ sandboxId, volumeId, mountPath, ... })` | Mount a volume. Options: `readOnly`, `subpath`, `exclusive`, `uid`, `gid` and [mount tuning](docs/api.md#mount-options). |
| `detach({ sandboxId, mountPath })` | Unmount once every upload has finished; returns `flushed`. |
| `detachAll({ sandboxId })` | Detach every volume in a VM, for example before deleting it. |
| `inspectMount({ sandboxId, mountPath })` | Status (`mounted`, `stale`, `absent`, `unmanaged`), pending uploads and log tail. |
| `listMounts({ sandboxId })` | Every mount in a VM, with its upload queue. |
| `flush({ sandboxId, mountPath })`, `flushAll({ sandboxId })` | Upload everything closed so far and keep the mount. |
| `restoreMounts({ sandboxId })` | Mount stale volumes again after a restart or crash. |
| `discardMount({ sandboxId, mountPath, confirm })` | Delete the cache a forced detach kept. |
| **Maintenance** | |
| `getLease(volumeId)`, `releaseLease({ volumeId, confirm })` | Show or release the exclusive-writer lease. |
| `reconcile()`, `removeStaleRecords()`, `removeOrphanGeneration(...)` | Find and clean up what failed operations left behind. |
| `checkStorage()`, `checkSandbox({ sandboxId })` | The `doctor` checks. |
| **Helpers** | |
| `freestyleSandboxes(freestyle)` | Run commands in Freestyle VMs through `vm.exec`. |
| `createVmWithVolumes(freestyle, volumes, { vm, mounts })` | Create a VM and attach volumes in one call. |
| `createVolumeReadySnapshot(freestyle, options)` | Build a snapshot with the runtime preinstalled. |
| `storageConfigFromEnv()`, `sandboxCredentialsFromEnv()` | Read the `VOLUMES_S3_*` variables. |
| `scopedPolicy(scope)` | Build an IAM policy limited to one volume. |
| `isVolumeError(error, code?)` | Check whether an error is a `VolumeError`, optionally with a given code. |
| `dockerSandboxes()` from `freestyle-volumes/docker` | Use local Docker containers in place of VMs. |
| `volumeGit(...)` from `freestyle-volumes/git` | Run explicit Git operations on a mounted volume. |

Every signature, option, result and error is in the **[API reference](docs/api.md)**.

## Guarantees and limits

### What you can rely on

- **`flushed: true` means durable.** `detach`, `detachAll` and `flush` report it only after rclone confirms that no upload is queued, in progress or failed.
- **Nothing is deleted by accident.** Detach never deletes volume data. Deleting a volume, releasing a lease or discarding a cache requires repeating its name in `confirm`, and buckets are never created or emptied.
- **Volume names are unique.** Creation uses a conditional write, so two concurrent creates of one name cannot both succeed.
- **Failures keep your data.** When a detach cannot prove that every upload finished, it keeps the cache and records so you can retry or recover.
- **Keys stay out of files and logs.** They reach a VM only as process environment: never on its disk, on a command line, in events or in error messages.

### What a volume is not

A volume is an object-store mount, not a disk. Programs in the VM use it like a normal directory, random writes included, thanks to the local cache. But:

- **Changed files upload whole.** Editing one byte of a 10 GB file uploads 10 GB when the file is closed.
- **Rename is copy plus delete.** It is not atomic, and it is slow for large files and trees.
- **No cross-VM locks, hard links or change notifications.**
- **Other VMs see changes after a delay.** Up to `dirCacheSeconds` (60 s by default).
- **The last upload wins.** Two VMs writing the same file get no conflict error.
- **`fsync()` reaches the VM's cache, not the bucket.** Use `flush()` or `detach()`.
- **Pending uploads live on the VM disk and are never evicted.** Writing faster than the bucket accepts can fill the disk (16 GB on `freestyle/ubuntu-sm`).
- **No quotas.** Watch `usage()` and set limits or alerts on the bucket.
- **Versioned buckets:** `delete` removes current versions only.

**A good fit:** datasets, model weights, build artifacts and caches, agent inputs and outputs, reports and logs written as whole files.
**A poor fit:** databases (SQLite, Postgres), active Git worktrees (keep those on the VM's disk), append-heavy logs, and anything that needs locks or atomic renames.

The durability rules and the full failure matrix are in [docs/semantics.md](docs/semantics.md).

### Where it runs

| Environment | Supported | Notes |
| :--- | :--- | :--- |
| Freestyle `freestyle/ubuntu*` (Ubuntu 24.04) | Yes | Verified live on `freestyle/ubuntu-sm` (x86_64) with Cloudflare R2. |
| Freestyle `freestyle/busybox` | No | No package manager to install `fuse3`; attach fails with `RUNTIME_INSTALL`. |
| Docker containers | Yes | Need `--device /dev/fuse --cap-add SYS_ADMIN`, plus `--security-opt apparmor:unconfined` where AppArmor is enforced. Verified in CI. |
| Containers without `/dev/fuse` (such as gVisor) | No | Attach fails with `FUSE_UNAVAILABLE` before installing anything. |
| CPU | x86_64, aarch64 | rclone is pinned for both. |

## FAQ

**What happens if a VM crashes before I detach?**
Files that were still waiting to upload stay in the cache on the VM's disk. When the VM boots again, `restoreMounts()` resumes their upload. If the VM is deleted instead, those writes are lost; calling `flush()` during long jobs limits how much is at risk.

**Can several VMs write to the same volume?**
Yes, but there are no locks across VMs, and the last upload of a file wins. Either keep one writer with read-only readers (`exclusive: true` enforces it), or give each writer its own `subpath`.

**Which storage services work?**
Cloudflare R2 is verified live on Freestyle, and MinIO runs in every CI build. AWS S3 speaks the same API but has not been part of a live run yet. Any S3-compatible service that passes `doctor` should work.

**Can I use it outside Freestyle?**
Yes, on any Linux machine or container where a script can run as root and `/dev/fuse` exists. The package includes a Docker adapter (`freestyle-volumes/docker`) for local development, which the integration suite uses, and the CLI's `--docker` flag targets a container; see [examples/local-docker.ts](examples/local-docker.ts). Another platform needs only a small adapter that runs a shell script as root (a `SandboxResolver`).

**What does it cost?**
Only your bucket's storage and requests and your Freestyle VM time. There is no hosted service.

**How is this different from Daytona volumes?**
The model is the same: named volumes backed by object storage, mounted at a `mountPath` with an optional `subpath` and shared between sandboxes. The differences: you bring the bucket, `detach` tells you whether writes are durable, a new volume is ready immediately, deletion requires `confirm`, and there are extras such as `readOnly`, `exclusive`, `flush`, `restoreMounts` and `clone`. See the [side-by-side mapping](docs/daytona-migration.md).

**Can I keep a Git repository on a volume?**
Yes, with the explicit helper in `freestyle-volumes/git` (clone, status, commit, pull, push). Active worktrees are still faster and safer on the VM's own disk, so use volumes for data and artifacts. See [docs/git.md](docs/git.md).

**Why rclone, and not JuiceFS or s3fs?**
rclone is a single binary with a solid S3 backend and a remote-control API, which is what lets `detach` prove that every upload finished. JuiceFS offers fuller POSIX semantics but needs a metadata database (Redis, Postgres, ...) that every VM can reach. The [full comparison](docs/architecture.md#why-rclone) covers the alternatives.

## Project status

Preview (`0.x`): the API may change between minor versions, and every change is listed in the [changelog](CHANGELOG.md).

| Test tier | What it runs against | Result (v0.2.0, 2026-09-25) |
| :--- | :--- | :--- |
| Unit | Mocked VMs, an in-memory bucket, guest scripts run in a local shell | 180 passed |
| Integration | Docker and MinIO with real rclone FUSE mounts (CI on linux/amd64, locally on arm64) | 38 passed, 1 opt-in test skipped |
| Package | The packed tarball, installed into a fresh project: ESM, `require()`, the CLI, TypeScript | Passed |
| Freestyle live (billed) | Real VMs on `freestyle/ubuntu-sm` with Cloudflare R2 | 4 passed, in two separate runs |

Measured on Freestyle: the first attach on a fresh VM took 15 s, and 1.3 to 1.5 s from a volume-ready snapshot. Pause and resume each took under a second, and the mount and a pending upload survived both.

**Not verified live yet:** recovery after a Freestyle stop/start, throughput, prefix-scoped keys on R2 or AWS, AWS S3 itself, other VM sizes and arm64 VMs. The stop/start and throughput tests exist and run in the [live workflow](.github/workflows/freestyle-live.yml). The full record is in [docs/evidence/v0.2.md](docs/evidence/v0.2.md).

## Security

- Anyone with root in a VM can read the key its mounts use, so give VMs [keys limited to their volume](#give-each-vm-a-key-for-its-volume-only).
- Detach before snapshotting a VM, so that no key or cached write ends up in the snapshot.
- Every value that reaches a shell script is validated and quoted. Mount paths cannot be `/`, a system directory or a symlink, and a `subpath` mount cannot reach the rest of its volume through the filesystem.
- Destructive operations need confirmation, and nothing is deleted implicitly.

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome.

```bash
pnpm install
pnpm test                # unit tests: no network, no Docker
pnpm test:integration    # Docker and MinIO with real FUSE mounts
pnpm test:package        # pack, install into a fresh project, run the CLI, type-check
pnpm test:freestyle      # real Freestyle VMs (billed): needs FREESTYLE_API_KEY and VOLUMES_S3_*
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the conventions, and [docs/release.md](docs/release.md) covers releasing.

**Further reading:** [API reference](docs/api.md) · [semantics and failure matrix](docs/semantics.md) · [architecture](docs/architecture.md) · [performance and cloning](docs/performance.md) · [Freestyle notes](docs/freestyle.md) · [Git on volumes](docs/git.md) · [coming from Daytona](docs/daytona-migration.md)

## License

[MIT](LICENSE). rclone (MIT) is downloaded from rclone.org inside the VM, and the AWS SDK for JavaScript (Apache-2.0) is a dependency.
