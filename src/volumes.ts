/**
 * The Daytona-style facade. Storage configuration, the sandbox integration and
 * the filesystem process management stay separate underneath:
 *   - {@link VolumeRegistry}   metadata + data prefixes in the bucket
 *   - {@link RcloneBackend}    the rclone FUSE mount inside the sandbox
 *   - {@link SandboxResolver}  how to run a script in a sandbox (Freestyle, Docker)
 */
import type { SandboxCredentialsProvider, SandboxCredentialsRequest } from './credentials.js';
import { ValidationError, VolumeError, isVolumeError } from './errors.js';
import { DEFAULT_GUEST_PATHS, RcloneBackend, type CacheMode, type GuestMountListing, type GuestMountResult, type MountSpec } from './rclone.js';
import {
  VolumeRegistry, type AttachmentRecord, type Volume, type CloneVolumeOptions, type CloneResult, type ListVolumesOptions,
  type LeaseRecord, type ReconcileReport, type StaleRecordCleanup, type VolumeUsage,
} from './registry.js';
import type { SandboxResolver } from './sandbox.js';
import {
  RCLONE_REMOTE, S3ObjectStore, rcloneRemoteEnv, resolveSandboxCredentials, resolveStorage,
  type ObjectStore, type ResolvedStorage, type SandboxCredentials, type StorageConfig,
} from './storage.js';
import { assertCacheSize, assertInteger, assertMountPath, assertRcloneSize, assertSandboxId, assertSubpath, assertUmask, assertVolumeName, mountIdFor } from './validate.js';

export interface MountDefaults {
  /** rclone VFS cache mode. `writes` buffers writes on the sandbox disk; `full` also caches reads. */
  cacheMode: CacheMode;
  /** Seconds a closed file waits before its upload starts. Detach forces pending uploads regardless. */
  writeBackSeconds: number;
  /** Seconds directory listings are cached. Changes made by other sandboxes become visible after this. */
  dirCacheSeconds: number;
  /** Let users other than root use the mount (`--allow-other`). */
  allowOther: boolean;
  /** Report this uid as the owner of every file (`--uid`). Default: the mounting user, root. */
  uid?: number;
  gid?: number;
  /** Permission mask, e.g. "022". */
  umask?: string;
  /** Eviction target for the on-disk cache, e.g. "10G", or "off". Unbounded by default; files not yet uploaded are never evicted. */
  cacheMaxSize?: string;
  /**
   * Evict clean cached files when free space on the cache disk drops below
   * this, e.g. "1G" (the default), or "off". Pending uploads are never evicted,
   * so this protects the VM disk from read caching, not from writing faster
   * than the bucket accepts.
   */
  cacheMinFreeSpace?: string;
  /** Per-open-file memory buffer, e.g. "16M" or "0B". Explicit units required; omitted uses rclone's default. */
  bufferSize?: string;
  /** Extra disk read-ahead, effective only with cacheMode: "full"; does not change cacheMode. Explicit units required. */
  readAhead?: string;
  /** Initial ranged-read chunk size, e.g. "128M". Explicit units required; omitted uses rclone's default. */
  readChunkSize?: string;
  /** Maximum ranged-read chunk size with explicit units, or "off" for no limit. Omitted uses rclone's default. */
  readChunkSizeLimit?: string;
  /** Daemon-wide concurrent file transfers, integer 1–64. Omitted uses rclone's default. */
  transfers?: number;
  /** How long attach waits for the FUSE mount to answer a directory listing. */
  readyTimeoutMs: number;
  /** How long detach and flush wait for pending uploads to finish. */
  flushTimeoutMs: number;
  /** How long the runtime bootstrap (fuse3 + rclone install) may take. */
  bootstrapTimeoutMs: number;
  inspectTimeoutMs: number;
}

export const DEFAULT_MOUNT_DEFAULTS: MountDefaults = {
  cacheMode: 'writes',
  writeBackSeconds: 5,
  dirCacheSeconds: 60,
  allowOther: true,
  cacheMinFreeSpace: '1G',
  readyTimeoutMs: 30_000,
  flushTimeoutMs: 60_000,
  bootstrapTimeoutMs: 240_000,
  inspectTimeoutMs: 30_000,
};

/** Freestyle's hard cap on one exec call. */
const MAX_EXEC_MS = 300_000;
/** Attach warns when less than this is free for the write cache. */
const LOW_CACHE_DISK_BYTES = 2 * 1024 ** 3;
/** Attach warns when sandbox credentials expire sooner than this. */
const SHORT_CREDENTIALS_MS = 15 * 60 * 1000;

export interface VolumeEvent {
  type: 'volume.created' | 'volume.deleted' | 'attach.bootstrap' | 'attach.mount' | 'attach.done' | 'detach.start' | 'detach.done' | 'flush.done' | 'mount.discarded' | 'warning';
  sandboxId?: string;
  volumeId?: string;
  mountPath?: string;
  message?: string;
}

export interface FreestyleVolumesOptions {
  storage: StorageConfig;
  sandboxes: SandboxResolver;
  /** Override the object store (tests, dry runs). */
  objectStore?: ObjectStore;
  backend?: RcloneBackend;
  defaults?: Partial<MountDefaults>;
  /**
   * Credentials for the rclone process in each sandbox, instead of `storage`'s
   * own keys: fixed keys (for example a key limited to this namespace), or a
   * function called per attach to mint keys limited to that volume. The host
   * process keeps using `storage` for volume records.
   */
  sandboxCredentials?: SandboxCredentials | SandboxCredentialsProvider;
  /** Structured progress events. Never contain credentials. */
  onEvent?: (event: VolumeEvent) => void;
}

export interface CreateVolumeOptions {
  name: string;
  labels?: Record<string, string>;
  /** Return the existing volume instead of failing when the name is taken. */
  ifNotExists?: boolean;
}

export interface GetVolumeOptions {
  /** Create the volume when it does not exist (Daytona's `volume.get(name, true)`). */
  create?: boolean;
}

