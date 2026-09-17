# Freestyle: what is verified, what is assumed, how to run the live test

## Facts taken from Freestyle's documentation and SDK (`freestyle@0.2.13`)

| Fact | Source | Used for |
| :--- | :--- | :--- |
| VMs are full Linux machines; the product page lists "nested virtualization, FUSE, eBPF, and full networking" among capabilities. | https://www.freestyle.sh/docs | Feasibility of a FUSE mount. |
| Public base snapshots `freestyle/ubuntu*` run Ubuntu 24.04 LTS with curl, git, sudo, Docker, Node and Python preinstalled; `freestyle/busybox` is BusyBox only. | https://www.freestyle.sh/docs/vms/base-snapshots | Bootstrap path (apt, curl); BusyBox unsupported. |
| `vm.exec({ command, linuxUser?, timeoutMs?, env?, stdin? })` runs a command through the guest shell; `timeoutMs` is 1-300000; `statusCode` is `null` on timeout; default user is uid 1000 (`ubuntu`) or `root`. | `dist/vms/types.d.ts` in the SDK | The single integration point. Scripts run with `linuxUser: 'root'`; timeouts are capped at 300 s. |
| A VM gets no network unless firewall rules allow it. | `CreateVmOptions.firewall` docs in the SDK | VMs must allow outbound traffic to the storage endpoint and to downloads.rclone.org. |
| Pausing preserves memory and running processes; stopping discards memory and boots fresh; deleting is permanent. | https://www.freestyle.sh/docs/vms/lifecycle | Stale-mount handling after stop/start; pause is expected to keep mounts alive. |
| `vm.fs.writeFile` is atomic and defaults to mode 0600. | https://www.freestyle.sh/docs/vms/files | Not used; credentials go through `env` instead so nothing touches the disk. |
| The SDK client is `new Freestyle({ apiKey })`; `freestyle.vms.ref(id)` returns a `Vm` handle without a network call. | `dist/index.d.ts` | `freestyleSandboxes()` resolves sandbox ids with `ref`. |
| PTY sessions survive detaching the client. | https://www.freestyle.sh/docs/vms/pty | Fallback strategy if background processes started from `exec` were ever reaped (see assumptions). |

`pnpm check:types` compiles `test/types/freestyle-sdk.ts`, which assigns a real `Freestyle` client and `Vm` handle to this library's structural interfaces. If Freestyle changes `exec`, that check fails.

## Assumptions not yet verified on Freestyle

1. **Background processes started from `vm.exec` keep running after the call returns.** The mount script starts rclone with `setsid`, detached from the exec's stdio. This is how it behaves in Docker and on any normal Linux init. If Freestyle's exec agent kills the session's process group, the mount would disappear right after attach; `inspectMount` would report `stale`. The documented fallback is to start rclone inside a PTY session (`vm.pty.open({ exec })`, documented to survive `detach()`); that path is not implemented.
2. **`/dev/fuse` exists and `fusermount3` can be installed with apt in the Ubuntu snapshots.** Freestyle lists FUSE as a capability; the bootstrap checks `/dev/fuse` first and reports `FUSE_UNAVAILABLE` precisely if it is missing.
3. **Outbound HTTPS from the VM reaches `downloads.rclone.org`** (30 MB download) when the snapshot has no rclone. Pre-installing rclone ≥ 1.68 in a custom snapshot avoids this entirely.
4. **Pause/resume keeps the mount usable.** rclone retries failed requests, so a paused VM should resume with a working mount.
5. **First-attach time.** Expect apt (`fuse3`) plus the download to take one to two minutes on a fresh VM. Snapshot a prepared VM to skip it.

## Running the live test

The live test creates two `freestyle/ubuntu-sm` VMs, runs the round trip, and deletes them and the volume. It is billed to your Freestyle account and needs a bucket you control.

```bash
export FREESTYLE_API_KEY=...            # freestyle tokens create "volumes-test"
export VOLUMES_S3_BUCKET=my-volumes
export VOLUMES_S3_ACCESS_KEY_ID=...
export VOLUMES_S3_SECRET_ACCESS_KEY=...
export VOLUMES_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
export VOLUMES_S3_REGION=auto                                          # omit for AWS us-east-1
export VOLUMES_S3_PROVIDER=Cloudflare                                  # optional rclone hint
pnpm test:freestyle
```

The test prints every `onEvent` line and deletes both VMs in a `finally` block; if it aborts before that, remove VMs tagged `freestyle-volumes=live-test` in the dashboard.

## Operational notes

- Attach with `uid: 1000, gid: 1000` so the `ubuntu` user owns files; the mount is `allow_other` either way.
- Keep `detach()` in your VM shutdown path. Deleting a VM with pending uploads loses them.
- Snapshots taken while a volume is attached contain the rclone process (with credentials in its environment) and the write cache. Detach first.
- Freestyle's exec limit is 300 s. `bootstrapTimeoutMs` (240 s), `readyTimeoutMs` (30 s) and `flushTimeoutMs` (60 s) are bounded so no single step can exceed it.
- The same library works for Docker containers (`dockerSandboxes()`), which is how the integration suite runs without a Freestyle account.
