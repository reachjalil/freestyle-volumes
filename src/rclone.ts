/**
 * rclone backend: everything that runs inside the sandbox. Each operation is
 * one POSIX `sh` script executed as root through {@link SandboxRuntime.exec}.
 * Scripts print machine-readable `FSVOL_*` lines that the host parses.
 *
 * Credentials never appear in these scripts. They reach rclone only through
 * `RCLONE_CONFIG_FSVOL_*` environment variables (see storage.ts).
 */
import { MountError, VolumeError } from './errors.js';
import { runGuest, type GuestRun, type SandboxRuntime } from './sandbox.js';
import { shellQuote as q } from './validate.js';

/** rclone release installed when the sandbox has none (or an older one). */
export const RCLONE_VERSION = '1.75.1';
/** Oldest rclone accepted if the sandbox already ships one (needs `vfs/queue` and unix-socket rc). */
export const RCLONE_MIN_VERSION = '1.68.0';
/** SHA-256 of the official release archives, verified before install. */
export const RCLONE_SHA256: Record<'amd64' | 'arm64', string> = {
  amd64: '982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab',
  arm64: '03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9',
};

export interface GuestPaths {
  /** Per-mount state: pid, run script, log, mount.json. */
  stateRoot: string;
  /** rclone remote-control unix sockets. */
  runRoot: string;
  /** rclone VFS cache (write-back buffer). Pending uploads live here. */
  cacheRoot: string;
  /** Where a downloaded rclone binary is installed. */
  binDir: string;
}

export const DEFAULT_GUEST_PATHS: GuestPaths = {
  stateRoot: '/var/lib/freestyle-volumes',
  runRoot: '/run/freestyle-volumes',
  cacheRoot: '/var/cache/freestyle-volumes',
  binDir: '/opt/freestyle-volumes/bin',
};

export type CacheMode = 'writes' | 'full';

export interface MountSpec {
  mountId: string;
  /** `fsvol:bucket/prefix/v/<volume>[/subpath]` */
  remotePath: string;
  mountPath: string;
  readOnly: boolean;
  cacheMode: CacheMode;
  writeBackSeconds: number;
  dirCacheSeconds: number;
  allowOther: boolean;
  uid?: number;
  gid?: number;
  umask?: string;
  cacheMaxSize?: string;
  /** rclone SizeSuffix (e.g. "16M" or "16777216B"); per-open-file memory buffer. */
  bufferSize?: string;
  /** Extra disk read-ahead in full cache mode; rclone SizeSuffix. */
  readAhead?: string;
  /** Initial sequential read chunk size; rclone SizeSuffix. */
  readChunkSize?: string;
  /** Sequential chunk growth limit; rclone SizeSuffix, or "off" for unlimited. */
  readChunkSizeLimit?: string;
  /** Daemon-wide concurrent file transfers; public validation must enforce integer 1..64. */
  transfers?: number;
  readyTimeoutMs: number;
  /** JSON document stored as mount.json in the sandbox. Must not contain single quotes. */
  stateJson: string;
}

export interface GuestOutput {
  result?: Record<string, string>;
  error?: { code: string; detail: string };
  blocks: Record<string, string[]>;
}

