# Releasing to npm

`freestyle-volumes` is published to npm as an unscoped public package. Versions follow semver with the usual `0.x` rule: a breaking change bumps the minor version (`0.2.0` → `0.3.0`), anything else the patch version. Every release gets a `CHANGELOG.md` entry.

`npm publish` protects itself: `prepublishOnly` runs `npm run verify` (unit tests, the SDK and example type checks, and the package smoke test that installs the packed tarball into a fresh project), and `prepack` rebuilds `dist/` from a clean directory. A failing check stops the publish before anything is uploaded.

## First release (0.2.0)

npm only lets you add a trusted publisher to a package that already exists, so the first version is published from a maintainer's machine:

```bash
git checkout main && git pull
pnpm install --frozen-lockfile
npm login                # browser sign-in
npm publish --dry-run    # full verification and the exact file list; uploads nothing
npm publish              # npm asks for your second factor if your account uses one
git tag v0.2.0 && git push origin v0.2.0
```

Then check `https://www.npmjs.com/package/freestyle-volumes` and try `npm install freestyle-volumes freestyle` in a scratch project. Optionally publish a GitHub release for the tag (`gh release create v0.2.0 --generate-notes`). The release workflow runs, finds 0.2.0 already on npm and skips the upload.

## Later releases from GitHub (recommended)

One-time setup: on npmjs.com, open the package's **Settings → Trusted publishing** and add a GitHub Actions publisher with owner `reachjalil`, repository `freestyle-volumes` and workflow `release.yml`. The workflow then authenticates with OIDC, with no long-lived token to leak, and every version carries a provenance attestation. If you prefer a token instead, store a granular npm access token with publish rights as the repository secret `NPM_TOKEN`.

For each release:

1. Move the changes into a new `## X.Y.Z — YYYY-MM-DD` section of `CHANGELOG.md` and commit.
2. Bump the version; this commits `package.json` and creates the tag `vX.Y.Z`:
   ```bash
   npm version patch      # or: npm version minor
   git push --follow-tags
   ```
3. Publish a GitHub release for the tag:
   ```bash
   gh release create "v$(node -p "require('./package.json').version")" --generate-notes
   ```

[`release.yml`](../.github/workflows/release.yml) checks that the tag matches `package.json`, reruns the unit tests, type checks and package smoke test, and publishes with `--provenance`. Versions that are already on npm are skipped, and prerelease versions (`0.3.0-beta.0`, from `npm version prerelease --preid beta`) go to the `next` dist-tag instead of `latest`. It can also be started by hand from `main` (**Actions → Release → Run workflow**).

## Later releases from your machine

```bash
npm version patch && git push --follow-tags && npm publish
```

## Before a release

1. `pnpm install --frozen-lockfile`.
2. `npm publish --dry-run`: runs `pnpm test`, `pnpm check:types`, `pnpm check:examples` and `pnpm test:package`, then lists the tarball: `dist/`, `src/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json` only.
3. `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration` on a host with Docker. CI runs it on every push.
4. The live Freestyle tests (billed): run the manual **Freestyle live test** workflow, which reads repository secrets and variables, or locally `VOLUMES_TEST_PREPARE_SNAPSHOT=1 pnpm test:freestyle` with `FREESTYLE_API_KEY` and `VOLUMES_S3_*` set. Record the outcome in `docs/evidence/`.
5. Update `CHANGELOG.md` and the README's project status, then bump the version and tag `vX.Y.Z`.

## When a release is broken

Publish a fixed patch version, then deprecate the broken one so installs warn:

```bash
npm deprecate freestyle-volumes@0.2.1 "Use 0.2.2 instead: <what is broken>"
```

Treat `npm unpublish` as a last resort: npm allows it freely only within 72 hours of publishing, never while other packages depend on the version, and a published version number can never be reused.

## History

- **0.2.0 (2026-09-25):** first npm release. See the [changelog](../CHANGELOG.md#020--2026-09-25) and [verification record](evidence/v0.2.md).
- **0.1.0 (2026-09-17):** GitHub-only preview (`npm install github:reachjalil/freestyle-volumes`), never published to npm. Its verification history is in [evidence/v0.1.md](evidence/v0.1.md).
