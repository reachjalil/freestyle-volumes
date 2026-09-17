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
fsvol_rclone() { if [ -x "$BIN_DIR/rclone" ]; then echo "$BIN_DIR/rclone"; elif have rclone; then command -v rclone; else return 1; fi; }
fsvol_fusermount() { if have fusermount3; then command -v fusermount3; elif have fusermount; then command -v fusermount; else return 1; fi; }
fsvol_mounted() { grep -q " $1 fuse.rclone " /proc/mounts 2>/dev/null; }
fsvol_mount_source() { awk -v m="$1" '$2 == m && $3 == "fuse.rclone" { s = $1 } END { print s }' /proc/mounts; }
fsvol_mount_ro() { awk -v m="$1" '$2 == m && $3 == "fuse.rclone" { o = $4 } END { if (o ~ /^ro(,|$)/) print 1; else print 0 }' /proc/mounts; }
fsvol_log_tail() { if [ -f "$1" ]; then echo FSVOL_LOG_BEGIN; tail -n 25 "$1"; echo FSVOL_LOG_END; fi; }
fsvol_find_state() { d=""; for f in "$STATE_ROOT"/mounts/*/mount.json; do [ -f "$f" ] || continue; if grep -q -F "\\"mountPath\\":\\"$1\\"" "$f"; then d=$(dirname "$f"); fi; done; echo "$d"; }
fsvol_pid_alive() { [ -n "$1" ] || return 1; kill -0 "$1" 2>/dev/null || return 1; st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d" " -f1); [ "$st" != "Z" ]; }
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
fsvol_fusermount >/dev/null || { echo "FSVOL_ERR fuse3-missing"; exit 13; }
for t in setsid timeout awk sha256sum sed grep; do have "$t" || { echo "FSVOL_ERR tool-missing $t"; exit 13; }; done
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
  if (spec.allowOther) flags.push('--allow-other');
  if (spec.uid !== undefined) flags.push('--uid', String(spec.uid));
  if (spec.gid !== undefined) flags.push('--gid', String(spec.gid));
  if (spec.umask !== undefined) flags.push('--umask', spec.umask);
  if (spec.readOnly) flags.push('--read-only');
  return flags.join(' ');
}

export function mountScript(paths: GuestPaths, spec: MountSpec): string {
  const ticks = Math.max(4, Math.ceil(spec.readyTimeoutMs / 250));
  if (spec.stateJson.includes("'")) throw new VolumeError('VALIDATION', 'Mount state must not contain single quotes.');
  return `${prelude(paths)}
RC=$(fsvol_rclone) || { echo "FSVOL_ERR rclone-missing"; exit 14; }
FM=$(fsvol_fusermount) || { echo "FSVOL_ERR fuse3-missing"; exit 13; }
MP=${q(spec.mountPath)}
MID=${q(spec.mountId)}
REMOTE=${q(spec.remotePath)}
RO=${spec.readOnly ? 1 : 0}
SD="$STATE_ROOT/mounts/$MID"; SOCK="$RUN_ROOT/$MID.sock"; CACHE="$CACHE_ROOT/$MID"; LOG="$SD/rclone.log"
mkdir -p "$SD" "$CACHE" "$RUN_ROOT" || { echo "FSVOL_ERR mkdir"; exit 11; }
pid=""; [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null)
alive=0; fsvol_pid_alive "$pid" && alive=1
if fsvol_mounted "$MP"; then
  src=$(fsvol_mount_source "$MP")
  if [ "\${src#*:}" != "\${REMOTE#*:}" ]; then echo "FSVOL_ERR path-in-use $src"; exit 20; fi
  if [ "$alive" = 1 ] && timeout 5 stat "$MP" >/dev/null 2>&1; then
    if [ "$(fsvol_mount_ro "$MP")" != "$RO" ]; then echo "FSVOL_ERR path-in-use read-only-mismatch"; exit 20; fi
    echo "FSVOL_RESULT status=attached already=1 pid=$pid"; exit 0
  fi
  "$FM" -uz "$MP" >/dev/null 2>&1 || umount -l "$MP" >/dev/null 2>&1
  sleep 0.3
  if fsvol_mounted "$MP"; then echo "FSVOL_ERR stale-unmount-failed"; exit 22; fi
fi
if [ "$alive" = 1 ]; then kill "$pid" 2>/dev/null; sleep 0.5; kill -9 "$pid" 2>/dev/null; fi
OTHER=$(fsvol_find_state "$MP")
if [ -n "$OTHER" ] && [ "$OTHER" != "$SD" ]; then echo "FSVOL_ERR path-in-use stale-state $(basename "$OTHER")"; exit 20; fi
rm -f "$SOCK" "$SD/pid"
(umask 022; mkdir -p "$MP") || { echo "FSVOL_ERR mountpoint-create"; exit 21; }
[ -d "$MP" ] || { echo "FSVOL_ERR mountpoint-not-dir"; exit 21; }
if grep -q " $MP " /proc/mounts; then echo "FSVOL_ERR path-in-use foreign-mount"; exit 20; fi
if [ -n "$(ls -A "$MP" 2>/dev/null)" ]; then echo "FSVOL_ERR mountpoint-not-empty"; exit 21; fi
printf '%s\\n' ${q(spec.stateJson)} > "$SD/mount.json"
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
: > "$SD/stderr.log"
cat > "$SD/run.sh" <<FSVOL_RUN
echo \\$\\$ > '$SD/pid'
exec '$RC' mount '$REMOTE' '$MP' ${mountFlags(spec)} --cache-dir '$CACHE' --rc --rc-addr 'unix://$SOCK' --rc-no-auth --log-file '$LOG' --log-level INFO
FSVOL_RUN
fail_cleanup() { rm -f "$SD/pid" "$SOCK"; mkdir -p "$STATE_ROOT/orphans"; mv "$SD" "$STATE_ROOT/orphans/$MID.$(date +%s).failed" 2>/dev/null; }
setsid sh "$SD/run.sh" </dev/null >/dev/null 2>>"$SD/stderr.log" &
i=0; pid=""
while [ $i -lt ${ticks} ]; do
  [ -z "$pid" ] && [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! fsvol_pid_alive "$pid"; then
    echo "FSVOL_ERR process-exited"; fsvol_log_tail "$LOG"
    if [ -s "$SD/stderr.log" ]; then echo FSVOL_STDERR_BEGIN; tail -n 10 "$SD/stderr.log"; echo FSVOL_STDERR_END; fi
    fail_cleanup; exit 22
  fi
  if [ -n "$pid" ] && fsvol_mounted "$MP" && timeout 5 ls "$MP" >/dev/null 2>&1; then echo "FSVOL_RESULT status=attached already=0 pid=$pid"; exit 0; fi
  sleep 0.25; i=$((i+1))
done
echo "FSVOL_ERR ready-timeout"; fsvol_log_tail "$LOG"
if [ -s "$SD/stderr.log" ]; then echo FSVOL_STDERR_BEGIN; tail -n 10 "$SD/stderr.log"; echo FSVOL_STDERR_END; fi
if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 0.5; kill -9 "$pid" 2>/dev/null; fi
"$FM" -uz "$MP" >/dev/null 2>&1; fail_cleanup; exit 23
`;
}

export function inspectScript(paths: GuestPaths, mountPath: string): string {
  return `${prelude(paths)}
MP=${q(mountPath)}
RC=$(fsvol_rclone) || RC=""
mounted=0; fsvol_mounted "$MP" && mounted=1
src=""; ro=""
if [ "$mounted" = 1 ]; then src=$(fsvol_mount_source "$MP"); ro=$(fsvol_mount_ro "$MP"); fi
SD=$(fsvol_find_state "$MP")
state=0; pid=""; alive=0; responsive=0; mid=""
if [ -n "$SD" ]; then state=1; mid=$(basename "$SD"); [ -f "$SD/pid" ] && pid=$(cat "$SD/pid" 2>/dev/null); fsvol_pid_alive "$pid" && alive=1; fi
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
alive=0; fsvol_pid_alive "$pid" && alive=1
ro="$rostate"; [ "$mounted" = 1 ] && ro=$(fsvol_mount_ro "$MP")
rc() { [ -n "$RC" ] && [ -S "$SOCK" ] && timeout 15 "$RC" rc --unix-socket "$SOCK" "$@" 2>/dev/null; }
num() { sed -n "s/^[[:space:]]*\\"$1\\": *\\([0-9][0-9]*\\).*/\\1/p" | head -n 1; }
expedite() { qout=$(rc vfs/queue) || return 0; for id in $(echo "$qout" | sed -n 's/^[[:space:]]*"id": *\\([0-9][0-9]*\\).*/\\1/p'); do rc vfs/queue-set-expiry "id=$id" expiry=0 >/dev/null 2>&1; done; }
stop_process() { if fsvol_pid_alive "$pid"; then kill "$pid" 2>/dev/null; j=0; while [ $j -lt 20 ] && fsvol_pid_alive "$pid"; do sleep 0.25; j=$((j+1)); done; fsvol_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null; fi; return 0; }
finish() {
  rm -f "$SD/pid" "$SOCK"
  if [ "$1" = 1 ]; then rm -rf "$CACHE" "$SD"; else mkdir -p "$STATE_ROOT/orphans" && mv "$SD" "$STATE_ROOT/orphans/$MID.$(date +%s)" 2>/dev/null; fi
  echo "FSVOL_RESULT status=detached flushed=$1 pending=$2 volume=$vol mid=$MID ro=$ro"; exit 0
}
if [ "$mounted" = 0 ]; then
  stop_process
  if [ "$rostate" = 1 ]; then finish 1 0; fi
  if [ "$FORCE" = 1 ]; then finish 0 -1; fi
  echo "FSVOL_ERR stale not-mounted"; fsvol_log_tail "$LOG"; exit 32
fi
if [ "$alive" = 0 ]; then
  "$FM" -uz "$MP" >/dev/null 2>&1 || umount -l "$MP" >/dev/null 2>&1
  if [ "$ro" = 1 ]; then finish 1 0; fi
  if [ "$FORCE" = 1 ]; then finish 0 -1; fi
  echo "FSVOL_ERR stale process-dead"; fsvol_log_tail "$LOG"; exit 32
fi
pending=0; errored=0
if [ "$ro" = 0 ]; then
  if [ -z "$RC" ] || [ ! -S "$SOCK" ]; then
    if [ "$FORCE" = 1 ]; then "$FM" -uz "$MP" >/dev/null 2>&1; stop_process; finish 0 -1; fi
    echo "FSVOL_ERR flush-unavailable no-rc-socket"; exit 30
  fi
  limit=$((FLUSH * 4)); i=0; pending=-1
  while :; do
    expedite
    s=$(rc vfs/stats) || s=""
    qd=$(echo "$s" | num uploadsQueued); ip=$(echo "$s" | num uploadsInProgress); er=$(echo "$s" | num erroredFiles)
    [ -n "$er" ] || er=0
    if [ -n "$qd" ] && [ -n "$ip" ]; then pending=$((qd + ip)); errored=$er; if [ "$pending" -eq 0 ] && [ "$errored" -eq 0 ]; then break; fi; fi
    [ $i -ge $limit ] && break
    sleep 0.25; i=$((i+1))
  done
  if [ "$pending" -ne 0 ] || [ "$errored" -ne 0 ]; then
    if [ "$FORCE" = 1 ]; then "$FM" -uz "$MP" >/dev/null 2>&1; stop_process; finish 0 "$pending"; fi
    echo "FSVOL_ERR flush-timeout pending=$pending errored=$errored"; fsvol_log_tail "$LOG"; exit 30
  fi
fi
out=$("$FM" -u "$MP" 2>&1); st=$?
if [ "$st" -ne 0 ]; then
  case "$out" in
    *usy*) if [ "$FORCE" = 1 ]; then "$FM" -uz "$MP" >/dev/null 2>&1 || umount -l "$MP" >/dev/null 2>&1; stop_process; finish 0 -1; fi; echo "FSVOL_ERR busy $out"; exit 31;;
    *) echo "FSVOL_ERR unmount-failed $out"; exit 35;;
  esac
