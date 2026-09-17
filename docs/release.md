# Releases

## v0.1.0 — first preview

Scope: the rclone backend, the Freestyle and Docker adapters, the Daytona-style API, unit and Linux integration tests, and documentation. Verification records live in `docs/evidence/`.

Not published to npm. Installation is from GitHub (`npm install github:reachjalil/freestyle-volumes`), which runs `prepare` to build `dist/`.

## Checklist before a release

1. `pnpm install --frozen-lockfile`
2. `pnpm test`, `pnpm check:types`, `pnpm check:examples`
3. `VOLUMES_TEST_BOOTSTRAP=1 pnpm test:integration` on a Linux host with Docker (CI does this)
4. `pnpm test:freestyle` with a real Freestyle key and bucket; record the outcome in `docs/evidence/`
5. `pnpm pack` and inspect the archive: `dist/`, `README.md`, `LICENSE` only
6. Update `CHANGELOG.md`, bump `package.json` version, tag `vX.Y.Z`

Publishing to npm needs a separate decision; nothing in the repository publishes automatically.
