import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CopyObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
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
  multipartCopyThresholdBytes?: number;
  multipartCopyPartSizeBytes?: number;
  /**
   * Server-side encryption header on every object this library and rclone write:
   * `AES256` (SSE-S3) or `aws:kms` (SSE-KMS). Omit to rely on the bucket default,
   * which is the only option on providers without these headers (Cloudflare R2).
   */
  serverSideEncryption?: 'AES256' | 'aws:kms';
  /** KMS key id, alias or ARN for `aws:kms`. Omit for the AWS-managed key. */
  sseKmsKeyId?: string;
  /** Storage class for volume data (rclone uploads and clone copies), e.g. `STANDARD_IA`. Small records keep the bucket default. */
  storageClass?: string;
}

/** Credentials for the rclone process inside a sandbox, when they should differ from the host's. */
export interface SandboxCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When temporary credentials stop working. Recorded with the mount and reported by inspect and listMounts. */
  expiresAt?: string | Date;
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
  multipartCopyThresholdBytes: number;
  multipartCopyPartSizeBytes: number;
  serverSideEncryption: 'AES256' | 'aws:kms' | undefined;
  sseKmsKeyId: string | undefined;
  storageClass: string | undefined;
}

export const DEFAULT_PREFIX = 'freestyle-volumes';
/** Name of the rclone remote defined through environment variables inside the sandbox. */
export const RCLONE_REMOTE = 'fsvol';
const PROVIDER = /^[A-Za-z][A-Za-z0-9 ]{0,31}$/;
const STORAGE_CLASS = /^[A-Z][A-Z0-9_]{0,31}$/;
/** KMS key ids, aliases and ARNs: no quotes, spaces or shell metacharacters. */
const KMS_KEY_ID = /^[A-Za-z0-9:/_.+=@-]{1,2048}$/;

function resolveEncryption(config: StorageConfig): Pick<ResolvedStorage, 'serverSideEncryption' | 'sseKmsKeyId' | 'storageClass'> {
  const sse = config.serverSideEncryption;
  if (sse !== undefined && sse !== 'AES256' && sse !== 'aws:kms') {
    throw new ValidationError(`storage.serverSideEncryption must be "AES256" or "aws:kms", got ${JSON.stringify(sse)}.`);
  }
  const kmsKey = config.sseKmsKeyId;
  if (kmsKey !== undefined) {
    if (sse !== 'aws:kms') throw new ValidationError('storage.sseKmsKeyId needs storage.serverSideEncryption: "aws:kms".');
    if (typeof kmsKey !== 'string' || !KMS_KEY_ID.test(kmsKey)) throw new ValidationError(`storage.sseKmsKeyId ${JSON.stringify(kmsKey)} is not a KMS key id, alias or ARN.`);
  }
  const storageClass = config.storageClass;
  if (storageClass !== undefined && (typeof storageClass !== 'string' || !STORAGE_CLASS.test(storageClass))) {
    throw new ValidationError(`storage.storageClass ${JSON.stringify(storageClass)} must be an S3 storage class such as "STANDARD_IA".`);
  }
  return { serverSideEncryption: sse, sseKmsKeyId: kmsKey, storageClass };
}

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
    multipartCopyThresholdBytes: assertInteger('storage.multipartCopyThresholdBytes', config.multipartCopyThresholdBytes === undefined ? MAX_SINGLE_COPY_BYTES : config.multipartCopyThresholdBytes, MIN_MULTIPART_COPY_PART_BYTES, MAX_SINGLE_COPY_BYTES),
    multipartCopyPartSizeBytes: assertInteger('storage.multipartCopyPartSizeBytes', config.multipartCopyPartSizeBytes === undefined ? DEFAULT_MULTIPART_COPY_PART_BYTES : config.multipartCopyPartSizeBytes, MIN_MULTIPART_COPY_PART_BYTES, MAX_SINGLE_COPY_BYTES),
    ...resolveEncryption(config),
  };
}

