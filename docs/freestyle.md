# Freestyle: what is verified, what is assumed, how to run the live test

## Current verification status

Live on Freestyle on **2026-09-25** (`freestyle/ubuntu-sm`, Ubuntu 24.04.5, x86_64) against Cloudflare R2: all four live tests of that day passed, covering the runtime, the two-VM storage round trip, a volume-ready snapshot with a volume attached from it, and a mount with a pending upload surviving pause and resume. The stop/start and throughput tests were added afterwards and have not run live yet. Details and timings are below; test counts for every tier are in [the verification record](evidence/v0.2.md) (earlier runs in [v0.1](evidence/v0.1.md)). Neither the Docker results nor the local host clone/list benchmark is Freestyle runtime evidence. See also [performance](performance.md) and [source-linked research](freestyle-research.md).

## Facts taken from Freestyle's documentation and SDK (`freestyle@0.2.14`)

| Fact | Source | Used for |
| :--- | :--- | :--- |
| VMs are full Linux machines; Mesa publishes a Freestyle FUSE-mount integration example. | [Freestyle product page](https://www.freestyle.sh/products/vms), [Mesa example](https://docs.mesa.dev/content/integrations/sandboxes/freestyle) | Feasibility evidence only; neither proves this backend works live. |
| Public base snapshots `freestyle/ubuntu*` run Ubuntu 24.04 LTS with curl, git, sudo, Docker, Node and Python preinstalled; `freestyle/busybox` is BusyBox only. | https://www.freestyle.sh/docs/vms/base-snapshots | Bootstrap path (apt, curl); BusyBox unsupported. |
| `vm.exec({ command, linuxUser?, timeoutMs?, env?, stdin? })` runs a command through the guest shell; `timeoutMs` is 1-300000; `statusCode` is `null` on timeout; default user is uid 1000 (`ubuntu`) or `root`. | `dist/vms/types.d.ts` in the SDK | The single integration point. Scripts run with `linuxUser: 'root'`; timeouts are capped at 300 s. |
| Ordinary guest traffic needs explicit firewall allowances; Freestyle-delivered SSH/domain traffic has separate platform allowances. | [Firewall docs](https://www.freestyle.sh/docs/vms/network/firewall), `CreateVmOptions.firewall` in the SDK | Allow guest access to storage plus runtime/package downloads. Host connectivity does not prove guest connectivity. |
| Pausing preserves memory and running processes; stopping discards memory and boots fresh; deleting is permanent. | https://www.freestyle.sh/docs/vms/lifecycle | Stale-mount handling after stop/start; pause is expected to keep mounts alive. |
| `vm.fs.writeFile` is atomic and defaults to mode 0600. | https://www.freestyle.sh/docs/vms/files | Not used; credentials go through `env` instead so nothing touches the disk. |
| The SDK client is `new Freestyle({ apiKey })`; `freestyle.vms.ref(id)` returns a `Vm` handle without a network call. | `dist/index.d.ts` | `freestyleSandboxes()` resolves sandbox ids with `ref`. |
| PTY sessions survive detaching the client. | https://www.freestyle.sh/docs/vms/pty | Fallback strategy if background processes started from `exec` were ever reaped (see assumptions). |
| `vm.snapshot({ slug?, displayName? })` captures memory and disk of a running or paused VM; the snapshot is private and fully materialized when the call resolves. VMs boot from a snapshot id or slug and keep its CPU, memory and disk. `vms.snapshots.delete(id)` removes one. | `dist/vms/index.d.ts`, `dist/vms/snapshots.d.ts`, `dist/vms/types.d.ts` | `createVolumeReadySnapshot` snapshots a builder VM after the bootstrap; one snapshot per VM size. |
| `vms.create({ ttlSeconds, metadata, displayName, firewall })`: `ttlSeconds` deletes the VM that long after creation whatever it is doing; `firewall` is required. | `dist/vms/types.d.ts` | The builder VM gets a TTL (default 3600 s) and `metadata: { "freestyle-volumes": "snapshot-builder" }` so a crashed build cannot leave it running indefinitely. |

`pnpm check:types` compiles `test/types/freestyle-sdk.ts`, which assigns a real `Freestyle` client and `Vm` handle to this library's structural interfaces, including the ones `createVolumeReadySnapshot` uses (`vms.create`, `vm.snapshot`, `vm.delete` and the firewall spec). If Freestyle changes any of them, that check fails.

## Verified live on Freestyle — 2026-09-25

On `freestyle/ubuntu-sm` (Ubuntu 24.04.5 LTS, x86_64, 16 GB disk), storage on Cloudflare R2, with the four tests in `test/freestyle/`:

1. **Background processes started from `vm.exec` keep running after the call returns.** A `setsid` process started by one exec was alive in the next, and an rclone FUSE mount started by one exec was still mounted and readable in the next. The PTY fallback is not needed.
2. **`/dev/fuse` exists** (a `crw-rw-rw-` character device), scripts run as root, and bootstrap installs `fuse3` with apt; `flock` is preinstalled.
3. **Outbound HTTPS reaches `downloads.rclone.org`** with the broad public-egress firewall rule, and the pinned rclone passes its SHA-256 check.
4. **First-attach bootstrap took 15.1 s** on a fresh VM (apt plus the 30 MB download). The runtime check of `checkSandbox` passed on the VM; only its storage check failed, because it was given deliberately invalid keys.
5. **Snapshots keep the runtime.** `createVolumeReadySnapshot` took 22.5 s end to end (builder VM 0.4 s, bootstrap 15 s, snapshot 7 s) and deleted its builder; a VM booted from the snapshot had `/opt/freestyle-volumes/bin/rclone` 1.75.1, `fusermount3` and `flock` without installing anything, and **attach took 1.3–1.5 s** there.
6. **The storage round trip works.** The library's own `rclone rcd` mount of an R2 bucket, writes as the `ubuntu` user through `uid: 1000`, a verified-drain detach, reattach and read-back on a second VM, a read-only mount that rejects writes, `listMounts` and `detachAll` with `flushed: true`, and delete (`test/freestyle/live.test.mjs`, 45 s with two fresh VMs).
7. **The preflight works from inside a VM.** `checkSandbox` on a VM booted from the snapshot listed the bucket with the exec-env credentials ("rclone listed the namespace from inside the sandbox"); on a fresh VM it reported the installs attach would do, and R2 answered its unauthenticated probe with HTTP 400.
8. **Pause and resume keep the mount and its pending uploads.** With a write still queued in the VM's cache, pause and resume each took under a second (pause 0.2–0.4 s, resume 0.07–0.66 s over three runs); the mount was healthy and responsive, the queued upload drained on the next detach (`flushed: true`), and both files read back from the bucket (`test/freestyle/pause.test.mjs`).

## Not yet verified on Freestyle

1. **Stop and start.** A stopped VM boots fresh, so its mounts become `stale`; `restoreMounts({ sandboxId })` mounts them again with their saved options and resumes pending uploads. That is covered in Docker. `test/freestyle/stop-start.test.mjs` powers a VM off with an upload pending and requires the restore to bring both back, but it has not run live yet.
2. **Other sizes, images and CPUs.** Only `freestyle/ubuntu-sm` on x86_64 has been exercised live.
3. **Throughput.** `test/freestyle/throughput.test.mjs` measures large and small writes, uploads and cold reads (opt-in with `VOLUMES_TEST_THROUGHPUT=1`); it has not run yet.
4. **Scoped sandbox credentials on R2.** Prefix-limited keys are proven against MinIO in Docker, not yet against R2 or AWS S3 live.

## Volume-ready snapshots

`createVolumeReadySnapshot(freestyle, { baseSnapshotId, slug })` (CLI: `freestyle-volumes prepare-snapshot`) moves the one-time install out of the attach path:

1. `vms.create` boots a builder VM from `baseSnapshotId` (default: Freestyle's platform default) with outbound Internet access, a TTL and identifying metadata.
2. The same bootstrap script `attach` runs installs `fuse3`, `flock` and the pinned, SHA-256-verified rclone as `root`. Errors map to the usual codes (`FUSE_UNAVAILABLE`, `RUNTIME_INSTALL`, `SANDBOX_EXEC_TIMEOUT`), and nothing is snapshotted when it fails.
3. `vm.snapshot({ slug, displayName })` captures the VM, and the builder VM is deleted. A failed delete is reported in `warnings` and the TTL cleans up.

No storage credentials exist at any point of the build, so none can be captured. Attach on a VM booted from the snapshot still runs the bootstrap check, but it finds rclone `>= 1.68`, `fusermount3` and `flock` already installed, so nothing is downloaded. The build took 22.5 s on `freestyle/ubuntu-sm` in the live run; afterwards, attach on a VM booted from the snapshot took 1.3–1.5 s instead of paying the 15 s bootstrap. Rebuild the snapshot when you want a newer base image; library upgrades keep working with the installed rclone unless a release raises the minimum version.

## Running the live test

The live tests are billed to your Freestyle account. `test/freestyle/runtime.test.mjs` needs only `FREESTYLE_API_KEY`: it boots one VM, runs the first-attach bootstrap and checks FUSE plus processes and mounts that outlive their exec. The others need a bucket you control. `test/freestyle/pause.test.mjs` pauses and resumes a VM with an upload pending. `test/freestyle/live.test.mjs` creates two `freestyle/ubuntu-sm` VMs, runs the round trip, and deletes them and the volume. `test/freestyle/snapshot.test.mjs` runs only with `VOLUMES_TEST_PREPARE_SNAPSHOT=1`: it builds a volume-ready snapshot, boots a VM from it, checks that the runtime is preinstalled, round-trips a file, and deletes the VM, the snapshot and the volume. `test/freestyle/stop-start.test.mjs` powers a VM off with an upload pending, starts it again and requires `restoreMounts` to bring the mount and the upload back. `test/freestyle/throughput.test.mjs` runs only with `VOLUMES_TEST_THROUGHPUT=1`: it writes a large file (256 MB by default) and 1,000 small ones, flushes, and reads back cold, printing the rates as JSON.

The easiest way to run them is the **Freestyle live test** workflow (`.github/workflows/freestyle-live.yml`), which also runs every Monday once the repository has the secrets: add the repository secrets `FREESTYLE_API_KEY`, `VOLUMES_S3_ACCESS_KEY_ID` and `VOLUMES_S3_SECRET_ACCESS_KEY` and the variable `VOLUMES_S3_BUCKET` (plus `VOLUMES_S3_ENDPOINT`, `VOLUMES_S3_REGION` and `VOLUMES_S3_PROVIDER` for R2 or MinIO), then start it from the Actions tab. Each run uses its own bucket prefix. Locally:

```bash
export FREESTYLE_API_KEY=...            # freestyle tokens create "volumes-test"
export VOLUMES_S3_BUCKET=my-volumes
export VOLUMES_S3_ACCESS_KEY_ID=...
export VOLUMES_S3_SECRET_ACCESS_KEY=...
export VOLUMES_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
export VOLUMES_S3_REGION=auto                                          # omit for AWS us-east-1
export VOLUMES_S3_PROVIDER=Cloudflare                                  # optional rclone hint
export VOLUMES_TEST_PREPARE_SNAPSHOT=1                                 # also build and test a snapshot
pnpm test:freestyle
```

The tests print every `onEvent` line and delete what they created in `finally` blocks; if one aborts before that, remove VMs with the metadata `freestyle-volumes=live-test` or `freestyle-volumes=snapshot-builder`, and the snapshot named `freestyle-volumes-live-snapshot`, in the dashboard.

## Operational notes

- Run `checkSandbox({ sandboxId })` (CLI: `freestyle-volumes doctor --vm <vm-id>`) whenever you change the base snapshot or the firewall. It tests the VM's own path to the bucket with your credentials, which a check from your machine cannot prove.
- Attach with `uid: 1000, gid: 1000` so the `ubuntu` user owns files; the mount is `allow_other` either way.
- Give VMs keys limited to their volume with `sandboxCredentials` rather than your process's own key; see the README's scoped credentials section.
- After a VM stop/start (or a crash), call `restoreMounts({ sandboxId })` once exec works again. For a checkpoint without unmounting, `flush({ sandboxId, mountPath })` uploads every closed file.
- Keep `detachAll({ sandboxId })` in your VM shutdown path and delete the VM only when it returns `flushed: true`; it detaches every managed mount, including ones your code lost track of, and reports each failure instead of stopping at the first. Normal detach unmounts externally, waits for FUSE serving to stop, drains the VFS retained by `rclone rcd`, then stops the process. Deleting a VM with pending uploads loses them. `listMounts({ sandboxId })` shows what is mounted, stale or unmanaged at any time.
- After `FLUSH_FAILED`, the filesystem may already be unmounted while the uploader/cache/state remain: restore storage access and retry detach. Forced uncertain detach retains cache/state and the advisory attachment record; it is not a durability guarantee.
- Reattach recovery requires the same full storage and mount identity. Legacy state without ownership evidence or using old cache ids is not automatically migrated and can require operator intervention. Guest lifecycle locks and symlink rejection do not replace application orchestration of distributed attach/delete races.
- Snapshots taken while a volume is attached contain the rclone process (with credentials in its environment) and the write cache. Run `detachAll` first.
- Freestyle's exec limit is 300 s. `bootstrapTimeoutMs` (240 s), `readyTimeoutMs` (30 s) and `flushTimeoutMs` (60 s) are bounded so no single step can exceed it.
- The same library works for Docker containers (`dockerSandboxes()`), which is how the integration suite runs without a Freestyle account.
