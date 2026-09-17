# Architecture

## Components

| Component | File | Responsibility |
| :--- | :--- | :--- |
| `FreestyleVolumes` | `src/volumes.ts` | The public, Daytona-style API. Validates inputs, sequences the steps, never talks to a sandbox or bucket directly. |
| `VolumeRegistry` | `src/registry.ts` | Volume records, advisory attachment records and data prefixes in the bucket. Uses the `ObjectStore` interface. |
| `S3ObjectStore` / `MemoryObjectStore` | `src/storage.ts` | The six object operations the registry needs, on the AWS SDK or in memory. Also turns storage config into rclone environment variables. |
| `RcloneBackend` | `src/rclone.ts` | Generates the guest scripts (bootstrap, mount, inspect, detach), runs them through a `SandboxRuntime`, parses the `FSVOL_*` protocol, maps failures to error codes. |
| `SandboxRuntime` / `SandboxResolver` | `src/sandbox.ts` | The one-method integration interface: run a `sh` script as root with env and a timeout. |
| `freestyleSandboxes` | `src/freestyle.ts` | `SandboxResolver` over the `freestyle` SDK (`vm.exec`). Structural types, so the SDK is an optional peer. |
| `dockerSandboxes` | `src/docker.ts` | `SandboxResolver` over `docker exec`, for local development and the integration suite. |

Storage configuration, sandbox integration and filesystem-process management are separate on purpose: `FreestyleVolumes` can be given a different `ObjectStore`, a different `SandboxResolver`, or later a different backend without touching the others.

## Bucket layout

```
<prefix>/_volumes/<name>.json                     { version, id, name, createdAt, labels, backend, dataPrefix }
<prefix>/_attachments/<name>/<sandbox>__<mount>.json   advisory: who mounted what, where, when
<prefix>/v/<name>/                                 directory marker (created by rclone)
<prefix>/v/<name>/...                              the files
```

Volume ids are their names (validated DNS-label style), so `create` is a single `PutObject` and concurrent creates of the same name cannot corrupt anything. Namespaces (`prefix`) and volumes are isolated by key prefix; every prefix segment is validated, so no input can escape its prefix.

## Sandbox layout

```
/opt/freestyle-volumes/bin/rclone                 pinned rclone, only when the image has none >= 1.68
/var/lib/freestyle-volumes/mounts/<mountId>/       mount.json, pid, run.sh, rclone.log, stderr.log
/var/lib/freestyle-volumes/orphans/<mountId>.<ts>/ state of forced (unflushed) detaches, kept for diagnosis
/var/cache/freestyle-volumes/<mountId>/            rclone VFS cache; pending uploads live here
/run/freestyle-volumes/<mountId>.sock              rclone remote-control socket (root only)
```

`mountId` is the first 16 hex chars of `sha256(volumeId \0 subpath \0 mountPath)`, so the same volume at the same path always maps to the same cache directory, which is what lets a re-attach resume interrupted uploads.

## Attach sequence

1. Validate `sandboxId`, `volumeId`, `mountPath` (absolute, clean, outside protected roots), `subpath`, options.
2. `GET` the volume record; `LIST` one key under the data prefix. Wrong credentials, a missing bucket or an unreachable endpoint fail here, before any sandbox call.
3. Bootstrap script (no credentials): check `/dev/fuse`, install `fuse3` and rclone if needed, verify tools. Serialized with `flock`.
4. Mount script (credentials in `env`):
   - If a healthy mount of the same remote path exists: report `already=1`.
   - If a mount exists with a different remote path, a foreign mount, or stale state of another mount id at the same path: `path-in-use`.
   - If the mount is stale (process dead or unresponsive): lazy unmount, kill leftovers, remove the stale socket.
   - Create the mount point (must be empty), write `mount.json`, rotate the log, write `run.sh`, start it with `setsid` in the background with stdio detached.
   - Poll every 250 ms until: the process is alive, `/proc/mounts` lists `fuse.rclone` at the path, and `ls` of the root succeeds within 5 s. That last step is what turns "process started" into "mount ready": it forces rclone to talk to the bucket.
   - On process exit: report the log tail. On timeout: kill, lazy unmount, clean up, report `ready-timeout`.