/** Validate credentials meant for a sandbox. Error messages name the field, never the value. */
export function resolveSandboxCredentials(credentials: SandboxCredentials, source = 'sandboxCredentials'): { accessKeyId: string; secretAccessKey: string; sessionToken: string | undefined; expiresAt: string | null } {
  if (!credentials || typeof credentials !== 'object') throw new ValidationError(`${source} must return an object with accessKeyId and secretAccessKey.`);
  let expiresAt: string | null = null;
  if (credentials.expiresAt !== undefined) {
    const time = credentials.expiresAt instanceof Date ? credentials.expiresAt.getTime() : typeof credentials.expiresAt === 'string' ? Date.parse(credentials.expiresAt) : Number.NaN;
    if (!Number.isFinite(time)) throw new ValidationError(`${source}.expiresAt must be a Date or an ISO 8601 time.`);
    expiresAt = new Date(time).toISOString();
  }
  return {
    accessKeyId: assertEnvValue(`${source}.accessKeyId`, credentials.accessKeyId),
    secretAccessKey: assertEnvValue(`${source}.secretAccessKey`, credentials.secretAccessKey),
    sessionToken: credentials.sessionToken === undefined ? undefined : assertEnvValue(`${source}.sessionToken`, credentials.sessionToken),
    expiresAt,
  };
}

/**
 * Storage configuration from the `VOLUMES_S3_*` environment variables that the
 * CLI, the examples and the live tests share (see `.env.example`). Empty
 * variables count as unset. Throws a {@link ValidationError} naming every
 * missing required variable; the values themselves are validated later by
 * {@link resolveStorage}.
 *
 * @example
 * const volumes = new FreestyleVolumes({ storage: storageConfigFromEnv(), sandboxes: freestyleSandboxes(freestyle) });
 */
export function storageConfigFromEnv(env: Record<string, string | undefined> = process.env): StorageConfig {
  const missing = ['VOLUMES_S3_BUCKET', 'VOLUMES_S3_ACCESS_KEY_ID', 'VOLUMES_S3_SECRET_ACCESS_KEY'].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new ValidationError(`Missing environment variables: ${missing.join(', ')}.`, { hint: 'Every VOLUMES_S3_* variable is listed in .env.example.' });
  }
  const config: StorageConfig = { bucket: env.VOLUMES_S3_BUCKET!, accessKeyId: env.VOLUMES_S3_ACCESS_KEY_ID!, secretAccessKey: env.VOLUMES_S3_SECRET_ACCESS_KEY! };
  if (env.VOLUMES_S3_ENDPOINT) config.endpoint = env.VOLUMES_S3_ENDPOINT;
  if (env.VOLUMES_S3_SANDBOX_ENDPOINT) config.sandboxEndpoint = env.VOLUMES_S3_SANDBOX_ENDPOINT;
  if (env.VOLUMES_S3_REGION) config.region = env.VOLUMES_S3_REGION;
  if (env.VOLUMES_S3_PREFIX) config.prefix = env.VOLUMES_S3_PREFIX;
  if (env.VOLUMES_S3_PROVIDER) config.provider = env.VOLUMES_S3_PROVIDER;
  if (env.VOLUMES_S3_SESSION_TOKEN) config.sessionToken = env.VOLUMES_S3_SESSION_TOKEN;
  const pathStyle = env.VOLUMES_S3_FORCE_PATH_STYLE;
  if (pathStyle) {
    if (!['true', 'false', '1', '0'].includes(pathStyle)) throw new ValidationError(`VOLUMES_S3_FORCE_PATH_STYLE must be true or false, got ${JSON.stringify(pathStyle)}.`);
    config.forcePathStyle = pathStyle === 'true' || pathStyle === '1';
  }
  if (env.VOLUMES_S3_SSE) config.serverSideEncryption = env.VOLUMES_S3_SSE as StorageConfig['serverSideEncryption'];
  if (env.VOLUMES_S3_SSE_KMS_KEY_ID) config.sseKmsKeyId = env.VOLUMES_S3_SSE_KMS_KEY_ID;
  if (env.VOLUMES_S3_STORAGE_CLASS) config.storageClass = env.VOLUMES_S3_STORAGE_CLASS;
  return config;
}

/**
 * Separate credentials for the rclone process in each VM, from
 * `VOLUMES_S3_SANDBOX_ACCESS_KEY_ID`, `VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY` and
 * `VOLUMES_S3_SANDBOX_SESSION_TOKEN`. Undefined when neither key is set, so the
 * host credentials are used. Pass the result as `sandboxCredentials`.
 */
