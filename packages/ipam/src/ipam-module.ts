// IpamModule — PRX RIR Member kernel module. Wraps the engine, emits bus
// events, and records allocation/announcement milestones into the Digital
// Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { IpamEngine, type AllocateBlockInput, type HoldAsnInput, type RegisterAddressInput } from './engine.js';
import type {
  AddressEntry, AddressFamily, AllocationStatus, AsnHolding, IpBlock, IpamStats, RirName,
} from './types.js';

export const IpamEvents = Object.freeze({
  BlockAllocated: 'ipam.block.allocated',
  BlockSplit: 'ipam.block.split',
  AsnHeld: 'ipam.asn.held',
  AddressRegistered: 'ipam.address.registered',
  AnnouncementCreated: 'ipam.announcement.created',
} as const);

export class IpamModule implements IModule {
  readonly id = 'ipam';
  readonly tags = ['core', 'ipam', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new IpamEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('ipam', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('ipam module initialized (PRX RIR Member)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  async allocateBlock(input: AllocateBlockInput): Promise<IpBlock> {
    const block = this.engine.allocateBlock(input);
    void this.api.bus.emit(IpamEvents.BlockAllocated, { id: block.id, cidr: block.cidr, rir: block.rir });
    await this.recordMemory('ipam_block', `allocated ${block.cidr} (${block.rir})`, {
      blockId: block.id, cidr: block.cidr, rir: block.rir,
    });
    return block;
  }
  getBlock(id: string): IpBlock | undefined { return this.engine.getBlock(id); }
  listBlocks(filter?: { family?: AddressFamily; rir?: RirName; status?: AllocationStatus }): IpBlock[] {
    return this.engine.listBlocks(filter);
  }
  setBlockStatus(id: string, status: AllocationStatus): IpBlock | undefined {
    return this.engine.setBlockStatus(id, status);
  }

  splitBlock(blockId: string, newPrefix: number): IpBlock[] {
    const children = this.engine.splitBlock(blockId, newPrefix);
    void this.api.bus.emit(IpamEvents.BlockSplit, { blockId, newPrefix, count: children.length });
    return children;
  }
  addressesInBlock(blockId: string, limit = 1000): string[] {
    return this.engine.addressesInBlock(blockId, limit);
  }

  async registerAddress(input: RegisterAddressInput): Promise<AddressEntry> {
    const entry = this.engine.registerAddress(input);
    void this.api.bus.emit(IpamEvents.AddressRegistered, { id: entry.id, address: entry.address, blockId: entry.blockId });
    await this.recordMemory('ipam_address', `registered ${entry.address}`, {
      addressId: entry.id, address: entry.address, blockId: entry.blockId,
    });
    return entry;
  }
  listAddresses(blockId?: string): AddressEntry[] { return this.engine.listAddresses(blockId); }

  holdAsn(input: HoldAsnInput): AsnHolding {
    const holding = this.engine.holdAsn(input);
    void this.api.bus.emit(IpamEvents.AsnHeld, { id: holding.id, asn: holding.asn, rir: holding.rir });
    return holding;
  }
  getAsn(id: string): AsnHolding | undefined { return this.engine.getAsn(id); }
  listAsns(status?: AsnHolding['status']): AsnHolding[] { return this.engine.listAsns(status); }
  setAsnStatus(id: string, status: AsnHolding['status']): AsnHolding | undefined {
    return this.engine.setAsnStatus(id, status);
  }

  announce(input: { blockId: string; asnId: string }): { blockId: string; asnId: string; since: number } {
    const record = this.engine.announce(input);
    void this.api.bus.emit(IpamEvents.AnnouncementCreated, { blockId: record.blockId, asnId: record.asnId });
    void this.recordMemory('ipam_announcement', `announced block ${record.blockId} via ASN ${record.asnId}`, record);
    return record;
  }
  listAnnouncements(): Array<{ blockId: string; asnId: string; since: number }> {
    return this.engine.listAnnouncements();
  }

  stats(): IpamStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['ipam', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
