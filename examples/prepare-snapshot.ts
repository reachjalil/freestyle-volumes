// Build once: a Freestyle snapshot with fuse3 and rclone preinstalled, so VMs
// booted from it skip the one-time package install on their first attach.
// Boots a temporary VM (billed for under a minute), snapshots it and deletes it.
// Run with: FREESTYLE_API_KEY=... npx tsx examples/prepare-snapshot.ts
import { Freestyle } from 'freestyle';
import { createVolumeReadySnapshot } from 'freestyle-volumes/freestyle';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });

const snapshot = await createVolumeReadySnapshot(freestyle, {
  baseSnapshotId: 'freestyle/ubuntu-sm', // VMs booted from the result get this size
  slug: 'ubuntu-sm-volumes', // boot with vms.create({ snapshotId: 'ubuntu-sm-volumes', ... })
  onEvent: (event) => console.log(`[${event.type}] ${event.vmId} ${event.message ?? ''}`),
});

console.log(`snapshot ${snapshot.snapshotId} has rclone ${snapshot.runtime.rcloneVersion} at ${snapshot.runtime.rclonePath}`);
for (const warning of snapshot.warnings) console.warn(warning);
