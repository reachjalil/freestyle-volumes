# Contributing

Issues and pull requests are welcome at https://github.com/reachjalil/freestyle-volumes.

## Setup

```bash
pnpm install
pnpm test                                   # unit tests
pnpm test:integration                       # needs Docker; pulls quay.io/minio/minio and rclone/rclone
VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration   # also runs the bare ubuntu:24.04 bootstrap test (slow, needs internet)
pnpm check:types && pnpm check:examples
```

The integration suite creates containers named `fsvol-*` and removes them afterwards. If a run is interrupted, `docker ps -a | grep fsvol-` shows leftovers.

## Conventions

- TypeScript, ES modules, Node 22+, no build step other than `tsc`.
- Volume failures use `VolumeError` with a stable `code` and a `hint`; the separate Git helper uses `VolumeGitError` with a stable `code` and `outcomeUnknown`. Add a code rather than a new prose-only error.
- Guest scripts are POSIX `sh` (BusyBox compatible: no bashisms, no `flock -w`, no `timeout --foreground`). Run `sh -n` on generated scripts in unit tests.
- Nothing that reaches a shell is unvalidated; extend `src/validate.ts` before adding a new script parameter.
- Never log or embed credentials. Tests assert that the secret never appears in commands, events or error messages.
- Say what was verified where. Docker results are not Freestyle results; keep the tiers separate in docs and evidence files.

## Adding a backend

`RcloneBackend` is the only place that knows about rclone. A second backend (for example JuiceFS with its metadata engine) should expose the same four operations (`ensureRuntime`, `mount`, `inspect`, `unmount`) and document its own durability and concurrency semantics.
