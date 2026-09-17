/**
 * Error model. Every failure raised by this library is a {@link VolumeError}
 * with a stable `code`, so callers branch on the code rather than on prose.
 * Messages never contain credentials.
 */
export type VolumeErrorCode =
  | 'VALIDATION'
  | 'VOLUME_NOT_FOUND'
  | 'VOLUME_ALREADY_EXISTS'
  | 'VOLUME_IN_USE'
  | 'CONFIRMATION_REQUIRED'
  | 'STORAGE_AUTH'
  | 'STORAGE_UNREACHABLE'
  | 'BUCKET_NOT_FOUND'
  | 'STORAGE_ERROR'
  | 'SANDBOX_EXEC'
  | 'SANDBOX_EXEC_TIMEOUT'
  | 'FUSE_UNAVAILABLE'
  | 'RUNTIME_INSTALL'
  | 'MOUNT_FAILED'
  | 'MOUNT_TIMEOUT'
  | 'MOUNT_PATH_IN_USE'
  | 'MOUNT_STALE'
  | 'MOUNT_BUSY'
  | 'MOUNT_UNMANAGED'
  | 'FLUSH_FAILED'
  | 'UNSUPPORTED';

export interface VolumeErrorOptions {
  /** Structured context (mount path, sandbox id, guest log tail). Never secrets. */
  details?: Record<string, unknown>;
  /** A short, actionable next step appended to the message. */
  hint?: string;
  cause?: unknown;
}

export class VolumeError extends Error {
  readonly code: VolumeErrorCode;
  readonly details: Record<string, unknown>;
  readonly hint: string | undefined;

  constructor(code: VolumeErrorCode, message: string, options: VolumeErrorOptions = {}) {
    super(options.hint ? `${message} ${options.hint}` : message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VolumeError';
    this.code = code;
    this.details = options.details ?? {};
    this.hint = options.hint;
  }
}

export class ValidationError extends VolumeError {
  constructor(message: string, options: VolumeErrorOptions = {}) {
    super('VALIDATION', message, options);
    this.name = 'ValidationError';
  }
}

export class VolumeNotFoundError extends VolumeError {
  constructor(volumeId: string, options: VolumeErrorOptions = {}) {
    super('VOLUME_NOT_FOUND', `Volume "${volumeId}" does not exist in this namespace.`, {
      hint: 'Create it with create({ name }) or get(name, { create: true }).',
      ...options,
      details: { volumeId, ...options.details },
    });
    this.name = 'VolumeNotFoundError';
  }
}

export class VolumeAlreadyExistsError extends VolumeError {
  constructor(volumeId: string, options: VolumeErrorOptions = {}) {
    super('VOLUME_ALREADY_EXISTS', `Volume "${volumeId}" already exists in this namespace.`, {
      hint: 'Pass { ifNotExists: true } to reuse it, or pick another name.',
      ...options,
      details: { volumeId, ...options.details },
    });
    this.name = 'VolumeAlreadyExistsError';
  }
}

export type StorageErrorCode = 'STORAGE_AUTH' | 'STORAGE_UNREACHABLE' | 'BUCKET_NOT_FOUND' | 'STORAGE_ERROR';

export class StorageError extends VolumeError {
  constructor(code: StorageErrorCode, message: string, options: VolumeErrorOptions = {}) {
    super(code, message, options);
    this.name = 'StorageError';
  }
}

export class SandboxError extends VolumeError {
  constructor(code: 'SANDBOX_EXEC' | 'SANDBOX_EXEC_TIMEOUT', message: string, options: VolumeErrorOptions = {}) {
    super(code, message, options);
    this.name = 'SandboxError';
  }
}

export type MountErrorCode =
  | 'FUSE_UNAVAILABLE'
  | 'RUNTIME_INSTALL'
  | 'MOUNT_FAILED'
  | 'MOUNT_TIMEOUT'
  | 'MOUNT_PATH_IN_USE'
  | 'MOUNT_STALE'
  | 'MOUNT_BUSY'
  | 'MOUNT_UNMANAGED';

export class MountError extends VolumeError {
  constructor(code: MountErrorCode, message: string, options: VolumeErrorOptions = {}) {
    super(code, message, options);
    this.name = 'MountError';
  }
}

/** Thrown by detach when pending writes could not be made durable. The mount is left in place. */
export class FlushError extends VolumeError {
  constructor(message: string, options: VolumeErrorOptions = {}) {
    super('FLUSH_FAILED', message, options);
    this.name = 'FlushError';
  }
}

export function isVolumeError(error: unknown, code?: VolumeErrorCode): error is VolumeError {
  return error instanceof VolumeError && (code === undefined || error.code === code);
}
