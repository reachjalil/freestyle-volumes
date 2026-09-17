import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

/** Volume ids double as names: DNS-label style, 1-63 chars. */
const VOLUME_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** One path segment inside the bucket. No leading dot, so `.`, `..` and hidden segments are impossible. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MOUNT_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
const BUCKET = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CACHE_SIZE = /^[0-9]{1,6}[KMGT]?$/;
const UMASK = /^0?[0-7]{3}$/;

/** Mount targets that would shadow or damage the guest OS, or this library's own state. */
export const PROTECTED_MOUNT_ROOTS = [
  '/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/usr', '/run',
  '/var/lib/freestyle-volumes', '/var/cache/freestyle-volumes', '/opt/freestyle-volumes',
];

export function assertVolumeName(name: unknown): string {
  if (typeof name !== 'string' || !VOLUME_NAME.test(name)) {
    throw new ValidationError(`Invalid volume name ${JSON.stringify(name)}.`, {
      hint: 'Use 1-63 lowercase letters, digits or hyphens, starting and ending with a letter or digit.',
    });
  }
  return name;
}

function assertSegments(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${what} must be a string.`);
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') throw new ValidationError(`${what} must not be empty.`);
  if (trimmed.length > 512) throw new ValidationError(`${what} is longer than 512 characters.`);
  for (const segment of trimmed.split('/')) {
    if (!SEGMENT.test(segment)) {
      throw new ValidationError(`${what} contains an invalid segment ${JSON.stringify(segment)}.`, {
        hint: 'Segments use letters, digits, ".", "_" and "-", cannot start with a dot, and cannot be empty.',
      });
    }
  }
  return trimmed;
}

/** Namespace prefix inside the bucket. Leading and trailing slashes are dropped. */
export function normalizePrefix(prefix: unknown): string {
  return assertSegments(prefix, 'Storage prefix');
}

/** Sub-directory of a volume to mount as the root (tenant isolation). */
export function assertSubpath(subpath: unknown): string {
  return assertSegments(subpath, 'Subpath');
}

export function assertMountPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) throw new ValidationError('Mount path must be a non-empty string.');
  if (path.length > 512) throw new ValidationError('Mount path is longer than 512 characters.');
  if (!path.startsWith('/')) throw new ValidationError(`Mount path ${JSON.stringify(path)} must be absolute.`);
  if (!MOUNT_PATH_CHARS.test(path)) {
    throw new ValidationError(`Mount path ${JSON.stringify(path)} contains unsupported characters.`, {
      hint: 'Use letters, digits, ".", "_", "-" and "/" only.',
    });
  }
  if (path === '/') throw new ValidationError('Mount path must not be "/".');
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new ValidationError(`Mount path ${JSON.stringify(path)} must not contain empty, "." or ".." segments.`);
  }
  for (const root of PROTECTED_MOUNT_ROOTS) {
    if (path === root || path.startsWith(`${root}/`)) {
      throw new ValidationError(`Mount path ${JSON.stringify(path)} is inside the protected directory ${root}.`);
    }
  }
  return path;
}

export function assertBucket(bucket: unknown): string {
  if (typeof bucket !== 'string' || !BUCKET.test(bucket) || bucket.includes('..')) {
    throw new ValidationError(`Invalid bucket name ${JSON.stringify(bucket)}.`);
  }
  return bucket;
}

export function assertSandboxId(id: unknown): string {
  if (typeof id !== 'string' || !SANDBOX_ID.test(id)) {
    throw new ValidationError(`Invalid sandbox id ${JSON.stringify(id)}.`);
  }
  return id;
}

/** Credentials and other values that travel as environment variables. */
export function assertEnvValue(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${name} must be a non-empty string.`);
  if (/[\0\r\n]/.test(value)) throw new ValidationError(`${name} must not contain newlines or NUL bytes.`);
  return value;
}

export function assertUrl(name: string, value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${name} ${JSON.stringify(value)} is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${name} must use http or https.`);
  }
  if (/[\s'"\\$`]/.test(value)) throw new ValidationError(`${name} contains unsupported characters.`);
  return value;
}

export function assertInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function assertCacheSize(value: unknown): string {
  if (typeof value !== 'string' || !CACHE_SIZE.test(value)) {
    throw new ValidationError(`cacheMaxSize ${JSON.stringify(value)} must look like "10G", "500M" or "1024" (MiB).`);
  }
  return value;
}

export function assertUmask(value: unknown): string {
  if (typeof value !== 'string' || !UMASK.test(value)) {
    throw new ValidationError(`umask ${JSON.stringify(value)} must be three octal digits, e.g. "022".`);
  }
  return value;
}

/** POSIX single-quote a value for `sh`. Values are validated before they get here; this is defence in depth. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new ValidationError('Values passed to the guest shell must not contain NUL bytes.');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Stable identifier for one (volume, subpath, mountPath) triple inside a sandbox. */
export function mountIdFor(volumeId: string, subpath: string | undefined, mountPath: string): string {
  return createHash('sha256').update(`${volumeId}\0${subpath ?? ''}\0${mountPath}`).digest('hex').slice(0, 16);
}
