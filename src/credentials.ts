/**
 * Credentials for the rclone process inside a sandbox. By default a sandbox gets
 * the same key as the host process, which can reach everything that key can.
 * A {@link SandboxCredentialsProvider} lets each mount get its own key instead:
 * short-lived, limited to the volume's data prefix, and read-only for read-only
 * mounts. The host keeps its own credentials for volume records.
 */
import { ValidationError } from './errors.js';
import type { SandboxCredentials } from './storage.js';
import { assertBucket } from './validate.js';

export type { SandboxCredentials } from './storage.js';

/** What a provider is asked to cover. */
export interface SandboxCredentialsRequest {
  /** `mount` for attach; `check` for checkSandbox, which lists the namespace root. */
  purpose: 'mount' | 'check';
  sandboxId: string;
  bucket: string;
  /** Namespace prefix of the FreestyleVolumes instance. */
  prefix: string;
  /** Key prefix the credentials must reach, without a trailing slash: the volume's data prefix (plus subpath) for a mount, the namespace for a check. */
  keyPrefix: string;
  /** True for read-only mounts and for checks: listing and reading are enough. */
  readOnly: boolean;
  volumeId: string | null;
  subpath: string | null;
  mountPath: string | null;
}

/**
 * Called once per attach (and per checkSandbox) with the scope to cover.
 * Return static keys limited to that scope, or mint temporary ones, for example
 * with AWS STS AssumeRole and {@link scopedPolicy}, or Cloudflare R2 temporary
 * credentials limited to `keyPrefix`. Set `expiresAt` for temporary keys:
 * rclone cannot refresh them, so a mount must be reattached before they expire.
 */
export type SandboxCredentialsProvider = (request: SandboxCredentialsRequest) => SandboxCredentials | Promise<SandboxCredentials>;

export interface ScopedPolicyStatement {
  Sid: string;
  Effect: 'Allow';
  Action: string[];
  Resource: string[];
  Condition?: { StringLike: { 's3:prefix': string[] } };
}

export interface ScopedPolicy {
  Version: '2012-10-17';
  Statement: ScopedPolicyStatement[];
}

const KEY_PREFIX = /^[A-Za-z0-9._/-]{1,1024}$/;

/**
 * An IAM policy that allows listing and reading one key prefix and, unless
 * `readOnly`, writing and deleting under it: what rclone needs to mount that
 * prefix and nothing else. Use it as the session policy of STS AssumeRole or
 * GetFederationToken, or as the policy of a MinIO user.
 */
export function scopedPolicy(scope: Pick<SandboxCredentialsRequest, 'bucket' | 'keyPrefix' | 'readOnly'>): ScopedPolicy {
  const bucket = assertBucket(scope.bucket);
  const keyPrefix = typeof scope.keyPrefix === 'string' ? scope.keyPrefix.replace(/\/+$/, '') : '';
  if (!KEY_PREFIX.test(keyPrefix) || keyPrefix.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ValidationError(`Invalid key prefix ${JSON.stringify(scope.keyPrefix)} for a scoped policy.`);
  }
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objects = `${bucketArn}/${keyPrefix}/*`;
  const statements: ScopedPolicyStatement[] = [
    { Sid: 'ListPrefix', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [bucketArn], Condition: { StringLike: { 's3:prefix': [keyPrefix, `${keyPrefix}/`, `${keyPrefix}/*`] } } },
    { Sid: 'ReadPrefix', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [objects] },
  ];
  if (scope.readOnly !== true) {
    statements.push({ Sid: 'WritePrefix', Effect: 'Allow', Action: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: [objects] });
  }
  return { Version: '2012-10-17', Statement: statements };
}
