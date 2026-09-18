# Performance and bounded server-side cloning

This guide describes the current public API, not a new set of defaults. Keep active source trees, package installations, databases and watch-heavy work on the VM's native disk; use these volumes for datasets, shared inputs and exported artifacts that tolerate object-store semantics. See [Freestyle research](freestyle-research.md) for the source-linked rationale and [semantics](semantics.md) for durability limits.

## Opt-in mount tuning

Set these fields in constructor `defaults` or override them per `attach`. Omitting them leaves rclone's own defaults in place. The library still defaults to `cacheMode: 'writes'`, `writeBackSeconds: 5`, `dirCacheSeconds: 60`, and an unbounded disk cache.

| Public option | Meaning | Validation / runtime mapping |
| :--- | :--- | :--- |
| `bufferSize` | Per-open-file memory buffer; larger buffers can multiply memory usage across open files. | Explicit-unit size string; daemon `--buffer-size`. |
| `readAhead` | Additional disk read-ahead, effective only with `cacheMode: 'full'`. | Explicit-unit size string; RC `vfsOpt.ReadAhead`. Does not switch the cache mode automatically. |
| `readChunkSize` | Initial ranged-read chunk size. | Explicit-unit size string; RC `vfsOpt.ChunkSize`. |
| `readChunkSizeLimit` | Maximum ranged-read chunk size, or no limit. | Explicit-unit size string, or exactly lowercase `'off'`; RC `vfsOpt.ChunkSizeLimit`. |
| `transfers` | Concurrent file transfers for this mount's daemon, not host-side clone concurrency. | Integer 1–64; daemon `--transfers`. |

The four new size fields accept nonnegative decimal strings with explicit units: `B`, `K` through `E`, optionally followed by `B` or `iB` for the larger units, case-insensitively. Examples: `'0B'`, `'512K'`, `'16M'`, `'1.5GiB'`. Strings must be at most 64 characters and resolve to fewer than 2^63 bytes (8 EiB); units use powers of 1024. Bare numbers, numeric JS values, whitespace, signs and scientific notation are rejected. Only `readChunkSizeLimit` accepts `'off'`. These are syntactic/range checks, not a promise that every combination improves a workload; no chunk-size ordering constraint is added.

The existing `cacheMaxSize` validation is unchanged: one to six digits, optionally followed by uppercase `K`, `M`, `G` or `T`, as accepted by `assertCacheSize`. Do not assume it uses the new explicit-unit validator. It is an rclone cache eviction target, not a strict disk quota: open/dirty files and cleanup timing can require more space. Leave disk headroom for both native workspace data and retained uploads.

An illustrative read-heavy configuration, not a measured recommendation:

```ts
await volumes.attach({
  sandboxId: vmId,
  volumeId: 'datasets',
  mountPath: '/mnt/datasets',
  readOnly: true,
  cacheMode: 'full',
  cacheMaxSize: '4G',
  bufferSize: '8M',
  readAhead: '32M',
  readChunkSize: '16M',
  readChunkSizeLimit: '128M',
  transfers: 4,
});
```

A healthy matching mount returns `alreadyAttached: true`; changing tuning fields on another `attach` does **not** reconfigure that running mount. Stop writers, detach normally and require verified drain, then attach with the new options. Tuning must not replace the tested `rcd` unmount-first/retained-VFS drain protocol with direct `rclone mount` teardown, a sleep, or process termination.

