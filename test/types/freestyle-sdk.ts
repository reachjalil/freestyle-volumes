// Compile-time proof that the real `freestyle` SDK satisfies the structural
// types this library uses. Checked with `pnpm check:types`; never executed.
import { Freestyle, type Vm } from 'freestyle';
import { freestyleSandboxes, type FreestyleClientLike, type FreestyleVmLike } from '../../src/index.js';

const client: FreestyleClientLike = new Freestyle({ apiKey: 'unused' });
const vm: FreestyleVmLike = client.vms.ref('vm-id') as Vm;
const resolver = freestyleSandboxes(new Freestyle({ apiKey: 'unused' }), { linuxUser: 'root' });
export const ok = [client, vm, resolver] as const;
