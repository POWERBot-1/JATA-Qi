// @jataqi/ipam — PRX RIR Member IP Address Management. Public API.

export { IpamModule, IpamEvents } from './ipam-module.js';
export { IpamEngine, parseCidr, formatIpv4, formatIpv6 } from './engine.js';
export type { AllocateBlockInput, HoldAsnInput, RegisterAddressInput } from './engine.js';
export type {
  RirName, AddressFamily, AllocationStatus, IpBlock, AsnHolding, AddressEntry, IpamStats,
} from './types.js';
