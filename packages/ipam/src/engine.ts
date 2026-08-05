// IpamEngine — PRX RIR Member core: IP blocks with CIDR math (splitting,
// utilization, address enumeration), ASN holdings, address registries, and
// anycast announcement tracking. Pure engine.

import { randomUUID } from 'node:crypto';
import type { AddressEntry, AddressFamily, AllocationStatus, AsnHolding, IpBlock, IpamStats, RirName } from './types.js';

export interface AllocateBlockInput {
  cidr: string;
  rir: RirName;
  purpose?: string;
  parentId?: string;
}

export interface HoldAsnInput {
  asn: number;
  rir: RirName;
  announcementType?: 'anycast' | 'unicast';
}

export interface RegisterAddressInput {
  blockId: string;
  address: string;
  assignedTo?: string;
}

const VALID_RIRS: RirName[] = ['AFRINIC', 'APNIC', 'ARIN', 'RIPE', 'LACNIC'];

/** Parse 'a.b.c.d/len' or 'x::y/len' into { networkBig, prefixLen, family }. */
export function parseCidr(cidr: string): { network: bigint; prefixLen: number; family: AddressFamily; total: bigint } {
  const [addr, lenStr] = cidr.split('/');
  if (!addr || !lenStr) throw new Error(`invalid CIDR ${cidr}`);
  const prefixLen = Number(lenStr);
  if (addr.includes(':')) {
    // IPv6: expand to 16 bytes.
    if (prefixLen < 0 || prefixLen > 128) throw new Error(`invalid IPv6 prefix ${prefixLen}`);
    const bytes = expandIpv6(addr);
    const network = ipv6Network(bytes, prefixLen);
    return { network, prefixLen, family: 'ipv6', total: 1n << BigInt(128 - prefixLen) };
  }
  if (prefixLen < 0 || prefixLen > 32) throw new Error(`invalid IPv4 prefix ${prefixLen}`);
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) throw new Error(`invalid IPv4 address ${addr}`);
  let value = 0n;
  for (const p of parts) value = (value << 8n) | BigInt(p);
  const network = value & ((0xffffffffn << BigInt(32 - prefixLen)) & 0xffffffffn);
  return { network, prefixLen, family: 'ipv4', total: 1n << BigInt(32 - prefixLen) };
}

/** Format a bigint IPv4 address as dotted quad. */
export function formatIpv4(value: bigint): string {
  return [
    (value >> 24n) & 0xffn,
    (value >> 16n) & 0xffn,
    (value >> 8n) & 0xffn,
    value & 0xffn,
  ].map((b) => b.toString()).join('.');
}

function expandIpv6(addr: string): number[] {
  const double = addr.indexOf('::');
  let head: number[];
  let tail: number[];
  if (double >= 0) {
    head = addr.slice(0, double).split(':').filter(Boolean).map((h) => parseInt(h, 16));
    tail = addr.slice(double + 2).split(':').filter(Boolean).map((h) => parseInt(h, 16));
  } else {
    head = addr.split(':').map((h) => parseInt(h, 16));
    tail = [];
  }
  if (head.length + tail.length > 8) throw new Error(`invalid IPv6 address ${addr}`);
  const bytes: number[] = [];
  const push = (groups: number[]): void => {
    for (const g of groups) {
      bytes.push((g >> 8) & 0xff, g & 0xff);
    }
  };
  push(head);
  const zeros = 8 - head.length - tail.length;
  for (let i = 0; i < zeros; i++) bytes.push(0, 0);
  push(tail);
  return bytes;
}

function ipv6Network(bytes: number[], prefixLen: number): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  const full = (1n << 128n) - 1n;
  const mask = prefixLen === 0 ? 0n : (full << BigInt(128 - prefixLen)) & full;
  return value & mask;
}

/** Format a bigint IPv6 address as canonical groups. */
export function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Compress the longest zero run.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen >= 2) {
    const before = groups.slice(0, bestStart).join(':');
    const after = groups.slice(bestStart + bestLen).join(':');
    return `${before}::${after}`;
  }
  return groups.join(':');
}

export class IpamEngine {
  private blocks = new Map<string, IpBlock>();
  private asns = new Map<string, AsnHolding>();
  private addresses = new Map<string, AddressEntry>();
  private announced = new Map<string, { blockId: string; asnId: string; since: number }>();

