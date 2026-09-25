// Package smoke test: pack the tarball exactly as `npm publish` would, install
// it into a fresh project next to the Freestyle SDK, and use it from there.
// Checks the file list, ESM/require entry points, the CLI bin and TypeScript
// resolution under nodenext, bundler and node10. Needs network access to the
// npm registry for dependencies. Set KEEP_SMOKE_DIR=1 to keep the scratch dir.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'fsvol-package-'));
const consumer = join(work, 'consumer');

// This script also runs from `npm publish` (prepublishOnly). Nested npm
// commands must not inherit that npm's configuration: npm_config_dry_run would
// make `npm pack` write nothing, and npm_config_local_prefix would point
// `npm install` at this repository. Keep only registry, cache and auth files.
const KEEP_NPM_CONFIG = new Set(['npm_config_registry', 'npm_config_cache', 'npm_config_userconfig']);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) || KEEP_NPM_CONFIG.has(key.toLowerCase())));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: childEnv, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function step(name, fn) {
  const started = Date.now();
  fn();
  console.log(`ok - ${name} (${Date.now() - started} ms)`);
}

try {
  let tarball;
  step('build and pack', () => {
    run('npm', ['run', 'build', '--silent'], { cwd: root });
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: root }));
    tarball = join(work, packed.filename);
    const files = packed.files.map((file) => file.path);
    for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'dist/bin.js', 'dist/cli.js', 'dist/freestyle.js', 'dist/docker.js', 'dist/git.js', 'src/index.ts']) {
      assert.ok(files.includes(required), `tarball contains ${required}`);
    }
    const unexpected = files.filter((file) => !/^(dist|src)\//.test(file) && !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(file));
    assert.deepEqual(unexpected, [], 'tarball holds only dist, src, docs and the manifest');
  });

  step('install into a fresh project', () => {
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    const dev = manifest.devDependencies;
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', tarball, `freestyle@${dev.freestyle}`, `typescript@${dev.typescript}`, `@types/node@${dev['@types/node']}`], { cwd: consumer });
  });

  step('import every entry point at runtime', () => {
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import * as root from 'freestyle-volumes';
      import * as freestyle from 'freestyle-volumes/freestyle';
      import * as docker from 'freestyle-volumes/docker';
      import * as git from 'freestyle-volumes/git';
      import manifest from 'freestyle-volumes/package.json' with { type: 'json' };
      for (const name of ['FreestyleVolumes', 'freestyleSandboxes', 'createVolumeReadySnapshot', 'storageConfigFromEnv', 'dockerSandboxes', 'volumeGit', 'VolumeError', 'MemoryObjectStore']) {
        assert.equal(typeof root[name], 'function', name);
      }
      assert.equal(typeof freestyle.createVolumeReadySnapshot, 'function');
      assert.equal(typeof docker.dockerSandboxes, 'function');
      assert.equal(typeof git.VolumeGit, 'function');
      assert.equal(manifest.version, ${JSON.stringify(manifest.version)});
      if (process.features.require_module) {
        assert.equal(createRequire(import.meta.url)('freestyle-volumes').FreestyleVolumes, root.FreestyleVolumes, 'require(esm) resolves the same module');
      }
      const volumes = new root.FreestyleVolumes({
        storage: { bucket: 'smoke', accessKeyId: 'id', secretAccessKey: 'secret' },
        sandboxes: docker.dockerSandboxes(),
        objectStore: new root.MemoryObjectStore(),
      });
      await volumes.create({ name: 'smoke' });
      assert.deepEqual((await volumes.list()).map((v) => v.name), ['smoke']);
      assert.equal((await volumes.checkStorage()).ok, true, 'the bucket probe runs from the installed package');
    `;
    run(process.execPath, ['--input-type=module', '-e', script], { cwd: consumer });
  });

  step('run the installed CLI', () => {
    const bin = join(consumer, 'node_modules', '.bin', 'freestyle-volumes');
    assert.equal(run(bin, ['--version'], { cwd: consumer }).trim(), manifest.version);
    const help = run(bin, ['--help'], { cwd: consumer });
    for (const command of ['prepare-snapshot', 'mounts', 'detach-all', 'doctor']) assert.match(help, new RegExp(`^  ${command} `, 'm'), command);
    const missing = spawnSync(bin, ['list'], { cwd: consumer, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Missing environment variables: VOLUMES_S3_BUCKET/);
  });

  step('type-check a consumer under nodenext, bundler and node10 resolution', () => {
    writeFileSync(join(consumer, 'index.ts'), `
      import { Freestyle } from 'freestyle';
      import { FreestyleVolumes, freestyleSandboxes, createVolumeReadySnapshot, isVolumeError, storageConfigFromEnv, type Volume, type VolumeAttachment, type DetachResult, type DetachAllResult, type MountListing, type CheckReport } from 'freestyle-volumes';
      import { freestyleSandboxes as fromSubpath, type VolumeReadySnapshot } from 'freestyle-volumes/freestyle';
      import { dockerSandboxes } from 'freestyle-volumes/docker';
      import { volumeGit, type GitStatus } from 'freestyle-volumes/git';

      const freestyle = new Freestyle({ apiKey: 'unused' });
      const volumes = new FreestyleVolumes({
        storage: { endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', bucket: 'volumes', accessKeyId: 'id', secretAccessKey: 'secret' },
        sandboxes: freestyleSandboxes(freestyle),
      });
      export const local = new FreestyleVolumes({ storage: { bucket: 'volumes', accessKeyId: 'id', secretAccessKey: 'secret' }, sandboxes: dockerSandboxes() });
      export const volume: Promise<Volume> = volumes.get('datasets', { create: true });
      export const attached: Promise<VolumeAttachment> = volumes.attach({ sandboxId: 'vm', volumeId: 'datasets', mountPath: '/mnt/datasets', uid: 1000, gid: 1000 });
      export const detached: Promise<DetachResult> = volumes.detach({ sandboxId: 'vm', mountPath: '/mnt/datasets' });
      export const snapshot: Promise<VolumeReadySnapshot> = createVolumeReadySnapshot(freestyle, { baseSnapshotId: 'freestyle/ubuntu-sm', slug: 'ubuntu-sm-volumes' });
      export const status: Promise<GitStatus> = volumeGit({ volumes, sandboxes: fromSubpath(freestyle) }).status({ sandboxId: 'vm', mountPath: '/mnt/src' });
      export const check = (error: unknown) => isVolumeError(error, 'FLUSH_FAILED');
      export const fromEnv = new FreestyleVolumes({ storage: storageConfigFromEnv({ VOLUMES_S3_BUCKET: 'b', VOLUMES_S3_ACCESS_KEY_ID: 'id', VOLUMES_S3_SECRET_ACCESS_KEY: 's' }), sandboxes: dockerSandboxes() });
      export const mounts: Promise<MountListing> = volumes.listMounts({ sandboxId: 'vm' });
      export const drained: Promise<DetachAllResult> = volumes.detachAll({ sandboxId: 'vm' }).then((result) => { if (!result.flushed) for (const entry of result.results) if (entry.status === 'failed') console.error(entry.error.code); return result; });
      export const preflight: Promise<CheckReport[]> = Promise.all([volumes.checkStorage(), volumes.checkSandbox({ sandboxId: 'vm' })]);
    `);
    const configs = {
      nodenext: { module: 'nodenext', moduleResolution: 'nodenext' },
      bundler: { module: 'esnext', moduleResolution: 'bundler' },
      node10: { module: 'commonjs', moduleResolution: 'node10' },
    };
    for (const [name, resolution] of Object.entries(configs)) {
      const file = join(consumer, `tsconfig.${name}.json`);
      writeFileSync(file, JSON.stringify({ compilerOptions: { ...resolution, target: 'es2022', strict: true, noEmit: true, types: ['node'], skipLibCheck: name !== 'nodenext' }, files: ['index.ts'] }));
      run(process.execPath, [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', file], { cwd: consumer });
    }
  });

  console.log(`package ${manifest.name}@${manifest.version}: all smoke checks passed`);
} finally {
  if (process.env.KEEP_SMOKE_DIR === '1') console.log(`scratch directory kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
