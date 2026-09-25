# Freestyle: what is verified, what is assumed, how to run the live test

## Current verification status

Pre-release run for 0.2.0 — **2026-09-25**: `pnpm test`: 127 passed, 0 skipped; `pnpm check:types`, `pnpm check:examples` and `pnpm test:package` passed; `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration`: 28 passed, 0 failed, 0 skipped on Docker. `pnpm test:freestyle`: 2 skipped because no Freestyle key or bucket was configured. **No live Freestyle round trip, snapshot build or pause/resume has been validated.** Neither the Docker results nor the local host clone/list benchmark is Freestyle runtime evidence. See [verification](evidence/v0.2.md) (earlier runs in [v0.1](evidence/v0.1.md)), [performance](performance.md) and [source-linked research](freestyle-research.md).

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

## Assumptions not yet verified on Freestyle

1. **Background processes started from `vm.exec` keep running after the call returns.** The mount script starts rclone with `setsid`, detached from the exec's stdio. This is how it behaves in Docker and on any normal Linux init. If Freestyle's exec agent kills the session's process group, the mount would disappear right after attach; `inspectMount` would report `stale`. The documented fallback is to start rclone inside a PTY session (`vm.pty.open({ exec })`, documented to survive `detach()`); that path is not implemented.
2. **`/dev/fuse` exists and `fusermount3` can be installed with apt in the Ubuntu snapshots.** The public Mesa integration supports investigating this path, but is not our runtime test; bootstrap checks `/dev/fuse` first and reports `FUSE_UNAVAILABLE` precisely if it is missing.
3. **Outbound HTTPS from the VM reaches `downloads.rclone.org`** (30 MB download) when the snapshot has no rclone. Pre-installing rclone ≥ 1.68 in a custom snapshot avoids this entirely.
4. **Pause/resume keeps the mount usable.** This is an expectation based on process preservation and rclone retries, not a validated result. The two-VM round trip alone does not prove pause/resume recovery.
5. **First-attach time.** Expect apt (`fuse3`) plus the download to take one to two minutes on a fresh VM. [A volume-ready snapshot](#volume-ready-snapshots) skips it.
6. **Snapshots keep the runtime.** A VM booted from a snapshot of the builder VM is expected to have the same `/opt/freestyle-volumes/bin/rclone`, `fuse3` and `flock`, since snapshots capture the disk. The snapshot live test checks exactly this.

## Volume-ready snapshots

`createVolumeReadySnapshot(freestyle, { baseSnapshotId, slug })` (CLI: `freestyle-volumes prepare-snapshot`) moves the one-time install out of the attach path:

1. `vms.create` boots a builder VM from `baseSnapshotId` (default: Freestyle's platform default) with outbound Internet access, a TTL and identifying metadata.
2. The same bootstrap script `attach` runs installs `fuse3`, `flock` and the pinned, SHA-256-verified rclone as `root`. Errors map to the usual codes (`FUSE_UNAVAILABLE`, `RUNTIME_INSTALL`, `SANDBOX_EXEC_TIMEOUT`), and nothing is snapshotted when it fails.
3. `vm.snapshot({ slug, displayName })` captures the VM, and the builder VM is deleted. A failed delete is reported in `warnings` and the TTL cleans up.

No storage credentials exist at any point of the build, so none can be captured. Attach on a VM booted from the snapshot still runs the bootstrap check, but it finds rclone `>= 1.68`, `fusermount3` and `flock` already installed, so nothing is downloaded. The live test logs the resulting attach time; it has not been measured on Freestyle yet. Rebuild the snapshot when you want a newer base image; library upgrades keep working with the installed rclone unless a release raises the minimum version.

## Running the live test

The live tests are billed to your Freestyle account and need a bucket you control. `test/freestyle/live.test.mjs` creates two `freestyle/ubuntu-sm` VMs, runs the round trip, and deletes them and the volume. `test/freestyle/snapshot.test.mjs` runs only with `VOLUMES_TEST_PREPARE_SNAPSHOT=1`: it builds a volume-ready snapshot, boots a VM from it, checks that the runtime is preinstalled, round-trips a file, and deletes the VM, the snapshot and the volume.

The easiest way to run both is the manual **Freestyle live test** workflow (`.github/workflows/freestyle-live.yml`): add the repository secrets `FREESTYLE_API_KEY`, `VOLUMES_S3_ACCESS_KEY_ID` and `VOLUMES_S3_SECRET_ACCESS_KEY` and the variable `VOLUMES_S3_BUCKET` (plus `VOLUMES_S3_ENDPOINT`, `VOLUMES_S3_REGION` and `VOLUMES_S3_PROVIDER` for R2 or MinIO), then start it from the Actions tab. Each run uses its own bucket prefix. Locally:

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

- Attach with `uid: 1000, gid: 1000` so the `ubuntu` user owns files; the mount is `allow_other` either way.
- Keep `detach()` in your VM shutdown path and require `flushed: true` before discarding recoverable cache. Normal detach unmounts externally, waits for FUSE serving to stop, drains the VFS retained by `rclone rcd`, then stops the process. Deleting a VM with pending uploads loses them.
- After `FLUSH_FAILED`, the filesystem may already be unmounted while the uploader/cache/state remain: restore storage access and retry detach. Forced uncertain detach retains cache/state and the advisory attachment record; it is not a durability guarantee.
- Reattach recovery requires the same full storage and mount identity. Legacy state without ownership evidence or using old cache ids is not automatically migrated and can require operator intervention. Guest lifecycle locks and symlink rejection do not replace application orchestration of distributed attach/delete races.
- Snapshots taken while a volume is attached contain the rclone process (with credentials in its environment) and the write cache. Detach first.
- Freestyle's exec limit is 300 s. `bootstrapTimeoutMs` (240 s), `readyTimeoutMs` (30 s) and `flushTimeoutMs` (60 s) are bounded so no single step can exceed it.
- The same library works for Docker containers (`dockerSandboxes()`), which is how the integration suite runs without a Freestyle account.
