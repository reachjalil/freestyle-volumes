# Changelog

## 0.1.0 — 2026-09-17

First preview.

- **API.** `FreestyleVolumes` with `create`, `get` (with `create`), `list`, `delete` (confirmed, guarded by attachment records), `attach`, `inspectMount`, `detach`. Volumes are addressed by name; `subpath` and `readOnly` mounts.
- **Backend.** rclone FUSE mount (`--vfs-cache-mode writes`) over any S3-compatible bucket. Pinned rclone 1.75.1 with SHA-256 verification, or an existing rclone ≥ 1.68. Credentials only as environment variables. Unix-socket remote control drives flush-on-detach.
- **Lifecycle.** Readiness is a successful directory listing, not a started process. Detach expedites the upload queue and reports `flushed` honestly; `force` is explicit. Stale mounts after crashes or restarts are detected, cleaned and resumed on re-attach.
- **Integrations.** `freestyleSandboxes()` over the `freestyle` SDK (structural types, optional peer); `dockerSandboxes()` for local Linux containers.
- **Tests.** 33 unit tests; Linux integration suite on Docker + MinIO covering the full lifecycle, replacement, read-only, namespace and subpath isolation, bad credentials, unreachable storage, mount failure and timeout, missing FUSE, crash resume, busy mounts, flush failure and delete; opt-in bare-Ubuntu bootstrap test; a gated Freestyle live test (not yet executed).
