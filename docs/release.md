# Releases

## v0.1.0 — first preview

Scope: the rclone backend, the Freestyle and Docker adapters, the Daytona-style API, unit and Linux integration tests, and documentation. Verification records live in `docs/evidence/`.

Not published to npm. Installation is from GitHub (`npm install github:reachjalil/freestyle-volumes`), which runs `prepare` to build `dist/`.

## Unreleased safety, multipart clone, Git and performance changes

- Mounts use `rclone rcd` with RC `mount/mount`. Normal detach externally unmounts, waits for FUSE serving to stop, drains the retained VFS, then stops the process and removes verified-clean cache/state.
- `FLUSH_FAILED` may leave the mount gone but uploader/cache/state retained: restore storage access and retry detach. Forced uncertain detach retains recovery state/cache and the advisory attachment record; it does not guarantee durability or override unsafe process cleanup.
- Guest lifecycle operations require per-path `flock`, reject symlink paths/ancestors, and validate process identity before signaling. Failed attach retains recovery evidence.
- Mount/cache identity now includes resolved host and guest endpoints, bucket, prefix, region, provider and path-style mode as well as volume/subpath/path. Credentials and request timeouts are excluded. Legacy state/cache is not automatically migrated or rebound; missing identity evidence can require operator recovery.
- **Custom-store contract change:** implement atomic `ObjectStore.putObjectIfAbsent(key, body): Promise<boolean>`. S3 uses `If-None-Match: *`; unsupported or ambiguous conditional writes fail rather than falling back to overwrite. Registry records must pass strict shape and exact-prefix validation.
- Attachment records are still advisory. Atomic creation and guest locks do not solve distributed attach/delete or create/delete races; application orchestration remains necessary.
- **Clone:** same-bucket/namespace conditional server-side copies, with source ETags and atomic conditional destination publication. Caller-coordinated quiescence is required; advisory attachment checks and `allowLiveSource` do not provide snapshots, COW or ACID. Single copy applies at or below `storage.multipartCopyThresholdBytes` (default 5 GiB); multipart copy supports larger objects up to a conservative 5 TiB per object. `multipartCopyPartSizeBytes` defaults to 128 MiB (minimum configured 5 MiB), adaptively grows to stay within 10,000 parts, and parts are sequential per object, keeping clone concurrency an upper bound. HEAD checks source size/ETag and pins available versions; every part is ETag-conditional. Supported HEAD metadata and separately read tags are preserved; verify provider version/tag/multipart/abort permissions. Selection is capped at 100,000 objects and 32 MiB UTF-8 JSON metadata, with lower configurable budgets.
- **Layout compatibility:** new creates/clones write v2 generation prefixes; existing v1 records are supported, but older v1-only clients cannot read v2. Upgrade all namespace participants before writing new records. Always consume stored `dataPrefix`; generation also changes mount/cache identity.
- **Failure handling:** clone ownership intents remain even on success. Unknown completion or publication retains data; other failed copies/cleanup yield `cleanupStatus: 'uncertain'` because remote work can finish late. Expose upload/stage/abort diagnostics and abort failures; acknowledged abort does not prove destination absence. Reconcile provider uploads and late objects; recommend incomplete-MPU lifecycle cleanup, not age-based deletion of generations. There is no automatic GC/resume. See [reconciliation](semantics.md#clone-publication-and-reconciliation).
- **Git and exports:** `VolumeGit`, `volumeGit`, `VolumeGitError` and types are available at the root and `/git`; copy constants are exported at the root. Explicit clone/status/path-selected commit with identity, clean ff-only pull, normal push and directional sync; no automatic commits, PRs or GitHub REST. Requires preinstalled Git, credential-free HTTPS (or GitHub `owner/name`), env-only tokens with temporary askpass and a trusted adapter/guest that does not log env. Restricted repositories only: hooks disabled, filters/submodules/linked worktrees/symlinks and unsafe layouts/configuration rejected. Single-writer coordination and separate verified detach are required; results are guest-local, not ACID or S3 durability. Prefer native active worktrees. See [Git guide](git.md).
- **Tuning:** `list({ concurrency? })` and clone concurrency default to 8 (1–64). Mount `bufferSize`, `readAhead`, `readChunkSize`, `readChunkSizeLimit` and `transfers` are opt-in with unchanged defaults; full-cache mode is required for read-ahead to take effect. See [performance](performance.md), [research rationale](freestyle-research.md) and [local-only benchmark evidence](evidence/performance-local.md).

**Final main-run verification — 2026-09-18:** `pnpm test`: 112 passed, 0 skipped; `pnpm check:types` and `pnpm check:examples` passed. `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration`: 26 passed, 0 failed, 0 skipped, including a small multipart fixture, real-FUSE Git, minimum/pinned rclone 1.68.0/1.75.1 and Ubuntu bootstrap. Large multipart boundaries are mocked, not actual 5 TiB copies. Git coverage is unit/local smart HTTP plus real FUSE, not live authenticated GitHub. `pnpm test:freestyle`: 1 skipped for missing `FREESTYLE_API_KEY`, `VOLUMES_S3_BUCKET`, `VOLUMES_S3_ACCESS_KEY_ID`, and `VOLUMES_S3_SECRET_ACCESS_KEY`; no live round trip or pause/resume behavior is validated. Earlier 85/17 counts and CI links in [evidence/v0.1.md](evidence/v0.1.md) remain historical; they certify only their older revisions.

## Checklist before a release

1. `pnpm install --frozen-lockfile`
2. `pnpm test`, `pnpm check:types`, `pnpm check:examples`
3. `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration` on a Linux host with Docker (CI does this)
4. `pnpm test:freestyle` with a real Freestyle key and bucket; record the outcome in `docs/evidence/`
5. `pnpm pack` and inspect the archive: `dist/`, `README.md`, `LICENSE` only
6. Update `CHANGELOG.md`, bump `package.json` version, tag `vX.Y.Z`

Publishing to npm needs a separate decision; nothing in the repository publishes automatically.
