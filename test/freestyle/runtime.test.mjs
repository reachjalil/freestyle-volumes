// Live Freestyle runtime test: needs only FREESTYLE_API_KEY, no bucket. Boots
// one VM (billed for about a minute), runs the real first-attach bootstrap, and
// checks what every mount relies on: /dev/fuse, a background process started
// by one exec surviving into the next, and an rclone FUSE mount doing the same.
// Deletes the VM at the end.
//
// Required: FREESTYLE_API_KEY. Optional: VOLUMES_TEST_SNAPSHOT (default freestyle/ubuntu-sm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleSandbox, FreestyleVolumes, RcloneBackend, freestyleSandboxes } from '../../dist/index.js';

const env = process.env;

test('Freestyle live runtime: bootstrap, FUSE, and processes and mounts that outlive their exec', { skip: !env.FREESTYLE_API_KEY && 'set FREESTYLE_API_KEY', timeout: 10 * 60 * 1000 }, async () => {
  const { Freestyle } = await import('freestyle');
  const freestyle = new Freestyle({ apiKey: env.FREESTYLE_API_KEY });
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: env.VOLUMES_TEST_SNAPSHOT || 'freestyle/ubuntu-sm',
    displayName: 'freestyle-volumes-live-runtime',
    metadata: { 'freestyle-volumes': 'live-test' },
    ttlSeconds: 1800,
    firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] },
  });
  console.log(`created VM ${vmId}`);
  const sandbox = new FreestyleSandbox(vm);
  const sh = async (command) => {
    const result = await sandbox.exec({ command, timeoutMs: 60_000 });
    assert.equal(result.exitCode, 0, `${command}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const started = Date.now();
    const runtime = await new RcloneBackend().ensureRuntime(sandbox, { timeoutMs: 240_000 });
    console.log(`bootstrap on a fresh VM took ${Date.now() - started} ms: ${JSON.stringify(runtime)}`);
    assert.match(runtime.rcloneVersion, /^1\.\d+/);
    assert.match(runtime.fusermountPath, /fusermount3?$/);
    assert.match(await sh('ls -l /dev/fuse'), /^c/, '/dev/fuse is a character device');

    await sh("setsid sh -c 'echo $$ > /tmp/fsvol-bg.pid; exec sleep 600' </dev/null >/dev/null 2>&1 &");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(await sh('kill -0 "$(cat /tmp/fsvol-bg.pid)" && echo alive'), 'alive', 'a setsid process survives the exec that started it');

    await sh(`mkdir -p /tmp/fsvol-src /mnt/fsvol-probe && echo probe > /tmp/fsvol-src/a.txt && ${runtime.rclonePath} mount /tmp/fsvol-src /mnt/fsvol-probe --daemon --config /dev/null`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(await sh("grep -c ' /mnt/fsvol-probe fuse.rclone ' /proc/mounts"), '1', 'the FUSE mount outlives the exec');
    assert.equal(await sh('cat /mnt/fsvol-probe/a.txt'), 'probe');
    await sh('fusermount3 -u /mnt/fsvol-probe');

    // The preflight with deliberately unusable storage keys: everything but storage must pass.
    const volumes = new FreestyleVolumes({ storage: { bucket: 'unused-bucket', accessKeyId: 'unused', secretAccessKey: 'unused' }, sandboxes: freestyleSandboxes(freestyle) });
    const report = await volumes.checkSandbox({ sandboxId: vmId });
    console.log(`[checkSandbox] ${JSON.stringify(report)}`);
    assert.deepEqual(report.checks.filter((check) => check.name !== 'storage' && check.status !== 'ok'), []);
  } finally {
    await vm.delete().catch((error) => console.error(`could not delete VM ${vmId}: ${error}`));
  }
});
