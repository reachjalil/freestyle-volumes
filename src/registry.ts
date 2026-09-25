/**
 * Volume registry: metadata records and per-volume data prefixes in the
 * bucket. Volume ids are their names; conditional writes arbitrate concurrent
 * creation and stored data prefixes must match the namespace and volume exactly.
 *
 * Layout under `<prefix>/`:
 *   _volumes/<id>.json                       volume record
 *   _attachments/<id>/<sandbox>__<mount>.json advisory attachment records
 *   v/<id>/...                               the volume's data (mounted by rclone)
 *   v2/<id>/<generation>/...                 isolated data for new volumes
 *   _operations/<operationId>.json           immutable clone ownership intent
 *   _leases/<id>.json                        exclusive-writer lease, taken with a conditional create
 *   _deleting/<id>.json                      written before a delete starts; attaches refuse while it matches
 *   _doctor/<uuid>.json                      short-lived probe written and deleted by checkStore
 */
import { VolumeAlreadyExistsError, VolumeError, VolumeNotFoundError, ValidationError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { MAX_MULTIPART_COPY_BYTES, childPrefixes, type ObjectStore, type ObjectSummary } from './storage.js';
import { assertInteger, assertVolumeName } from './validate.js';

export interface Volume {
  /** Same as `name`. Volumes are addressed by name, like Daytona's `volume.get(name)`. */
  id: string;
  name: string;
  createdAt: string;
  labels: Record<string, string>;
  backend: 'rclone-s3';
  /** Bucket key prefix holding this volume's data, without trailing slash. */
  dataPrefix: string;
  /** Absent only for legacy v1 records. */
  generation?: string;
}

export interface CloneVolumeOptions {
  sourceVolumeId: string;
  name: string;
  labels?: Record<string, string>;
  /** Advisory override, not a snapshot: concurrent writers/attachments are not locked out. */
  allowLiveSource?: boolean;
  /** Maximum in-flight server-side copies, default 8 (1–64). */
  concurrency?: number;
  /** Manifest object budget, default/cap 100,000; integer 1–100,000. Checked before any copies start. */
  maxObjects?: number;
  /** UTF-8 JSON manifest budget (array of key/size/etag), default/cap 32 MiB; integer 2–33,554,432. */
  maxManifestBytes?: number;
}

export const MAX_CLONE_OBJECTS = 100_000;
export const MAX_CLONE_MANIFEST_BYTES = 32 * 1024 ** 2;
/** Error details only. `completed` means acknowledged copies were cleaned up;
 * any failed copy makes cleanup `uncertain`, because remote work can outlive its promise. */
export type CloneCleanupStatus = 'not-needed' | 'completed' | 'uncertain' | 'retained';

export interface CloneResult {
  volume: Volume;
  operationId: string;
  copiedObjects: number;
  copiedBytes: number;
}

export interface ListVolumesOptions {
  /** Maximum concurrent metadata reads, default 8 (1–64). */
  concurrency?: number;
  /**
   * Skip volume records that fail validation (corrupt JSON, wrong shape or data
   * prefix) instead of failing the whole listing. Storage errors still throw.
   */
  skipInvalid?: boolean;
  /** Called for every record skipped by `skipInvalid`. */
  onInvalid?: (name: string, error: VolumeError) => void;
}

/** Holder of a volume's exclusive-writer lease. */
export interface LeaseRecord {
  volumeId: string;
  /** Generation the lease was taken on; null for legacy v1 volumes. A lease from an earlier generation of the same name is stale. */
  generation: string | null;
  sandboxId: string;
  mountId: string;
  mountPath: string;
  acquiredAt: string;
}

export interface VolumeUsage {
  volumeId: string;
  dataPrefix: string;
  /** Objects under the data prefix, directory markers included. */
  objects: number;
  bytes: number;
  /** Zero-byte `dir/` objects rclone keeps for directories. */
  directoryMarkers: number;
}

/** Data of a generation that no published volume record points at, typically left by a failed clone. */
export interface OrphanGeneration {
  volumeId: string;
  generation: string;
  objects: number;
  bytes: number;
  /** The clone operation that owns this generation, when its intent record exists. */
  operationId: string | null;
  /** When that operation started, from its intent record. */
  startedAt: string | null;
}

export interface ReconcileReport {
  prefix: string;
  checkedAt: string;
  volumes: number;
  /** Unpublished v2 generations: candidates for `removeOrphanGeneration` once no clone can still publish them. */
  orphanGenerations: OrphanGeneration[];
  /** Legacy `v/<name>/` data without a v1 record. Reported only; remove it with your own S3 tooling. */
  orphanLegacyData: Array<{ volumeId: string; objects: number; bytes: number }>;
  /** Clone intents; `published` when the destination record points at the operation's generation. */
  operations: Array<{ operationId: string; volumeId: string | null; status: 'published' | 'unpublished' | 'unreadable'; startedAt: string | null }>;
  /** Deleting markers. `volumeExists: true` means a delete is running or was interrupted: run it again to finish. */
  deletingMarkers: Array<{ volumeId: string; generation: string | null; volumeExists: boolean }>;
  /** Leases whose volume is gone or was recreated. */
  staleLeases: LeaseRecord[];
  /** Attachment records of volumes that no longer exist. */
  staleAttachments: AttachmentRecord[];
  /** Probe objects that an interrupted `checkStorage` left behind. */
  doctorProbes: string[];
  /** Volume records that failed validation. */
  invalidRecords: Array<{ volumeId: string; error: string }>;
}

export interface StaleRecordCleanup {
  leases: number;
  deletingMarkers: number;
  attachments: number;
  doctorProbes: number;
}

/** Advisory record of an attachment. Written on attach, removed on detach; can be stale if a sandbox died. */
export interface AttachmentRecord {
  volumeId: string;
  sandboxId: string;
  mountId: string;
  mountPath: string;
  subpath: string | null;
  readOnly: boolean;
  attachedAt: string;
}

const RECORD_VERSION = 1;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;

/** One result of {@link VolumeRegistry.checkStore}. */
export interface StoreCheck {
  name: string;
  status: 'ok' | 'fail';
  detail: string;
  hint?: string;
}

/** Storage errors are already sanitized; never include credentials here. */
function describeError(error: unknown): string {
  if (error instanceof VolumeError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function validateLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (labels !== undefined && !isRecord(labels)) throw new ValidationError('Labels must be an object of strings.');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!LABEL_KEY.test(key)) throw new ValidationError(`Invalid label key ${JSON.stringify(key)}.`);
    if (typeof value !== 'string' || value.length > 256) throw new ValidationError(`Label ${key} must be a string of at most 256 characters.`);
    out[key] = value;
  }
  if (Object.keys(out).length > 32) throw new ValidationError('At most 32 labels are allowed.');
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-8 length of JSON.stringify(value), without allocating its escaped copy.
 * Stop once over budget, including escapes and lone-surrogate encoding. */
function jsonStringBytes(value: string, budget: number): number {
  let bytes = 2; // Quotes.
  for (let i = 0; i < value.length && bytes <= budget; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

function parseVolume(body: string, expectedId: string, expectedPrefix: string, generationRoot: string): Volume {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" is not valid JSON.`, { cause: error, details: { invalidRecord: true, volumeId: expectedId } });
  }
  const validPrefix = isRecord(parsed) && (
    (parsed.version === 1 && parsed.generation === undefined && parsed.dataPrefix === expectedPrefix) ||
    (parsed.version === 2 && typeof parsed.generation === 'string' && GENERATION.test(parsed.generation) &&
      parsed.dataPrefix === `${generationRoot}/${parsed.generation}`));
  if (!isRecord(parsed) || !validPrefix || parsed.id !== expectedId || parsed.name !== expectedId ||
      parsed.backend !== 'rclone-s3' || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !isRecord(parsed.labels) || typeof parsed.dataPrefix !== 'string') {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" has an unexpected shape or data prefix.`, { details: { invalidRecord: true, volumeId: expectedId } });
  }
  let labels: Record<string, string>;
  try {
    labels = validateLabels(parsed.labels as Record<string, string>);
  } catch (error) {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" has invalid labels.`, { cause: error, details: { invalidRecord: true, volumeId: expectedId } });
  }
  return {
    id: parsed.id,
    name: parsed.name,
    createdAt: parsed.createdAt,
    labels,
    backend: 'rclone-s3',
    dataPrefix: parsed.dataPrefix,
    ...(parsed.version === 2 ? { generation: parsed.generation as string } : {}),
  };
}

export class VolumeRegistry {
  constructor(
    private readonly store: ObjectStore,
    readonly prefix: string,
  ) {}

  volumeKey(id: string): string {
    return `${this.prefix}/_volumes/${id}.json`;
  }

  /** Legacy v1 when generation is omitted. Mount existing volumes using their validated stored dataPrefix. */
  dataPrefix(id: string, subpath?: string, generation?: string): string {
    const root = generation === undefined ? `${this.prefix}/v/${id}` : `${this.prefix}/v2/${id}/${generation}`;
    return subpath ? `${root}/${subpath}` : root;
  }

  attachmentKey(volumeId: string, sandboxId: string, mountId: string): string {
    return `${this.prefix}/_attachments/${volumeId}/${sandboxId}__${mountId}.json`;
  }

  leaseKey(volumeId: string): string {
    return `${this.prefix}/_leases/${volumeId}.json`;
  }

  deletingKey(volumeId: string): string {
    return `${this.prefix}/_deleting/${volumeId}.json`;
  }

  async create(input: { name: string; labels?: Record<string, string> }, options: { ifNotExists?: boolean } = {}): Promise<Volume> {
    return (await this.createWithStatus(input, options)).volume;
  }

  /** Like {@link create}, and reports whether this call wrote the record (false when `ifNotExists` returned an existing volume). */
  async createWithStatus(input: { name: string; labels?: Record<string, string> }, options: { ifNotExists?: boolean } = {}): Promise<{ volume: Volume; created: boolean }> {
    const name = assertVolumeName(input.name);
    const labels = validateLabels(input.labels);
    const existing = await this.find(name);
    if (existing) {
      if (options.ifNotExists) return { volume: existing, created: false };
      throw new VolumeAlreadyExistsError(name);
    }
    const generation = randomUUID();
    const volume: Volume = { id: name, name, createdAt: new Date().toISOString(), labels, backend: 'rclone-s3', generation, dataPrefix: this.dataPrefix(name, undefined, generation) };
    if (typeof this.store.putObjectIfAbsent !== 'function') {
      throw new VolumeError('STORAGE_ERROR', 'Volume creation requires an object store with atomic putObjectIfAbsent support.');
    }
    if (!await this.store.putObjectIfAbsent(this.volumeKey(name), JSON.stringify({ version: 2, ...volume }))) {
      if (!options.ifNotExists) throw new VolumeAlreadyExistsError(name);
      const winner = await this.find(name);
      if (!winner) throw new VolumeError('STORAGE_ERROR', `Volume "${name}" disappeared after a concurrent create. Retry the operation.`);
      return { volume: winner, created: false };
    }
    return { volume, created: true };
  }

  /** The volume's exclusive-writer lease for its current generation, if any. Leases of an earlier generation are ignored. */
  async getLease(volume: Pick<Volume, 'id' | 'generation'>): Promise<LeaseRecord | undefined> {
    const lease = await this.readLease(volume.id);
    return lease !== undefined && lease.generation === (volume.generation ?? null) ? lease : undefined;
  }

  private async readLease(volumeId: string): Promise<LeaseRecord | undefined> {
    const body = await this.store.getObject(this.leaseKey(assertVolumeName(volumeId)));
    if (body === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed) || parsed.volumeId !== volumeId || typeof parsed.sandboxId !== 'string' || typeof parsed.mountId !== 'string' ||
        typeof parsed.mountPath !== 'string' || typeof parsed.acquiredAt !== 'string' || (parsed.generation !== null && typeof parsed.generation !== 'string')) {
      // Fail closed: an unreadable lease still blocks writers until someone releases it on purpose.
      throw new VolumeError('VOLUME_IN_USE', `The exclusive lease of volume "${volumeId}" is unreadable.`, {
        hint: 'Release it with releaseLease({ volumeId, confirm: volumeId }) once no writer holds the volume.',
        details: { volumeId, key: this.leaseKey(volumeId) },
      });
    }
    return { volumeId, generation: parsed.generation as string | null, sandboxId: parsed.sandboxId, mountId: parsed.mountId, mountPath: parsed.mountPath, acquiredAt: parsed.acquiredAt };
  }

  /**
   * Take the exclusive-writer lease with a conditional create. Idempotent for
   * the same holder; a lease left by an earlier generation of the same name is
   * replaced. Throws VOLUME_IN_USE while another mount holds it.
   */
  async acquireLease(lease: LeaseRecord): Promise<{ acquired: boolean; lease: LeaseRecord }> {
    const key = this.leaseKey(assertVolumeName(lease.volumeId));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.store.putObjectIfAbsent(key, JSON.stringify({ version: 1, ...lease }))) return { acquired: true, lease };
      const existing = await this.readLease(lease.volumeId);
      if (existing === undefined) continue; // Released between the two calls.
      if (existing.sandboxId === lease.sandboxId && existing.mountId === lease.mountId && existing.generation === lease.generation) {
        return { acquired: false, lease: existing };
      }
      if (existing.generation !== lease.generation) {
        // The volume was deleted and recreated since this lease was taken.
        await this.store.deleteObject(key);
        continue;
      }
      throw new VolumeError('VOLUME_IN_USE', `Volume "${lease.volumeId}" is attached exclusively at ${existing.sandboxId}:${existing.mountPath}.`, {
        hint: 'Detach it there first. If that VM is gone, release the lease with releaseLease({ volumeId, confirm: volumeId }).',
        details: { lease: existing },
      });
    }
    throw new VolumeError('VOLUME_IN_USE', `The exclusive lease of volume "${lease.volumeId}" changed while it was being taken. Retry the attach.`);
  }

  /**
   * Remove the lease. With `holder`, only when that mount still holds it, so a
   * detach never releases someone else's lease. Returns whether a lease was removed.
   */
  async releaseLease(volumeId: string, holder?: { sandboxId: string; mountId: string }): Promise<boolean> {
    const key = this.leaseKey(assertVolumeName(volumeId));
    if (holder !== undefined) {
      const existing = await this.readLease(volumeId);
      if (existing === undefined || existing.sandboxId !== holder.sandboxId || existing.mountId !== holder.mountId) return false;
    } else if ((await this.store.getObject(key)) === undefined) {
      return false;
    }
    await this.store.deleteObject(key);
    return true;
  }

  /** True while a delete of this generation is running or was interrupted. */
  async isDeleting(volume: Pick<Volume, 'id' | 'generation'>): Promise<boolean> {
    const marker = await this.readDeletingMarker(volume.id);
    return marker !== undefined && marker.generation === (volume.generation ?? null);
  }

  private async readDeletingMarker(volumeId: string): Promise<{ generation: string | null } | undefined> {
    const body = await this.store.getObject(this.deletingKey(volumeId));
    if (body === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed) && (parsed.generation === null || typeof parsed.generation === 'string')) return { generation: parsed.generation as string | null };
    } catch {
      // An unreadable marker still means a delete started: treat it as current.
    }
    return { generation: null };
  }

  /** Throws VOLUME_DELETING when a delete of this generation has started. */
  async assertNotDeleting(volume: Pick<Volume, 'id' | 'generation'>): Promise<void> {
    if (await this.isDeleting(volume)) {
      throw new VolumeError('VOLUME_DELETING', `Volume "${volume.id}" is being deleted.`, {
        hint: 'Wait for the delete to finish. If it was interrupted, run delete again to finish it.',
        details: { volumeId: volume.id },
      });
    }
  }

  /** Object count and bytes under a volume's data prefix (one LIST request per 1,000 objects). */
  async usage(name: string): Promise<VolumeUsage> {
    const volume = await this.get(name);
    let objects = 0;
    let bytes = 0;
    let directoryMarkers = 0;
    for await (const object of this.store.listObjects(`${volume.dataPrefix}/`)) {
      objects += 1;
      bytes += object.size;
      if (object.key.endsWith('/') && object.size === 0) directoryMarkers += 1;
    }
    return { volumeId: volume.id, dataPrefix: volume.dataPrefix, objects, bytes, directoryMarkers };
  }

  /** Object-wise consistent copy, never a point-in-time snapshot. No guest or body downloads. */
  async clone(input: CloneVolumeOptions): Promise<CloneResult> {
    const operationId = randomUUID();
    let destinationPrefix: string | undefined;
    let publication: 'not-attempted' | 'unknown' | 'rejected' | 'published' = 'not-attempted';
    let copyStarted = false;
    let copyFailed = false;
    let completionUnknown = false;
    const multipartFailures: Record<string, unknown>[] = [];
    try {
      const name = assertVolumeName(input.name);
      const sourceId = assertVolumeName(input.sourceVolumeId);
      const labels = validateLabels(input.labels);
      const concurrency = assertInteger('concurrency', input.concurrency ?? 8, 1, 64);
      const maxObjects = assertInteger('maxObjects', input.maxObjects === undefined ? MAX_CLONE_OBJECTS : input.maxObjects, 1, MAX_CLONE_OBJECTS);
      const maxManifestBytes = assertInteger('maxManifestBytes', input.maxManifestBytes === undefined ? MAX_CLONE_MANIFEST_BYTES : input.maxManifestBytes, 2, MAX_CLONE_MANIFEST_BYTES);
      if (!this.store.copyObject) throw new VolumeError('UNSUPPORTED', 'This object store does not support conditional server-side copy.');
      if (typeof this.store.putObjectIfAbsent !== 'function') throw new VolumeError('UNSUPPORTED', 'Clone requires atomic conditional publication.');
      if (await this.find(name)) throw new VolumeAlreadyExistsError(name);
      const source = await this.get(sourceId);
      await this.assertNotDeleting(source);
      const attachments = await this.listAttachments(sourceId);
      const lease = await this.getLease(source);
      if ((attachments.length || lease) && input.allowLiveSource !== true) {
        throw new VolumeError('VOLUME_IN_USE', 'Clone source has recorded attachments or an exclusive writer.', {
          hint: 'Detach first or explicitly pass allowLiveSource: true. This check is advisory, not a snapshot or a lock against concurrent writers.',
          details: { attachments, ...(lease ? { lease } : {}) },
        });
      }
      const volume: Volume = { id: name, name, labels, backend: 'rclone-s3', createdAt: new Date().toISOString(), generation: operationId, dataPrefix: this.dataPrefix(name, undefined, operationId) };
      // Immutable durable ownership intent. Retained even on success; it is not
      // a cleanup lease, and neither its age nor its presence authorizes deletion.
      const operationKey = `${this.prefix}/_operations/${operationId}.json`;
      if (!await this.store.putObjectIfAbsent(operationKey, JSON.stringify({ version: 1, operationId, source, destination: volume }))) {
        throw new VolumeError('STORAGE_ERROR', 'Clone operation identity collision.');
      }
      destinationPrefix = volume.dataPrefix;
      const selected: ObjectSummary[] = [];
      let manifestBytes = 2; // JSON array brackets; entries include intervening commas.
      const budgetExceeded = (budget: 'maxObjects' | 'maxManifestBytes') => new ValidationError(`Clone selection exceeds ${budget}; no objects were copied or published.`, {
        details: { budget, maxObjects, maxManifestBytes, selectedObjects: selected.length, manifestBytes },
      });
      for await (const object of this.store.listObjects(`${source.dataPrefix}/`)) {
        if (selected.length >= maxObjects) throw budgetExceeded('maxObjects');
        if (!object.key.startsWith(`${source.dataPrefix}/`)) throw new VolumeError('STORAGE_ERROR', 'Source listing escaped its validated prefix.');
        assertInteger('source object size', object.size, 0, MAX_MULTIPART_COPY_BYTES);
        if (typeof object.etag !== 'string' || !object.etag) throw new VolumeError('UNSUPPORTED', 'Clone requires source ETags for every selected object.');
        // Count escaped UTF-8 bytes without serializing potentially enormous
        // keys/ETags. Retain only known fields, not arbitrary provider metadata.
        const remaining = maxManifestBytes - manifestBytes;
        const entry = { key: object.key, size: object.size, etag: object.etag };
        const overhead = Buffer.byteLength(JSON.stringify({ key: '', size: object.size, etag: '' })) - 4;
        const entryBytes = overhead + jsonStringBytes(object.key, remaining) + jsonStringBytes(object.etag, remaining) + (selected.length ? 1 : 0);
        if (entryBytes > remaining) throw budgetExceeded('maxManifestBytes');
        selected.push(entry);
        manifestBytes += entryBytes;
      }
      let next = 0;
      let failed = false;
      const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
        while (!failed && next < selected.length) {
          const object = selected[next++]!;
          try {
            copyStarted = true;
            await this.store.copyObject!(object.key, `${volume.dataPrefix}/${object.key.slice(source.dataPrefix.length + 1)}`, { size: object.size, sourceIfMatch: object.etag! });
          } catch (error) {
            failed = true;
            copyFailed = true;
            if (error instanceof VolumeError) {
              if (error.details.completionStatus === 'unknown') completionUnknown = true;
              if (error.details.uploadId !== undefined || error.details.stage === 'create') multipartFailures.push(error.details);
            }
            throw error;
          }
        }
      });
      const settled = await Promise.allSettled(workers);
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      // Any thrown publication outcome is ambiguous, including a failed read
      // afterwards. Never infer safety to delete from a later missing record.
      publication = 'unknown';
      if (!await this.store.putObjectIfAbsent(this.volumeKey(name), JSON.stringify({ version: 2, ...volume }))) {
        publication = 'rejected';
        throw new VolumeAlreadyExistsError(name);
      }
      publication = 'published';
      return { volume, operationId, copiedObjects: selected.length, copiedBytes: selected.reduce((sum, object) => sum + object.size, 0) };
    } catch (error) {
      let cleanupError: unknown;
      let cleanupStatus: CloneCleanupStatus = publication === 'unknown' || completionUnknown ? 'retained' : 'not-needed';
      if (!completionUnknown && copyStarted && destinationPrefix && (publication === 'not-attempted' || publication === 'rejected')) {
        // Settled client workers do not prove remote CopyObject requests stopped.
        // Cleanup is best effort, never a clean-state claim after a copy failure.
        cleanupStatus = copyFailed ? 'uncertain' : 'completed';
        try {
          let keys: string[] = [];
          for await (const object of this.store.listObjects(`${destinationPrefix}/`)) {
            if (!object.key.startsWith(`${destinationPrefix}/`)) throw new VolumeError('STORAGE_ERROR', 'Cleanup listing escaped operation prefix.');
            keys.push(object.key);
            if (keys.length === 1000) { await this.store.deleteObjects(keys); keys = []; }
          }
          await this.store.deleteObjects(keys);
        } catch (failure) { cleanupError = failure; cleanupStatus = 'uncertain'; }
      }
      throw new VolumeError(error instanceof VolumeError ? error.code : 'STORAGE_ERROR', 'Clone failed.', {
        cause: error,
        hint: completionUnknown ? 'Copy completion may have succeeded. Data and ownership intent are retained; reconcile the destination generation and unfinished uploads before retrying.'
          : publication === 'unknown' ? 'Publication may have succeeded. Data is retained; reconcile the destination generation before retrying.'
          : cleanupStatus === 'uncertain' ? 'Cleanup is uncertain: remote copies may complete after client failure, or cleanup may have failed. The ownership intent is retained; an empty listing does not prove cleanup is complete. Reconcile this operation manually; do not use age-based garbage collection.'
          : (error instanceof Error ? error.message : undefined),
        details: { ...(error instanceof VolumeError ? error.details : {}), operationId, destinationPrefix, publication, completionUnknown, multipartFailures, cleanupStatus, ...(cleanupError === undefined ? {} : { cleanupError }) },
      });
    }
  }

  async find(name: string): Promise<Volume | undefined> {
    const id = assertVolumeName(name);
    const body = await this.store.getObject(this.volumeKey(id));
    return body === undefined ? undefined : parseVolume(body, id, this.dataPrefix(id), `${this.prefix}/v2/${id}`);
  }

  async get(name: string): Promise<Volume> {
    const volume = await this.find(name);
    if (!volume) throw new VolumeNotFoundError(name);
    return volume;
  }

  async list(options: ListVolumesOptions = {}): Promise<Volume[]> {
    const concurrency = assertInteger('concurrency', options.concurrency ?? 8, 1, 64);
    const volumes: Volume[] = [];
    let names: string[] = [];
    const readBatch = async () => {
      const results = await Promise.allSettled(names.map(name => this.find(name)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          const error: unknown = result.reason;
          if (options.skipInvalid === true && error instanceof VolumeError && error.details.invalidRecord === true) {
            options.onInvalid?.(names[index]!, error);
            continue;
          }
          throw error;
        }
        if (result.value) volumes.push(result.value);
      }
      names = [];
    };
    const keyPrefix = `${this.prefix}/_volumes/`;
    for await (const object of this.store.listObjects(keyPrefix)) {
      if (!object.key.startsWith(keyPrefix)) continue;
      const match = /^([a-z0-9-]+)\.json$/.exec(object.key.slice(keyPrefix.length));
      if (!match || match[1] === undefined) continue;
      names.push(match[1]);
      if (names.length === concurrency) await readBatch();
    }
    await readBatch();
    return volumes.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Probe what the registry needs from the object store: the bucket, listing,
   * atomic conditional creation (the provider must reject `If-None-Match: *`
   * over an existing key), read-back and delete. Writes one probe object under
   * `_doctor/` and deletes it again. Stops after a failed bucket or list check.
   */
  async checkStore(): Promise<StoreCheck[]> {
    const checks: StoreCheck[] = [];
    const ok = (name: string, detail: string) => checks.push({ name, status: 'ok', detail });
    const fail = (name: string, detail: string, hint?: string) => checks.push(hint === undefined ? { name, status: 'fail', detail } : { name, status: 'fail', detail, hint });
    try {
      await this.store.headBucket();
      ok('bucket', 'The bucket exists and these credentials can reach it.');
    } catch (error) {
      fail('bucket', describeError(error));
      return checks;
    }
    try {
      for await (const _object of this.store.listObjects(`${this.prefix}/`, { limit: 1 })) break;
      ok('list', `Listing ${this.prefix}/ works.`);
    } catch (error) {
      fail('list', describeError(error), 'The credentials need ListBucket on the namespace prefix.');
      return checks;
    }
    const key = `${this.prefix}/_doctor/${randomUUID()}.json`;
    const first = JSON.stringify({ probe: 'freestyle-volumes', write: 1 });
    let written = false;
    try {
      if (!(await this.store.putObjectIfAbsent(key, first))) {
        fail('conditional-create', 'A new probe key was reported as already existing.');
      } else {
        written = true;
        if (await this.store.putObjectIfAbsent(key, JSON.stringify({ probe: 'freestyle-volumes', write: 2 }))) {
          fail('conditional-create', 'The store accepted a conditional create over an existing object: it does not enforce If-None-Match, so two clients creating one volume at once could overwrite each other.', 'Use a provider (or version) that rejects PutObject with If-None-Match: * when the key exists.');
        } else {
          ok('conditional-create', 'Conditional creates are enforced: a second create of the same key was rejected.');
        }
      }
    } catch (error) {
      fail('conditional-create', describeError(error), 'Creating volumes needs PutObject with If-None-Match: *; this provider or its configuration rejected it.');
    }
    if (written) {
      try {
        const body = await this.store.getObject(key);
        if (body === first) ok('read', 'The probe object read back unchanged.');
        else fail('read', body === undefined ? 'The probe object could not be read right after it was written.' : 'The probe object changed after it was written.');
      } catch (error) {
        fail('read', describeError(error));
      }
      try {
        await this.store.deleteObject(key);
        ok('delete', 'Deleting the probe object works.');
      } catch (error) {
        fail('delete', describeError(error), `Deleting volumes needs DeleteObject. Remove ${key} by hand.`);
      }
    }
    return checks;
  }

  /** Cheap reachability and permission check against a data prefix (one LIST call). */
  async precheck(dataPrefix: string): Promise<void> {
    for await (const _object of this.store.listObjects(`${dataPrefix}/`, { limit: 1 })) break;
  }

  /**
   * Attachment and lease checks are advisory, not a lock against concurrent
   * attach/create/delete. A deleting marker is written first, so attaches that
   * start after it refuse, and a delete interrupted halfway keeps refusing them
   * until it is run again.
   */
  async delete(name: string, options: { force?: boolean } = {}): Promise<{ deletedObjects: number; attachments: AttachmentRecord[] }> {
    const volume = await this.get(name);
    const attachments = await this.listAttachments(volume.id);
    const lease = await this.getLease(volume);
    if ((attachments.length > 0 || lease !== undefined) && !options.force) {
      const holders = [...attachments.map((a) => `${a.sandboxId}:${a.mountPath}`), ...(lease ? [`${lease.sandboxId}:${lease.mountPath} (exclusive)`] : [])];
      throw new VolumeError('VOLUME_IN_USE', `Volume "${volume.id}" is in use: ${holders.join(', ')}.`, {
        hint: 'Detach it from those sandboxes first. If the sandboxes are gone, pass { force: true } to delete anyway; attachment records are advisory and can be stale.',
        details: { attachments, ...(lease ? { lease } : {}) },
      });
    }
    await this.store.putObject(this.deletingKey(volume.id), JSON.stringify({ version: 1, volumeId: volume.id, generation: volume.generation ?? null, startedAt: new Date().toISOString() }));
    let deletedObjects = 0;
    let batch: string[] = [];
    for await (const object of this.store.listObjects(`${volume.dataPrefix}/`)) {
      batch.push(object.key);
      if (batch.length === 1000) {
        await this.store.deleteObjects(batch);
        deletedObjects += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.store.deleteObjects(batch);
      deletedObjects += batch.length;
    }
    for (const attachment of attachments) {
      await this.store.deleteObject(this.attachmentKey(volume.id, attachment.sandboxId, attachment.mountId));
    }
    if (lease !== undefined) await this.store.deleteObject(this.leaseKey(volume.id));
    await this.store.deleteObject(this.volumeKey(volume.id));
    // Last, so an interruption anywhere above leaves attaches refused.
    await this.store.deleteObject(this.deletingKey(volume.id));
    return { deletedObjects, attachments };
  }

  async putAttachment(record: AttachmentRecord): Promise<void> {
    await this.store.putObject(this.attachmentKey(record.volumeId, record.sandboxId, record.mountId), JSON.stringify({ version: RECORD_VERSION, ...record }));
  }

  async removeAttachment(volumeId: string, sandboxId: string, mountId: string): Promise<void> {
    await this.store.deleteObject(this.attachmentKey(volumeId, sandboxId, mountId));
  }

  async listAttachments(volumeId: string): Promise<AttachmentRecord[]> {
    const records: AttachmentRecord[] = [];
    for await (const object of this.store.listObjects(`${this.prefix}/_attachments/${assertVolumeName(volumeId)}/`)) {
      const body = await this.store.getObject(object.key);
      if (body === undefined) continue;
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed) && parsed.version === RECORD_VERSION && parsed.volumeId === volumeId &&
            typeof parsed.sandboxId === 'string' && !/[\/\0]/.test(parsed.sandboxId) && parsed.sandboxId.length > 0 &&
            typeof parsed.mountPath === 'string' && typeof parsed.mountId === 'string' &&
            !/[\/\0]/.test(parsed.mountId) && parsed.mountId.length > 0 &&
            (parsed.subpath === null || typeof parsed.subpath === 'string') && typeof parsed.readOnly === 'boolean' &&
            typeof parsed.attachedAt === 'string' && object.key === this.attachmentKey(volumeId, parsed.sandboxId, parsed.mountId)) {
          records.push({
            volumeId,
            sandboxId: parsed.sandboxId,
            mountId: parsed.mountId,
            mountPath: parsed.mountPath,
            subpath: parsed.subpath,
            readOnly: parsed.readOnly,
            attachedAt: parsed.attachedAt,
          });
        }
      } catch {
        // A corrupt advisory record is ignored rather than blocking deletes.
      }
    }
    return records;
  }

  /**
   * Read-only survey of the namespace for leftovers: unpublished generations
   * (typically failed clones), legacy data without a record, clone intents and
   * their outcome, interrupted deletes, stale leases and attachment records,
   * and doctor probes. Lists "directories" with one request per 1,000 entries
   * and counts objects only under generations that no record points at.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      prefix: this.prefix, checkedAt: new Date().toISOString(), volumes: 0, orphanGenerations: [], orphanLegacyData: [],
      operations: [], deletingMarkers: [], staleLeases: [], staleAttachments: [], doctorProbes: [], invalidRecords: [],
    };
    const records = new Map<string, Volume>();
    await this.list({ skipInvalid: true, onInvalid: (name, error) => report.invalidRecords.push({ volumeId: name, error: error.message }) })
      .then((volumes) => volumes.forEach((volume) => records.set(volume.id, volume)));
    report.volumes = records.size;
    const invalid = new Set(report.invalidRecords.map((entry) => entry.volumeId));
    const intents = new Map<string, { volumeId: string | null; startedAt: string | null }>();
    for await (const object of this.store.listObjects(`${this.prefix}/_operations/`)) {
      const operationId = /\/([^/]+)\.json$/.exec(object.key)?.[1];
      if (operationId === undefined || !GENERATION.test(operationId)) continue;
      let volumeId: string | null = null;
      let startedAt: string | null = null;
      let readable = false;
      try {
        const parsed: unknown = JSON.parse((await this.store.getObject(object.key)) ?? '');
        if (isRecord(parsed) && isRecord(parsed.destination) && typeof parsed.destination.id === 'string') {
          volumeId = parsed.destination.id;
          startedAt = typeof parsed.destination.createdAt === 'string' ? parsed.destination.createdAt : null;
          readable = true;
        }
      } catch {
        readable = false;
      }
      intents.set(operationId, { volumeId, startedAt });
      const published = volumeId !== null && records.get(volumeId)?.generation === operationId;
      report.operations.push({ operationId, volumeId, status: !readable ? 'unreadable' : published ? 'published' : 'unpublished', startedAt });
    }
    for await (const namePrefix of childPrefixes(this.store, `${this.prefix}/v2/`)) {
      const volumeId = namePrefix.slice(`${this.prefix}/v2/`.length, -1);
      if (invalid.has(volumeId)) continue; // Its published generation is unknown: never call its data orphaned.
      for await (const generationPrefix of childPrefixes(this.store, namePrefix)) {
        const generation = generationPrefix.slice(namePrefix.length, -1);
        if (records.get(volumeId)?.generation === generation) continue;
        const counted = await this.count(generationPrefix);
        const intent = intents.get(generation);
        report.orphanGenerations.push({ volumeId, generation, ...counted, operationId: intent ? generation : null, startedAt: intent?.startedAt ?? null });
      }
    }
    for await (const namePrefix of childPrefixes(this.store, `${this.prefix}/v/`)) {
      const volumeId = namePrefix.slice(`${this.prefix}/v/`.length, -1);
      if (invalid.has(volumeId)) continue;
      const record = records.get(volumeId);
      if (record !== undefined && record.generation === undefined) continue;
      report.orphanLegacyData.push({ volumeId, ...(await this.count(namePrefix)) });
    }
    for await (const object of this.store.listObjects(`${this.prefix}/_deleting/`)) {
      const volumeId = /\/([a-z0-9-]+)\.json$/.exec(object.key)?.[1];
      if (volumeId === undefined) continue;
      const marker = await this.readDeletingMarker(volumeId);
      const record = records.get(volumeId);
      report.deletingMarkers.push({ volumeId, generation: marker?.generation ?? null, volumeExists: record !== undefined && (record.generation ?? null) === (marker?.generation ?? null) });
    }
    for await (const object of this.store.listObjects(`${this.prefix}/_leases/`)) {
      const volumeId = /\/([a-z0-9-]+)\.json$/.exec(object.key)?.[1];
      if (volumeId === undefined) continue;
      let lease: LeaseRecord | undefined;
      try {
        lease = await this.readLease(volumeId);
      } catch {
        continue; // Unreadable leases are reported by attach and released on purpose, never swept.
      }
      const record = records.get(volumeId);
      if (lease !== undefined && (record === undefined || (record.generation ?? null) !== lease.generation) && !invalid.has(volumeId)) report.staleLeases.push(lease);
    }
    for await (const namePrefix of childPrefixes(this.store, `${this.prefix}/_attachments/`)) {
      const volumeId = namePrefix.slice(`${this.prefix}/_attachments/`.length, -1);
      if (records.has(volumeId) || invalid.has(volumeId)) continue;
      try {
        report.staleAttachments.push(...(await this.listAttachments(volumeId)));
      } catch {
        // Not a valid volume name: nothing this library wrote.
      }
    }
    for await (const object of this.store.listObjects(`${this.prefix}/_doctor/`)) report.doctorProbes.push(object.key);
    return report;
  }

  private async count(prefix: string): Promise<{ objects: number; bytes: number }> {
    let objects = 0;
    let bytes = 0;
    for await (const object of this.store.listObjects(prefix)) {
      objects += 1;
      bytes += object.size;
    }
    return { objects, bytes };
  }

  /**
   * Delete one unpublished generation found by {@link reconcile}, plus its clone
   * intent. `confirm` must be `<volumeId>/<generation>`. Refuses the published
   * generation, and generations whose clone started less than `minAgeSeconds`
   * ago (default one day), because a slow clone could still publish them.
   */
  async removeOrphanGeneration(options: { volumeId: string; generation: string; confirm: string; minAgeSeconds?: number }): Promise<{ deletedObjects: number; intentRemoved: boolean }> {
    const volumeId = assertVolumeName(options.volumeId);
    if (typeof options.generation !== 'string' || !GENERATION.test(options.generation)) throw new ValidationError(`Invalid generation ${JSON.stringify(options.generation)}.`);
    const target = `${volumeId}/${options.generation}`;
    if (options.confirm !== target) {
      throw new VolumeError('CONFIRMATION_REQUIRED', `Refusing to delete generation ${target}: pass { confirm: "${target}" }.`);
    }
    const minAgeSeconds = assertInteger('minAgeSeconds', options.minAgeSeconds ?? 86_400, 0, 31_536_000);
    const record = await this.find(volumeId);
    if (record?.generation === options.generation) {
      throw new VolumeError('VOLUME_IN_USE', `Generation ${target} is the published data of volume "${volumeId}".`, { hint: 'Delete the volume instead.' });
    }
    const intentKey = `${this.prefix}/_operations/${options.generation}.json`;
    const intentBody = await this.store.getObject(intentKey);
    let intentOwner: string | null = null;
    if (intentBody !== undefined) {
      try {
        const parsed: unknown = JSON.parse(intentBody);
        if (isRecord(parsed) && isRecord(parsed.destination)) {
          intentOwner = typeof parsed.destination.id === 'string' ? parsed.destination.id : null;
          const started = typeof parsed.destination.createdAt === 'string' ? Date.parse(parsed.destination.createdAt) : Number.NaN;
          if (Number.isFinite(started) && Date.now() - started < minAgeSeconds * 1000) {
            throw new VolumeError('VOLUME_IN_USE', `The clone that owns ${target} started ${Math.round((Date.now() - started) / 1000)} s ago and could still publish it.`, {
              hint: 'Wait until no clone can still be running, or pass a smaller minAgeSeconds once you know it stopped.',
            });
          }
        }
      } catch (error) {
        if (error instanceof VolumeError) throw error;
      }
    }
    let deletedObjects = 0;
    let batch: string[] = [];
    const prefix = `${this.prefix}/v2/${volumeId}/${options.generation}/`;
    for await (const object of this.store.listObjects(prefix)) {
      if (!object.key.startsWith(prefix)) continue;
      batch.push(object.key);
      if (batch.length === 1000) {
        await this.store.deleteObjects(batch);
        deletedObjects += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.store.deleteObjects(batch);
      deletedObjects += batch.length;
    }
    const intentRemoved = intentBody !== undefined && intentOwner === volumeId;
    if (intentRemoved) await this.store.deleteObject(intentKey);
    return { deletedObjects, intentRemoved };
  }

  /**
   * Delete metadata that points at nothing: leases and attachment records of
   * volumes that no longer exist (or were recreated), deleting markers of
   * finished deletes, and leftover doctor probes. Never touches volume data.
   */
  async removeStaleRecords(report?: ReconcileReport): Promise<StaleRecordCleanup> {
    const survey = report ?? (await this.reconcile());
    const cleanup: StaleRecordCleanup = { leases: 0, deletingMarkers: 0, attachments: 0, doctorProbes: 0 };
    for (const lease of survey.staleLeases) {
      const record = await this.find(lease.volumeId).catch(() => undefined);
      if (record !== undefined && (record.generation ?? null) === lease.generation) continue; // Recreated since the survey.
      await this.store.deleteObject(this.leaseKey(lease.volumeId));
      cleanup.leases += 1;
    }
    for (const marker of survey.deletingMarkers) {
      if (marker.volumeExists) continue; // An interrupted delete: finish it with delete, never by removing the marker.
      await this.store.deleteObject(this.deletingKey(marker.volumeId));
      cleanup.deletingMarkers += 1;
    }
    for (const attachment of survey.staleAttachments) {
      if ((await this.find(attachment.volumeId).catch(() => undefined)) !== undefined) continue;
      await this.store.deleteObject(this.attachmentKey(attachment.volumeId, attachment.sandboxId, attachment.mountId));
      cleanup.attachments += 1;
    }
    for (const key of survey.doctorProbes) {
      if (!key.startsWith(`${this.prefix}/_doctor/`)) continue;
      await this.store.deleteObject(key);
      cleanup.doctorProbes += 1;
    }
    return cleanup;
  }
}