  // ---- IP blocks ---------------------------------------------------------

  allocateBlock(input: AllocateBlockInput): IpBlock {
    const { network, prefixLen, family, total } = parseCidr(input.cidr);
    if (!VALID_RIRS.includes(input.rir)) throw new Error(`unknown RIR ${input.rir}`);
    if (input.parentId && !this.blocks.has(input.parentId)) throw new Error(`unknown parent block ${input.parentId}`);
    const cidr = `${formatCidr(network, prefixLen, family)}/${prefixLen}`;
    // Overlap check against existing allocated/assigned blocks.
    for (const b of this.blocks.values()) {
      if (b.status === 'returned' || b.status === 'available') continue;
      const other = parseCidr(b.cidr);
      if (family === other.family && overlaps(network, prefixLen, other.network, other.prefixLen, family)) {
        throw new Error(`block ${cidr} overlaps existing block ${b.cidr}`);
      }
    }
    const block: IpBlock = {
      id: randomUUID(), cidr, family, rir: input.rir, status: 'allocated',
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      createdAt: Date.now(),
    };
    this.blocks.set(block.id, block);
    void total;
    return block;
  }

  getBlock(id: string): IpBlock | undefined { return this.blocks.get(id); }
  listBlocks(filter?: { family?: AddressFamily; rir?: RirName; status?: AllocationStatus }): IpBlock[] {
    return [...this.blocks.values()].filter((b) =>
      (!filter?.family || b.family === filter.family) &&
      (!filter?.rir || b.rir === filter.rir) &&
      (!filter?.status || b.status === filter.status));
  }

  setBlockStatus(id: string, status: AllocationStatus): IpBlock | undefined {
    const block = this.blocks.get(id);
    if (!block) return undefined;
    block.status = status;
    return block;
  }

  /** Split a block into sub-blocks of the given prefix length. */
  splitBlock(blockId: string, newPrefix: number): IpBlock[] {
    const block = this.blocks.get(blockId);
    if (!block) throw new Error(`unknown block ${blockId}`);
    const { network, prefixLen, family } = parseCidr(block.cidr);
    if (newPrefix <= prefixLen) throw new Error(`new prefix ${newPrefix} must be longer than ${prefixLen}`);
    const maxLen = family === 'ipv4' ? 32 : 128;
    if (newPrefix > maxLen) throw new Error(`invalid prefix ${newPrefix}`);
    const count = 1n << BigInt(newPrefix - prefixLen);
    const subBlocks: IpBlock[] = [];
    const step = 1n << BigInt(maxLen - newPrefix);
    for (let i = 0n; i < count; i++) {
      const sub = network + i * step;
      const cidr = `${formatCidr(sub, newPrefix, family)}/${newPrefix}`;
      const child: IpBlock = {
        id: randomUUID(), cidr, family, rir: block.rir, status: 'allocated',
        parentId: block.id, purpose: block.purpose, createdAt: Date.now(),
      };
      this.blocks.set(child.id, child);
      subBlocks.push(child);
    }
    block.status = 'assigned';
    return subBlocks;
  }

  /** Enumerate usable addresses in a block (bounded for IPv6). */
  addressesInBlock(blockId: string, limit = 1000): string[] {
    const block = this.blocks.get(blockId);
    if (!block) throw new Error(`unknown block ${blockId}`);
    const { network, prefixLen, family, total } = parseCidr(block.cidr);
    const count = total > BigInt(limit) ? BigInt(limit) : total;
    const out: string[] = [];
    for (let i = 0n; i < count; i++) {
      const value = network + i;
      out.push(family === 'ipv4' ? formatIpv4(value) : formatIpv6(value));
    }
    return out;
  }

  // ---- address registry --------------------------------------------------

  registerAddress(input: RegisterAddressInput): AddressEntry {
    const block = this.blocks.get(input.blockId);
    if (!block) throw new Error(`unknown block ${input.blockId}`);
    if (block.status !== 'allocated' && block.status !== 'assigned') throw new Error(`block ${block.cidr} is ${block.status}`);
    const entry: AddressEntry = {
      id: randomUUID(), blockId: block.id, address: input.address,
      ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
      createdAt: Date.now(),
    };
    this.addresses.set(entry.id, entry);
    return entry;
  }