export interface AttachVolumeOptions extends Partial<Omit<MountDefaults, 'flushTimeoutMs' | 'inspectTimeoutMs'>> {
  sandboxId: string;
  volumeId: string;
  /** Absolute path inside the sandbox. Created if missing; must be empty. */
  mountPath: string;
  readOnly?: boolean;
  /** Directory inside the volume to expose as the mount root (tenant isolation). */
  subpath?: string;
  /**
   * Take the volume's exclusive-writer lease with a conditional create. Other
   * writable attaches of the volume are refused until this mount is detached
   * with a verified flush (or the lease is released on purpose); read-only
   * attaches stay allowed. Writable mounts only.
   */
  exclusive?: boolean;
}

export interface VolumeAttachment {
  sandboxId: string;
  volumeId: string;
  mountPath: string;
  subpath: string | null;
  readOnly: boolean;
  /** True when this mount holds the volume's exclusive-writer lease. */
  exclusive: boolean;
  mountId: string;
  pid: number;
  /** True when a healthy mount of the same volume already existed at this path. */
  alreadyAttached: boolean;
  /** Free bytes on the VM disk that holds the write cache, when known. */
  cacheFreeBytes: number | null;
  /** When the sandbox credentials of this mount expire, if the provider said. */
  credentialsExpireAt: string | null;
  warnings: string[];
}

export interface InspectMountOptions {
  sandboxId: string;
  mountPath: string;
  timeoutMs?: number;
}

export interface MountInspection {
  /**
   * `mounted`: healthy. `stale`: this library attached something here, but the
   * mount or its process is gone (crash, sandbox restart); pending writes may
   * sit in the sandbox cache. `absent`: nothing managed here. `unmanaged`: an
   * rclone mount this library did not create.
   */
  status: 'mounted' | 'stale' | 'absent' | 'unmanaged';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  subpath: string | null;
  readOnly: boolean | null;
  exclusive: boolean | null;
  pid: number | null;
  /** The FUSE mount answered a stat call within 5 seconds. */
  responsive: boolean;
  uploads: { queued: number; inProgress: number; errored: number } | null;
  cacheBytes: number | null;
  startedAt: string | null;
  credentialsExpireAt: string | null;
  logTail: string[];
}

export interface DetachVolumeOptions {
  sandboxId: string;
  mountPath: string;
  flushTimeoutMs?: number;
  /**
   * Detach even when pending writes cannot be flushed, a process holds files
   * open, or the mount is stale. The result then reports `flushed: false` and
   * the unflushed data stays in the sandbox cache directory.
   */
  force?: boolean;
}

export interface DetachResult {
  status: 'detached' | 'absent';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  /** True only when the mount was removed and its pending uploads then fully drained. */
  flushed: boolean;
  /** Uploads still pending after the drain attempt; null when unknown. */
  pendingUploads: number | null;
  warnings: string[];
}

export interface FlushOptions {
  sandboxId: string;
  mountPath: string;
  /** How long to wait for pending uploads. Default: the `flushTimeoutMs` default (60 s). */
  flushTimeoutMs?: number;
}

export interface FlushResult {
  /** `flushed` when every upload finished in time; `pending` when some were still queued, in flight or failing. */
  status: 'flushed' | 'pending';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  /**
   * True once rclone reported zero queued, in-flight and errored uploads: every
   * file closed before the call is in the bucket. Files still open for writing
   * are queued only when they are closed, so they are not covered.
   */
  flushed: boolean;
  pendingUploads: number | null;
  erroredUploads: number | null;
  /** False when only a detached uploader was left to drain. */
  mounted: boolean;
}

export interface FlushAllResult {
  sandboxId: string;
  /** True when every managed mount reported a complete flush. */
  flushed: boolean;
  results: Array<FlushResult | MountFailure>;
}

export interface ListMountsOptions {
  sandboxId: string;
  timeoutMs?: number;
}

export interface MountSummary {
  /** `mounted`: healthy. `stale`: a state record without a healthy mount (crash, restart, or recovery data retained by a failed or forced detach). */
  status: 'mounted' | 'stale';
  /** Null when the state record is unreadable; inspect it in the sandbox. */
  mountPath: string | null;
  volumeId: string | null;
  subpath: string | null;
  readOnly: boolean | null;
  exclusive: boolean | null;
  mountId: string;
  pid: number | null;
  startedAt: string | null;
  /** Upload queue of a running uploader, for monitoring; null when it is not running. */
  uploads: { queued: number; inProgress: number; errored: number } | null;
  cacheBytes: number | null;
  credentialsExpireAt: string | null;
}

export interface MountListing {
  sandboxId: string;
  /** Every mount this library manages in the sandbox, sorted by mount path. */
  mounts: MountSummary[];
  /** rclone mounts that this library did not create. They are never touched. */
  unmanaged: string[];
}

export interface DetachAllOptions {
  sandboxId: string;
  flushTimeoutMs?: number;
  /** Passed to every detach; see {@link DetachVolumeOptions.force}. */
  force?: boolean;
}

/** A mount that a bulk operation could not handle. Its recovery state, cache and advisory record are retained. */
export interface MountFailure {
  status: 'failed';
  sandboxId: string;
  mountPath: string | null;
  volumeId: string | null;
  flushed: false;
  pendingUploads: null;
  warnings: string[];
  error: { code: string; message: string };
}

/** A mount that `detachAll` could not detach. */
export type DetachFailure = MountFailure;

export interface DetachAllResult {
  sandboxId: string;
  /** True when every managed mount was detached with a verified flush or was already gone: nothing unflushed is left in the sandbox. */
  flushed: boolean;
  results: Array<DetachResult | DetachFailure>;
  /** rclone mounts this library did not create; left alone. */
  unmanaged: string[];
}

export interface RestoreMountsOptions {
  sandboxId: string;
}

export interface RestoreMountsResult {
  sandboxId: string;
  /** Stale mounts that are mounted again, with their pending uploads resumed. */
  restored: VolumeAttachment[];
  /** Mount paths that were already healthy. */
  alreadyMounted: string[];
  failed: MountFailure[];
}

export interface DiscardMountOptions {
  sandboxId: string;
  mountPath: string;
  /** Must equal `mountPath`: discarding deletes every write in the cache that never reached the bucket. */
  confirm: string;
}

export interface DiscardMountResult {
  status: 'discarded' | 'absent';
  sandboxId: string;
  mountPath: string;
  volumeId: string | null;
  /** Size of the deleted write cache, including any writes that never reached the bucket. */
  discardedCacheBytes: number | null;
  warnings: string[];
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** The next step when the status is `warn` or `fail`. */
  hint?: string;
}