5. Write the advisory attachment record (failure is a warning, the mount is already live).

## Detach sequence

1. Find the state directory whose `mount.json` names this mount path.
2. No state and no mount: `absent`. No state but an rclone mount: `unmanaged` (refuse).
3. State but no mount, or mount with a dead process: `stale`. Refuse unless `force` (then move the state aside, keep the cache) or the mount was read-only.
4. Live writable mount: call `vfs/queue`, set every queued item's expiry to 0, then poll `vfs/stats` until `uploadsQueued + uploadsInProgress == 0` and `erroredFiles == 0`, up to `flushTimeoutMs`. Failure: `FLUSH_FAILED`, mount left attached (or, with `force`, lazy unmount and `flushed=0`).
5. `fusermount3 -u` (not lazy). `EBUSY`: `MOUNT_BUSY` (or lazy unmount with `force`).
6. Wait for the process to exit, SIGTERM then SIGKILL if it lingers.
7. Flushed: delete the cache and state directories. Not flushed: keep the cache, move the state to `orphans/`.
8. Remove the advisory attachment record.

## Guest protocol

Scripts print `FSVOL_RESULT key=value ...` on success, `FSVOL_ERR <code> <detail>` on failure, and optional blocks `FSVOL_LOG_BEGIN ... FSVOL_LOG_END`, `FSVOL_STATE_BEGIN ... END` (mount.json), `FSVOL_STATS_BEGIN ... END` (rclone `vfs/stats` JSON) and `FSVOL_STDERR_BEGIN ... END`. The host parses these with `parseGuestOutput` and never interprets free-form stdout. Exit codes are secondary; the `FSVOL_ERR` code decides the error class.

## rclone invocation

```
rclone mount fsvol:<bucket>/<prefix>/v/<name>[/<subpath>] <mountPath> \
  --vfs-cache-mode writes|full --vfs-write-back <n>s --dir-cache-time <n>s --poll-interval 0 \
  [--vfs-cache-max-size <size>] [--allow-other] [--uid N --gid N --umask MMM] [--read-only] \
  --cache-dir /var/cache/freestyle-volumes/<mountId> \
  --rc --rc-addr unix:///run/freestyle-volumes/<mountId>.sock --rc-no-auth \
  --log-file .../rclone.log --log-level INFO
```

The `fsvol` remote is defined entirely by `RCLONE_CONFIG_FSVOL_*` environment variables (`type=s3`, provider, endpoint, region, credentials, `force_path_style`, `no_check_bucket=true`, `directory_markers=true`) with `RCLONE_CONFIG=/dev/null`, so no config file exists. `--rc-no-auth` is safe because the socket lives in a root-only directory; anything that can reach it is already root.

`--daemon` is deliberately not used: rclone's daemon mode binds the rc socket in both the parent and the child and fails with "address already in use". Backgrounding with `setsid` plus a pid file written by the wrapper script (`echo $$` then `exec rclone`) gives an exact pid regardless of how the guest shell handles job control.

## Timeouts

| Step | Default | Bound |
| :--- | :--- | :--- |
| Host storage call | 15 s | `storage.requestTimeoutMs` |
| Bootstrap | 240 s | `bootstrapTimeoutMs` ≤ 300 s |
| Mount readiness | 30 s | `readyTimeoutMs` ≤ 270 s; exec limit is `readyTimeoutMs + 30 s` |
| Inspect | 30 s | `inspectTimeoutMs` |
| Flush | 60 s | `flushTimeoutMs` ≤ 260 s; exec limit is `flushTimeoutMs + 40 s` |

Every exec stays under Freestyle's 300 s cap. A timed-out exec (`statusCode === null`) surfaces as `SANDBOX_EXEC_TIMEOUT`.
