/**
 * The `freestyle-volumes` command line. A thin layer over the library: each
 * command maps to one method, prints the method's result as JSON on stdout and
 * reads its configuration from environment variables. Progress goes to stderr.
 */
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv, type ParseArgsConfig } from 'node:util';
import { dockerSandboxes } from './docker.js';
import { isVolumeError } from './errors.js';
import { createVolumeReadySnapshot, freestyleSandboxes, type FreestyleClientLike, type FreestyleSnapshotClientLike } from './freestyle.js';
import type { SandboxResolver } from './sandbox.js';
import { storageConfigFromEnv, type ObjectStore } from './storage.js';
import { FreestyleVolumes, type AttachVolumeOptions, type CheckReport, type DetachAllOptions, type DetachAllResult } from './volumes.js';

type Env = Record<string, string | undefined>;
type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface CliIo {
  env?: Env;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
  /** Replace the S3 client (tests). */
  objectStore?: ObjectStore;
  /** Replace the Freestyle/Docker sandbox resolver (tests). */
  sandboxes?: SandboxResolver;
  /** Use this client instead of constructing one from `FREESTYLE_API_KEY` (tests). */
  freestyle?: FreestyleClientLike & FreestyleSnapshotClientLike;
}

/** Wrong arguments or missing configuration: exit code 2. */
class UsageError extends Error {}

interface Context {
  env: Env;
  io: CliIo;
  values: Values;
  stderr: (text: string) => void;
}

interface Command {
  usage: string;
  summary: string;
  positionals: string[];
  options?: Options;
  run(context: Context, args: string[]): Promise<unknown>;
  /** Exit code for a result that was printed; default 0. */
  exitCode?(result: unknown): number;
}

const GLOBAL_OPTIONS: Options = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'env-file': { type: 'string' },
  prefix: { type: 'string' },
  docker: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
};

const LABEL_OPTION: Options = { label: { type: 'string', multiple: true } };

/** Flag name → attach option. Numbers are parsed here; the library validates ranges. */
const MOUNT_FLAGS: Record<string, { key: keyof AttachVolumeOptions; kind: 'string' | 'integer' | 'boolean' }> = {
  'read-only': { key: 'readOnly', kind: 'boolean' },
  subpath: { key: 'subpath', kind: 'string' },
  uid: { key: 'uid', kind: 'integer' },
  gid: { key: 'gid', kind: 'integer' },
  umask: { key: 'umask', kind: 'string' },
  'cache-mode': { key: 'cacheMode', kind: 'string' },
  'cache-max-size': { key: 'cacheMaxSize', kind: 'string' },
  'write-back': { key: 'writeBackSeconds', kind: 'integer' },
  'dir-cache': { key: 'dirCacheSeconds', kind: 'integer' },
  'buffer-size': { key: 'bufferSize', kind: 'string' },
  'read-ahead': { key: 'readAhead', kind: 'string' },
  'read-chunk-size': { key: 'readChunkSize', kind: 'string' },
  'read-chunk-size-limit': { key: 'readChunkSizeLimit', kind: 'string' },
  transfers: { key: 'transfers', kind: 'integer' },
  'ready-timeout': { key: 'readyTimeoutMs', kind: 'integer' },
  'bootstrap-timeout': { key: 'bootstrapTimeoutMs', kind: 'integer' },
};