export interface CheckReport {
  /** False when any check failed. Warnings are work attach will do, such as installing rclone, or checks that cannot run yet. */
  ok: boolean;
  checks: CheckResult[];
}

export interface CheckSandboxOptions {
  sandboxId: string;
  /** Default 120000 ms; the check makes network probes from inside the sandbox. */
  timeoutMs?: number;
}

const SANDBOX_CHECK_HINTS: Record<string, string> = {
  'arch:fail': 'Only x86_64 and aarch64 sandboxes are supported.',
  'root:fail': 'Run the scripts as root, the default linuxUser of freestyleSandboxes().',
  'fuse-device:fail': 'Freestyle Ubuntu VMs expose /dev/fuse. A Docker container needs --device /dev/fuse --cap-add SYS_ADMIN.',
  'fusermount:fail': 'Use an image with apt-get or apk, or preinstall fuse3.',
  'flock:fail': 'Use an image with apt-get or apk, or preinstall util-linux.',
  'rclone:warn': 'Boot from a volume-ready snapshot (createVolumeReadySnapshot or `freestyle-volumes prepare-snapshot`) to skip the download on attach.',
  'rclone-download:fail': 'Allow outbound HTTPS to downloads.rclone.org in the VM firewall, or boot from a volume-ready snapshot.',
  'storage:fail': 'If checkStorage passes from this process, the VM cannot reach the bucket: allow outbound traffic to the storage endpoint in the VM firewall, and set storage.sandboxEndpoint when the VM reaches storage at a different address. With sandboxCredentials, check that they can list the namespace.',
  'storage:warn': 'Credentials are verified from inside the VM once rclone is installed.',
  'cache-disk:warn': 'Pending writes are cached on the VM disk until they upload; use a larger VM, or seed big datasets straight into the bucket instead of through the mount.',
};

export interface DeleteVolumeOptions {
  volumeId: string;
  /** Must equal `volumeId`. Deleting destroys every object under the volume's data prefix. */
  confirm: string;
  /** Delete even when advisory attachment records or an exclusive lease exist. */
  force?: boolean;
}

export interface DeleteResult {
  volumeId: string;
  deletedObjects: number;
  attachments: AttachmentRecord[];
}

export interface ReleaseLeaseOptions {
  volumeId: string;
  /** Must equal `volumeId`: releasing lets other writers attach while the old holder may still write. */
  confirm: string;
}

export interface RemoveOrphanGenerationOptions {
  volumeId: string;
  generation: string;
  /** Must equal `<volumeId>/<generation>`. */
  confirm: string;
  /** Refuse generations whose clone started more recently than this. Default 86400 (one day). */
  minAgeSeconds?: number;
}

/** Mount options kept in the guest state record, so restoreMounts can reattach with the same settings. Never credentials. */
type SavedMountOptions = Pick<MountDefaults, 'cacheMode' | 'writeBackSeconds' | 'dirCacheSeconds' | 'allowOther' | 'uid' | 'gid' | 'umask' | 'cacheMaxSize' | 'cacheMinFreeSpace' | 'bufferSize' | 'readAhead' | 'readChunkSize' | 'readChunkSizeLimit' | 'transfers'>;

export class FreestyleVolumes {
  readonly storage: ResolvedStorage;
  readonly registry: VolumeRegistry;
  readonly backend: RcloneBackend;
  readonly defaults: MountDefaults;
  private readonly sandboxes: SandboxResolver;
  private readonly sandboxCredentials: SandboxCredentials | SandboxCredentialsProvider | undefined;
  private readonly onEvent: ((event: VolumeEvent) => void) | undefined;

  constructor(options: FreestyleVolumesOptions) {
    if (!options || typeof options !== 'object') throw new VolumeError('VALIDATION', 'FreestyleVolumes needs an options object.');
    if (!options.sandboxes || typeof options.sandboxes.get !== 'function') {
      throw new VolumeError('VALIDATION', 'options.sandboxes must be a SandboxResolver (see freestyleSandboxes() or dockerSandboxes()).');
    }
    this.storage = resolveStorage(options.storage);
    this.registry = new VolumeRegistry(options.objectStore ?? new S3ObjectStore(this.storage), this.storage.prefix);
    this.backend = options.backend ?? new RcloneBackend();
    this.defaults = validateDefaults({ ...DEFAULT_MOUNT_DEFAULTS, ...options.defaults });
    this.sandboxes = options.sandboxes;
    if (options.sandboxCredentials !== undefined && typeof options.sandboxCredentials !== 'function') {
      resolveSandboxCredentials(options.sandboxCredentials); // Fail fast on malformed fixed keys.
    }
    this.sandboxCredentials = options.sandboxCredentials;
    this.onEvent = options.onEvent;
  }