export function parseGuestOutput(stdout: string): GuestOutput {
  const out: GuestOutput = { blocks: {} };
  let current: string | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (current !== undefined) {
      if (line === `FSVOL_${current}_END`) current = undefined;
      else out.blocks[current]?.push(line);
      continue;
    }
    const begin = /^FSVOL_([A-Z]+)_BEGIN$/.exec(line);
    if (begin) {
      current = begin[1];
      out.blocks[current as string] = [];
      continue;
    }
    if (line.startsWith('FSVOL_ERR ')) {
      const rest = line.slice('FSVOL_ERR '.length);
      const space = rest.indexOf(' ');
      out.error = { code: space === -1 ? rest : rest.slice(0, space), detail: space === -1 ? '' : rest.slice(space + 1) };
      continue;
    }
    if (line.startsWith('FSVOL_RESULT ')) {
      const result: Record<string, string> = {};
      for (const pair of line.slice('FSVOL_RESULT '.length).split(' ')) {
        const eq = pair.indexOf('=');
        if (eq > 0) result[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      out.result = result;
    }
  }
  return out;
}

export interface RcloneVfsStats {
  uploadsQueued: number;
  uploadsInProgress: number;
  erroredFiles: number;
  cacheBytes: number;
  cachedFiles: number;
}

export function parseVfsStats(lines: string[] | undefined): RcloneVfsStats | undefined {
  if (!lines || lines.length === 0) return undefined;
  try {
    const parsed = JSON.parse(lines.join('\n')) as { diskCache?: Record<string, unknown> };
    const cache = parsed.diskCache ?? {};
    for (const key of ['uploadsQueued', 'uploadsInProgress', 'erroredFiles']) {
      if (typeof cache[key] !== 'number' || !Number.isSafeInteger(cache[key]) || (cache[key] as number) < 0) return undefined;
    }
    const num = (key: string) => (typeof cache[key] === 'number' ? (cache[key] as number) : 0);
    return { uploadsQueued: num('uploadsQueued'), uploadsInProgress: num('uploadsInProgress'), erroredFiles: num('erroredFiles'), cacheBytes: num('bytesUsed'), cachedFiles: num('files') };
  } catch {
    return undefined;
  }
}

export interface RuntimeInfo {
  rclonePath: string;
  rcloneVersion: string;
  fusermountPath: string;
  arch: string;
}

export interface GuestMountResult {
  pid: number;
  /** Reused mounts retain their existing options; requested tuning was not applied. */
  alreadyAttached: boolean;
}

export interface GuestMountInspection {
  mounted: boolean;
  hasState: boolean;
  alive: boolean;
  responsive: boolean;
  pid: number | null;
  readOnly: boolean | null;
  source: string | null;
  mountId: string | null;
  state: Record<string, unknown> | null;
  stats: RcloneVfsStats | null;
  logTail: string[];
}

export interface GuestDetachResult {
  status: 'detached' | 'absent';
  flushed: boolean;
  /** Uploads still pending when the mount was dropped; null when unknown. Always 0 after a flushed detach. */
  pending: number | null;
  volumeId: string | null;
  mountId: string | null;
  readOnly: boolean | null;
}

function prelude(paths: GuestPaths): string {
  return `set -u
umask 077
export RCLONE_CONFIG=/dev/null
export LC_ALL=C
STATE_ROOT=${q(paths.stateRoot)}
RUN_ROOT=${q(paths.runRoot)}
CACHE_ROOT=${q(paths.cacheRoot)}
BIN_DIR=${q(paths.binDir)}
have() { command -v "$1" >/dev/null 2>&1; }
# BusyBox timeout's watchdog can outlive its command. Only the lifecycle
# shell may retain the lock; neither the command nor its watchdog needs it.
timeout() { command timeout "$@" 8>&-; }
fsvol_rclone() { if [ -x "$BIN_DIR/rclone" ]; then echo "$BIN_DIR/rclone"; elif have rclone; then command -v rclone; else return 1; fi; }
fsvol_fusermount() { if have fusermount3; then command -v fusermount3; elif have fusermount; then command -v fusermount; else return 1; fi; }
fsvol_mounted() { awk -v m="$1" '$2 == m && $3 == "fuse.rclone" { found=1 } END { exit !found }' /proc/mounts; }
fsvol_mount_source() { awk -v m="$1" '$2 == m && $3 == "fuse.rclone" { s = $1 } END { print s }' /proc/mounts; }
fsvol_mount_ro() { awk -v m="$1" '$2 == m && $3 == "fuse.rclone" { o = $4 } END { if (o ~ /^ro(,|$)/) print 1; else print 0 }' /proc/mounts; }
fsvol_log_tail() { if [ -f "$1" ]; then echo FSVOL_LOG_BEGIN; tail -n 25 "$1"; echo FSVOL_LOG_END; fi; }
fsvol_find_state() { d=""; for f in "$STATE_ROOT"/mounts/*/mount.json; do [ -f "$f" ] || continue; if grep -q -F "\\"mountPath\\":\\"$1\\"" "$f"; then d=$(dirname "$f"); fi; done; echo "$d"; }
fsvol_pid_alive() { case "$1" in ''|*[!0-9]*|0|1) return 1;; esac; kill -0 "$1" 2>/dev/null || return 1; st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d" " -f1); [ -n "$st" ] && [ "$st" != "Z" ]; }
fsvol_start() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
# The start time survives exec and distinguishes a reused PID. Fail closed for
# legacy state without an identity record; never signal a process by PID alone.
fsvol_owned() {
  fsvol_pid_alive "$1" || return 1
  [ -s "$SD/pid.start" ] && [ "$(cat "$SD/pid.start")" = "$(fsvol_start "$1")" ] || return 1
  [ -s "$SD/pid.exe" ] && [ "$(cat "$SD/pid.exe")" = "$(readlink "/proc/$1/exe")" ] || return 1
  tr '\\000' '\\n' < "/proc/$1/cmdline" | grep -F -x -- "unix://$SOCK" >/dev/null || return 1
}
# Lock the path (not the volume ID): competing mounts of different volumes at
# one path must serialize too. Persistent lock files must never be unlinked.
fsvol_lock() {
  # Reject symlink aliases before locking or touching state: lexical path
  # validation alone cannot protect OS directories or serialize alias paths.
  p="$MP"
  while [ "$p" != / ]; do
    [ ! -L "$p" ] || { echo 'FSVOL_ERR path-in-use symlink-mount-path'; exit 20; }
    p=\${p%/*}; [ -n "$p" ] || p=/
  done
  have flock || { echo 'FSVOL_ERR tool-missing flock'; exit 13; }
  mkdir -p "$STATE_ROOT/locks" || exit 11
  lk=$(printf '%s' "$MP" | sha256sum); lk=\${lk%% *}
  exec 8>"$STATE_ROOT/locks/$lk.lock"
  flock -n 8 || { echo 'FSVOL_ERR lifecycle-busy'; exit 36; }
}
fsvol_now() { cut -d. -f1 /proc/uptime; }
`;
}

function versionParts(version: string): [number, number] {
  const [major = '0', minor = '0'] = version.split('.');
  return [Number(major), Number(minor)];
}

export function bootstrapScript(paths: GuestPaths): string {
  const [minMajor, minMinor] = versionParts(RCLONE_MIN_VERSION);
  return `${prelude(paths)}
umask 022
mkdir -p "$STATE_ROOT/mounts" "$RUN_ROOT" "$CACHE_ROOT" "$BIN_DIR" || { echo "FSVOL_ERR mkdir"; exit 11; }
chmod 700 "$STATE_ROOT" "$RUN_ROOT" "$CACHE_ROOT" 2>/dev/null
[ -e /dev/fuse ] || { echo "FSVOL_ERR no-dev-fuse"; exit 12; }
exec 9>"$STATE_ROOT/bootstrap.lock"
if have flock; then n=0; until flock -n 9; do n=$((n+1)); [ $n -ge 240 ] && { echo "FSVOL_ERR lock-timeout"; exit 11; }; sleep 1; done; fi
apt_install() { export DEBIAN_FRONTEND=noninteractive; apt-get install -y -q "$@" >>"$STATE_ROOT/apt.log" 2>&1 && return 0; apt-get update -q >>"$STATE_ROOT/apt.log" 2>&1 && apt-get install -y -q "$@" >>"$STATE_ROOT/apt.log" 2>&1; }
pkg_install() { if have apt-get; then apt_install "$@"; elif have apk; then apk add --no-cache "$@" >>"$STATE_ROOT/apk.log" 2>&1; else return 1; fi; }
if ! have fusermount3 && ! have fusermount; then pkg_install fuse3 || { echo "FSVOL_ERR fuse3-install"; tail -n 5 "$STATE_ROOT/apt.log" "$STATE_ROOT/apk.log" 2>/dev/null; exit 13; }; fi
if ! have flock; then pkg_install util-linux || { echo 'FSVOL_ERR tool-missing flock'; exit 13; }; fi
fsvol_fusermount >/dev/null || { echo "FSVOL_ERR fuse3-missing"; exit 13; }
for t in setsid timeout awk sha256sum sed grep flock readlink tr; do have "$t" || { echo "FSVOL_ERR tool-missing $t"; exit 13; }; done
rclone_ok() { b="$1"; v=$("$b" version 2>/dev/null | sed -n '1s/^rclone v\\([0-9][0-9.]*\\).*/\\1/p'); [ -n "$v" ] || return 1; maj=$(echo "$v" | cut -d. -f1); min=$(echo "$v" | cut -d. -f2); [ -n "$min" ] || min=0; [ "$maj" -gt ${minMajor} ] && return 0; [ "$maj" -eq ${minMajor} ] && [ "$min" -ge ${minMinor} ]; }
RC=""
if [ -x "$BIN_DIR/rclone" ] && rclone_ok "$BIN_DIR/rclone"; then RC="$BIN_DIR/rclone"; elif have rclone && rclone_ok "$(command -v rclone)"; then RC="$(command -v rclone)"; fi
if [ -z "$RC" ]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) a=amd64; sha=${q(RCLONE_SHA256.amd64)};;
    aarch64|arm64) a=arm64; sha=${q(RCLONE_SHA256.arm64)};;
    *) echo "FSVOL_ERR unsupported-arch $arch"; exit 14;;
  esac
  if ! have curl && ! have wget; then pkg_install curl ca-certificates || { echo "FSVOL_ERR no-downloader"; exit 14; }; fi
  if ! have unzip && ! have python3 && ! have busybox; then pkg_install unzip || true; fi
  tmp=$(mktemp -d "$STATE_ROOT/dl.XXXXXX") || { echo "FSVOL_ERR tmp"; exit 14; }
  url=${q(`https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-`)}"$a.zip"
  if have curl; then curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/rclone.zip" "$url"; else wget -q -T 60 -O "$tmp/rclone.zip" "$url"; fi || { echo "FSVOL_ERR download $url"; rm -rf "$tmp"; exit 14; }
  echo "$sha  $tmp/rclone.zip" | sha256sum -c - >/dev/null 2>&1 || { echo "FSVOL_ERR checksum-mismatch $url"; rm -rf "$tmp"; exit 15; }
  inner=${q(`rclone-v${RCLONE_VERSION}-linux-`)}"$a/rclone"
  if have unzip; then unzip -q -o -j "$tmp/rclone.zip" "$inner" -d "$tmp" >/dev/null 2>&1
  elif have python3; then python3 -c 'import sys, zipfile; open(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$tmp/rclone.zip" "$inner" "$tmp/rclone"
  elif have busybox; then (cd "$tmp" && busybox unzip -q -o rclone.zip "$inner" >/dev/null 2>&1 && mv "$inner" rclone)
  else echo "FSVOL_ERR no-unzip"; rm -rf "$tmp"; exit 14; fi
  [ -f "$tmp/rclone" ] || { echo "FSVOL_ERR extract"; rm -rf "$tmp"; exit 14; }
  install -m 755 "$tmp/rclone" "$BIN_DIR/rclone" || { echo "FSVOL_ERR install"; rm -rf "$tmp"; exit 14; }
  rm -rf "$tmp"
  RC="$BIN_DIR/rclone"
  rclone_ok "$RC" || { echo "FSVOL_ERR rclone-broken"; exit 14; }
fi
echo "FSVOL_RESULT rclone=$RC version=$("$RC" version 2>/dev/null | sed -n '1s/^rclone v//p') fusermount=$(fsvol_fusermount) arch=$(uname -m)"
`;
}

export function mountFlags(spec: MountSpec): string {
  const flags = [
    '--vfs-cache-mode', spec.cacheMode,
    '--vfs-write-back', `${spec.writeBackSeconds}s`,
    '--dir-cache-time', `${spec.dirCacheSeconds}s`,
    '--poll-interval', '0',
  ];
  if (spec.cacheMaxSize !== undefined) flags.push('--vfs-cache-max-size', spec.cacheMaxSize);
  if (spec.bufferSize !== undefined) flags.push('--buffer-size', spec.bufferSize);
  if (spec.readAhead !== undefined) flags.push('--vfs-read-ahead', spec.readAhead);
  if (spec.readChunkSize !== undefined) flags.push('--vfs-read-chunk-size', spec.readChunkSize);
  if (spec.readChunkSizeLimit !== undefined) flags.push('--vfs-read-chunk-size-limit', spec.readChunkSizeLimit);
  if (spec.transfers !== undefined) flags.push('--transfers', String(spec.transfers));
  if (spec.allowOther) flags.push('--allow-other');
  if (spec.uid !== undefined) flags.push('--uid', String(spec.uid));
  if (spec.gid !== undefined) flags.push('--gid', String(spec.gid));
  if (spec.umask !== undefined) flags.push('--umask', spec.umask);
  if (spec.readOnly) flags.push('--read-only');
  return flags.join(' ');
}

export function mountScript(paths: GuestPaths, spec: MountSpec): string {
  // rclone v1.68.0 and v1.75.1: cmd/mountlib/{mount,rc}.go and
  // cmd/mount/mount.go. External fusermount ends Wait(), but does not call
  // VFS.Shutdown(). rcd keeps that VFS alive for a post-unmount drain;
  // mount/unmount would shut it down too early and must NOT be used here.
  const readySeconds = Math.max(1, Math.ceil(spec.readyTimeoutMs / 1000));
  const mountOptions = JSON.stringify({ AllowOther: spec.allowOther });
  // Verified against v1.68.0 and v1.75.1 vfs/vfscommon/options.go and
  // fs/config.go: BufferSize/Transfers are global, not vfsOpt fields.
  // SizeSuffix JSON strings use fs/sizesuffix.go parsing (bare numbers are
  // KiB, explicit B means bytes). Preserve the caller's validated units.
  const daemonFlags: string[] = [];
  if (spec.bufferSize !== undefined) daemonFlags.push('--buffer-size', spec.bufferSize);
  if (spec.transfers !== undefined) daemonFlags.push('--transfers', String(spec.transfers));
  const vfsOptions = JSON.stringify({
    CacheMode: spec.cacheMode === 'writes' ? 2 : 3, WriteBack: `${spec.writeBackSeconds}s`,
    DirCacheTime: `${spec.dirCacheSeconds}s`, PollInterval: '0s', ReadOnly: spec.readOnly,
    ...(spec.uid === undefined ? {} : { UID: spec.uid }), ...(spec.gid === undefined ? {} : { GID: spec.gid }),
    ...(spec.umask === undefined ? {} : { Umask: parseInt(spec.umask, 8) }),
    ...(spec.cacheMaxSize === undefined ? {} : { CacheMaxSize: spec.cacheMaxSize }),
    ...(spec.readAhead === undefined ? {} : { ReadAhead: spec.readAhead }),
    ...(spec.readChunkSize === undefined ? {} : { ChunkSize: spec.readChunkSize }),
    ...(spec.readChunkSizeLimit === undefined ? {} : { ChunkSizeLimit: spec.readChunkSizeLimit }),
  });
  if (spec.stateJson.includes("'")) throw new VolumeError('VALIDATION', 'Mount state must not contain single quotes.');
  return `${prelude(paths)}
RC=$(fsvol_rclone) || { echo "FSVOL_ERR rclone-missing"; exit 14; }
FM=$(fsvol_fusermount) || { echo "FSVOL_ERR fuse3-missing"; exit 13; }
MP=${q(spec.mountPath)}
fsvol_lock
deadline=$(($(fsvol_now) + ${readySeconds}))
MID=${q(spec.mountId)}
REMOTE=${q(spec.remotePath)}
RO=${spec.readOnly ? 1 : 0}
SD="$STATE_ROOT/mounts/$MID"; SOCK="$RUN_ROOT/$MID.sock"; CACHE="$CACHE_ROOT/$MID"; LOG="$SD/rclone.log"
mkdir -p "$SD" "$CACHE" "$RUN_ROOT" || { echo "FSVOL_ERR mkdir"; exit 11; }
pid=""; [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null)
if [ -f "$SD/mount.json" ] && [ ! -f "$SD/stopped" ]; then
  case "$pid" in ''|*[!0-9]*|0|1) echo 'FSVOL_ERR path-in-use process-identity-missing'; exit 20;; esac
fi
alive=0; fsvol_owned "$pid" && alive=1
if fsvol_mounted "$MP"; then
  if [ "$(fsvol_find_state "$MP")" != "$SD" ] || ! grep -q -F "\\"mountId\\":\\"$MID\\"" "$SD/mount.json"; then echo 'FSVOL_ERR path-in-use mount-identity-mismatch'; exit 20; fi
  src=$(fsvol_mount_source "$MP")
  if [ "\${src#*:}" != "\${REMOTE#*:}" ]; then echo "FSVOL_ERR path-in-use $src"; exit 20; fi
  if [ "$alive" = 1 ] && timeout ${readySeconds} stat "$MP" >/dev/null 2>&1; then
    if [ "$(fsvol_mount_ro "$MP")" != "$RO" ]; then echo "FSVOL_ERR path-in-use read-only-mismatch"; exit 20; fi
    echo "FSVOL_RESULT status=attached already=1 pid=$pid"; exit 0
  fi
  echo "FSVOL_ERR path-in-use stale-mount-requires-detach"; exit 20
fi
if fsvol_pid_alive "$pid"; then echo "FSVOL_ERR path-in-use existing-process-requires-detach"; exit 20; fi
OTHER=$(fsvol_find_state "$MP")
if [ -n "$OTHER" ] && [ "$OTHER" != "$SD" ]; then echo "FSVOL_ERR path-in-use stale-state $(basename "$OTHER")"; exit 20; fi
(umask 022; mkdir -p "$MP") || { echo "FSVOL_ERR mountpoint-create"; exit 21; }
[ -d "$MP" ] || { echo "FSVOL_ERR mountpoint-not-dir"; exit 21; }
if grep -q " $MP " /proc/mounts; then echo "FSVOL_ERR path-in-use foreign-mount"; exit 20; fi
if [ -n "$(ls -A "$MP" 2>/dev/null)" ]; then echo "FSVOL_ERR mountpoint-not-empty"; exit 21; fi
# Preserve stopped/PID evidence until preflight succeeds: a rejected reattach
# must remain recoverable, including when a forced detach left no PID file.
rm -f "$SOCK" "$SD/pid" "$SD/pid.start" "$SD/pid.exe" "$SD/quiesced" "$SD/stopped"
printf '%s\\n' ${q(spec.stateJson)} > "$SD/mount.json"
printf '%s\\n' "$REMOTE" > "$SD/remote"
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
: > "$SD/stderr.log"
${daemonFlags.length ? `DAEMON_FLAGS=${q(daemonFlags.map(q).join(' '))}\n` : ''}\
cat > "$SD/run.sh" <<FSVOL_RUN
echo \\$\\$ > '$SD/pid'
sed 's/.*) //' /proc/\\$\\$/stat | cut -d' ' -f20 > '$SD/pid.start'
readlink -f '$RC' > '$SD/pid.exe'
exec '$RC' rcd --cache-dir '$CACHE' --rc-addr 'unix://$SOCK' --rc-no-auth --log-file '$LOG' --log-level INFO${daemonFlags.length ? ' $DAEMON_FLAGS' : ''}
FSVOL_RUN
fail_cleanup() { :; } # Keep recovery metadata and cache on any uncertainty.
echo rcd > "$SD/driver"
setsid sh "$SD/run.sh" 8>&- </dev/null >/dev/null 2>>"$SD/stderr.log" &
created=0; pid=""
while [ "$(fsvol_now)" -lt "$deadline" ]; do
  [ -z "$pid" ] && [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! fsvol_pid_alive "$pid"; then
    echo "FSVOL_ERR process-exited"; fsvol_log_tail "$LOG"
    if [ -s "$SD/stderr.log" ]; then echo FSVOL_STDERR_BEGIN; tail -n 10 "$SD/stderr.log"; echo FSVOL_STDERR_END; fi
    fail_cleanup; exit 22
  fi
  remaining=$((deadline - $(fsvol_now))); [ "$remaining" -gt 0 ] || break
  if [ "$created" = 0 ] && fsvol_owned "$pid" && [ -S "$SOCK" ]; then
    created=1
    if ! timeout "$remaining" "$RC" rc --unix-socket "$SOCK" mount/mount "fs=$REMOTE" "mountPoint=$MP" mountType=mount ${q(`mountOpt=${mountOptions}`)} ${q(`vfsOpt=${vfsOptions}`)} >>"$SD/stderr.log" 2>&1; then
      echo 'FSVOL_ERR mount-create-failed'; fsvol_log_tail "$LOG"
      echo FSVOL_STDERR_BEGIN; tail -n 10 "$SD/stderr.log"; echo FSVOL_STDERR_END; exit 22
    fi
  fi
  remaining=$((deadline - $(fsvol_now))); [ "$remaining" -gt 0 ] || break
  if fsvol_owned "$pid" && fsvol_mounted "$MP" && timeout "$remaining" ls "$MP" >/dev/null 2>&1; then echo "FSVOL_RESULT status=attached already=0 pid=$pid"; exit 0; fi
  sleep 0.25
done
echo "FSVOL_ERR ready-timeout"; fsvol_log_tail "$LOG"
if [ -s "$SD/stderr.log" ]; then echo FSVOL_STDERR_BEGIN; tail -n 10 "$SD/stderr.log"; echo FSVOL_STDERR_END; fi
fail_cleanup; exit 23
`;
}

export function inspectScript(paths: GuestPaths, mountPath: string): string {
  return `${prelude(paths)}
MP=${q(mountPath)}
fsvol_lock
RC=$(fsvol_rclone) || RC=""
mounted=0; fsvol_mounted "$MP" && mounted=1
src=""; ro=""
if [ "$mounted" = 1 ]; then src=$(fsvol_mount_source "$MP"); ro=$(fsvol_mount_ro "$MP"); fi
SD=$(fsvol_find_state "$MP")
state=0; pid=""; alive=0; responsive=0; mid=""
if [ -n "$SD" ]; then state=1; mid=$(basename "$SD"); SOCK="$RUN_ROOT/$mid.sock"; [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null); fsvol_owned "$pid" && alive=1; fi
if [ "$mounted" = 1 ] && timeout 5 stat "$MP" >/dev/null 2>&1; then responsive=1; fi
echo "FSVOL_RESULT mounted=$mounted state=$state alive=$alive responsive=$responsive pid=$pid ro=$ro src=$src mid=$mid"
if [ -n "$SD" ] && [ -f "$SD/mount.json" ]; then echo FSVOL_STATE_BEGIN; cat "$SD/mount.json"; echo; echo FSVOL_STATE_END; fi
if [ "$alive" = 1 ] && [ -n "$RC" ] && [ -S "$RUN_ROOT/$mid.sock" ]; then echo FSVOL_STATS_BEGIN; timeout 10 "$RC" rc --unix-socket "$RUN_ROOT/$mid.sock" vfs/stats 2>/dev/null; echo FSVOL_STATS_END; fi
[ -n "$SD" ] && fsvol_log_tail "$SD/rclone.log"
exit 0
`;
}

export function detachScript(paths: GuestPaths, options: { mountPath: string; flushTimeoutMs: number; force: boolean }): string {
  const flushSeconds = Math.max(1, Math.ceil(options.flushTimeoutMs / 1000));
  return `${prelude(paths)}
MP=${q(options.mountPath)}
fsvol_lock
FLUSH=${flushSeconds}
FORCE=${options.force ? 1 : 0}
FM=$(fsvol_fusermount) || FM=""
RC=$(fsvol_rclone) || RC=""
mounted=0; fsvol_mounted "$MP" && mounted=1
src=""; [ "$mounted" = 1 ] && src=$(fsvol_mount_source "$MP")
SD=$(fsvol_find_state "$MP")
if [ -z "$SD" ]; then
  if [ "$mounted" = 1 ]; then echo "FSVOL_ERR unmanaged $src"; exit 34; fi
  echo "FSVOL_RESULT status=absent"; exit 0
fi
MID=$(basename "$SD"); SOCK="$RUN_ROOT/$MID.sock"; LOG="$SD/rclone.log"; CACHE="$CACHE_ROOT/$MID"
vol=$(sed -n 's/.*"volumeId":"\\([^"]*\\)".*/\\1/p' "$SD/mount.json" 2>/dev/null)
rostate=0; grep -q '"readOnly":true' "$SD/mount.json" 2>/dev/null && rostate=1
pid=""; [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null)
alive=0; fsvol_owned "$pid" && alive=1
ro="$rostate"; [ "$mounted" = 1 ] && ro=$(fsvol_mount_ro "$MP")
deadline=$(($(fsvol_now) + FLUSH))
rc() { remaining=$((deadline - $(fsvol_now))); [ "$remaining" -gt 0 ] && fsvol_owned "$pid" && [ -n "$RC" ] && [ -S "$SOCK" ] && timeout "$remaining" "$RC" rc --unix-socket "$SOCK" "$@" 2>/dev/null; }
num() { sed -n "s/^[[:space:]]*\\"$1\\": *\\([0-9][0-9]*\\)[,[:space:]]*$/\\1/p" | head -n 1; }
expedite() { qout=$(rc vfs/queue) || return 0; for id in $(echo "$qout" | sed -n 's/^[[:space:]]*"id": *\\([0-9][0-9]*\\).*/\\1/p'); do rc vfs/queue-set-expiry "id=$id" expiry=0 >/dev/null 2>&1; done; }
stop_process() {
  case "$pid" in ''|*[!0-9]*|0|1) [ -f "$SD/stopped" ]; return $?;; esac
  if fsvol_owned "$pid"; then
    kill "$pid" 2>/dev/null
    j=0; while [ $j -lt 20 ] && fsvol_owned "$pid"; do sleep 0.25; j=$((j+1)); done
    if fsvol_owned "$pid"; then kill -9 "$pid" 2>/dev/null; fi
    j=0; while [ $j -lt 20 ] && fsvol_owned "$pid"; do sleep 0.25; j=$((j+1)); done
  fi
  # A live but unverified PID is uncertainty, not proof of termination.
  ! fsvol_pid_alive "$pid"
}
finish() {
  if fsvol_mounted "$MP" || ! stop_process; then echo 'FSVOL_ERR stale cleanup-uncertain'; exit 32; fi
  echo 1 > "$SD/stopped" || { echo 'FSVOL_ERR cleanup-failed'; exit 35; }
  rm -f "$SD/pid" "$SOCK"
  if [ "$1" = 1 ]; then rm -rf "$CACHE" "$SD" || { echo 'FSVOL_ERR cleanup-failed'; exit 35; }; fi
  echo "FSVOL_RESULT status=detached flushed=$1 pending=$2 volume=$vol mid=$MID ro=$ro"; exit 0
}
# A normal unmount quiesces writers. Lazy unmount does not: open descriptors
# can keep writing, so a forced lazy detach must never discard the cache.
if [ "$mounted" = 1 ]; then
  expected=$(cat "$SD/remote" 2>/dev/null) || expected=""
  if [ -z "$expected" ] || [ "\${src#*:}" != "\${expected#*:}" ]; then echo "FSVOL_ERR unmanaged $src"; exit 34; fi
  out=$(timeout "$FLUSH" "$FM" -u "$MP" 2>&1); st=$?
  if [ "$st" -ne 0 ]; then
    if [ "$FORCE" = 1 ]; then
      timeout 5 "$FM" -uz "$MP" >/dev/null 2>&1 || { echo "FSVOL_ERR unmount-failed $out"; exit 35; }
      finish 0 -1
    fi
    case "$out" in *usy*) echo "FSVOL_ERR busy $out"; exit 31;; *) echo "FSVOL_ERR unmount-failed $out"; exit 35;; esac
  fi
  fsvol_mounted "$MP" && { echo 'FSVOL_ERR unmount-failed still-mounted'; exit 35; }
  # Only mounts created by this driver have a VFS that survives unmount.
  if [ "$alive" = 1 ] && [ "$(cat "$SD/driver" 2>/dev/null)" = rcd ]; then echo 1 > "$SD/quiesced"; fi
fi
if [ "$alive" != 1 ] || [ ! -f "$SD/quiesced" ]; then
  if [ "$FORCE" = 1 ]; then finish 0 -1; fi
  echo 'FSVOL_ERR stale drain-not-verifiable'; exit 32
fi
pending=-1; errored=-1
while [ "$(fsvol_now)" -lt "$deadline" ]; do
  # Wait() removes the RC mount only after the FUSE server has finished. Do
  # not mistake an empty queue during the last Release request for durability.
  mounts=$(rc mount/listmounts) || mounts=""
  if ! echo "$mounts" | grep -q '"mountPoints": *\\[\\]'; then sleep 0.25; continue; fi
  expedite
  s=$(rc vfs/stats) || s=""
  qd=$(echo "$s" | num uploadsQueued); ip=$(echo "$s" | num uploadsInProgress); er=$(echo "$s" | num erroredFiles)
  pending=-1; errored=-1
  if [ -n "$qd" ] && [ -n "$ip" ] && [ -n "$er" ]; then
    pending=$((qd + ip)); errored=$er
    if [ "$pending" -eq 0 ] && [ "$errored" -eq 0 ]; then finish 1 0; fi
  fi
  sleep 0.25
done
if [ "$FORCE" = 1 ]; then finish 0 "$pending"; fi
echo "FSVOL_ERR flush-timeout pending=$pending errored=$errored"; fsvol_log_tail "$LOG"; exit 30
`;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function guestFailure(run: GuestRun, out: GuestOutput, sandboxId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sandboxId,
    step: run.label,
    exitCode: run.exitCode,
    guestError: out.error ?? null,
    logTail: out.blocks.LOG ?? [],
    stderrTail: out.blocks.STDERR ?? run.stderr.split('\n').filter(Boolean).slice(-10),
    ...extra,
  };
}

function bootstrapError(run: GuestRun, out: GuestOutput, sandboxId: string): VolumeError {
  const code = out.error?.code ?? 'unknown';
  const detail = out.error?.detail ?? '';
  const details = guestFailure(run, out, sandboxId);
  switch (code) {
    case 'no-dev-fuse':
      return new MountError('FUSE_UNAVAILABLE', `Sandbox "${sandboxId}" has no /dev/fuse device, so no FUSE filesystem can be mounted.`, {
        hint: 'Freestyle Ubuntu VMs expose FUSE. A Docker container needs `--device /dev/fuse --cap-add SYS_ADMIN`.',
        details,
      });
    case 'unsupported-arch':
      return new VolumeError('UNSUPPORTED', `Sandbox "${sandboxId}" runs on an unsupported CPU architecture (${detail}).`, { hint: 'Only x86_64 and aarch64 are supported.', details });
    case 'fuse3-install':
    case 'fuse3-missing':
      return new MountError('RUNTIME_INSTALL', `Sandbox "${sandboxId}" has no fusermount3 and it could not be installed (${code}).`, {
        hint: 'Use an image with apt-get or apk, or pre-install the fuse3 package in your snapshot.',
        details,
      });
    case 'download':
    case 'no-downloader':
      return new MountError('RUNTIME_INSTALL', `Sandbox "${sandboxId}" could not download rclone (${code} ${detail}).`.trim(), {
        hint: `Allow outbound HTTPS to downloads.rclone.org, or pre-install rclone >= ${RCLONE_MIN_VERSION} in the sandbox image.`,
        details,
      });
    case 'checksum-mismatch':
      return new MountError('RUNTIME_INSTALL', `The rclone archive downloaded in sandbox "${sandboxId}" did not match the pinned SHA-256. Nothing was installed.`, {
        hint: 'Retry; if it persists, the download is being tampered with or the mirror is corrupt.',
        details,
      });
    default:
      return new MountError('RUNTIME_INSTALL', `Preparing the volume runtime in sandbox "${sandboxId}" failed (${code} ${detail}).`.trim(), {
        hint: 'Inspect details.logTail and details.stderrTail.',
        details,
      });
  }
}

function mountError(run: GuestRun, out: GuestOutput, sandboxId: string, spec: MountSpec): VolumeError {
  const code = out.error?.code ?? 'unknown';
  const detail = out.error?.detail ?? '';
  const details = guestFailure(run, out, sandboxId, { mountPath: spec.mountPath, mountId: spec.mountId });
  const logText = [...(out.blocks.LOG ?? []), ...(out.blocks.STDERR ?? [])].join('\n');
  switch (code) {
    case 'lifecycle-busy':
      return new MountError('MOUNT_BUSY', `Another guest lifecycle operation is running at ${spec.mountPath}. Retry when it finishes.`, { details });
    case 'rclone-missing':
    case 'fuse3-missing':
      return new MountError('RUNTIME_INSTALL', `Sandbox "${sandboxId}" lost its volume runtime (${code}).`, { hint: 'Attach again; the runtime is re-installed on the next attempt.', details });
    case 'path-in-use':
      return new MountError('MOUNT_PATH_IN_USE', `Mount path ${spec.mountPath} in sandbox "${sandboxId}" is already used by another mount (${detail}).`, {
        hint: 'Detach it first (detach({ force: true }) for a stale one), or choose a different mountPath.',
        details,
      });
    case 'mountpoint-create':
    case 'mountpoint-not-dir':
    case 'mountpoint-not-empty':
      return new MountError('MOUNT_FAILED', `Mount path ${spec.mountPath} in sandbox "${sandboxId}" is not usable (${code}).`, {
        hint: 'The mount path must be a directory that is empty or missing; it is created when missing.',
        details,
      });
    case 'stale-unmount-failed':
      return new MountError('MOUNT_STALE', `A stale mount at ${spec.mountPath} in sandbox "${sandboxId}" could not be removed.`, {
        hint: 'Run `fusermount3 -uz <path>` inside the sandbox, or restart the sandbox, then attach again.',
        details,
      });
    case 'mount-create-failed':
    case 'process-exited': {
      if (/\/dev\/fuse not found|fuse device|Kernel module not loaded/i.test(logText)) {
        return new MountError('FUSE_UNAVAILABLE', `rclone could not open /dev/fuse in sandbox "${sandboxId}".`, {
          hint: 'The sandbox kernel must expose FUSE. Freestyle Ubuntu VMs do; Docker containers need `--device /dev/fuse --cap-add SYS_ADMIN`.',
          details,
        });
      }
      let hint = 'Inspect details.logTail.';
      if (/Failed to create file system|is a file not a directory|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403|no such host|connection refused|i\/o timeout|deadline exceeded/i.test(logText)) {
        hint = 'rclone could not reach or authenticate against the storage endpoint from inside the sandbox. Check storage.sandboxEndpoint, the credentials, and that the sandbox firewall allows outbound access to the endpoint.';
      }
      return new MountError('MOUNT_FAILED', `rclone exited before the mount at ${spec.mountPath} in sandbox "${sandboxId}" became ready.`, { hint, details });
    }
    case 'ready-timeout':
      return new MountError('MOUNT_TIMEOUT', `The mount at ${spec.mountPath} in sandbox "${sandboxId}" did not become ready within ${spec.readyTimeoutMs} ms. State and cache were retained for recovery; the process may still be running.`, {
        hint: 'This usually means the storage endpoint is unreachable from the sandbox (firewall, DNS, private endpoint). Raise readyTimeoutMs only if the endpoint is merely slow.',
        details,
      });
    default:
      return new MountError('MOUNT_FAILED', `Attaching at ${spec.mountPath} in sandbox "${sandboxId}" failed (${code} ${detail}).`.trim(), { details });
  }
}

function detachError(run: GuestRun, out: GuestOutput, sandboxId: string, mountPath: string, flushTimeoutMs: number): VolumeError {
  const code = out.error?.code ?? 'unknown';
  const detail = out.error?.detail ?? '';
  const details = guestFailure(run, out, sandboxId, { mountPath });
  switch (code) {
    case 'lifecycle-busy':
      return new MountError('MOUNT_BUSY', `Another guest lifecycle operation is running at ${mountPath}. Retry when it finishes.`, { details });
    case 'unmanaged':
      return new MountError('MOUNT_UNMANAGED', `${mountPath} in sandbox "${sandboxId}" is an rclone mount that freestyle-volumes did not create (${detail}).`, {
        hint: 'Unmount it manually inside the sandbox; this library only manages mounts it attached.',
        details,
      });
    case 'stale':
      return new MountError('MOUNT_STALE', `The mount at ${mountPath} in sandbox "${sandboxId}" is stale (${detail}); pending writes may still sit in the sandbox cache and cannot be flushed.`, {
        hint: 'Retry detach if the uploader is still running. After a forced detach stops it, attach the same volume at the same path to resume pending uploads. State and cache stay on the sandbox disk when durability is uncertain.',
        details,
      });
    case 'busy':
      return new MountError('MOUNT_BUSY', `The mount at ${mountPath} in sandbox "${sandboxId}" is busy: a process still has files open (${detail}).`, {
        hint: 'Stop the processes using the mount (`fuser -m <path>` in the sandbox), or detach with { force: true }; data still open at that moment is not flushed.',
        details,
      });
    case 'flush-timeout':
    case 'flush-unavailable':
      return new VolumeError('FLUSH_FAILED', `Pending writes under ${mountPath} in sandbox "${sandboxId}" could not be uploaded within ${flushTimeoutMs} ms (${detail}). The filesystem may already be unmounted; state and cache were retained for recovery.`, {
        hint: 'Check that the sandbox can reach the storage endpoint and retry detach with a larger flushTimeoutMs, or detach with { force: true } to give up durability for the pending files.',
        details,
      });
    default:
      return new MountError('MOUNT_FAILED', `Detaching ${mountPath} in sandbox "${sandboxId}" failed (${code} ${detail}).`.trim(), { details });
  }
}

export interface RcloneBackendOptions {
  paths?: Partial<GuestPaths>;
}

/** Host-side driver for the guest scripts above. Stateless: every call inspects the sandbox afresh. */
export class RcloneBackend {
  readonly paths: GuestPaths;

  constructor(options: RcloneBackendOptions = {}) {
    this.paths = { ...DEFAULT_GUEST_PATHS, ...options.paths };
  }

  async ensureRuntime(sandbox: SandboxRuntime, options: { timeoutMs: number }): Promise<RuntimeInfo> {
    const run = await runGuest(sandbox, { label: 'bootstrap', script: bootstrapScript(this.paths), timeoutMs: options.timeoutMs });
    const out = parseGuestOutput(run.stdout);
    if (out.error || run.exitCode !== 0 || !out.result) throw bootstrapError(run, out, sandbox.id);
    return {
      rclonePath: out.result.rclone ?? '',
      rcloneVersion: out.result.version ?? '',
      fusermountPath: out.result.fusermount ?? '',
      arch: out.result.arch ?? '',
    };
  }

  async mount(sandbox: SandboxRuntime, spec: MountSpec, env: Record<string, string>, options: { timeoutMs: number }): Promise<GuestMountResult> {
    const run = await runGuest(sandbox, { label: 'mount', script: mountScript(this.paths, spec), env, timeoutMs: options.timeoutMs });
    const out = parseGuestOutput(run.stdout);
    if (out.error || run.exitCode !== 0 || !out.result) throw mountError(run, out, sandbox.id, spec);
    return { pid: toInt(out.result.pid) ?? 0, alreadyAttached: out.result.already === '1' };
  }

  async inspect(sandbox: SandboxRuntime, mountPath: string, options: { timeoutMs: number }): Promise<GuestMountInspection> {
    const run = await runGuest(sandbox, { label: 'inspect', script: inspectScript(this.paths, mountPath), timeoutMs: options.timeoutMs });
    const out = parseGuestOutput(run.stdout);
    if (out.error || run.exitCode !== 0 || !out.result) {
      throw new MountError('MOUNT_FAILED', `Inspecting ${mountPath} in sandbox "${sandbox.id}" failed.`, { details: guestFailure(run, out, sandbox.id, { mountPath }) });
    }
    let state: Record<string, unknown> | null = null;
    if (out.blocks.STATE && out.blocks.STATE.length > 0) {
      try {
        state = JSON.parse(out.blocks.STATE.join('\n')) as Record<string, unknown>;
      } catch {
        state = null;
      }
    }
    const r = out.result;
    return {
      mounted: r.mounted === '1',
      hasState: r.state === '1',
      alive: r.alive === '1',
      responsive: r.responsive === '1',
      pid: toInt(r.pid),
      readOnly: r.ro === '1' ? true : r.ro === '0' ? false : null,
      source: r.src ? r.src : null,
      mountId: r.mid ? r.mid : null,
      state,
      stats: parseVfsStats(out.blocks.STATS) ?? null,
      logTail: out.blocks.LOG ?? [],
    };
  }

  async unmount(sandbox: SandboxRuntime, options: { mountPath: string; flushTimeoutMs: number; force: boolean; timeoutMs: number }): Promise<GuestDetachResult> {
    const run = await runGuest(sandbox, {
      label: 'detach',
      script: detachScript(this.paths, { mountPath: options.mountPath, flushTimeoutMs: options.flushTimeoutMs, force: options.force }),
      timeoutMs: options.timeoutMs,
    });
    const out = parseGuestOutput(run.stdout);
    if (out.error || run.exitCode !== 0 || !out.result) throw detachError(run, out, sandbox.id, options.mountPath, options.flushTimeoutMs);
    const r = out.result;
    if (r.status === 'absent') return { status: 'absent', flushed: false, pending: null, volumeId: null, mountId: null, readOnly: null };
    const pending = toInt(r.pending);
    return {
      status: 'detached',
      flushed: r.flushed === '1',
      pending: pending === null || pending < 0 ? null : pending,
      volumeId: r.volume ? r.volume : null,
      mountId: r.mid ? r.mid : null,
      readOnly: r.ro === '1' ? true : r.ro === '0' ? false : null,
    };
  }
}
