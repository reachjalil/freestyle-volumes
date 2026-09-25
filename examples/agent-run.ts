// One agent run on Freestyle: shared read-only inputs, a private output
// directory per run, and a shutdown that deletes the VM only when every write
// reached the bucket. Run with: FREESTYLE_API_KEY=... VOLUMES_S3_*=... npx tsx examples/agent-run.ts
import { randomUUID } from 'node:crypto';
import { Freestyle, type FirewallSpec } from 'freestyle';
import { FreestyleVolumes, freestyleSandboxes, storageConfigFromEnv } from 'freestyle-volumes';

const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const volumes = new FreestyleVolumes({ storage: storageConfigFromEnv(), sandboxes: freestyleSandboxes(freestyle) });
const firewall: FirewallSpec = { rules: [{ action: 'allow', source: {}, destination: { public: true } }] };

// Once per namespace: `datasets` holds the inputs, `runs` collects every run's outputs.
await volumes.get('datasets', { create: true });
await volumes.get('runs', { create: true });

const runId = `run-${randomUUID().slice(0, 8)}`;
const { vm, vmId } = await freestyle.vms.create({
  snapshotId: process.env.VOLUMES_VM_SNAPSHOT ?? 'freestyle/ubuntu-sm', // a volume-ready snapshot skips the installs
  firewall,
});
try {
  // Every run reads the same inputs, and nothing a run does can change them.
  await volumes.attach({ sandboxId: vmId, volumeId: 'datasets', mountPath: '/home/ubuntu/data', readOnly: true });
  // Each run writes only its own directory of the shared outputs volume.
  await volumes.attach({ sandboxId: vmId, volumeId: 'runs', subpath: runId, mountPath: '/home/ubuntu/out', uid: 1000, gid: 1000 });

  // The agent works on native VM disk and writes finished artifacts to the volume.
  const agent = await vm.exec('mkdir -p ~/work && cd ~/work && ls -la /home/ubuntu/data > inputs.txt && cp inputs.txt /home/ubuntu/out/');
  if (agent.statusCode !== 0) throw new Error(agent.stderr ?? 'the agent command failed');
} finally {
  // Delete the VM only when nothing unflushed is left in it; otherwise keep it to recover the data.
  const { flushed, results } = await volumes.detachAll({ sandboxId: vmId });
  if (flushed) await vm.delete();
  else console.error(`Kept VM ${vmId} because of unflushed mounts: ${JSON.stringify(results.filter((result) => !result.flushed))}`);
}

// Read the outputs anywhere: attach `runs` with `subpath: runId`, or list <dataPrefix>/<runId>/ in the bucket.
console.log(`outputs: volume "runs", directory ${runId}/`);
