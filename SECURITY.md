# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository's **Security** tab choose **Report a vulnerability**, or open <https://github.com/reachjalil/freestyle-volumes/security/advisories/new>. Do not open a public issue. Include the affected version, what an attacker could do, and steps to reproduce.

## Supported versions

Fixes land in the latest `0.x` release on npm. Upgrade to receive them.

## Trust boundary

- **Storage credentials** stay in your process and reach a sandbox only as exec environment variables of the rclone process (Git tokens likewise, for the Git helper). They are never written to the sandbox disk or put on a command line, but anyone with root in the sandbox while a volume is attached can read them from the process environment. Do not hand VMs your process's key: set `sandboxCredentials` so each mount gets a key limited to its volume's prefix (read-only for read-only mounts), for example STS session credentials with `scopedPolicy()`, and short-lived where your provider allows it. At the least, give each namespace its own key limited to its bucket and prefix.
- **Exclusive leases and attachment records** only bind clients that go through this library. A key that can write the bucket can bypass them; scope keys so that it cannot.
- **Snapshots** taken while a volume is attached capture those credentials and the write cache, and a VM booted from such a snapshot resumes the mount with them. Run `detachAll` before snapshotting; `createVolumeReadySnapshot` never involves credentials.
- **Guest scripts** run as root. Every value interpolated into them is validated against a strict character set and single-quoted; mount paths cannot reach system directories or follow symlinks.
- **Errors and events** never contain credentials, and the CLI's tests assert that the secret never reaches stdout or stderr.
- **The bucket probe** (`checkStorage`, `freestyle-volumes doctor`) writes one object under `<prefix>/_doctor/` and deletes it again; `reconcile` reports any probe an interrupted check left behind.
- **Destructive operations** need the target repeated: `delete` and `releaseLease` the volume id, `discardMount` the mount path, `removeOrphanGeneration` `<volume>/<generation>`.

More detail: the [security notes](README.md#security-notes) and [Freestyle operational notes](docs/freestyle.md#operational-notes).
