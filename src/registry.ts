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
 */
import { VolumeAlreadyExistsError, VolumeError, VolumeNotFoundError, ValidationError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { MAX_MULTIPART_COPY_BYTES, type ObjectStore, type ObjectSummary } from './storage.js';
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
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" is not valid JSON.`, { cause: error });
  }
  const validPrefix = isRecord(parsed) && (
    (parsed.version === 1 && parsed.generation === undefined && parsed.dataPrefix === expectedPrefix) ||
    (parsed.version === 2 && typeof parsed.generation === 'string' && GENERATION.test(parsed.generation) &&
      parsed.dataPrefix === `${generationRoot}/${parsed.generation}`));
  if (!isRecord(parsed) || !validPrefix || parsed.id !== expectedId || parsed.name !== expectedId ||
      parsed.backend !== 'rclone-s3' || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !isRecord(parsed.labels) || typeof parsed.dataPrefix !== 'string') {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" has an unexpected shape or data prefix.`);
  }
  let labels: Record<string, string>;
  try {
    labels = validateLabels(parsed.labels as Record<string, string>);
  } catch (error) {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" has invalid labels.`, { cause: error });
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

  async create(input: { name: string; labels?: Record<string, string> }, options: { ifNotExists?: boolean } = {}): Promise<Volume> {
    const name = assertVolumeName(input.name);
    const labels = validateLabels(input.labels);
    const existing = await this.find(name);
    if (existing) {
      if (options.ifNotExists) return existing;
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
      return winner;
    }
    return volume;
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
      const attachments = await this.listAttachments(sourceId);
      if (attachments.length && input.allowLiveSource !== true) {
        throw new VolumeError('VOLUME_IN_USE', 'Clone source has recorded attachments.', {
          hint: 'Detach first or explicitly pass allowLiveSource: true. This check is advisory, not a snapshot or a lock against concurrent writers.',
          details: { attachments },
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
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
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

  /** Cheap reachability and permission check against a data prefix (one LIST call). */
  async precheck(dataPrefix: string): Promise<void> {
    for await (const _object of this.store.listObjects(`${dataPrefix}/`, { limit: 1 })) break;
  }

  /** Attachment checks are advisory, not a lock against concurrent attach/create/delete. */
  async delete(name: string, options: { force?: boolean } = {}): Promise<{ deletedObjects: number; attachments: AttachmentRecord[] }> {
    const volume = await this.get(name);
    const attachments = await this.listAttachments(volume.id);
    if (attachments.length > 0 && !options.force) {
      throw new VolumeError('VOLUME_IN_USE', `Volume "${volume.id}" has ${attachments.length} recorded attachment(s): ${attachments.map((a) => `${a.sandboxId}:${a.mountPath}`).join(', ')}.`, {
        hint: 'Detach it from those sandboxes first. If the sandboxes are gone, pass { force: true } to delete anyway; attachment records are advisory and can be stale.',
        details: { attachments },
      });
    }
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
    await this.store.deleteObject(this.volumeKey(volume.id));
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
}
