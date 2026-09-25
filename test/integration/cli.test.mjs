// The CLI end to end on Docker + MinIO: the real bin in a child process, a real
// rclone FUSE mount and a real bucket. Like the other integration tests, this
// is NOT a Freestyle test; `--docker` swaps the Freestyle VM for a container.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Stack, dockerAvailable } from '../helpers/stack.mjs';

const BIN = new URL('../../dist/bin.js', import.meta.url).pathname;

if (!dockerAvailable()) {
  test('CLI integration tests (skipped: Docker is not available or VOLUMES_SKIP_INTEGRATION=1)', { skip: true }, () => {});
} else {
  describe('freestyle-volumes CLI on Docker + MinIO', () => {
    const stack = new Stack();
    let sandbox;
    let env;
    before(async () => {
      await stack.start();
      sandbox = stack.sandbox();
      const storage = stack.storage('cli');
      env = {
        ...process.env,
        VOLUMES_S3_ENDPOINT: storage.endpoint,
        VOLUMES_S3_SANDBOX_ENDPOINT: storage.sandboxEndpoint,
        VOLUMES_S3_REGION: storage.region,
        VOLUMES_S3_BUCKET: storage.bucket,
        VOLUMES_S3_PREFIX: storage.prefix,
        VOLUMES_S3_ACCESS_KEY_ID: storage.accessKeyId,
        VOLUMES_S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
        VOLUMES_S3_PROVIDER: storage.provider,
        VOLUMES_S3_FORCE_PATH_STYLE: 'true',
      };
    });
    after(async () => {
      await stack.stop();
    });

    function cli(...args) {
      const result = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 280_000 });
      const secret = env.VOLUMES_S3_SECRET_ACCESS_KEY;
      assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false, `secret leaked by ${args.join(' ')}`);
      return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
    }

    test('create, attach, write, inspect, detach, read back from the bucket, delete', async () => {
      assert.equal(cli('create', 'cli-data', '--label', 'suite=cli').code, 0);

      const attached = cli('attach', '--docker', sandbox, 'cli-data', '/mnt/cli', '--write-back', '1');
      assert.equal(attached.code, 0, attached.stderr);
      assert.ok(attached.json().pid > 0);
      assert.match(attached.stderr, /\[attach\.done\]/);

      const write = stack.exec(sandbox, 'echo "hello from the cli" > /mnt/cli/hello.txt && cat /mnt/cli/hello.txt');
      assert.equal(write.status, 0, write.stderr);

      const inspected = cli('inspect', '--docker', sandbox, '/mnt/cli');
      assert.equal(inspected.code, 0, inspected.stderr);
      assert.equal(inspected.json().status, 'mounted');
      assert.equal(inspected.json().volumeId, 'cli-data');
      assert.equal(cli('attachments', 'cli-data').json().length, 1);

      const detached = cli('detach', '--docker', sandbox, '/mnt/cli');
      assert.equal(detached.code, 0, detached.stderr);
      assert.equal(detached.json().flushed, true);
      assert.equal(cli('inspect', '--docker', sandbox, '/mnt/cli').json().status, 'absent');

      const volume = cli('get', 'cli-data').json();
      assert.equal(await stack.readObject(`${volume.dataPrefix}/hello.txt`), 'hello from the cli\n');
      assert.deepEqual(cli('attachments', 'cli-data').json(), []);

      const deleted = cli('delete', 'cli-data', '--confirm', 'cli-data');
      assert.equal(deleted.code, 0, deleted.stderr);
      assert.deepEqual(cli('list').json(), []);
      assert.deepEqual(await stack.listKeys(volume.dataPrefix), []);
    });

    test('operation failures exit 1 with the error code', () => {
      const missing = cli('attach', '--docker', sandbox, 'no-such-volume', '/mnt/none');
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /VOLUME_NOT_FOUND/);
      const unmanaged = cli('detach', '--docker', sandbox, '/mnt/never-attached');
      assert.equal(unmanaged.code, 0, 'detaching an absent mount is a no-op');
      assert.equal(unmanaged.json().status, 'absent');
    });
  });
}