fi
i=0; while [ $i -lt 40 ] && fsvol_pid_alive "$pid"; do sleep 0.25; i=$((i+1)); done
stop_process
finish 1 0
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
      return new MountError('MOUNT_TIMEOUT', `The mount at ${spec.mountPath} in sandbox "${sandboxId}" did not become ready within ${spec.readyTimeoutMs} ms. The process was stopped and the mount point cleaned up.`, {
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
    case 'unmanaged':
      return new MountError('MOUNT_UNMANAGED', `${mountPath} in sandbox "${sandboxId}" is an rclone mount that freestyle-volumes did not create (${detail}).`, {
        hint: 'Unmount it manually inside the sandbox; this library only manages mounts it attached.',
        details,
      });
    case 'stale':
      return new MountError('MOUNT_STALE', `The mount at ${mountPath} in sandbox "${sandboxId}" is stale (${detail}); pending writes may still sit in the sandbox cache and cannot be flushed.`, {
        hint: 'Attach the same volume at the same path again to resume the pending uploads, then detach. Or detach with { force: true } to drop the mount state; the cache stays on the sandbox disk.',
        details,
      });
    case 'busy':
      return new MountError('MOUNT_BUSY', `The mount at ${mountPath} in sandbox "${sandboxId}" is busy: a process still has files open (${detail}).`, {
        hint: 'Stop the processes using the mount (`fuser -m <path>` in the sandbox), or detach with { force: true }; data still open at that moment is not flushed.',
        details,
      });
    case 'flush-timeout':
    case 'flush-unavailable':
      return new VolumeError('FLUSH_FAILED', `Pending writes under ${mountPath} in sandbox "${sandboxId}" could not be uploaded within ${flushTimeoutMs} ms (${detail}). The mount is still attached; nothing was discarded.`, {
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