export function sandboxCredentialsFromEnv(env: Record<string, string | undefined> = process.env): SandboxCredentials | undefined {
  const id = env.VOLUMES_S3_SANDBOX_ACCESS_KEY_ID;
  const secret = env.VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY;
  if (!id && !secret) return undefined;
  if (!id || !secret) throw new ValidationError('Set both VOLUMES_S3_SANDBOX_ACCESS_KEY_ID and VOLUMES_S3_SANDBOX_SECRET_ACCESS_KEY, or neither.');
  return env.VOLUMES_S3_SANDBOX_SESSION_TOKEN ? { accessKeyId: id, secretAccessKey: secret, sessionToken: env.VOLUMES_S3_SANDBOX_SESSION_TOKEN } : { accessKeyId: id, secretAccessKey: secret };
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
  if (storage.serverSideEncryption) env[key('SERVER_SIDE_ENCRYPTION')] = storage.serverSideEncryption;
  if (storage.sseKmsKeyId) env[key('SSE_KMS_KEY_ID')] = storage.sseKmsKeyId;
  if (storage.storageClass) env[key('STORAGE_CLASS')] = storage.storageClass;
  return env;
}

export interface ObjectSummary {
  key: string;
  size: number;
  etag?: string;
}

export const MAX_SINGLE_COPY_BYTES = 5 * 1024 ** 3;
export const MAX_MULTIPART_COPY_BYTES = 5 * 1024 ** 4;
export const MIN_MULTIPART_COPY_PART_BYTES = 5 * 1024 ** 2;
export const DEFAULT_MULTIPART_COPY_PART_BYTES = 128 * 1024 ** 2;
export const MAX_MULTIPART_COPY_PARTS = 10_000;
export interface CopyObjectOptions {
  /** Opaque ETag from the selected source listing, including quotes. */
  sourceIfMatch: string;
  size: number;
}

/** The few object-store operations the registry needs. Implemented on the AWS SDK and in memory (tests). */
export interface ObjectStore {
  /** Server-side copy only; must enforce sourceIfMatch and preserve bytes. */
  copyObject?(sourceKey: string, destinationKey: string, options: CopyObjectOptions): Promise<void>;
  headBucket(): Promise<void>;
  putObject(key: string, body: string): Promise<void>;
  /** Atomically write only if absent. False proves this call never wrote the key; never overwrite it.
   * Ambiguous outcomes (including a retry observing its own prior write) must throw, not return false.
   * Implementations must fail if the backend cannot enforce the condition. */
  putObjectIfAbsent(key: string, body: string): Promise<boolean>;
  getObject(key: string): Promise<string | undefined>;
  deleteObject(key: string): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  listObjects(prefix: string, options?: { limit?: number }): AsyncIterable<ObjectSummary>;
  /**
   * The immediate "subdirectories" of a prefix that ends in "/" (a delimiter
   * listing), each returned with its trailing "/". Optional: callers fall back
   * to a full listing, which costs one request per 1,000 objects.
   */
  listPrefixes?(prefix: string): AsyncIterable<string>;
}

/** Immediate child prefixes of `prefix`, derived from a full listing when the store has no delimiter listing. */
export async function* childPrefixes(store: ObjectStore, prefix: string): AsyncIterable<string> {
  if (typeof store.listPrefixes === 'function') {
    yield* store.listPrefixes(prefix);
    return;
  }
  const seen = new Set<string>();
  for await (const object of store.listObjects(prefix)) {
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (!object.key.startsWith(prefix) || slash <= 0) continue;
    const child = `${prefix}${rest.slice(0, slash + 1)}`;
    if (!seen.has(child)) {
      seen.add(child);
      yield child;
    }
  }
}