  private emit(event: VolumeEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observers must not break operations.
    }
  }

  /** rclone environment for a sandbox: `storage`'s keys, or the ones `sandboxCredentials` gives for this scope. */
  private async sandboxEnv(request: Omit<SandboxCredentialsRequest, 'bucket' | 'prefix'>): Promise<{ env: Record<string, string>; expiresAt: string | null }> {
    if (this.sandboxCredentials === undefined) return { env: rcloneRemoteEnv(this.storage), expiresAt: null };
    let raw: SandboxCredentials;
    try {
      raw = typeof this.sandboxCredentials === 'function'
        ? await this.sandboxCredentials({ ...request, bucket: this.storage.bucket, prefix: this.storage.prefix })
        : this.sandboxCredentials;
    } catch (error) {
      throw new VolumeError('STORAGE_AUTH', `The sandboxCredentials provider failed for ${request.purpose} in sandbox "${request.sandboxId}"; nothing was started.`, {
        cause: error,
        hint: 'Check the provider (STS role, R2 API token, key scope). The host credentials were not used as a fallback.',
        details: { purpose: request.purpose, sandboxId: request.sandboxId, volumeId: request.volumeId, keyPrefix: request.keyPrefix },
      });
    }
    const credentials = resolveSandboxCredentials(raw);
    const env = rcloneRemoteEnv({ ...this.storage, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken });
    // A key limited to the mount's prefix cannot HEAD the mount root itself. rclone 1.75 then
    // mistakes an empty volume for a file and refuses to mount it; skipping that HEAD avoids it.
    env.RCLONE_CONFIG_FSVOL_NO_HEAD_OBJECT = 'true';
    return { env, expiresAt: credentials.expiresAt };
  }

  async create(options: CreateVolumeOptions): Promise<Volume> {
    const { volume, created } = await this.registry.createWithStatus({ name: options.name, labels: options.labels }, { ifNotExists: options.ifNotExists });
    if (created) this.emit({ type: 'volume.created', volumeId: volume.id });
    return volume;
  }

  async get(name: string, options: GetVolumeOptions = {}): Promise<Volume> {
    if (options.create) return this.create({ name, ifNotExists: true });
    return this.registry.get(name);
  }

  /** Server-side, object-wise consistent clone. Advisory attachment checks do not provide snapshot isolation. */
  async clone(options: CloneVolumeOptions): Promise<CloneResult> {
    const result = await this.registry.clone(options);
    this.emit({ type: 'volume.created', volumeId: result.volume.id });
    return result;
  }

  /** Volumes in this namespace, sorted by name. With `skipInvalid`, malformed records are skipped and reported as `warning` events. */
  async list(options: ListVolumesOptions = {}): Promise<Volume[]> {
    return this.registry.list({
      ...options,
      onInvalid: (name, error) => {
        options.onInvalid?.(name, error);
        this.emit({ type: 'warning', volumeId: name, message: `Skipped an invalid volume record: ${error.message}` });
      },
    });
  }

  /** Object count and bytes stored for a volume, from a listing of its data prefix. */
  async usage(name: string): Promise<VolumeUsage> {
    return this.registry.usage(name);
  }

  /** Destroys the volume record and every object under its data prefix. Requires `confirm === volumeId`. */
  async delete(options: DeleteVolumeOptions): Promise<DeleteResult> {
    const volumeId = assertVolumeName(options.volumeId);
    if (options.confirm !== volumeId) {
      throw new VolumeError('CONFIRMATION_REQUIRED', `Refusing to delete volume "${volumeId}": pass { confirm: "${volumeId}" } to confirm destroying all of its data.`);
    }
    const result = await this.registry.delete(volumeId, { force: options.force });
    this.emit({ type: 'volume.deleted', volumeId, message: `${result.deletedObjects} objects deleted` });
    return { volumeId, ...result };
  }

  /** The exclusive-writer lease of a volume, or null. */
  async getLease(volumeId: string): Promise<LeaseRecord | null> {
    const volume = await this.registry.get(volumeId);
    return (await this.registry.getLease(volume)) ?? null;
  }

  /**
   * Remove a volume's exclusive-writer lease without a detach, for example when
   * the VM that held it was deleted. Requires `confirm === volumeId`.
   */
  async releaseLease(options: ReleaseLeaseOptions): Promise<{ volumeId: string; released: boolean }> {
    const volumeId = assertVolumeName(options.volumeId);
    if (options.confirm !== volumeId) {
      throw new VolumeError('CONFIRMATION_REQUIRED', `Refusing to release the lease of "${volumeId}": pass { confirm: "${volumeId}" }. Make sure its holder no longer writes.`);
    }
    const released = await this.registry.releaseLease(volumeId);
    if (released) this.emit({ type: 'warning', volumeId, message: 'exclusive lease released by hand' });
    return { volumeId, released };
  }

  /** Read-only survey of the namespace for leftovers; see {@link VolumeRegistry.reconcile}. */
  async reconcile(): Promise<ReconcileReport> {
    return this.registry.reconcile();
  }

  /** Delete one unpublished generation reported by {@link reconcile}. */
  async removeOrphanGeneration(options: RemoveOrphanGenerationOptions): Promise<{ volumeId: string; generation: string; deletedObjects: number; intentRemoved: boolean }> {
    const result = await this.registry.removeOrphanGeneration(options);
    return { volumeId: options.volumeId, generation: options.generation, ...result };
  }

  /** Delete leases, attachment records, deleting markers and doctor probes that point at nothing. Never touches volume data. */
  async removeStaleRecords(): Promise<StaleRecordCleanup> {
    return this.registry.removeStaleRecords();
  }

  /**
   * Mount a volume into a sandbox. Idempotent: a healthy mount of the same
   * storage identity, volume and read-only mode at the same path is reported with
   * `alreadyAttached: true`. Stale mounts require detach before retrying;
   * retained cache is reused only for the same storage and mount identity.
   */
  async attach(options: AttachVolumeOptions): Promise<VolumeAttachment> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const volumeId = assertVolumeName(options.volumeId);
    const mountPath = assertMountPath(options.mountPath);
    const subpath = options.subpath === undefined ? undefined : assertSubpath(options.subpath);
    const readOnly = options.readOnly === true;
    const exclusive = options.exclusive === true;
    if (exclusive && readOnly) throw new ValidationError('exclusive applies to writable mounts; read-only mounts never take the lease.');
    const settings = validateDefaults({ ...this.defaults, ...stripUndefined(options) });
    const volume = await this.registry.get(volumeId);
    await this.registry.assertNotDeleting(volume);
    const mountId = mountIdFor(volumeId, subpath, mountPath, this.storage, volume.generation);
    const dataPrefix = subpath ? `${volume.dataPrefix}/${subpath}` : volume.dataPrefix;
    await this.registry.precheck(dataPrefix);

    // Exclusive writers take the lease; other writers refuse while someone else holds it. Readers are never blocked.
    let leaseTaken = false;
    if (exclusive) {
      leaseTaken = (await this.registry.acquireLease({ volumeId: volume.id, generation: volume.generation ?? null, sandboxId, mountId, mountPath, acquiredAt: new Date().toISOString() })).acquired;
    } else if (!readOnly) {
      const lease = await this.registry.getLease(volume);
      if (lease !== undefined && !(lease.sandboxId === sandboxId && lease.mountId === mountId)) {
        throw new VolumeError('VOLUME_IN_USE', `Volume "${volume.id}" is attached exclusively at ${lease.sandboxId}:${lease.mountPath}; only read-only attaches are allowed until it is detached.`, {
          hint: 'Attach with readOnly: true, detach the exclusive writer, or release a lease whose VM is gone with releaseLease.',
          details: { lease },
        });
      }
    }

    let mountStarted = false;
    let mounted: GuestMountResult;
    let credentialsExpireAt: string | null;
    try {
      const credentials = await this.sandboxEnv({ purpose: 'mount', sandboxId, keyPrefix: dataPrefix, readOnly, volumeId: volume.id, subpath: subpath ?? null, mountPath });
      credentialsExpireAt = credentials.expiresAt;
      const sandbox = await this.sandboxes.get(sandboxId);
      this.emit({ type: 'attach.bootstrap', sandboxId, volumeId, mountPath });
      await this.backend.ensureRuntime(sandbox, { timeoutMs: Math.min(settings.bootstrapTimeoutMs, MAX_EXEC_MS) });

      const spec: MountSpec = {
        mountId,
        remotePath: `${RCLONE_REMOTE}:${this.storage.bucket}/${dataPrefix}`,
        mountPath,
        readOnly,
        cacheMode: settings.cacheMode,
        writeBackSeconds: settings.writeBackSeconds,
        dirCacheSeconds: settings.dirCacheSeconds,
        allowOther: settings.allowOther,
        readyTimeoutMs: settings.readyTimeoutMs,
        stateJson: JSON.stringify({
          version: 1,
          mountId,
          volumeId: volume.id,
          generation: volume.generation,
          subpath: subpath ?? null,
          mountPath,
          readOnly,
          exclusive,
          cacheMode: settings.cacheMode,
          sandboxId,
          startedAt: new Date().toISOString(),
          credentialsExpireAt,
          options: savedOptions(settings),
        }),
      };
      if (settings.uid !== undefined) spec.uid = settings.uid;
      if (settings.gid !== undefined) spec.gid = settings.gid;
      if (settings.umask !== undefined) spec.umask = settings.umask;
      if (settings.cacheMaxSize !== undefined) spec.cacheMaxSize = settings.cacheMaxSize;
      if (settings.cacheMinFreeSpace !== undefined) spec.cacheMinFreeSpace = settings.cacheMinFreeSpace;
      if (settings.bufferSize !== undefined) spec.bufferSize = settings.bufferSize;
      if (settings.readAhead !== undefined) spec.readAhead = settings.readAhead;
      if (settings.readChunkSize !== undefined) spec.readChunkSize = settings.readChunkSize;
      if (settings.readChunkSizeLimit !== undefined) spec.readChunkSizeLimit = settings.readChunkSizeLimit;
      if (settings.transfers !== undefined) spec.transfers = settings.transfers;

      this.emit({ type: 'attach.mount', sandboxId, volumeId, mountPath });
      mountStarted = true;
      mounted = await this.backend.mount(sandbox, spec, credentials.env, { timeoutMs: Math.min(settings.readyTimeoutMs + 30_000, MAX_EXEC_MS) });
    } catch (error) {
      // Keep the lease when a mount may have started: a timed-out mount can still come up and write.
      const nothingStarted = !mountStarted || (isVolumeError(error) && ['MOUNT_PATH_IN_USE', 'MOUNT_BUSY', 'VALIDATION'].includes(error.code));
      if (leaseTaken && nothingStarted) await this.registry.releaseLease(volume.id, { sandboxId, mountId }).catch(() => false);
      else if (leaseTaken && isVolumeError(error)) error.details.leaseRetained = true;
      throw error;
    }

    const warnings: string[] = [];
    const warn = (message: string) => {
      warnings.push(message);
      this.emit({ type: 'warning', sandboxId, volumeId, mountPath, message });
    };
    try {
      await this.registry.putAttachment({ volumeId: volume.id, sandboxId, mountId, mountPath, subpath: subpath ?? null, readOnly, attachedAt: new Date().toISOString() });
    } catch (error) {
      warn(`The mount is live, but the advisory attachment record could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (mounted.cacheFreeBytes !== null && mounted.cacheFreeBytes < LOW_CACHE_DISK_BYTES && !readOnly) {
      warn(`Only ${Math.floor(mounted.cacheFreeBytes / 1024 ** 2)} MiB are free on the VM disk for the write cache. Writes wait there until they upload, so writing more than that faster than the bucket accepts fills the disk.`);
    }
    if (credentialsExpireAt !== null && Date.parse(credentialsExpireAt) - Date.now() < SHORT_CREDENTIALS_MS) {
      warn(`The sandbox credentials of this mount expire at ${credentialsExpireAt}. rclone cannot refresh them: detach before then, or reattach with fresh credentials.`);
    }
    this.emit({ type: 'attach.done', sandboxId, volumeId, mountPath, message: mounted.alreadyAttached ? 'already attached' : `pid ${mounted.pid}` });
    return {
      sandboxId, volumeId: volume.id, mountPath, subpath: subpath ?? null, readOnly, exclusive, mountId, pid: mounted.pid,
      alreadyAttached: mounted.alreadyAttached, cacheFreeBytes: mounted.cacheFreeBytes, credentialsExpireAt, warnings,
    };
  }

  async inspectMount(options: InspectMountOptions): Promise<MountInspection> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    const timeoutMs = Math.min(assertInteger('timeoutMs', options.timeoutMs ?? this.defaults.inspectTimeoutMs, 1000, MAX_EXEC_MS), MAX_EXEC_MS);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.inspect(sandbox, mountPath, { timeoutMs });
    let status: MountInspection['status'];
    if (guest.hasState) status = guest.mounted && guest.alive ? 'mounted' : 'stale';
    else status = guest.mounted ? 'unmanaged' : 'absent';
    const state = guest.state ?? {};
    return {
      status,
      sandboxId,
      mountPath,
      volumeId: typeof state.volumeId === 'string' ? state.volumeId : null,
      subpath: typeof state.subpath === 'string' ? state.subpath : null,
      readOnly: guest.readOnly ?? (typeof state.readOnly === 'boolean' ? state.readOnly : null),
      exclusive: typeof state.exclusive === 'boolean' ? state.exclusive : guest.hasState ? false : null,
      pid: guest.alive ? guest.pid : null,
      responsive: guest.responsive,
      uploads: guest.stats ? { queued: guest.stats.uploadsQueued, inProgress: guest.stats.uploadsInProgress, errored: guest.stats.erroredFiles } : null,
      cacheBytes: guest.stats ? guest.stats.cacheBytes : null,
      startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
      credentialsExpireAt: typeof state.credentialsExpireAt === 'string' ? state.credentialsExpireAt : null,
      logTail: guest.logTail,
    };
  }

  /**
   * Unmount first to stop new writes, drain pending uploads, then stop the
   * filesystem process. Succeeds only after a verified drain (`flushed: true`),
   * unless `force` is set. An unflushed detach retains the advisory attachment
   * record and any exclusive lease to guard the recoverable data left in the
   * sandbox. Never deletes volume data.
   */
  async detach(options: DetachVolumeOptions): Promise<DetachResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    const flushTimeoutMs = assertInteger('flushTimeoutMs', options.flushTimeoutMs ?? this.defaults.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000);
    const force = options.force === true;
    const sandbox = await this.sandboxes.get(sandboxId);
    this.emit({ type: 'detach.start', sandboxId, mountPath });
    const guest = await this.backend.unmount(sandbox, { mountPath, flushTimeoutMs, force, timeoutMs: flushTimeoutMs + 40_000 });
    const warnings: string[] = [];
    if (guest.status === 'detached' && guest.flushed && guest.volumeId && guest.mountId) {
      try {
        await this.registry.removeAttachment(guest.volumeId, sandboxId, guest.mountId);
      } catch (error) {
        const message = `Detached, but the advisory attachment record could not be removed: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        this.emit({ type: 'warning', sandboxId, mountPath, volumeId: guest.volumeId, message });
      }
      try {
        await this.registry.releaseLease(guest.volumeId, { sandboxId, mountId: guest.mountId });
      } catch (error) {
        const message = `Detached, but the exclusive lease could not be released: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        this.emit({ type: 'warning', sandboxId, mountPath, volumeId: guest.volumeId, message });
      }
    }
    this.emit({ type: 'detach.done', sandboxId, mountPath, volumeId: guest.volumeId ?? undefined, message: guest.status === 'absent' ? 'nothing mounted' : guest.flushed ? 'flushed' : 'not flushed' });
    return {
      status: guest.status,
      sandboxId,
      mountPath,
      volumeId: guest.volumeId,
      flushed: guest.status === 'detached' && guest.flushed,
      pendingUploads: guest.pending,
      warnings,
    };
  }

  /**
   * Upload every file closed before the call and keep the mount: a checkpoint
   * for a running VM (end of an agent step, before a snapshot of a paused VM).
   * Returns `flushed: false` with the remaining counts when uploads do not
   * finish in time; the mount stays usable either way.
   */
  async flush(options: FlushOptions): Promise<FlushResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    const flushTimeoutMs = assertInteger('flushTimeoutMs', options.flushTimeoutMs ?? this.defaults.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.flush(sandbox, { mountPath, flushTimeoutMs, timeoutMs: flushTimeoutMs + 30_000 });
    this.emit({ type: 'flush.done', sandboxId, mountPath, volumeId: guest.volumeId ?? undefined, message: guest.flushed ? 'flushed' : `pending ${guest.pending ?? 'unknown'}, errored ${guest.errored ?? 'unknown'}` });
    return { status: guest.flushed ? 'flushed' : 'pending', sandboxId, mountPath, volumeId: guest.volumeId, flushed: guest.flushed, pendingUploads: guest.pending, erroredUploads: guest.errored, mounted: guest.mounted };
  }

  /** {@link flush} every healthy managed mount in a sandbox. Stale mounts count as not flushed. */
  async flushAll(options: { sandboxId: string; flushTimeoutMs?: number }): Promise<FlushAllResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const listing = await this.listMounts({ sandboxId });
    const results: Array<FlushResult | MountFailure> = [];
    for (const mount of listing.mounts) {
      if (mount.status !== 'mounted' || mount.mountPath === null) {
        results.push(mountFailure(sandboxId, mount, 'MOUNT_STALE', 'No running uploader: reattach the volume (restoreMounts) before flushing.'));
        continue;
      }
      try {
        results.push(await this.flush({ sandboxId, mountPath: mount.mountPath, ...(options.flushTimeoutMs === undefined ? {} : { flushTimeoutMs: options.flushTimeoutMs }) }));
      } catch (error) {
        results.push(mountFailure(sandboxId, mount, error instanceof VolumeError ? error.code : 'UNKNOWN', error instanceof Error ? error.message : String(error)));
      }
    }
    return { sandboxId, flushed: results.every((result) => result.status !== 'failed' && result.flushed), results };
  }

  /**
   * Every mount this library manages in a sandbox, healthy or stale, plus rclone
   * mounts it did not create. A point-in-time view: no locks are taken, so it
   * also shows upload progress while a detach or flush runs.
   */
  async listMounts(options: ListMountsOptions): Promise<MountListing> {
    return (await this.listMountsWithState(options)).listing;
  }

  private async listMountsWithState(options: ListMountsOptions): Promise<{ listing: MountListing; states: Map<string, Record<string, unknown>> }> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const timeoutMs = assertInteger('timeoutMs', options.timeoutMs ?? this.defaults.inspectTimeoutMs, 1000, MAX_EXEC_MS);
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest: GuestMountListing = await this.backend.listMounts(sandbox, { timeoutMs });
    const states = new Map<string, Record<string, unknown>>();
    const mounts = guest.mounts.map((mount): MountSummary => {
      const state = mount.state ?? {};
      if (mount.state) states.set(mount.mountId, mount.state);
      return {
        status: mount.mounted && mount.alive ? 'mounted' : 'stale',
        mountPath: mountPathOrNull(state.mountPath),
        volumeId: typeof state.volumeId === 'string' ? state.volumeId : null,
        subpath: typeof state.subpath === 'string' ? state.subpath : null,
        readOnly: mount.readOnly ?? (typeof state.readOnly === 'boolean' ? state.readOnly : null),
        exclusive: typeof state.exclusive === 'boolean' ? state.exclusive : mount.state ? false : null,
        mountId: mount.mountId,
        pid: mount.alive ? mount.pid : null,
        startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
        uploads: mount.stats ? { queued: mount.stats.uploadsQueued, inProgress: mount.stats.uploadsInProgress, errored: mount.stats.erroredFiles } : null,
        cacheBytes: mount.stats ? mount.stats.cacheBytes : null,
        credentialsExpireAt: typeof state.credentialsExpireAt === 'string' ? state.credentialsExpireAt : null,
      };
    });
    mounts.sort((a, b) => (a.mountPath ?? '').localeCompare(b.mountPath ?? '') || a.mountId.localeCompare(b.mountId));
    return { listing: { sandboxId, mounts, unmanaged: [...guest.unmanaged].sort() }, states };
  }

  /**
   * Detach every managed mount in a sandbox, one after another, before the VM
   * is deleted or snapshotted. Never throws for an individual mount: failures
   * are reported in `results`, with their recovery data retained, and
   * `flushed` is true only when nothing unflushed is left behind.
   */
  async detachAll(options: DetachAllOptions): Promise<DetachAllResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    if (options.flushTimeoutMs !== undefined) assertInteger('flushTimeoutMs', options.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000);
    const listing = await this.listMounts({ sandboxId });
    const results: Array<DetachResult | DetachFailure> = [];
    for (const mount of listing.mounts) {
      if (mount.mountPath === null) {
        results.push(mountFailure(sandboxId, mount, 'MOUNT_STALE', `State record ${mount.mountId} has no valid mount path; inspect ${this.backend.paths.stateRoot}/mounts/${mount.mountId} in the sandbox.`));
        continue;
      }
      const detachOptions: DetachVolumeOptions = { sandboxId, mountPath: mount.mountPath, force: options.force === true };
      if (options.flushTimeoutMs !== undefined) detachOptions.flushTimeoutMs = options.flushTimeoutMs;
      try {
        results.push(await this.detach(detachOptions));
      } catch (error) {
        results.push(mountFailure(sandboxId, mount, error instanceof VolumeError ? error.code : 'UNKNOWN', error instanceof Error ? error.message : String(error)));
      }
    }
    const flushed = results.every((result) => result.status === 'absent' || (result.status === 'detached' && result.flushed));
    return { sandboxId, flushed, results, unmanaged: listing.unmanaged };
  }

  /**
   * Mount again every stale managed mount in a sandbox, with the options it
   * was attached with, after a VM stop/start or a crash. The retained cache is
   * reused, so uploads that were pending resume. Mounts left by a forced detach
   * are restored too; detach them normally afterwards if they are not wanted.
   */
  async restoreMounts(options: RestoreMountsOptions): Promise<RestoreMountsResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const { listing, states } = await this.listMountsWithState({ sandboxId });
    const result: RestoreMountsResult = { sandboxId, restored: [], alreadyMounted: [], failed: [] };
    for (const mount of listing.mounts) {
      if (mount.status === 'mounted') {
        if (mount.mountPath !== null) result.alreadyMounted.push(mount.mountPath);
        continue;
      }
      if (mount.mountPath === null || mount.volumeId === null) {
        result.failed.push(mountFailure(sandboxId, mount, 'MOUNT_STALE', `State record ${mount.mountId} is unreadable; inspect ${this.backend.paths.stateRoot}/mounts/${mount.mountId} in the sandbox.`));
        continue;
      }
      const state = states.get(mount.mountId) ?? {};
      const attachOptions: AttachVolumeOptions = { ...restoredOptions(state.options), sandboxId, volumeId: mount.volumeId, mountPath: mount.mountPath, readOnly: mount.readOnly === true };
      if (mount.subpath !== null) attachOptions.subpath = mount.subpath;
      if (mount.exclusive === true && mount.readOnly !== true) attachOptions.exclusive = true;
      try {
        try {
          result.restored.push(await this.attach(attachOptions));
        } catch (error) {
          const detail = isVolumeError(error, 'MOUNT_PATH_IN_USE') ? guestErrorDetail(error) : undefined;
          if (detail === 'stale-mount-requires-detach') {
            // A crashed mount left a dead FUSE entry: remove it, keeping cache and state, then mount again.
            await this.detach({ sandboxId, mountPath: mount.mountPath, force: true });
          } else if (detail === 'existing-process-requires-detach') {
            // An unmounted uploader is still draining: let it finish (verified), then mount again.
            await this.detach({ sandboxId, mountPath: mount.mountPath });
          } else {
            throw error;
          }
          result.restored.push(await this.attach(attachOptions));
        }
      } catch (error) {
        result.failed.push(mountFailure(sandboxId, mount, error instanceof VolumeError ? error.code : 'UNKNOWN', error instanceof Error ? error.message : String(error)));
      }
    }
    return result;
  }

  /**
   * Delete the recovery state and write cache that a forced or failed detach
   * kept for a mount path. Every write in that cache that never reached the
   * bucket is lost, so `confirm` must repeat the mount path. Refuses while the
   * path is mounted or its uploader runs; removes the mount's advisory
   * attachment record and releases its exclusive lease.
   */
  async discardMount(options: DiscardMountOptions): Promise<DiscardMountResult> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const mountPath = assertMountPath(options.mountPath);
    if (options.confirm !== mountPath) {
      throw new VolumeError('CONFIRMATION_REQUIRED', `Refusing to discard ${mountPath}: pass { confirm: "${mountPath}" } to confirm deleting writes that may never have reached the bucket.`);
    }
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.discard(sandbox, { mountPath, timeoutMs: this.defaults.inspectTimeoutMs });
    const warnings: string[] = [];
    if (guest.status === 'discarded' && guest.volumeId && guest.mountId) {
      await this.registry.removeAttachment(guest.volumeId, sandboxId, guest.mountId).catch((error: unknown) => {
        warnings.push(`The advisory attachment record could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      });
      await this.registry.releaseLease(guest.volumeId, { sandboxId, mountId: guest.mountId }).catch((error: unknown) => {
        warnings.push(`The exclusive lease could not be released: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.emit({ type: 'mount.discarded', sandboxId, mountPath, volumeId: guest.volumeId, message: `${guest.cacheBytes ?? 'unknown'} bytes of cache deleted` });
    }
    return { status: guest.status, sandboxId, mountPath, volumeId: guest.volumeId, discardedCacheBytes: guest.cacheBytes, warnings };
  }

  /**
   * Preflight the bucket from this process: reachability, listing, atomic
   * conditional creation, read-back and delete, using one short-lived probe
   * object under `<prefix>/_doctor/`. Never throws for a failed check.
   */
  async checkStorage(): Promise<CheckReport> {
    const checks: CheckResult[] = await this.registry.checkStore();
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }

  /**
   * Preflight a sandbox without changing it: CPU, root, /dev/fuse, fusermount,
   * flock and rclone (or whether attach can install them), whether the sandbox
   * can reach the bucket with the credentials a mount would get, and cache disk space.
   */
  async checkSandbox(options: CheckSandboxOptions): Promise<CheckReport> {
    const sandboxId = assertSandboxId(options.sandboxId);
    const timeoutMs = assertInteger('timeoutMs', options.timeoutMs ?? 120_000, 1000, MAX_EXEC_MS);
    const credentials = await this.sandboxEnv({ purpose: 'check', sandboxId, keyPrefix: this.storage.prefix, readOnly: true, volumeId: null, subpath: null, mountPath: null });
    const sandbox = await this.sandboxes.get(sandboxId);
    const guest = await this.backend.check(sandbox, credentials.env, {
      remotePath: `${RCLONE_REMOTE}:${this.storage.bucket}/${this.storage.prefix}`,
      endpointUrl: this.storage.sandboxEndpoint ?? `https://s3.${this.storage.region}.amazonaws.com`,
      timeoutMs,
    });
    const checks = guest.map((check): CheckResult => {
      const hint = SANDBOX_CHECK_HINTS[`${check.name}:${check.status}`];
      return hint === undefined ? check : { ...check, hint };
    });
    return { ok: checks.every((check) => check.status !== 'fail'), checks };
  }
}

