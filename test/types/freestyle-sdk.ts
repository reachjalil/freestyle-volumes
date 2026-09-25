// Compile-time proof that the real `freestyle` SDK satisfies the structural
// types this library uses. Checked with `pnpm check:types`; never executed.
import { Freestyle, type FirewallSpec, type Vm } from 'freestyle';
import {
  createVolumeReadySnapshot,
  freestyleSandboxes,
  type FreestyleClientLike,
  type FreestyleFirewallSpec,
  type FreestyleSnapshotClientLike,
  type FreestyleVmLike,
} from '../../src/index.js';

const client: FreestyleClientLike = new Freestyle({ apiKey: 'unused' });
const vm: FreestyleVmLike = client.vms.ref('vm-id') as Vm;
const resolver = freestyleSandboxes(new Freestyle({ apiKey: 'unused' }), { linuxUser: 'root' });

// The snapshot helper takes the real client, and firewalls written for the SDK fit it both ways.
const snapshotClient: FreestyleSnapshotClientLike = new Freestyle({ apiKey: 'unused' });
const sdkFirewall: FirewallSpec = { rules: [{ action: 'allow', source: {}, destination: { public: true, port: 443, protocol: 'tcp' } }] };
const firewall: FreestyleFirewallSpec = sdkFirewall;
const backToSdk: FirewallSpec = firewall;
const building = createVolumeReadySnapshot(new Freestyle({ apiKey: 'unused' }), { baseSnapshotId: 'freestyle/ubuntu-sm', slug: 'ubuntu-sm-volumes', firewall: sdkFirewall });

export const ok = [client, vm, resolver, snapshotClient, backToSdk, building] as const;