  getAddress(id: string): AddressEntry | undefined { return this.addresses.get(id); }
  listAddresses(blockId?: string): AddressEntry[] {
    const all = [...this.addresses.values()];
    return blockId ? all.filter((a) => a.blockId === blockId) : all;
  }

  // ---- ASNs --------------------------------------------------------------

  holdAsn(input: HoldAsnInput): AsnHolding {
    if (input.asn < 1 || input.asn > 4294967295) throw new Error('ASN out of range');
    if (!VALID_RIRS.includes(input.rir)) throw new Error(`unknown RIR ${input.rir}`);
    if ([...this.asns.values()].some((a) => a.asn === input.asn && a.status !== 'returned')) {
      throw new Error(`ASN ${input.asn} already held`);
    }
    const holding: AsnHolding = {
      id: randomUUID(), asn: input.asn, rir: input.rir,
      announcementType: input.announcementType ?? 'unicast',
      status: 'active', createdAt: Date.now(),
    };
    this.asns.set(holding.id, holding);
    return holding;
  }

  getAsn(id: string): AsnHolding | undefined { return this.asns.get(id); }
  listAsns(status?: AsnHolding['status']): AsnHolding[] {
    const all = [...this.asns.values()];
    return status ? all.filter((a) => a.status === status) : all;
  }

  setAsnStatus(id: string, status: AsnHolding['status']): AsnHolding | undefined {
    const holding = this.asns.get(id);
    if (!holding) return undefined;
    holding.status = status;
    return holding;
  }

  // ---- anycast announcements ---------------------------------------------

  announce(input: { blockId: string; asnId: string }): { blockId: string; asnId: string; since: number } {
    const block = this.blocks.get(input.blockId);
    const asn = this.asns.get(input.asnId);
    if (!block) throw new Error(`unknown block ${input.blockId}`);
    if (!asn) throw new Error(`unknown ASN ${input.asnId}`);
    if (asn.status !== 'active') throw new Error(`ASN ${asn.asn} is ${asn.status}`);
    const record = { blockId: block.id, asnId: asn.id, since: Date.now() };
    this.announced.set(block.id, record);
    return record;
  }

  listAnnouncements(): Array<{ blockId: string; asnId: string; since: number }> {
    return [...this.announced.values()];
  }

  // ---- analytics ---------------------------------------------------------

  stats(): IpamStats {
    const blocks = [...this.blocks.values()];
    // Leaf blocks only (blocks that are not the parent of any other block),
    // so split hierarchies are counted once.
    const parentIds = new Set(blocks.map((b) => b.parentId).filter((p): p is string => p !== undefined));
    const activeBlocks = blocks.filter((b) => !parentIds.has(b.id) && (b.status === 'allocated' || b.status === 'assigned'));
    let totalAddresses = 0n;
    let allocatedAddresses = 0n;
    for (const b of activeBlocks) {
      const { total } = parseCidr(b.cidr);
      totalAddresses += total;
      if (b.status === 'allocated') allocatedAddresses += total;
    }
    const asns = [...this.asns.values()];
    return {
      blocks: blocks.length,
      allocatedBlocks: activeBlocks.length,
      totalAddresses,
      allocatedAddresses,
      utilizationPct: totalAddresses > 0n ? Number((allocatedAddresses * 10000n) / totalAddresses) / 100 : 0,
      asns: asns.length,
      activeAsns: asns.filter((a) => a.status === 'active').length,
      addressEntries: this.addresses.size,
    };
  }
}

// ---- helpers --------------------------------------------------------------

function overlaps(aNet: bigint, aLen: number, bNet: bigint, bLen: number, family: AddressFamily): boolean {
  const bits = family === 'ipv4' ? 32 : 128;
  const aEnd = aNet + (1n << BigInt(bits - aLen)) - 1n;
  const bEnd = bNet + (1n << BigInt(bits - bLen)) - 1n;
  return aNet <= bEnd && bNet <= aEnd;
}

function formatCidr(network: bigint, prefixLen: number, family: AddressFamily): string {
  return family === 'ipv4' ? formatIpv4(network) : formatIpv6(network);
}