function mountFailure(sandboxId: string, mount: Pick<MountSummary, 'mountPath' | 'volumeId'>, code: string, message: string): MountFailure {
  return { status: 'failed', sandboxId, mountPath: mount.mountPath, volumeId: mount.volumeId, flushed: false, pendingUploads: null, warnings: [], error: { code, message } };
}

/** The guest's reason for a refused mount, e.g. `stale-mount-requires-detach`. */
function guestErrorDetail(error: VolumeError): string | undefined {
  const guestError = error.details.guestError;
  if (guestError !== null && typeof guestError === 'object' && typeof (guestError as { detail?: unknown }).detail === 'string') return (guestError as { detail: string }).detail;
  return undefined;
}

function savedOptions(settings: MountDefaults): SavedMountOptions {
  const saved: SavedMountOptions = { cacheMode: settings.cacheMode, writeBackSeconds: settings.writeBackSeconds, dirCacheSeconds: settings.dirCacheSeconds, allowOther: settings.allowOther };
  for (const key of ['uid', 'gid', 'umask', 'cacheMaxSize', 'cacheMinFreeSpace', 'bufferSize', 'readAhead', 'readChunkSize', 'readChunkSizeLimit', 'transfers'] as const) {
    if (settings[key] !== undefined) (saved as Record<string, unknown>)[key] = settings[key];
  }
  return saved;
}

