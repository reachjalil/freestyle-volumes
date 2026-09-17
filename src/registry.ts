/**
 * Volume registry: metadata records and per-volume data prefixes in the
 * bucket. Volume ids are their names, so creation is naturally idempotent and
 * cross-volume access is a matter of prefix validation.
 *
 * Layout under `<prefix>/`:
 *   _volumes/<id>.json                       volume record
 *   _attachments/<id>/<sandbox>__<mount>.json advisory attachment records
 *   v/<id>/...                               the volume's data (mounted by rclone)
 */
import { VolumeAlreadyExistsError, VolumeError, VolumeNotFoundError, ValidationError } from './errors.js';
import type { ObjectStore } from './storage.js';
import { assertVolumeName } from './validate.js';

export interface Volume {
  /** Same as `name`. Volumes are addressed by name, like Daytona's `volume.get(name)`. */
  id: string;
  name: string;
  createdAt: string;
  labels: Record<string, string>;
  backend: 'rclone-s3';
  /** Bucket key prefix holding this volume's data, without trailing slash. */
  dataPrefix: string;
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
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;

function validateLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!LABEL_KEY.test(key)) throw new ValidationError(`Invalid label key ${JSON.stringify(key)}.`);
    if (typeof value !== 'string' || value.length > 256) throw new ValidationError(`Label ${key} must be a string of at most 256 characters.`);
    out[key] = value;
  }
  if (Object.keys(out).length > 32) throw new ValidationError('At most 32 labels are allowed.');
  return out;
}

function parseVolume(body: string, expectedId: string): Volume {
  let parsed: Partial<Volume> & { version?: number };
  try {
    parsed = JSON.parse(body) as Partial<Volume> & { version?: number };
  } catch (error) {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" is not valid JSON.`, { cause: error });
  }
  if (parsed.version !== RECORD_VERSION || parsed.id !== expectedId || typeof parsed.dataPrefix !== 'string') {
    throw new VolumeError('STORAGE_ERROR', `The record for volume "${expectedId}" has an unexpected shape.`, { details: { version: parsed.version } });
  }
  return {
    id: parsed.id,
    name: parsed.name ?? parsed.id,
    createdAt: parsed.createdAt ?? '',
    labels: parsed.labels ?? {},
    backend: 'rclone-s3',
    dataPrefix: parsed.dataPrefix,
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

  dataPrefix(id: string, subpath?: string): string {
    return subpath ? `${this.prefix}/v/${id}/${subpath}` : `${this.prefix}/v/${id}`;
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
    const volume: Volume = { id: name, name, createdAt: new Date().toISOString(), labels, backend: 'rclone-s3', dataPrefix: this.dataPrefix(name) };
    await this.store.putObject(this.volumeKey(name), JSON.stringify({ version: RECORD_VERSION, ...volume }));
    return volume;
  }

  async find(name: string): Promise<Volume | undefined> {
    const id = assertVolumeName(name);
    const body = await this.store.getObject(this.volumeKey(id));
    return body === undefined ? undefined : parseVolume(body, id);
  }

  async get(name: string): Promise<Volume> {
    const volume = await this.find(name);
    if (!volume) throw new VolumeNotFoundError(name);
    return volume;
  }

  async list(): Promise<Volume[]> {
    const volumes: Volume[] = [];
    for await (const object of this.store.listObjects(`${this.prefix}/_volumes/`)) {
      const match = /\/_volumes\/([a-z0-9-]+)\.json$/.exec(object.key);
      if (!match || match[1] === undefined) continue;
      const volume = await this.find(match[1]);
      if (volume) volumes.push(volume);
    }
    return volumes.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Cheap reachability and permission check against a data prefix (one LIST call). */
  async precheck(dataPrefix: string): Promise<void> {
    for await (const _object of this.store.listObjects(`${dataPrefix}/`, { limit: 1 })) break;
  }

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
        const parsed = JSON.parse(body) as Partial<AttachmentRecord>;
        if (typeof parsed.sandboxId === 'string' && typeof parsed.mountPath === 'string' && typeof parsed.mountId === 'string') {
          records.push({
            volumeId,
            sandboxId: parsed.sandboxId,
            mountId: parsed.mountId,
            mountPath: parsed.mountPath,
            subpath: parsed.subpath ?? null,
            readOnly: parsed.readOnly === true,
            attachedAt: parsed.attachedAt ?? '',
          });
        }
      } catch {
        // A corrupt advisory record is ignored rather than blocking deletes.
      }
    }
    return records;
  }
}
