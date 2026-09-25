# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository's **Security** tab choose **Report a vulnerability**, or open <https://github.com/reachjalil/freestyle-volumes/security/advisories/new>. Do not open a public issue. Include the affected version, what an attacker could do, and steps to reproduce.

## Supported versions

Fixes land in the latest `0.x` release on npm. Upgrade to receive them.

## Trust boundary

- **Storage credentials** stay in your process and reach a sandbox only as exec environment variables of the rclone process (Git tokens likewise, for the Git helper). They are never written to the sandbox disk or put on a command line, but anyone with root in the sandbox while a volume is attached can read them from the process environment. Give each namespace credentials that can reach only its bucket and prefix.
- **Snapshots** taken while a volume is attached capture those credentials and the write cache. Run `detachAll` before snapshotting; `createVolumeReadySnapshot` never involves credentials.
- **Guest scripts** run as root. Every value interpolated into them is validated against a strict character set and single-quoted; mount paths cannot reach system directories or follow symlinks.
- **Errors and events** never contain credentials, and the CLI's tests assert that the secret never reaches stdout or stderr.
- **The bucket probe** (`checkStorage`, `freestyle-volumes doctor`) writes one object under `<prefix>/_doctor/` and deletes it again.

More detail: the [security notes](README.md#security-notes) and [Freestyle operational notes](docs/freestyle.md#operational-notes).
