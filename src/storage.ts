import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageError, ValidationError, type StorageErrorCode } from './errors.js';
import { assertBucket, assertEnvValue, assertInteger, assertUrl, normalizePrefix } from './validate.js';

/**
 * S3-compatible storage configuration. This is the only durable store for
 * volume data with the rclone backend: there is no separate metadata service.
 */
export interface StorageConfig {
  /** S3 API endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` or `http://minio:9000`. Omit for AWS S3. */
  endpoint?: string;
  /** Endpoint the sandbox uses when it differs from the one this process uses (private networks, Docker). Defaults to `endpoint`. */
  sandboxEndpoint?: string;
  /** Region. Required by AWS; `auto` for R2; any value for MinIO. Default `us-east-1`. */
  region?: string;
  bucket: string;
  /** Key prefix (namespace) under which volumes live. Default `freestyle-volumes`. */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style addressing (`endpoint/bucket/key`). Default: true when `endpoint` is set, false for AWS. */
  forcePathStyle?: boolean;
  /** rclone provider hint: `AWS`, `Minio`, `Cloudflare`, `Ceph`, `Other`, ... Default: `AWS` without an endpoint, else `Other`. */
  provider?: string;
  /** Per-request timeout for host-side storage calls. Default 15000. */
  requestTimeoutMs?: number;
}

export interface ResolvedStorage {
  endpoint: string | undefined;
  sandboxEndpoint: string | undefined;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
  forcePathStyle: boolean;
  provider: string;
  requestTimeoutMs: number;
}

export const DEFAULT_PREFIX = 'freestyle-volumes';
/** Name of the rclone remote defined through environment variables inside the sandbox. */
export const RCLONE_REMOTE = 'fsvol';
const PROVIDER = /^[A-Za-z][A-Za-z0-9 ]{0,31}$/;

export function resolveStorage(config: StorageConfig): ResolvedStorage {
  if (!config || typeof config !== 'object') throw new ValidationError('storage configuration is required.');
  const endpoint = config.endpoint === undefined ? undefined : assertUrl('storage.endpoint', config.endpoint);
  const sandboxEndpoint = config.sandboxEndpoint === undefined ? endpoint : assertUrl('storage.sandboxEndpoint', config.sandboxEndpoint);
  const provider = config.provider ?? (endpoint ? 'Other' : 'AWS');
  if (!PROVIDER.test(provider)) throw new ValidationError(`storage.provider ${JSON.stringify(provider)} is not a valid rclone provider name.`);
  const region = config.region ?? 'us-east-1';
  if (!/^[A-Za-z0-9-]{1,32}$/.test(region)) throw new ValidationError(`storage.region ${JSON.stringify(region)} is invalid.`);
  return {
    endpoint,
    sandboxEndpoint,
    region,
    bucket: assertBucket(config.bucket),
    prefix: normalizePrefix(config.prefix ?? DEFAULT_PREFIX),
    accessKeyId: assertEnvValue('storage.accessKeyId', config.accessKeyId),
    secretAccessKey: assertEnvValue('storage.secretAccessKey', config.secretAccessKey),
    sessionToken: config.sessionToken === undefined ? undefined : assertEnvValue('storage.sessionToken', config.sessionToken),
    forcePathStyle: config.forcePathStyle ?? endpoint !== undefined,
    provider,
    requestTimeoutMs: assertInteger('storage.requestTimeoutMs', config.requestTimeoutMs ?? 15000, 1000, 300000),
  };
}

/**
 * Environment variables that define the rclone remote inside the sandbox.
 * Credentials travel only this way: never on a command line, never in a file.
 */
export function rcloneRemoteEnv(storage: ResolvedStorage): Record<string, string> {
  const key = (option: string) => `RCLONE_CONFIG_${RCLONE_REMOTE.toUpperCase()}_${option}`;
  const env: Record<string, string> = {
    RCLONE_CONFIG: '/dev/null',
    [key('TYPE')]: 's3',
    [key('PROVIDER')]: storage.provider,
    [key('ENV_AUTH')]: 'false',
    [key('ACCESS_KEY_ID')]: storage.accessKeyId,
    [key('SECRET_ACCESS_KEY')]: storage.secretAccessKey,
    [key('REGION')]: storage.region,
    [key('FORCE_PATH_STYLE')]: storage.forcePathStyle ? 'true' : 'false',
    [key('NO_CHECK_BUCKET')]: 'true',
    [key('DIRECTORY_MARKERS')]: 'true',
  };
  if (storage.sandboxEndpoint) env[key('ENDPOINT')] = storage.sandboxEndpoint;
  if (storage.sessionToken) env[key('SESSION_TOKEN')] = storage.sessionToken;
  return env;
}

export interface ObjectSummary {
  key: string;
  size: number;
}

/** The few object-store operations the registry needs. Implemented on the AWS SDK and in memory (tests). */
export interface ObjectStore {
  headBucket(): Promise<void>;
  putObject(key: string, body: string): Promise<void>;
  getObject(key: string): Promise<string | undefined>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  listObjects(prefix: string, options?: { limit?: number }): AsyncIterable<ObjectSummary>;
}

interface ErrorLike {
  name?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  cause?: ErrorLike;
}

