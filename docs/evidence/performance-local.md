# Local MinIO performance evidence

## Current-code rerun: mandatory source HEAD safety checks

Actual local Docker MinIO run: **2026-09-18T23:24:33.530Z–23:24:46.775Z**.
This supersedes the historical performance summary below for the code identified
by the new hashes here. No synthetic store or delays were used.

| Operation | Fixed workload per call | Median c=1 (ms) | Median c=8 (ms) | Median c=1 / median c=8 |
| --- | --- | ---: | ---: | ---: |
| Registry listing | 1,024 records; 208,896 metadata bytes | 756.4392295000007 | 264.85835450000013 | 2.856014230428968 |
| Server-side clone | 64 objects; 17,891,328 payload bytes | 219.57945850000033 | 73.95714599999974 | 2.9690093571215024 |

The current run observed **2.86x registry-list** and **2.97x clone** ratios of
elapsed medians at concurrency 1 versus 8 for this local host workload, including
mandatory source HEAD checks. The small-object fixture uses single-copy requests;
it does not measure multipart throughput, Git, FUSE or Freestyle performance.
These are not general speedup claims. Do not attribute differences between runs
solely to HEAD safety checks: code, instrumentation, caches and host load differ,
and no controlled before/after experiment was performed.

### Guard change and correctness evidence

`test/bench/registry-clone.mjs` now uses the SDK middleware `context.commandName`
instead of assuming every data-prefix operation must carry `CopySource`.
For both `/v/` and `/v2/` data keys it permits source `HeadObjectCommand` and
`GetObjectTaggingCommand`, conditional server-side copies, and multipart-copy
control commands. It rejects payload `GetObjectCommand`, `PutObjectCommand`,
`UploadPartCommand` and all other unrecognized data commands before dispatch.
It checks the owned bucket, restricts HEAD/tag reads to the source prefix,
requires HEAD `IfMatch` and copy `CopySourceIfMatch`, forbids mutation of the
source, and rejects any data-command upload `Body` or returned SDK `Body`.
An unexpected returned body is destroyed without consumption and fails the run.
Metadata JSON GETs remain allowed; the invariant is no **object payload** download,
not zero HTTP response traffic.

Preflight self-checks passed: payload GET/PUT/UploadPart never reached the mock
next handler; HEAD/tag reads were accepted; an injected unexpected body was
rejected and destroyed. These are guard-only checks, not synthetic performance
samples. Actual warmup and measured clones each asserted exactly:

- **64 HeadObjectCommand + 64 CopyObjectCommand** data operations.
- **0 returned data bodies**, hence no SDK object-payload stream consumed during
  the timed clone. This is command/output-boundary evidence, not packet tracing.
- **0 GetObjectTagging calls** for this small-object fixture. Tag reads are allowed
  by the guard but the multipart path was not exercised in this run.
- **64 store copy calls**, peak in-flight store calls **1 or 8** as requested.
  Each store copy call now includes its mandatory source HEAD plus CopyObject.
- All destination key sets, lengths, SHA-256 hashes, content types and user
  metadata matched outside the timed API call. Source verification before and
  after all clones passed; **sourceUnchanged: true**.
- Destination deletion/count/empty-prefix checks and final owned-container/network
  cleanup passed; **cleanupVerified: true**. Guest resolution still throws.

The earlier fixture definition, seed/manifest, six repetitions per concurrency,
untimed warmup pair and alternating pair order remain unchanged. The clone has
16 objects of each size **0, 4,096, 65,536 and 1,048,576 bytes**. The source is
quiescent; all objects use single CopyObject, not multipart copy. The public API
timer includes mandatory source HEAD checks. The measured **copy window** spans
store `copyObject` calls, so HEAD time is inside it, not in `nonCopyMs`.

### Current raw samples and overhead

All following sample times are ms rounded to six decimals; summary medians and
ratios above retain the emitted JSON precision, not a claim of clock accuracy.

