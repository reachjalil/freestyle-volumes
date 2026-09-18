// Minimal Freestyle example: one volume, two VMs, data that survives the first VM.
// Run with: FREESTYLE_API_KEY=... VOLUMES_S3_*=... npx tsx examples/freestyle.ts
import { Freestyle, type FirewallSpec } from 'freestyle';
import { FreestyleVolumes, freestyleSandboxes } from 'freestyle-volumes';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const volumes = new FreestyleVolumes({
  storage: {
    endpoint: process.env.VOLUMES_S3_ENDPOINT, // omit for AWS S3
    region: process.env.VOLUMES_S3_REGION ?? 'us-east-1',
    bucket: process.env.VOLUMES_S3_BUCKET ?? 'my-volumes',
    prefix: 'my-app', // namespace inside the bucket
    accessKeyId: process.env.VOLUMES_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.VOLUMES_S3_SECRET_ACCESS_KEY ?? '',
  },
  sandboxes: freestyleSandboxes(freestyle),
});

// VMs must be allowed to reach the storage endpoint (and downloads.rclone.org on first use).
const firewall: FirewallSpec = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };

const volume = await volumes.get('datasets', { create: true });

const { vm: first, vmId: firstId } = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: firstId, volumeId: volume.id, mountPath: '/home/ubuntu/datasets', uid: 1000, gid: 1000 });
await first.exec('echo "trained on $(date)" > /home/ubuntu/datasets/run.log');
const detached = await volumes.detach({ sandboxId: firstId, mountPath: '/home/ubuntu/datasets' });
console.log('detached, durable:', detached.flushed); // true only when every pending upload finished
await first.delete();

const { vm: second, vmId: secondId } = await freestyle.vms.create({ snapshotId: 'freestyle/ubuntu-sm', firewall });
await volumes.attach({ sandboxId: secondId, volumeId: volume.id, mountPath: '/home/ubuntu/datasets', readOnly: true });
console.log((await second.exec('cat /home/ubuntu/datasets/run.log')).stdout);
await volumes.detach({ sandboxId: secondId, mountPath: '/home/ubuntu/datasets' });
await second.delete();
