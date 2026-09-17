// Exercises the runtime bootstrap on a bare Ubuntu 24.04 container (the same
// distribution as Freestyle's public snapshots): installs fuse3 and curl with
// apt, downloads the pinned rclone release, verifies its SHA-256, mounts.
// Opt in with VOLUMES_TEST_BOOTSTRAP=1 (it needs internet access and takes a
// couple of minutes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreestyleVolumes, dockerSandboxes, RCLONE_VERSION } from '../../dist/index.js';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

const enabled = process.env.VOLUMES_TEST_BOOTSTRAP === '1' && dockerAvailable();

test('bootstrap installs fuse3 and the pinned rclone on Ubuntu 24.04 and mounts', { skip: !enabled && 'set VOLUMES_TEST_BOOTSTRAP=1 with Docker available' }, async () => {
  const stack = new Stack();
  try {
    await stack.start();
    const volumes = new FreestyleVolumes({ storage: stack.storage('ubuntu'), sandboxes: dockerSandboxes(), defaults: { writeBackSeconds: 1 } });
    const sandbox = stack.sandbox({ image: 'ubuntu:24.04' });
    assert.equal(stack.exec(sandbox, 'command -v rclone || command -v fusermount3 || echo none').stdout.trim(), 'none', 'bare image has neither rclone nor fusermount3');
    await volumes.create({ name: 'u' });
    const started = Date.now();
    const attached = await volumes.attach({ sandboxId: sandbox, volumeId: 'u', mountPath: '/mnt/u' });
    assert.ok(attached.pid > 0);
    const version = stack.exec(sandbox, '/opt/freestyle-volumes/bin/rclone version | head -1').stdout.trim();
    assert.equal(version, `rclone v${RCLONE_VERSION}`);
    assert.equal(stack.exec(sandbox, 'echo ubuntu > /mnt/u/ok.txt').status, 0);
    const detached = await volumes.detach({ sandboxId: sandbox, mountPath: '/mnt/u' });
    assert.equal(detached.flushed, true);
    assert.equal(await stack.readObject('ubuntu/v/u/ok.txt'), 'ubuntu\n');
    console.log(`bootstrap + mount + detach on ubuntu:24.04 took ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await stack.stop();
  }
});