const COMMANDS: Record<string, Command> = {
  list: {
    usage: 'list',
    summary: 'List the volumes in the namespace.',
    positionals: [],
    run: async (context) => (await volumesFor(context)).list(),
  },
  get: {
    usage: 'get <volume>',
    summary: 'Show one volume.',
    positionals: ['volume'],
    run: async (context, [name]) => (await volumesFor(context)).get(name!),
  },
  create: {
    usage: 'create <volume> [--label key=value]... [--if-not-exists]',
    summary: 'Create a volume. Names are 1-63 chars of a-z, 0-9 and "-".',
    positionals: ['volume'],
    options: { ...LABEL_OPTION, 'if-not-exists': { type: 'boolean' } },
    run: async (context, [name]) => (await volumesFor(context)).create({ name: name!, labels: labels(context.values), ifNotExists: context.values['if-not-exists'] === true }),
  },
  clone: {
    usage: 'clone <source> <volume> [--label key=value]... [--allow-live-source]',
    summary: 'Copy a quiesced volume server-side; tune with --concurrency <n>.',
    positionals: ['source', 'volume'],
    options: { ...LABEL_OPTION, concurrency: { type: 'string' }, 'allow-live-source': { type: 'boolean' } },
    run: async (context, [sourceVolumeId, name]) => {
      const options: Parameters<FreestyleVolumes['clone']>[0] = { sourceVolumeId: sourceVolumeId!, name: name!, labels: labels(context.values) };
      const concurrency = integer(context.values, 'concurrency');
      if (concurrency !== undefined) options.concurrency = concurrency;
      if (context.values['allow-live-source'] === true) options.allowLiveSource = true;
      return (await volumesFor(context)).clone(options);
    },
  },
  delete: {
    usage: 'delete <volume> --confirm <volume> [--force]',
    summary: 'Delete a volume and every object in it. Repeat the name with --confirm.',
    positionals: ['volume'],
    options: { confirm: { type: 'string' }, force: { type: 'boolean' } },
    run: async (context, [name]) => {
      if (context.values.confirm !== name) throw new UsageError(`Refusing to delete "${name}" and all of its data: repeat the name with --confirm ${name}.`);
      return (await volumesFor(context)).delete({ volumeId: name!, confirm: name!, force: context.values.force === true });
    },
  },
  attachments: {
    usage: 'attachments <volume>',
    summary: 'List the advisory attachment records of a volume.',
    positionals: ['volume'],
    run: async (context, [name]) => {
      const volumes = await volumesFor(context);
      const volume = await volumes.get(name!);
      return volumes.registry.listAttachments(volume.id);
    },
  },
  attach: {
    usage: 'attach <vm> <volume> <mountPath> [mount options]',
    summary: 'Mount a volume into a VM. Installs fuse3 and rclone on first use.',
    positionals: ['vm', 'volume', 'mountPath'],
    options: Object.fromEntries(Object.entries(MOUNT_FLAGS).map(([flag, spec]) => [flag, { type: spec.kind === 'boolean' ? 'boolean' : 'string' }])) as Options,
    run: async (context, [sandboxId, volumeId, mountPath]) => {
      const options: AttachVolumeOptions = { sandboxId: sandboxId!, volumeId: volumeId!, mountPath: mountPath! };
      for (const [flag, spec] of Object.entries(MOUNT_FLAGS)) {
        const value = spec.kind === 'integer' ? integer(context.values, flag) : context.values[flag];
        if (value !== undefined) (options as unknown as Record<string, unknown>)[spec.key] = value;
      }
      return (await volumesFor(context, true)).attach(options);
    },
  },
  inspect: {
    usage: 'inspect <vm> <mountPath>',
    summary: 'Show mount status (mounted/stale/absent/unmanaged) and pending uploads.',
    positionals: ['vm', 'mountPath'],
    run: async (context, [sandboxId, mountPath]) => (await volumesFor(context, true)).inspectMount({ sandboxId: sandboxId!, mountPath: mountPath! }),
  },
  detach: {
    usage: 'detach <vm> <mountPath> [--flush-timeout <ms>] [--force]',
    summary: 'Unmount after every pending upload reached the bucket (flushed: true).',
    positionals: ['vm', 'mountPath'],
    options: { 'flush-timeout': { type: 'string' }, force: { type: 'boolean' } },
    run: async (context, [sandboxId, mountPath]) => {
      const options: Parameters<FreestyleVolumes['detach']>[0] = { sandboxId: sandboxId!, mountPath: mountPath!, force: context.values.force === true };
      const flushTimeoutMs = integer(context.values, 'flush-timeout');
      if (flushTimeoutMs !== undefined) options.flushTimeoutMs = flushTimeoutMs;
      const result = await (await volumesFor(context, true)).detach(options);
      if (result.status === 'detached' && !result.flushed) {
        context.stderr('warning: detached without a verified flush; pending uploads stay in the sandbox cache. Reattach the same volume at the same path to resume them.\n');
      }
      return result;
    },
  },
  mounts: {
    usage: 'mounts <vm>',
    summary: 'List the mounts this library manages in a VM, healthy or stale.',
    positionals: ['vm'],
    run: async (context, [sandboxId]) => (await volumesFor(context, true)).listMounts({ sandboxId: sandboxId! }),
  },
  'detach-all': {
    usage: 'detach-all <vm> [--flush-timeout <ms>] [--force]',
    summary: 'Detach every managed mount in a VM, e.g. before deleting it.',
    positionals: ['vm'],
    options: { 'flush-timeout': { type: 'string' }, force: { type: 'boolean' } },
    run: async (context, [sandboxId]) => {
      const options: DetachAllOptions = { sandboxId: sandboxId!, force: context.values.force === true };
      const flushTimeoutMs = integer(context.values, 'flush-timeout');
      if (flushTimeoutMs !== undefined) options.flushTimeoutMs = flushTimeoutMs;
      const result = await (await volumesFor(context, true)).detachAll(options);
      for (const entry of result.results) {
        if (entry.status === 'failed') context.stderr(`error: ${entry.mountPath ?? 'unreadable state'}: ${entry.error.code}: ${entry.error.message}\n`);
        else if (entry.status === 'detached' && !entry.flushed) context.stderr(`warning: ${entry.mountPath} detached without a verified flush; its pending uploads stay in the sandbox cache.\n`);
      }
      return result;
    },
    exitCode: (result) => ((result as DetachAllResult).results.some((entry) => entry.status === 'failed') ? 1 : 0),
  },
  doctor: {
    usage: 'doctor [--vm <vm>]',
    summary: 'Check the bucket, and with --vm a VM, before the first attach.',
    positionals: [],
    options: { vm: { type: 'string' } },
    run: async (context) => {
      const vm = typeof context.values.vm === 'string' ? context.values.vm : undefined;
      const volumes = await volumesFor(context, vm !== undefined);
      const storage = await volumes.checkStorage();
      printChecks(context, 'storage', storage);
      const report: { ok: boolean; storage: CheckReport; sandbox?: CheckReport } = { ok: storage.ok, storage };
      if (vm !== undefined) {
        report.sandbox = await volumes.checkSandbox({ sandboxId: vm });
        report.ok = report.ok && report.sandbox.ok;
        printChecks(context, vm, report.sandbox);
      }
      return report;
    },
    exitCode: (result) => ((result as { ok: boolean }).ok ? 0 : 1),
  },
  'prepare-snapshot': {
    usage: 'prepare-snapshot [--base <snapshot>] [--slug <slug>] [--name <display name>]',
    summary: 'Build a Freestyle snapshot with fuse3 and rclone preinstalled.',
    positionals: [],
    options: { base: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' } },
    run: async (context) => {
      if (context.values.docker === true) throw new UsageError('prepare-snapshot builds a Freestyle snapshot; it has no --docker mode.');
      const options: Parameters<typeof createVolumeReadySnapshot>[1] = {};
      if (typeof context.values.base === 'string') options.baseSnapshotId = context.values.base;
      if (typeof context.values.slug === 'string') options.slug = context.values.slug;
      if (typeof context.values.name === 'string') options.displayName = context.values.name;
      if (context.values.quiet !== true) options.onEvent = (event) => context.stderr(`[${event.type}] ${event.vmId}${event.message ? ` ${event.message}` : ''}\n`);
      return createVolumeReadySnapshot(await freestyleClient(context), options);
    },
  },
};

const ENVIRONMENT = `Environment:
  VOLUMES_S3_BUCKET             bucket that holds the volumes (must exist)
  VOLUMES_S3_ACCESS_KEY_ID      storage credentials, also given to rclone
  VOLUMES_S3_SECRET_ACCESS_KEY
  VOLUMES_S3_ENDPOINT           S3 API URL; omit for AWS S3
  VOLUMES_S3_SANDBOX_ENDPOINT   S3 API URL as the VM sees it, if different
  VOLUMES_S3_REGION             e.g. auto for Cloudflare R2; default us-east-1
  VOLUMES_S3_PREFIX             bucket namespace; default freestyle-volumes
  VOLUMES_S3_PROVIDER           rclone hint: AWS, Cloudflare, Minio, Ceph, Other
  VOLUMES_S3_FORCE_PATH_STYLE   true or false; default true with an endpoint
  VOLUMES_S3_SESSION_TOKEN      for temporary credentials
  FREESTYLE_API_KEY             for every command that takes a VM`;

function helpText(version: string): string {
  const commands = Object.values(COMMANDS).map((command) => `  ${command.usage}\n      ${command.summary}`).join('\n');
  const mountFlags = Object.entries(MOUNT_FLAGS).map(([flag, spec]) => `--${flag}${spec.kind === 'boolean' ? '' : ` <${spec.kind === 'integer' ? 'n' : 'value'}>`}`);
  return `freestyle-volumes ${version}
Daytona-style persistent volumes for Freestyle VMs, backed by an S3 bucket.

Usage: freestyle-volumes <command> [arguments] [options]

Commands:
${commands}

Mount options (attach):
  ${wrap(mountFlags, 76, '  ')}

Global options:
  --env-file <path>   load variables from a file; variables already set win
  --prefix <prefix>   namespace inside the bucket (overrides VOLUMES_S3_PREFIX)
  --docker            <vm> is a local Docker container started with /dev/fuse
  -q, --quiet         no progress output on stderr
  -h, --help          show this help
  -v, --version       show the version

${ENVIRONMENT}

Every command prints JSON on stdout and progress on stderr.
Exit codes: 0 success, 1 operation failed, 2 usage or configuration error.
Docs: https://github.com/reachjalil/freestyle-volumes#readme
`;
}

/** A readable checklist on stderr; the JSON report goes to stdout. */
function printChecks(context: Context, scope: string, report: CheckReport): void {
  if (context.values.quiet === true) return;
  for (const check of report.checks) {
    const mark = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL';
    context.stderr(`${mark} ${scope} ${check.name}: ${check.detail}\n`);
    if (check.hint) context.stderr(`     ${check.hint}\n`);
  }
}

/** Join items with spaces, breaking lines between items only. */
function wrap(items: string[], width: number, indent: string): string {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (line && line.length + 1 + item.length > width) {
      lines.push(line);
      line = item;
    } else {
      line = line ? `${line} ${item}` : item;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function labels(values: Values): Record<string, string> | undefined {
  const pairs = values.label;
  if (!Array.isArray(pairs) || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    if (typeof pair !== 'string') continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--label ${JSON.stringify(pair)} must look like key=value.`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function integer(values: Values, flag: string): number | undefined {
  const value = values[flag];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) throw new UsageError(`--${flag} must be an integer.`);
  return Number(value);
}

/** Variables that are set and non-empty in the real environment win over the file, like `node --env-file`. */
function mergeEnv(file: Env, real: Env): Env {
  const env: Env = { ...file };
  for (const [key, value] of Object.entries(real)) {
    if (value) env[key] = value;
  }
  return env;
}

function readEnvFile(path: string): Env {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`Could not read --env-file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseEnv(text);
}

async function freestyleClient(context: Context): Promise<FreestyleClientLike & FreestyleSnapshotClientLike> {
  if (context.io.freestyle) return context.io.freestyle;
  const apiKey = context.env.FREESTYLE_API_KEY;
  if (!apiKey) throw new UsageError('FREESTYLE_API_KEY is not set. Create an API key in the Freestyle dashboard (https://dash.freestyle.sh), or pass --docker to target a local container.');
  let sdk: { Freestyle: new (options: { apiKey: string }) => FreestyleClientLike & FreestyleSnapshotClientLike };
  try {
    sdk = (await import('freestyle')) as unknown as typeof sdk;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new UsageError('The Freestyle SDK is not installed. Run `npm install freestyle` in the project that has freestyle-volumes.');
    }
    throw error;
  }
  return new sdk.Freestyle({ apiKey });
}

async function volumesFor(context: Context, needsSandbox = false): Promise<FreestyleVolumes> {
  const storage = storageConfigFromEnv(context.env);
  if (typeof context.values.prefix === 'string') storage.prefix = context.values.prefix;
  let sandboxes: SandboxResolver;
  if (context.io.sandboxes) sandboxes = context.io.sandboxes;
  else if (context.values.docker === true) sandboxes = dockerSandboxes();
  else if (needsSandbox) sandboxes = freestyleSandboxes(await freestyleClient(context));
  else sandboxes = { get: () => Promise.reject(new UsageError('This command does not use a sandbox.')) };
  const options: ConstructorParameters<typeof FreestyleVolumes>[0] = { storage, sandboxes };
  if (context.io.objectStore) options.objectStore = context.io.objectStore;
  if (context.values.quiet !== true) {
    options.onEvent = (event) => {
      const where = [event.sandboxId, event.mountPath, event.volumeId].filter(Boolean).join(' ');
      context.stderr(`[${event.type}]${where ? ` ${where}` : ''}${event.message ? ` (${event.message})` : ''}\n`);
    };
  }
  return new FreestyleVolumes(options);
}

function describeError(error: unknown): string {
  if (isVolumeError(error)) {
    const details = Object.keys(error.details).length > 0 ? `\n${JSON.stringify(error.details, null, 2)}` : '';
    return `${error.code}: ${error.message}${details}`;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Every option any command accepts, so the command name can be found wherever the options sit. */
const ALL_OPTIONS: Options = Object.assign({}, GLOBAL_OPTIONS, ...Object.values(COMMANDS).map((command) => command.options ?? {}));

function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}

/** Run the CLI with `argv` (without the node and script paths). Resolves to the process exit code. */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = (text: string) => void (io.stdout ?? process.stdout).write(text);
  const err = (text: string) => void (io.stderr ?? process.stderr).write(text);
  const version = packageVersion();
  let name: string | undefined;
  try {
    name = parseArgs({ args: argv, options: ALL_OPTIONS, allowPositionals: true, strict: false }).positionals[0];
  } catch {
    name = undefined;
  }
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  try {
    if (name !== undefined && command === undefined) throw new UsageError(`Unknown command "${name}". Run freestyle-volumes --help for the list.`);
    const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...command?.options }, allowPositionals: true, strict: true });
    if (values.version === true) {
      out(`${version}\n`);
      return 0;
    }
    if (values.help === true) {
      out(helpText(version));
      return 0;
    }
    if (command === undefined) {
      err(helpText(version));
      return 2;
    }
    const args = positionals.slice(1);
    if (args.length !== command.positionals.length) throw new UsageError(`Usage: freestyle-volumes ${command.usage}`);
    const envFile = values['env-file'];
    const env = mergeEnv(typeof envFile === 'string' ? readEnvFile(envFile) : {}, io.env ?? process.env);
    const result = await command.run({ env, io, values, stderr: err }, args);
    out(`${JSON.stringify(result, null, 2)}\n`);
    return command.exitCode?.(result) ?? 0;
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      err(`freestyle-volumes: ${(error as Error).message}\n`);
      return 2;
    }
    err(`freestyle-volumes: ${describeError(error)}\n`);
    // Invalid names, paths or option values are usage errors, whichever layer caught them.
    return isVolumeError(error, 'VALIDATION') ? 2 : 1;
  }
}