Implementation: [`MountDefaults` and validation](../src/volumes.ts#L15), [`assertRcloneSize`](../src/validate.ts#L128), and [`mountScript`](../src/rclone.ts#L294). `bufferSize`/`transfers` are daemon-global options, not VFS fields. [`rclone-perf-options.test.mjs`](../test/integration/rclone-perf-options.test.mjs) exercises option readback and read/write integrity on rclone 1.68.0 and 1.75.1; it is not a throughput benchmark. See the [verification record](evidence/v0.1.md) for run status.

## Metadata listing

```ts
const volumesByName = await volumes.list({ concurrency: 8 });
```

`list()` defaults to 8 concurrent metadata reads; `concurrency` must be an integer 1–64. The registry streams the metadata-key listing, reads records in batches no larger than that setting, validates them and returns results sorted by name. Records deleted before their GET are omitted; malformed records and read failures still reject. It is not a snapshot of concurrent registry changes. This setting does not parallelize all S3 listing pages or change attachment-list behavior. See [`VolumeRegistry.list`](../src/registry.ts#L311).

## Clone API

`clone` runs on the host using server-side object copies, without a sandbox or payload download/re-upload. Source and destination are in the **same configured bucket and namespace**; cross-bucket and cross-namespace cloning are not exposed.

Before this call, the application must stop all writers (including direct bucket writers), prevent new writes/attachments and source deletion, close files, and normally detach all known source mounts with `flushed: true`. Hold that application-level coordination until the clone finishes. A missing advisory attachment record is not proof that a writer is absent. See the complete orchestration example in [`examples/clone.ts`](../examples/clone.ts).

```ts
const result = await volumes.clone({
  sourceVolumeId: 'datasets',
  name: 'datasets-copy',
  labels: { purpose: 'evaluation' },
  concurrency: 8,
  maxObjects: 100_000,
  maxManifestBytes: 32 * 1024 ** 2,
});
```

| Field | Contract |
| :--- | :--- |
| `sourceVolumeId`, `name` | Existing source and a new destination name, using the normal volume-name validator. No overwrite or `ifNotExists` clone mode. |
| `labels?` | Destination labels; omitted means `{}`, not inherited source labels. Normal label validation applies. |
| `allowLiveSource?` | Only `true` bypasses the advisory attachment refusal, including read-only attachments. It neither drains caches nor locks writers nor creates a snapshot. |
| `concurrency?` | Integer 1–64, default 8; bounds concurrent object-copy workers. Multipart parts are sequential per object, so this also bounds in-flight part-copy requests (no extra part fan-out). |
| `maxObjects?` | Integer 1–100,000, default and hard cap 100,000. Can only lower the budget. |
| `maxManifestBytes?` | Integer 2–33,554,432, default and hard cap 32 MiB. Can only lower the budget. |
| Return | `CloneResult`: `{ volume, operationId, copiedObjects, copiedBytes }`. Counts include directory-marker objects selected from the source prefix. |

Selection completes before any copy starts. The in-memory manifest retains only `{ key, size, etag }`; its byte budget counts escaped UTF-8 JSON, brackets and commas, **not payload bytes or total process RSS**. Either budget exceeded yields `VALIDATION`, with no copies and no destination publication; an ownership intent may already exist. Splitting work or future paged-manifest support is required for larger selections, not raising these hard caps.

Every selected object needs an opaque nonempty ETag. Missing source ETags or a custom store without conditional server-side copy support yields `UNSUPPORTED`; provider API/permission failures surface as storage errors, not a payload-download fallback. ETags are conditions, not assumed MD5 checksums or snapshot identifiers.

### Single and multipart copy

These are host-side `StorageConfig` fields, not clone-call or rclone mount options:

| Field | Default | Valid values / effect |
| :--- | :--- | :--- |
| `multipartCopyThresholdBytes` | 5 GiB (`5 * 1024 ** 3`) | Integer bytes, 5 MiB–5 GiB inclusive. Objects **at or below** the threshold use one `CopyObject` (including zero-byte markers); larger objects use multipart copy. |
| `multipartCopyPartSizeBytes` | 128 MiB (`128 * 1024 ** 2`) | Integer bytes, 5 MiB–5 GiB inclusive. The actual size is `max(configuredPartSize, ceil(objectSize / 10_000))`, keeping at most 10,000 parts. The final part may be smaller than 5 MiB. |

The conservative implementation ceiling is **5 TiB per object**, including the total of its multipart parts, not a 5 TiB budget for the whole volume. Larger objects fail selection with `VALIDATION` before copying or publishing. This ceiling is not a promise of every provider's maximum. Source data stays within the configured bucket/namespace and never passes through the host or guest. Parts are copied **sequentially within each object**; clone `concurrency` bounds active objects and therefore concurrent part-copy requests. A single large object does not use all workers. `requestTimeoutMs` applies to each S3 request, not the entire clone. Ordinary rclone uploads use their own separate settings.

Both paths first issue source `HeadObject` with the selected ETag as `IfMatch`, then require exact matching size and ETag. If HEAD supplies `VersionId`, it is pinned in subsequent copy requests and the multipart tag read. Single copy uses `CopySourceIfMatch`; **every** `UploadPartCopy` also uses that selected ETag and its inclusive byte range. ETag conditions do not prevent every metadata/tag-only race; even a pinned version can have its tags changed. Version pinning does not provide a tree-wide snapshot, so source quiescence is still required.

Single `CopyObject` uses the provider's default metadata/tag-copy behavior. Multipart copy reads source tags with `GetObjectTagging`, initializes an upload with those tags and HEAD's user metadata plus `ContentType`, `ContentEncoding`, `ContentLanguage`, `ContentDisposition`, `CacheControl` and `Expires`, copies ordered parts, then completes with their returned ETags. It does not promise to preserve ACLs, ownership, storage class, object-lock settings or source encryption configuration. Destination bucket policy/defaults still apply. A missing/invalid part or completion ETag is an error, never a successful clone.

### Provider support and permissions

Allow namespace listing, metadata/intent reads and conditional writes, source HEAD/read and server-side copy, destination writes and cleanup deletes. Multipart additionally needs tag reads (version-specific when pinned), destination tagging, multipart creation, part copy, completion and abort. On AWS these generally map to `s3:ListBucket`, `s3:GetObject`/`s3:GetObjectVersion`, `s3:GetObjectTagging`/`s3:GetObjectVersionTagging`, `s3:PutObject`, `s3:PutObjectTagging`, `s3:AbortMultipartUpload` and `s3:DeleteObject` as applicable. Encrypted objects may also require provider/KMS decrypt and data-key permissions. Reconciliation operators need multipart-list/part-list access (on AWS `s3:ListBucketMultipartUploads` and `s3:ListMultipartUploadParts`). Scope policies to the relevant namespace and verify the provider's action mapping, conditional-copy, version, tagging and multipart behavior; S3 compatibility alone is not proof.

Configure a provider lifecycle rule to **abort incomplete multipart uploads** after an appropriate operational recovery window. This limits orphaned-part storage/cost when the client loses an upload ID or cannot abort; it does not prove completion failed, delete completed objects, or authorize age-based deletion of clone generations/intents. See [reconciliation](semantics.md#clone-publication-and-reconciliation).

The package root exports `MAX_SINGLE_COPY_BYTES` (5 GiB), `MAX_MULTIPART_COPY_BYTES` (5 TiB), `MIN_MULTIPART_COPY_PART_BYTES` (5 MiB), `DEFAULT_MULTIPART_COPY_PART_BYTES` (128 MiB), `MAX_MULTIPART_COPY_PARTS` (10,000), `MAX_CLONE_OBJECTS` (100,000) and `MAX_CLONE_MANIFEST_BYTES` (32 MiB). The `/git` subpath exports Git helpers/types, not these storage constants.

Copies go into a unique generation prefix. Only after every selected copy is acknowledged does an atomic `If-None-Match: *` metadata write publish the destination name. Until publication, this operation's partial tree is not exposed through `get`, `list` or `attach`; a different operation can independently win that name. Direct bucket readers can see staged objects. This is **atomic conditional publication**, not a point-in-time snapshot, copy-on-write fork or ACID transaction. Listing spans time, objects can change after being copied, and concurrent additions can be missed. Caller quiescence is required for a coherent tree.

Implementation and failure contracts: [`VolumeRegistry.clone`](../src/registry.ts#L185), [`S3ObjectStore.copyObject`](../src/storage.ts#L231), and [clone semantics and reconciliation](semantics.md#clone-publication-and-reconciliation).

## Layout compatibility and cleanup

New `create` and `clone` calls write version-2 records with a UUID `generation` and `<prefix>/v2/<name>/<generation>` data prefixes. Existing version-1 records pointing to `<prefix>/v/<name>` data remain readable, attachable and deletable without migration. Always use the returned `volume.dataPrefix`; do not synthesize a v1 path from the name. Generation is part of mount/cache identity so deleting and recreating a name cannot silently bind an old cache to new data. **Older clients that only understand v1 cannot read v2 records.** Upgrade namespace participants before new v2 records are written; there is no automatic downgrade.

Every clone ownership intent at `<prefix>/_operations/<operationId>.json` is immutable and retained, even on success. It is not a resumable manifest, cleanup lease or garbage-collection authorization. There is no automatic GC or clone resume. On failure inspect `VolumeError.details.operationId`, `destinationPrefix`, `publication`, `completionUnknown`, `multipartFailures` and `cleanupStatus`. Unknown copy completion or publication retains data; other failed copies/cleanup are uncertain because remote work can outlive a client timeout and empty cleanup listing. When an upload ID is known, abort is attempted on copy failure; `abortStatus: 'failed'` includes a sanitized `abortError`, while even `'acknowledged'` proves neither destination absence nor cessation of remote work. An ambiguous create may leave an upload without a known ID. Do not blindly retry or delete a generation by age. See [semantics](semantics.md#clone-publication-and-reconciliation).

## Measured local evidence, not Freestyle performance

The [current-code local MinIO rerun](evidence/performance-local.md#current-code-rerun-mandatory-source-head-safety-checks) ran on **2026-09-18T23:24:33.530Z–23:24:46.775Z**, comparing concurrency 1 with 8 after the benchmark guard was updated to accept mandatory source HEAD checks. The medians below are rounded to six decimal places; the evidence retains the exact emitted values:

| API / fixture | Median c=1 | Median c=8 | Ratio of medians |
| :--- | ---: | ---: | ---: |
| Metadata list: 1,024 legacy v1 records | 756.439230 ms | 264.858355 ms | 2.86x |
| Clone: 64 objects, 17.0625 MiB total | 219.579459 ms | 73.957146 ms | 2.97x |

These are local host API measurements for specific fixtures, not guaranteed speedups or comparisons against client-side copying. Each clone includes **64 source HEAD checks and 64 single CopyObject requests** in its timing, with no tag reads or multipart copies. The largest object is 1 MiB; this run measures neither multipart throughput nor Git, FUSE or Freestyle performance. The harness measures whole API calls, validates bytes outside clone timers and checks that no guest or object-payload download/upload is used during clone; metadata JSON traffic remains allowed.

Six samples per configuration, warm connections and shared caches limit inference; type/example checks also ran concurrently, and host load was not isolated. Differences from the archived run must not be attributed solely to HEAD checks: code, instrumentation, caches and host load differ, with no controlled before/after experiment. The evidence includes raw samples, timing boundaries, image digests, dirty-tree source hashes and cleanup verification; those hashes identify the measured revision, not later edits. The older run remains in the evidence's historical archive.

For further tuning, measure cold and warm reads separately, include close-to-verified-detach time for writes, and record object sizes/counts, VM disk/memory, endpoint latency, throttling and cache settings. Preinstall runtime dependencies in a clean snapshot to isolate bootstrap from steady-state costs. Lower concurrency when throttling or memory pressure dominates. No default change or production performance claim follows from this one local benchmark.