| Pair | Order | Registry c=1 | Registry c=8 | Clone c=1 | Clone c=8 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0 | 1,8 | 813.472334 | 295.537083 | 244.910250 | 90.457208 |
| 1 | 8,1 | 904.007708 | 292.880084 | 220.143500 | 82.290167 |
| 2 | 1,8 | 911.910042 | 261.908042 | 207.526250 | 76.159875 |
| 3 | 8,1 | 698.000125 | 267.808667 | 218.881833 | 66.121208 |
| 4 | 1,8 | 684.769916 | 246.654208 | 219.015417 | 71.754417 |
| 5 | 8,1 | 699.406125 | 241.975792 | 230.826500 | 63.263750 |

| Clone component median (ms) | c=1 | c=8 |
| --- | ---: | ---: |
| Copy window including source HEAD, included | 209.476271 | 65.508771 |
| Non-copy wall time, included | 9.645229 | 9.133583 |
| Full destination data verification, excluded | 50.752167 | 50.207521 |
| Destination deletion API, excluded | 13.186813 | 13.036291 |

| Pair | c | Copy window (ms) | Non-copy (ms) | Data verification (ms) | Destination deletion (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 234.176459 | 10.733791 | 50.491959 | 13.562750 |
| 0 | 8 | 78.790333 | 11.666875 | 51.497500 | 18.669708 |
| 1 | 8 | 70.357791 | 11.932376 | 49.953792 | 13.076125 |
| 1 | 1 | 204.341500 | 15.802000 | 51.853334 | 13.397625 |
| 2 | 1 | 198.921250 | 8.605000 | 46.162666 | 12.997667 |
| 2 | 8 | 68.110208 | 8.049667 | 49.868375 | 12.996458 |
| 3 | 8 | 56.701125 | 9.420083 | 49.193791 | 12.631667 |
| 3 | 1 | 209.961042 | 8.920791 | 47.861250 | 13.184000 |
| 4 | 1 | 208.991500 | 10.023917 | 51.624792 | 12.337875 |
| 4 | 8 | 62.907334 | 8.847083 | 50.461250 | 11.854375 |
| 5 | 8 | 54.991125 | 8.272625 | 51.159125 | 14.548250 |
| 5 | 1 | 221.559959 | 9.266541 | 51.012375 | 13.189625 |

LIST-only samples: `17.747625, 18.328917, 23.973459, 17.534166, 17.550292,
17.114083` ms; emitted median **17.648958499999935 ms**. As before, this is a
separate measurement, not subtracted from registry API times. Non-copy time is
computed per sample as full API time minus copy-window wall time. Component
medians need not add to the total median. Guard/instrumentation overhead is
included but not independently isolated.

| Excluded work | Elapsed (ms) |
| --- | ---: |
| Stack start | 538.145333 |
| Registry seed | 434.993334 |
| Clone payload seed | 77.356459 |
| Final source verification | 49.588500 |
| Stack stop | 321.991542 |

### Current runtime, source provenance and validation

The reported host/runtime/image identities match the historical machine table:
Apple M4 Max, Darwin 25.5.0 arm64, 14 logical CPUs, 38,654,705,664 bytes RAM;
Node v24.11.1 / V8 13.6.233.10-node.28; AWS SDK 3.1135.0. Docker server 27.3.1,
Ubuntu 24.04.1 LTS, kernel 6.8.0-47-generic aarch64, 4 CPUs,
8,308,215,808 bytes RAM, overlayfs. Both images were requested as `:latest` and
resolved again to the exact pinned digests in the reproduction command below:

- MinIO: `quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.
- rclone: `rclone/rclone@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5`.
- Both linux/arm64. Configured/container rclone 1.75.1; container Alpine 3.24.1,
  Go 1.27.1, static linking, no Go tags. rclone remains outside timed paths.

HEAD remains `4cf8e868a5d2a55fe6fa520d58388cb6459eb5cc`; the working tree is dirty.
A successful fresh `pnpm build` preceded this run. New SHA-256 values identify
exactly the source/build/harness measured, independently of the historical hashes:

| File | Current-run SHA-256 |
| --- | --- |
| `src/registry.ts` | `6e2be2d84e96d39f1a1e7e038b2928c830d4b8c941cdd882679575add735ea34` |
| `src/storage.ts` | `8c5f0bd4ef7f890003b24ca4ac73c0bf0bbfc3acfa3aa9be1d62f088c6ea3dba` |
| `src/volumes.ts` | `6c20b2346c9f4ec3d071d5ce3dc2aaf47a5774d6d0b84b1b97b8e6b3416b4cae` |
| `dist/registry.js` | `c29a937b448cfc097e0ed4bc691c9953c89e3504f9ef642c7cc163e3759f9b84` |
| `dist/storage.js` | `33d79461d789c19b7242c628527da7df01b82e84612087fb27b604956d90ea92` |
| `dist/volumes.js` | `b191bdf98a87a42a0c0a73195dcec2cba1203a6d0ecb82cf09258a8c95401da5` |
| `pnpm-lock.yaml` | `a2f4fecd0489c7d835606159303b5753ccea910fc19a6c397417239ab3dd4ca6` |
| `test/helpers/stack.mjs` | `9ec970ab699df4a0c04481afe69e426b5fcf916c0da6605e9d0f657c468a97ac` |
| `test/bench/registry-clone.mjs` | `0d71b0e28662b95f7c63aaf6909b6ccc7bcc1d5fda1228665ccb4ee8e373c209` |

Build, harness syntax, guard self-checks, actual benchmark, `pnpm check:types`
and `pnpm check:examples` passed. No lint command is defined in package.json.
Type/example checks were launched concurrently with the build/benchmark command;
host load was not isolated or quantified. All earlier local-run limitations still
apply: warm caches, no confidence intervals, no production latency/TLS, no
multi-GiB/multipart fixture or concurrent writers. This run includes the mandatory
HEAD path but does not validate multipart copying or the Git helper.

## Historical evidence archive (19:51 run, not current-code results)

**Everything below records the earlier run.** Its 2.940882889557109 /
2.4636302901390223 ratios and old source hashes are retained for provenance,
not as measurements of the current code. Reproduction instructions and fixed
fixture definitions remain applicable; running the updated harness measures the
new code and requires the command-aware guard above.

### Historical scope and result

Actual Docker-backed MinIO run, **2026-09-18T19:51:10.866Z–19:51:23.106Z**.
Harness: [`test/bench/registry-clone.mjs`](../../test/bench/registry-clone.mjs).
This historical run compares the then-current public `FreestyleVolumes.list({ concurrency })` and
`FreestyleVolumes.clone({ sourceVolumeId, name, concurrency })` APIs at **1 vs 8**.
No synthetic delays or MemoryObjectStore were used. It predates the source HEAD/version
checks, multipart-copy implementation and Git helper; it is not a measurement or
validation of those changes. Source hashes below identify the measured code.

| Operation | Fixed workload per call | Median c=1 (ms) | Median c=8 (ms) | Median c=1 / median c=8 |
| --- | --- | ---: | ---: | ---: |
| Registry listing | 1,024 records; 208,896 metadata bytes | 724.463708 | 246.342250 | 2.940882889557109 |
| Server-side clone | 64 objects; 17,891,328 payload bytes | 197.961521 | 80.353583 | 2.4636302901390223 |

Concurrency 8 had lower elapsed medians **in this run, on these fixtures**. These
ratios are descriptive observations, not production speedup guarantees, statistical
significance claims, or comparisons with rclone/client-side copying.

## Reproduction

Requires installed project dependencies, Node >=22, pnpm, and a running Docker
daemon. From the repository root:

```sh
pnpm build
VOLUMES_TEST_MINIO_IMAGE='quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e' \
VOLUMES_TEST_SANDBOX_IMAGE='rclone/rclone@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5' \
node test/bench/registry-clone.mjs --run
```

The recorded run used the helper's `:latest` defaults, resolved to exactly the
digests above. Pinning them avoids tag drift; these observed images are ARM64.
Unset `VOLUMES_SKIP_INTEGRATION` (or set it to a value other than `1`). Docker
unavailability is a failure, not a silently skipped or synthetic result.
Rebuild before every run to benchmark current source rather than stale `dist`.
The script writes a JSON report to stdout, including all unrounded samples,
medians, hashes, image references, and cleanup status. It requires `--run`, is
outside the normal test globs, and adds no package scripts or dependencies.

### Fixtures and timing boundaries

- The existing `test/helpers/stack.mjs` creates a fresh MinIO container, private
  Docker network, loopback-bound ephemeral port, generated test credentials, and
  `volumes-test` bucket inside that container. Each run also uses a unique
  `bench-<stack.id>/` namespace. No external bucket/endpoint is accepted.
- Registry seed: exactly 1,024 valid legacy v1 JSON metadata records, each **204
  UTF-8 bytes**, fixed timestamp `2026-01-01T00:00:00.000Z`, fixed labels, and names
  `record-0000` through `record-1023`. Only the unique namespace varies; its length
  is fixed. Direct metadata seeding avoids variable timestamps and UUIDs in this
  fixture. Registry timing exercises two LIST pages (page limit 1,000), 1,024
  metadata reads, validation/parsing, and sorting. Results are deep-compared with
  the baseline after every call. This does not benchmark v2 metadata size/parse
  cost, attachments, malformed records, or concurrent registry mutations.
- Clone source: a current-API-created v2 volume, with **16 objects of each size**:
  **0, 4,096, 65,536, 1,048,576 bytes**; **64 objects / 17,891,328 bytes** total
  (17.0625 MiB). Every name includes nested paths, spaces, literal `+%#`, Unicode
  `é`, and `!'()`. Binary data uses deterministic xorshift32 with seed
  `0x5eed1234` (1,592,594,996), taking the low byte at each step. Manifest SHA-256
  over JSON `[name, byteLength, sha256]` tuples:
  `5c84d26b36dc83106d202d48415d3d81e8a970476b121b6e6d6a60db09353466`.
- One untimed warmup pair per operation (c=1 then c=8), then **six measured calls
  per concurrency**. Registry also performs one initial c=1 baseline read. Pair
  order alternates `1,8` / `8,1`, balancing which concurrency runs first. Medians
  average the two middle sorted samples. Ratio is the ratio of medians, not a
  median of paired ratios. Calls are not run simultaneously across benchmark
  configurations. The same stack/client/connection pool remains warm.
- `performance.now()` measures host wall time around the full awaited API call.
  Clone time includes source/destination metadata checks, advisory attachment
  listing, operation intent publication, source listing, conditional server-side
  copies, final metadata publication, and the API return. Each call gets a fresh
  destination; it is verified and deleted before the next call. Source writes
  stop before warmup.
- SDK middleware prohibits data GET/PUT during timed clones and checks conditional
  `CopySourceIfMatch`; a store wrapper counts copies and measures their first-start
  to last-completion window. Every clone made **64 CopyObject calls**, with peak
  in-flight calls exactly **1 or 8**, matching its setting. A guest resolver that
  throws ensures neither operation uses a sandbox. rclone is not a timed path.
- Outside each clone timer, destination metadata is read back; exact key sets,
  byte lengths, SHA-256 of **every object**, content type, and user metadata are
  checked. This includes both warmups and all measured destinations. The source
  receives the same full validation before cloning and after all destination
  deletions. Final result: **source unchanged; all checks passed**.

## Raw elapsed samples

All times below are milliseconds, rounded to six decimal places from the emitted
JSON (`performance.now()` precision does not imply equivalent timing accuracy).
Pair order is the actual execution order; columns group configurations for reading.

| Pair | Order | Registry c=1 | Registry c=8 | Clone c=1 | Clone c=8 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0 | 1,8 | 736.342333 | 246.914917 | 218.818125 | 96.529917 |
| 1 | 8,1 | 687.999083 | 245.769583 | 184.362209 | 85.589958 |
| 2 | 1,8 | 734.758333 | 265.550209 | 228.108625 | 72.512375 |
| 3 | 8,1 | 718.057208 | 242.810500 | 210.808459 | 81.563625 |
| 4 | 1,8 | 730.870208 | 260.092750 | 185.114583 | 67.149416 |
| 5 | 8,1 | 699.566166 | 239.800208 | 177.366541 | 79.143541 |

### Overhead and excluded work

“Non-copy” is full clone wall time minus the measured copy window, **per sample**.
It estimates pre/post-copy orchestration, listing and publication time, not pure
CPU overhead. The copy window includes SDK/network/backend time, scheduling and
gaps between requests. Lightweight assertions/instrumentation are included in
timed calls; their marginal overhead was not independently isolated. Independent
component medians need not sum to the median total.

| Clone component median (ms) | c=1 | c=8 |
| --- | ---: | ---: |
| Copy window, included in API time | 186.787834 | 70.070250 |
| Non-copy wall time, included in API time | 9.753187 | 9.532896 |
| Full destination data verification, excluded | 49.344500 | 48.601833 |
| Destination deletion API, excluded | 12.777896 | 13.477396 |

| Pair | c | Copy window (ms) | Non-copy (ms) | Data verification (ms) | Destination deletion (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 208.763167 | 10.054958 | 48.761875 | 12.111708 |
| 0 | 8 | 86.349917 | 10.180000 | 53.434417 | 14.309166 |
| 1 | 8 | 76.155458 | 9.434500 | 48.284834 | 11.431750 |
| 1 | 1 | 175.261292 | 9.100917 | 48.826917 | 12.621167 |
| 2 | 1 | 219.069500 | 9.039125 | 50.257416 | 12.934625 |
| 2 | 8 | 63.229375 | 9.283000 | 46.671667 | 13.518750 |
| 3 | 8 | 71.932333 | 9.631292 | 47.791666 | 13.929000 |
| 3 | 1 | 197.912500 | 12.895959 | 48.870208 | 11.839583 |
| 4 | 1 | 175.663167 | 9.451416 | 50.405916 | 13.018042 |
| 4 | 8 | 58.394750 | 8.754666 | 49.009208 | 13.436042 |
| 5 | 8 | 68.208167 | 10.935374 | 48.918833 | 13.259042 |
| 5 | 1 | 166.258250 | 11.108291 | 49.818792 | 13.383875 |

Real registry **LIST-only** samples, collected after the listing comparisons:
`16.709166, 16.513417, 16.243209, 15.419083, 15.286834, 15.248875` ms.
Median **15.831146 ms**, including iterator consumption/count assertion but no
metadata GETs. This is a separately measured reference cost, not a matched
decomposition or subtraction from registry API timing.

Other measured work excluded from API timings:

| Work | Elapsed (ms) |
| --- | ---: |
| Stack start (MinIO/network/bucket/readiness) | 489.068959 |
| Registry seed (eight upload workers) | 423.834417 |
| Clone payload seed (eight upload workers) | 85.018875 |
| Final source data verification | 52.125875 |
| Stack stop | 354.488958 |

These rows are not an exhaustive accounting of harness runtime: fixture byte
generation, image/version inspection, warmups, assertions, metadata readback,
post-delete listing, and cleanup verification also take time. No host CPU, RSS,
backend disk I/O or network-byte overhead was measured.

## Machine, runtime and image references

| Field | Observed value |
| --- | --- |
| Host | Apple M4 Max; Darwin 25.5.0; arm64; 14 logical CPUs |
| Host RAM | 38,654,705,664 bytes |
| Node / V8 | v24.11.1 / 13.6.233.10-node.28 |
| AWS SDK client-s3 | 3.1135.0 |
| Docker client/server | 27.3.1 / 27.3.1; Colima context |
| Docker VM | Ubuntu 24.04.1 LTS; Linux 6.8.0-47-generic; aarch64 |
| Docker resources | 4 CPUs; 8,308,215,808 bytes RAM; overlayfs storage driver |
| MinIO requested image | `quay.io/minio/minio:latest` |
| MinIO resolved image ID/digest | `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` (linux/arm64) |
| rclone requested image | `rclone/rclone:latest` |
| rclone resolved image ID/digest | `sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5` (linux/arm64) |
| Configured / container rclone | 1.75.1 / v1.75.1 |
| rclone container runtime | Alpine 3.24.1; linux/arm64; Go 1.27.1; static linking; no Go tags |

rclone was inspected in a stack-owned **non-FUSE** container solely for provenance.
Neither benchmark mounts a filesystem or measures rclone performance. Image
digests identify the actual local image content rather than relying on tags.
The report whitelists machine fields and image identifiers: it does not dump
container environment, credentials, signed requests, Docker auth or storage config.

### Code provenance

HEAD: `4cf8e868a5d2a55fe6fa520d58388cb6459eb5cc`; **working tree was dirty** with
in-progress current-API changes. HEAD alone is not a reproduction of that source.
`pnpm build` completed successfully immediately before the run. SHA-256 at run:

| File | SHA-256 |
| --- | --- |
| `src/registry.ts` | `7deb1383bf44fb9e01cda8ccddb84d39a96a483ecf08a3f0f386d6cbda4d94b0` |
| `src/storage.ts` | `ea5fbd0a60a197fdae59d5a994997e66e981b2bce6988595d88d2c13302469f4` |
| `src/volumes.ts` | `117761f3c116520c511b2b4274f9c1ba2900095284633367354ef9682946f4a2` |
| `dist/registry.js` | `285325b5b51447f2d0e722e42f6b2ba51524f75599da2493ca0f0848e818f4ca` |
| `dist/storage.js` | `62dc65476ad99583fd65447cafa1103dc1d6793a9cd73291b47420ea350db439` |
| `dist/volumes.js` | `b191bdf98a87a42a0c0a73195dcec2cba1203a6d0ecb82cf09258a8c95401da5` |
| `pnpm-lock.yaml` | `a2f4fecd0489c7d835606159303b5753ccea910fc19a6c397417239ab3dd4ca6` |
| `test/helpers/stack.mjs` | `9ec970ab699df4a0c04481afe69e426b5fcf916c0da6605e9d0f657c468a97ac` |
| `test/bench/registry-clone.mjs` | `1c238d754b6492ecaae2a20d1ad53592e6a1db1fabe0007acf394ed04f5a6ce6` |

## Cleanup and limitations

Each successfully verified destination is removed using the public delete API
with its exact generated volume ID and matching confirmation. Empty destination
prefixes are checked afterward. The source, seeded registry records and retained
clone operation intents remain within the isolated stack until `finally` invokes
`Stack.stop()`. No bucket-wide deletion, host-volume removal, Docker prune, or
shared-container cleanup is used. The harness verifies its named MinIO/rclone
containers and network are gone. **Recorded cleanupVerified: true.**
SIGINT/SIGTERM request interruption at operation boundaries and still reach
`finally`; SIGKILL, host loss or a hung Docker daemon cannot guarantee cleanup.

This is one short local run with six samples per setting, shared caches and a
warm HTTP pool. No cache eviction, CPU pinning, load isolation, cross-machine
replication or confidence interval was attempted. Verification itself warms
backend caches. Host-to-container traffic crosses the local Colima VM boundary;
storage is container-local, with no production TLS, WAN latency or S3 billing.
Backend copy implementation/caching may dominate small-object measurements.
The largest payload is 1 MiB; this says nothing about multi-GiB objects, multipart
copy, large-scale trees, concurrent writers, snapshot isolation or crash behavior.
Performance depends on record/object distributions and resource contention;
re-run rather than extrapolating these ratios to other workloads.
