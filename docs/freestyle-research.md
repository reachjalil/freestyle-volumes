# Freestyle storage research and design rationale

Reviewed 2026-09-18 against the linked public pages and this repository's current source. This is a targeted review of primary documentation, vendor engineering commentary and public integration discussions, not an exhaustive market survey. Vendor claims are not measurements by this project; third-party examples and rclone issues are not Freestyle consensus or endorsement.

## Native active workspaces, object artifacts, reviewable source

Freestyle's [Cloud Storage vs Working Directories for AI Agents](https://www.freestyle.sh/blog/product/cloud-storage-vs-working-directories-ai-agents) distinguishes a real machine's active working directory from durable objects: package managers, watchers, terminals, services and local caches belong with the VM, while uploads, datasets, exports, logs and completed artifacts fit object storage. Its [agent filesystems and Git article](https://www.freestyle.sh/blog/engineering/agent-filesystems-git) argues for Git as the version/review layer for branches, diffs, promotion and rollback. These are architectural recommendations from Freestyle, not proof that any one backend is universally best.

The resulting recommendation here is a three-way split:

| State | Recommended home | Reason / boundary |
| :--- | :--- | :--- |
| Active checkout, dependencies, database files, watcher-heavy state | Native VM disk | Tools need local filesystem and process semantics; an S3 mount does not become POSIX by exposing paths. |
| Reviewable code and document changes | Git repository, with a native working checkout | History, review and merge are different requirements from persistence. The optional `VolumeGit` helper invokes guest Git on a managed mount; it does not make S3 transactional or replace native active worktrees. |
| Shared datasets, read-mostly assets, finalized exports | Object storage, optionally mounted by this library | Named volumes and subpaths simplify file access across VMs while retaining whole-object writes, cache delay and nontransactional semantics. |

This complements Freestyle's native workspace model rather than replacing it. A library `clone` copies stored objects into another volume; it is not a Git branch, VM fork, native-disk snapshot or copy-on-write workspace. See [`VolumeRegistry.clone`](../src/registry.ts#L185) and [clone semantics](semantics.md#clone-publication-and-reconciliation).

## Verified documentation and implementation consequences

| Source | What the retrieved page says | Consequence for this project |
| :--- | :--- | :--- |
| [VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle) | Pause preserves memory, open files and processes; start resumes them. Stop discards memory while retaining disk; only persistent VMs can start again. Deletion is permanent. | Pause is not an upload-completion signal. Stop/crash can leave local cache/state without an uploader; deleting a VM can destroy unflushed data. Pause/resume was later verified live (2026-09-25): the mount and a pending upload survived; stop/start recovery goes through `restoreMounts`. |
| [PTY sessions](https://www.freestyle.sh/docs/vms/pty) | PTYs outlive their WebSocket, detach leaves a process running, and exec has a five-minute limit. Stop/delete terminate PTY sessions. | The adapter bounds individual execs to 300 s. PTY hosting is a possible future alternative if live testing finds exec-spawned daemons do not survive; it is not implemented, and PTY persistence does not prove exec-background persistence. |
| [Base snapshots](https://www.freestyle.sh/docs/vms/base-snapshots) | Ubuntu variants use Ubuntu 24.04; `ubuntu-sm` has 4 GiB memory and 16 GB disk. BusyBox has no package manager. Custom snapshots capture memory and disk from a running or paused VM. | Use Ubuntu for apt/FUSE bootstrap. Prepare a clean image with fuse3, rclone and flock when startup latency matters. Detach mounts before snapshotting to avoid retaining credentials and pending cache. Do not extrapolate a vendor startup figure to attach time. |
| [VM product page](https://www.freestyle.sh/products/vms) | Advertises full Linux, live forking and pause/resume, with marketing startup figures and SDK examples. | Native VM cloning is a separate capability. We do not claim its timing, memory semantics or instant copying for object-volume `clone`. Prefer detailed docs and the installed SDK for API contracts; the page's examples can differ from them. |
| [Firewall](https://www.freestyle.sh/docs/vms/network/firewall) | VM creation declares a firewall; no ordinary inbound/outbound traffic is implicit. `source: {}` inside VM creation denotes that VM, while `destination: { public: true }` broadly permits the public Internet. Freestyle-delivered SSH/domain traffic has separate platform allowances. | Explicitly allow guest access to storage and runtime/package download endpoints. A successful host metadata request does not prove guest connectivity. Narrow production rules to the required destinations where feasible; the broad README rule is a bootstrap example, not least privilege. |

The snapshot warning is an inference from documented memory/disk capture and our own credential/cache placement, not a Freestyle-specific credential test. Source: [`rcloneRemoteEnv`](../src/storage.ts#L98), [`mountScript`](../src/rclone.ts#L294). The [Freestyle verification guide](freestyle.md) separates documented capabilities, installed-SDK type checks and untested runtime assumptions.

## Public FUSE example: feasibility evidence only

[Mesa's Freestyle integration](https://docs.mesa.dev/content/integrations/sandboxes/freestyle) publicly demonstrates installing a filesystem client in a Freestyle VM, configuring FUSE access, and keeping a mount daemon running for an agent. It also recommends preinstallation when startup time matters. This supports investigating FUSE as a practical integration path; it does not validate this library's rclone implementation, minimum rclone version, durability protocol, performance or pause/resume behavior.

Do not copy that example mechanically: its VM creation omits the firewall now required by the detailed Freestyle docs, and it interpolates a token into a command string. This library instead passes credentials in exec environment variables, uses a root-only RC Unix socket and a checksum-verified pinned bootstrap binary. None of those differences warrants claiming superiority to Mesa or equivalent semantics. Live `/dev/fuse` availability and installation still need our own test.

## rclone developer discussion: shutdown is not remote fsync

Two public rclone threads explain the failure class we must guard against:

- [Issue #7309](https://github.com/rclone/rclone/issues/7309), reported with rclone 1.64.0 in 2023, describes a short-lived container unmounting before write-back completed. Discussion distinguishes preserved local cache from completed remote uploads; maintainer `ncw` explains that mount shutdown was designed to allow remaining uploads on a later run. A fixed sleep is not a durability proof.
- [Issue #6490](https://github.com/rclone/rclone/issues/6490), opened in 2022, discusses dirty writes, applications that keep files open and call fsync, queue metrics, and the difficulty of stopping new writes on existing handles. It motivates explicit quiescence and retaining recoverable data, not assuming `fsync`, SIGTERM or unmount alone commits the remote contents.

These are historical rclone developer/user discussions, **not Freestyle developer consensus**, a current-version guarantee, or evidence that our live Freestyle integration passed. The generic suggestions in them are not a substitute for the repository's implementation and regression tests.

### Preserve the tested retained-VFS protocol

The actual backend uses one `rclone rcd` process and RC `mount/mount` per managed mount. Normal detach is:

1. External normal unmount (`fusermount3 -u`) to stop new filesystem access; reject a busy mount rather than silently declaring success.
2. Wait until RC `mount/listmounts` reports no serving mounts, avoiding a final-release versus empty-queue race.
3. Keep the VFS alive in `rcd`, expedite queued uploads and require valid zero queued, in-flight and errored counters.
4. Stop only the verified owned process, verify cleanup, then remove clean cache/state and the advisory attachment record.

This is intentionally **not** direct `rclone mount` followed by unmount/kill, and intentionally not RC `mount/unmount`, which would shut down the VFS too early. An empty queue sampled before writer quiescence is insufficient. `FLUSH_FAILED` can leave an unmounted but live uploader; retry after restoring connectivity. Uncertain forced detach retains cache/state and the advisory record without claiming durability.

The protocol rationale comes from [`src/rclone.ts`](../src/rclone.ts#L294), [architecture](architecture.md#detach-sequence), and the repository's [guest regression tests](../test/integration/rclone-guest.test.mjs), not an extrapolation from issue comments. [Verification evidence](evidence/v0.1.md) records the final main run on **2026-09-18**: `pnpm test`: 112 passed, 0 skipped; `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration`: 26 passed, 0 failed, 0 skipped, including a small multipart fixture, real-FUSE Git, minimum/pinned rclone 1.68.0/1.75.1 and Ubuntu bootstrap; SDK/example type checks passed. Large multipart boundaries are mocked, not actual 5 TiB copies. Git verification covers unit/local smart HTTP and real FUSE, not live authenticated GitHub. `pnpm test:freestyle` had 1 skipped test for the four missing environment variables listed in the evidence, so these were not live Freestyle results at the time; the later live run of 2026-09-25 (round trip, snapshot, pause/resume) is recorded in [evidence/v0.2.md](evidence/v0.2.md).

## Daytona comparison without equivalence claims

[Daytona's volume documentation](https://www.daytona.io/docs/en/volumes/) explicitly calls its volumes FUSE mounts over S3-compatible storage, with shared access and subpath isolation. Its sharing section says they are **not transactional** and concurrent writes to one path are last-write-wins, requiring application coordination when ordering matters. The page also describes immediate visibility across its sandboxes; that is not a promise this library inherits, because our directory caches can delay visibility.

“Daytona-style” here means a named-volume developer experience, not the same API, managed provisioning, implementation, consistency or latency. Atomic conditional publication of a new clone record does not make our volume transactional either. See [migration differences](daytona-migration.md) and [semantics](semantics.md).

## Enhancements supported by this review

Already implemented and documented:

- Bounded parallel metadata reads and server-side clone copies avoid serial host round trips without moving payloads through a VM. Clone uses source ETag conditions and isolated generation prefixes, then conditional metadata publication; it is neither COW nor snapshot isolation.
- Opt-in `bufferSize`, `readAhead`, `readChunkSize`, `readChunkSizeLimit` and `transfers` preserve defaults. Full-cache read-ahead can help selected read-heavy workloads but consumes guest disk; per-open-file buffers consume memory. Measure rather than enabling large values universally.
- Manifest caps (100,000 objects and 32 MiB serialized metadata) bound selection; immutable ownership intents and conservative cleanup states expose uncertainty rather than conceal it. They do not implement automatic resume or GC.
- Multipart server-side copy handles objects above the configured single-copy threshold (default 5 GiB), up to a conservative 5 TiB per object. HEAD/version/ETag checks and per-part ETag conditions protect object selection, not tree-wide snapshot consistency. Adaptive parts (minimum configured 5 MiB, default 128 MiB, maximum 10,000 parts) run sequentially within each object; clone concurrency bounds part requests. Supported HEAD metadata and tags are preserved subject to provider support/permissions. Unknown completion/publication retains data; abort failures and unfinished uploads need reconciliation. Recommend incomplete-MPU lifecycle rules, never age-based generation deletion. See [copy API](performance.md#single-and-multipart-copy).
- The optional [Git helper](git.md) exposes explicit clone/status/commit with paths and identity, clean ff-only pull, normal push and directional sync using preinstalled Git. It is not automatic committing, PR creation or GitHub REST. Credential-free HTTPS/GitHub `owner/name`, env-only tokens and temporary askpass require a trusted guest/adapter with no env logging. Hooks are disabled; filters, submodules, linked worktrees and symlink layouts are outside its restricted support. Single-writer orchestration and a separate verified detach remain mandatory; guest-local commits are not ACID/S3 durability. This does not change the native-active-worktree recommendation.

Further work should be gated by evidence: live Freestyle round-trip and pause/resume tests; cold/warm read and close-to-detach measurements on representative VM sizes; version/tag/multipart/conditional-write verification beyond the local MinIO fixtures, actual large-object copies and live authenticated GitHub verification; and a separately designed durable-manifest/resume protocol if workloads require it. Those results/protocols are not claimed here. Never add age-based orphan deletion without proving publication and outstanding remote-copy outcomes.

The current-code [local MinIO rerun](evidence/performance-local.md) on **2026-09-18** observed **2.86x metadata-list** and **2.97x clone** ratios of elapsed medians (concurrency 1 versus 8), including mandatory source HEAD checks. It measures local host registry/copy operations on small single-copy objects, not multipart throughput, Git, FUSE or Freestyle performance. It supports the bounded-concurrency implementation on those fixtures, not a best-in-market or general production speed claim. Differences from the archived run cannot be attributed solely to HEAD checks: this was not a controlled before/after experiment. See [performance options and medians](performance.md#measured-local-evidence-not-freestyle-performance).