/** Mount options from a guest state record. Unknown or malformed fields are dropped; attach validates the rest. */
function restoredOptions(value: unknown): Partial<AttachVolumeOptions> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['cacheMode', 'writeBackSeconds', 'dirCacheSeconds', 'allowOther', 'uid', 'gid', 'umask', 'cacheMaxSize', 'cacheMinFreeSpace', 'bufferSize', 'readAhead', 'readChunkSize', 'readChunkSizeLimit', 'transfers']) {
    const entry = source[key];
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') out[key] = entry;
  }
  return out as Partial<AttachVolumeOptions>;
}

function mountPathOrNull(value: unknown): string | null {
  try {
    return assertMountPath(value);
  } catch {
    return null;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

function validateDefaults(input: MountDefaults & Record<string, unknown>): MountDefaults {
  if (input.cacheMode !== 'writes' && input.cacheMode !== 'full') {
    throw new VolumeError('VALIDATION', `cacheMode must be "writes" or "full", got ${JSON.stringify(input.cacheMode)}.`);
  }
  const out: MountDefaults = {
    cacheMode: input.cacheMode,
    writeBackSeconds: assertInteger('writeBackSeconds', input.writeBackSeconds, 0, 3600),
    dirCacheSeconds: assertInteger('dirCacheSeconds', input.dirCacheSeconds, 0, 86_400),
    allowOther: input.allowOther === true,
    readyTimeoutMs: assertInteger('readyTimeoutMs', input.readyTimeoutMs, 1000, MAX_EXEC_MS - 30_000),
    flushTimeoutMs: assertInteger('flushTimeoutMs', input.flushTimeoutMs, 1000, MAX_EXEC_MS - 40_000),
    bootstrapTimeoutMs: assertInteger('bootstrapTimeoutMs', input.bootstrapTimeoutMs, 1000, MAX_EXEC_MS),
    inspectTimeoutMs: assertInteger('inspectTimeoutMs', input.inspectTimeoutMs, 1000, MAX_EXEC_MS),
  };
  if (input.uid !== undefined) out.uid = assertInteger('uid', input.uid, 0, 4_294_967_294);
  if (input.gid !== undefined) out.gid = assertInteger('gid', input.gid, 0, 4_294_967_294);
  if (input.umask !== undefined) out.umask = assertUmask(input.umask);
  if (input.cacheMaxSize !== undefined) out.cacheMaxSize = assertCacheSize(input.cacheMaxSize);
  if (input.cacheMinFreeSpace !== undefined) out.cacheMinFreeSpace = assertCacheSize(input.cacheMinFreeSpace, 'cacheMinFreeSpace');
  if (input.bufferSize !== undefined) out.bufferSize = assertRcloneSize('bufferSize', input.bufferSize);
  if (input.readAhead !== undefined) out.readAhead = assertRcloneSize('readAhead', input.readAhead);
  if (input.readChunkSize !== undefined) out.readChunkSize = assertRcloneSize('readChunkSize', input.readChunkSize);
  if (input.readChunkSizeLimit !== undefined) out.readChunkSizeLimit = assertRcloneSize('readChunkSizeLimit', input.readChunkSizeLimit, true);
  if (input.transfers !== undefined) out.transfers = assertInteger('transfers', input.transfers, 1, 64);
  return out;
}

export { DEFAULT_GUEST_PATHS };
export type { Volume, AttachmentRecord, LeaseRecord, ReconcileReport, StaleRecordCleanup, VolumeUsage };
export type { CloneVolumeOptions, CloneResult, ListVolumesOptions };