const AUTH_NAMES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'AuthorizationHeaderMalformed', 'InvalidToken', 'ExpiredToken', 'CredentialsProviderError']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const SAFE_ERROR_NAMES = new Set([...AUTH_NAMES, 'Error', 'TypeError', 'TimeoutError', 'AbortError', 'NoSuchBucket', 'NoSuchKey', 'NotFound', 'PreconditionFailed', 'ConditionalRequestConflict', 'NotImplemented', 'NoSuchUpload', 'InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'EntityTooLarge', 'InvalidRequest', 'InvalidArgument', 'InvalidTag', 'InternalError', 'ServiceUnavailable', 'SlowDown', 'RequestTimeout', 'StorageError']);
const STORAGE_CODES = new Set<StorageErrorCode>(['STORAGE_AUTH', 'STORAGE_UNREACHABLE', 'BUCKET_NOT_FOUND', 'STORAGE_ERROR']);

function errorField(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

function safeErrorName(value: unknown): string {
  return typeof value === 'string' && SAFE_ERROR_NAMES.has(value) ? value : 'Error';
}

function isNotFound(error: unknown): boolean {
  const name = errorField(error, 'name');
  return name === 'NoSuchKey' || name === 'NotFound' || errorField(errorField(error, '$metadata'), 'httpStatusCode') === 404;
}

/** Map an AWS SDK / network failure to a {@link StorageError} without leaking credentials. */
export function toStorageError(error: unknown, operation: string, bucket: string): StorageError {
  const name = safeErrorName(errorField(error, 'name'));
  const rawStatus = errorField(errorField(error, '$metadata'), 'httpStatusCode');
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const rawCode = errorField(error, 'code');
  const causeCode = errorField(errorField(error, 'cause'), 'code');
  const code = typeof rawCode === 'string' && NETWORK_CODES.has(rawCode) ? rawCode
    : typeof causeCode === 'string' && NETWORK_CODES.has(causeCode) ? causeCode : undefined;
  let kind: StorageErrorCode = typeof rawCode === 'string' && STORAGE_CODES.has(rawCode as StorageErrorCode) ? rawCode as StorageErrorCode : 'STORAGE_ERROR';
  let hint = 'Inspect the safe error classification and provider-side logs; raw provider diagnostics are omitted.';
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
  return new StorageError(kind, `Storage ${operation} failed for bucket "${bucket}": ${name}${status ? ` (HTTP ${status})` : ''}${code ? ` [${code}]` : ''}.`, {
    cause: { name, ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }) },
    hint,
    details: { operation, bucket, status, name, code },
  });
}

export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly timeoutMs: number;
  private readonly multipartCopyThresholdBytes: number;
  private readonly multipartCopyPartSizeBytes: number;
  /** SSE headers for every write, records included: bucket policies that require them apply to all PUTs. */
  private readonly encryption: { ServerSideEncryption?: ServerSideEncryption; SSEKMSKeyId?: string };
  /** Storage class for copied volume data only; tiny records stay in the bucket default. */
  private readonly dataClass: { StorageClass?: StorageClass };

  constructor(storage: ResolvedStorage, client?: S3Client) {
    this.bucket = storage.bucket;
    this.timeoutMs = storage.requestTimeoutMs;
    this.multipartCopyThresholdBytes = storage.multipartCopyThresholdBytes;
    this.multipartCopyPartSizeBytes = storage.multipartCopyPartSizeBytes;
    this.encryption = {
      ...(storage.serverSideEncryption ? { ServerSideEncryption: storage.serverSideEncryption as ServerSideEncryption } : {}),
      ...(storage.sseKmsKeyId ? { SSEKMSKeyId: storage.sseKmsKeyId } : {}),
    };
    this.dataClass = storage.storageClass ? { StorageClass: storage.storageClass as StorageClass } : {};
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

  async copyObject(sourceKey: string, destinationKey: string, options: CopyObjectOptions): Promise<void> {
    validateCopy(options);
    const encode = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    let uploadId: string | undefined;
    let stage = 'head';
    let completionStatus: 'not-attempted' | 'unknown' = 'not-attempted';
    let validationFailure: StorageError | undefined;
    const invalidResponse = (message: string) => {
      validationFailure = new StorageError('STORAGE_ERROR', message);
      return validationFailure;
    };
    try {
      const head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket, Key: sourceKey, IfMatch: options.sourceIfMatch,
      }), { abortSignal: this.signal() });
      if (head.ContentLength !== options.size || head.ETag !== options.sourceIfMatch) {
        throw invalidResponse('Copy source size or ETag changed since selection.');
      }
      const version = head.VersionId === undefined ? {} : { VersionId: head.VersionId };
      const copySource = [this.bucket, ...sourceKey.split('/')].map(encode).join('/') +
        (head.VersionId === undefined ? '' : `?versionId=${encode(head.VersionId)}`);
      if (options.size <= this.multipartCopyThresholdBytes) {
        stage = 'copy';
        const copied = await this.client.send(new CopyObjectCommand({
          Bucket: this.bucket, Key: destinationKey, CopySource: copySource,
          CopySourceIfMatch: options.sourceIfMatch,
          ...this.encryption, ...this.dataClass,
        }), { abortSignal: this.signal() });
        completionStatus = 'unknown';
        if (!validEtag(copied?.CopyObjectResult?.ETag)) {
          throw invalidResponse('Copy returned no valid completion ETag; the destination may exist.');
        }
        return;
      }
      stage = 'tags';
      const tags = await this.client.send(new GetObjectTaggingCommand({
        Bucket: this.bucket, Key: sourceKey, ...version,
      }), { abortSignal: this.signal() });
      const tagging = (tags.TagSet ?? []).map(tag => {
        if (typeof tag.Key !== 'string' || typeof tag.Value !== 'string') {
          throw invalidResponse('Copy source returned an invalid tag.');
        }
        return `${encode(tag.Key)}=${encode(tag.Value)}`;
      }).join('&');
      stage = 'create';
      const created = await this.client.send(new CreateMultipartUploadCommand({
        Bucket: this.bucket, Key: destinationKey,
        ContentType: head.ContentType, ContentEncoding: head.ContentEncoding,
        ContentLanguage: head.ContentLanguage, ContentDisposition: head.ContentDisposition,
        CacheControl: head.CacheControl, Expires: head.Expires, Metadata: head.Metadata,
        ...(tagging ? { Tagging: tagging } : {}),
        ...this.encryption, ...this.dataClass,
      }), { abortSignal: this.signal() });
      if (typeof created.UploadId !== 'string' || !created.UploadId.trim()) {
        throw invalidResponse('Multipart creation returned no UploadId; an upload may exist and requires reconciliation.');
      }
      uploadId = created.UploadId;
      const destination = { Bucket: this.bucket, Key: destinationKey, UploadId: uploadId };
      const partSize = Math.max(this.multipartCopyPartSizeBytes, Math.ceil(options.size / MAX_MULTIPART_COPY_PARTS));
      const parts: { PartNumber: number; ETag: string }[] = [];
      stage = 'part';
      for (let start = 0; start < options.size; start += partSize) {
        const partNumber = parts.length + 1;
        const part = await this.client.send(new UploadPartCopyCommand({
          ...destination, PartNumber: partNumber, CopySource: copySource,
          CopySourceIfMatch: options.sourceIfMatch,
          CopySourceRange: `bytes=${start}-${Math.min(start + partSize, options.size) - 1}`,
        }), { abortSignal: this.signal() });
        const etag = part?.CopyPartResult?.ETag;
        if (!validEtag(etag)) {
          throw invalidResponse('Multipart copy returned no valid part ETag.');
        }
        parts.push({ PartNumber: partNumber, ETag: etag });
      }
      stage = 'complete';
      completionStatus = 'unknown';
      const completed = await this.client.send(new CompleteMultipartUploadCommand({
        ...destination, MultipartUpload: { Parts: parts },
      }), { abortSignal: this.signal() });
      if (!validEtag(completed?.ETag)) {
        throw invalidResponse('Multipart copy returned no valid completion ETag; the destination may exist.');
      }
    } catch (error) {
      let abortStatus: 'not-attempted' | 'acknowledged' | 'failed' = 'not-attempted';
      let abortError: StorageError | undefined;
      if (uploadId !== undefined) {
        try {
          await this.client.send(new AbortMultipartUploadCommand({
            Bucket: this.bucket, Key: destinationKey, UploadId: uploadId,
          }), { abortSignal: this.signal() });
          abortStatus = 'acknowledged';
        } catch (failure) {
          abortStatus = 'failed';
          abortError = toStorageError(failure, 'abortMultipartCopy', this.bucket);
        }
      }
      const failure = validationFailure !== undefined && error === validationFailure ? validationFailure : toStorageError(error, 'copy', this.bucket);
      throw new StorageError(failure.code as StorageErrorCode, 'Server-side copy failed.', {
        cause: failure,
        hint: completionStatus === 'unknown'
          ? 'Completion may have succeeded. Retain destination data and reconcile; an abort response does not prove the destination is absent.'
          : stage === 'create' || uploadId !== undefined
            ? 'Reconcile unfinished uploads; abort acknowledgment alone does not prove all remote work stopped.'
            : 'Inspect cause for the source validation or provider failure.',
        details: { operation: 'copy', bucket: this.bucket, destinationKey, stage, uploadId, completionStatus, abortStatus,
          ...(abortError === undefined ? {} : { abortError }) },
      });
    }
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
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json', ...this.encryption }), { abortSignal: this.signal() });
    } catch (error) {
      throw toStorageError(error, 'put', this.bucket);
    }
  }

  async putObjectIfAbsent(key: string, body: string): Promise<boolean> {
    let attempts = 0;
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json', IfNoneMatch: '*', ...this.encryption });
    // A retry may observe our own successful first write. Such a 412 is not
    // proof that this operation never published, so callers must retain data.
    command.middlewareStack.add((next) => async (args) => {
      attempts += 1;
      return next(args);
    }, { step: 'finalizeRequest', priority: 'low', name: 'countConditionalAttempts' });
    try {
      await this.client.send(
        command,
        { abortSignal: this.signal() },
      );
      return true;
    } catch (error) {
      if (attempts <= 1 && (errorField(errorField(error, '$metadata'), 'httpStatusCode') === 412 || errorField(error, 'name') === 'PreconditionFailed')) return false;
      // Conflicts (409), unsupported conditions and ambiguous failures are not
      // proof of an existing record. Surface them; never fall back to a plain PUT.
      throw toStorageError(error, 'putIfAbsent', this.bucket);
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
    let response;
    try {
      response = await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
        { abortSignal: this.signal() },
      );
    } catch (error) {
      throw toStorageError(error, 'deleteObjects', this.bucket);
    }
    const failed = response.Errors ?? [];
    if (failed.length > 0) {
      const requested = new Set(keys);
      throw new StorageError('STORAGE_ERROR', `Storage delete failed for ${failed.length} of ${keys.length} objects in bucket "${this.bucket}".`, {
        details: { failed: failed.map((f) => ({ key: typeof f.Key === 'string' && requested.has(f.Key) ? f.Key : undefined, code: safeErrorName(f.Code) })) },
      });
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
          yield { key: object.Key, size: object.Size ?? 0, ...(object.ETag === undefined ? {} : { etag: object.ETag }) };
          remaining -= 1;
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && remaining > 0);
  }

  async *listPrefixes(prefix: string): AsyncIterable<string> {
    let token: string | undefined;
    do {
      let page;
      try {
        page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token, MaxKeys: 1000 }),
          { abortSignal: this.signal() },
        );
      } catch (error) {
        throw toStorageError(error, 'list', this.bucket);
      }
      for (const common of page.CommonPrefixes ?? []) {
        if (typeof common.Prefix === 'string' && common.Prefix.startsWith(prefix)) yield common.Prefix;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

/** In-memory object store for unit tests and dry runs. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, string>();
  /** Set to make every call fail with this error (simulates outages). */
  failWith: unknown = undefined;

  private check(operation: string): void {
    if (this.failWith === undefined) return;
    throw toStorageError(this.failWith, operation, 'memory');
  }

  async headBucket(): Promise<void> {
    this.check('headBucket');
  }

  async copyObject(sourceKey: string, destinationKey: string, options: CopyObjectOptions): Promise<void> {
    this.check('copy');
    validateCopy(options);
    const body = this.objects.get(sourceKey);
    if (body === undefined || memoryEtag(body) !== options.sourceIfMatch || Buffer.byteLength(body) !== options.size) {
      throw new StorageError('STORAGE_ERROR', 'Copy source is missing or changed.');
    }
    this.objects.set(destinationKey, body);
  }

  async putObject(key: string, body: string): Promise<void> {
    this.check('put');
    this.objects.set(key, body);
  }

  async putObjectIfAbsent(key: string, body: string): Promise<boolean> {
    this.check('putIfAbsent');
    if (this.objects.has(key)) return false;
    this.objects.set(key, body);
    return true;
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
        const body = this.objects.get(key);
        if (body === undefined) continue;
        yield { key, size: Buffer.byteLength(body), etag: memoryEtag(body) };
        remaining -= 1;
      }
    }
  }

  async *listPrefixes(prefix: string): AsyncIterable<string> {
    this.check('list');
    const children = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.indexOf('/', prefix.length);
      if (slash > prefix.length) children.add(key.slice(0, slash + 1));
    }
    yield* [...children].sort();
  }
}

function memoryEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex')}"`;
}

function validEtag(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCopy(options: CopyObjectOptions): void {
  assertInteger('copy size', options.size, 0, MAX_MULTIPART_COPY_BYTES);
  if (typeof options.sourceIfMatch !== 'string' || !options.sourceIfMatch) throw new ValidationError('Copy requires a source ETag.');
}
