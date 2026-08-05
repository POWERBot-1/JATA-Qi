// JATA Qi PRX RIR Member — IP Address Management types.

/** Regional Internet Registries (RFC 7020). */
export type RirName = 'AFRINIC' | 'APNIC' | 'ARIN' | 'RIPE' | 'LACNIC';

export type AddressFamily = 'ipv4' | 'ipv6';

export type AllocationStatus = 'allocated' | 'assigned' | 'available' | 'returned';

/** A block of addresses held from an RIR (allocation) or delegated onward. */
export interface IpBlock {
  id: string;
  /** CIDR, e.g. '196.201.0.0/16' or '2c0f:f248::/32'. */
  cidr: string;
  family: AddressFamily;
  rir: RirName;
  status: AllocationStatus;
  /** Parent block id when this is a sub-allocation. */
  parentId?: string;
  /** Purpose (anycast / infrastructure / customer / internal). */
  purpose?: string;
  createdAt: number;
}

/** An autonomous system number held from the RIR. */
export interface AsnHolding {
  id: string;
  asn: number;
  rir: RirName;
  /** Anycast or single-homed announcement. */
  announcementType: 'anycast' | 'unicast';
  status: 'active' | 'reserved' | 'returned';
  createdAt: number;
}

/** A single address within a block (registry entry). */
export interface AddressEntry {
  id: string;
  blockId: string;
  address: string;
  /** Assigned to a host/device id (cloud instance, router, ...). */
  assignedTo?: string;
  createdAt: number;
}

export interface IpamStats {
  blocks: number;
  allocatedBlocks: number;
  totalAddresses: bigint;
  allocatedAddresses: bigint;
  utilizationPct: number;
  asns: number;
  activeAsns: number;
  addressEntries: number;
}