const AUTH_NAMES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'AuthorizationHeaderMalformed', 'InvalidToken', 'ExpiredToken', 'CredentialsProviderError']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function isNotFound(error: unknown): boolean {
  const e = error as ErrorLike;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** Map an AWS SDK / network failure to a {@link StorageError} without leaking credentials. */
export function toStorageError(error: unknown, operation: string, bucket: string): StorageError {
  const e = (error ?? {}) as ErrorLike;
  const name = e.name ?? 'Error';
  const status = e.$metadata?.httpStatusCode;
  const code = e.code ?? e.cause?.code;
  const message = typeof e.message === 'string' ? e.message : String(error);
  let kind: StorageErrorCode = 'STORAGE_ERROR';
  let hint = 'Inspect `cause` for the underlying error.';
  if (AUTH_NAMES.has(name) || status === 403 || status === 401) {
    kind = 'STORAGE_AUTH';
    hint = 'Check accessKeyId, secretAccessKey, sessionToken and the bucket policy for this key.';
  } else if (name === 'NoSuchBucket' || (operation === 'headBucket' && status === 404)) {
    kind = 'BUCKET_NOT_FOUND';
    hint = 'Create the bucket first: freestyle-volumes never creates or formats storage on its own.';
  } else if (name === 'TimeoutError' || name === 'AbortError' || (code !== undefined && NETWORK_CODES.has(code))) {
    kind = 'STORAGE_UNREACHABLE';
    hint = 'Check the endpoint URL, DNS, TLS and network access from this process.';
  }
  return new StorageError(kind, `Storage ${operation} failed for bucket "${bucket}": ${name}${status ? ` (HTTP ${status})` : ''}${code ? ` [${code}]` : ''}: ${message}`, {
    cause: error,
    hint,
    details: { operation, bucket, status, name, code },
  });
}

export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly timeoutMs: number;

  constructor(storage: ResolvedStorage, client?: S3Client) {
    this.bucket = storage.bucket;
    this.timeoutMs = storage.requestTimeoutMs;
    this.client =
      client ??
      new S3Client({
        region: storage.region,
        ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
        forcePathStyle: storage.forcePathStyle,
        credentials: {
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
          ...(storage.sessionToken ? { sessionToken: storage.sessionToken } : {}),
        },
      });
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  async headBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: this.signal() });
    } catch (error) {
      throw toStorageError(error, 'headBucket', this.bucket);
    }
  }

  async putObject(key: string, body: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json' }), { abortSignal: this.signal() });
    } catch (error) {
      throw toStorageError(error, 'put', this.bucket);
    }
  }

  async getObject(key: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: this.signal() });
      return (await response.Body?.transformToString()) ?? '';
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw toStorageError(error, 'get', this.bucket);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: this.signal() });
    } catch (error) {
      throw toStorageError(error, 'delete', this.bucket);
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      const response = await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
        { abortSignal: this.signal() },
      );
      const failed = response.Errors ?? [];
      if (failed.length > 0) {
        throw new StorageError('STORAGE_ERROR', `Storage delete failed for ${failed.length} of ${keys.length} objects in bucket "${this.bucket}": ${failed[0]?.Code ?? 'unknown'}: ${failed[0]?.Message ?? ''}`, {
          details: { failed: failed.map((f) => ({ key: f.Key, code: f.Code })) },
        });
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw toStorageError(error, 'deleteObjects', this.bucket);
    }
  }

  async *listObjects(prefix: string, options: { limit?: number } = {}): AsyncIterable<ObjectSummary> {
    let token: string | undefined;
    let remaining = options.limit ?? Number.POSITIVE_INFINITY;
    do {
      let page;
      try {
        page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, remaining) }),
          { abortSignal: this.signal() },
        );
      } catch (error) {
        throw toStorageError(error, 'list', this.bucket);
      }
      for (const object of page.Contents ?? []) {
        if (remaining <= 0) return;
        if (object.Key !== undefined) {
          yield { key: object.Key, size: object.Size ?? 0 };
          remaining -= 1;
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && remaining > 0);
  }
}

/** In-memory object store for unit tests and dry runs. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, string>();
  /** Set to make every call fail with this error (simulates outages). */
  failWith: unknown = undefined;

  private check(operation: string): void {
    if (this.failWith === undefined) return;
    if (this.failWith instanceof StorageError) throw this.failWith;
    throw toStorageError(this.failWith, operation, 'memory');
  }

  async headBucket(): Promise<void> {
    this.check('headBucket');
  }

  async putObject(key: string, body: string): Promise<void> {
    this.check('put');
    this.objects.set(key, body);
  }

  async getObject(key: string): Promise<string | undefined> {
    this.check('get');
    return this.objects.get(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.check('delete');
    this.objects.delete(key);
  }

  async deleteObjects(keys: string[]): Promise<void> {
    this.check('deleteObjects');
    for (const key of keys) this.objects.delete(key);
  }

  async *listObjects(prefix: string, options: { limit?: number } = {}): AsyncIterable<ObjectSummary> {
    this.check('list');
    let remaining = options.limit ?? Number.POSITIVE_INFINITY;
    for (const key of [...this.objects.keys()].sort()) {
      if (remaining <= 0) return;
      if (key.startsWith(prefix)) {
        yield { key, size: this.objects.get(key)?.length ?? 0 };
        remaining -= 1;
      }
    }
  }
}
