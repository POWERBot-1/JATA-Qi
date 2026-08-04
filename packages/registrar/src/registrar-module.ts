// RegistrarModule — kernel module managing accredited registrars. Each
// registrar is wired to a registry (direct connection by default; EPP for
// remote) and optionally to commerce for billing. Integrates with the
// accreditation gate so a registrar's accreditation grant is recorded (Part L).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { CommerceModule } from '@jataqi/commerce';
import type { RegistryModule, Registry } from '@jataqi/registry';
import { Registrar, type RegistrarOptions } from './registrar.js';
import { DirectRegistryConnection } from './connection.js';
import type { PriceBook } from './pricing.js';
import type { PromoCode, Registrant } from './types.js';

export interface RegistrarRecord {
  id: string;
  name: string;
  accreditationGrantId?: string;
  tld?: string;
  active: boolean;
}

export const RegistrarEvents = Object.freeze({
  RegistrarAdded: 'registrar.added',
  OrderCompleted: 'registrar.order.completed',
  OrderFailed: 'registrar.order.failed',
} as const);

export class RegistrarModule implements IModule {
  readonly id = 'registrar';
  readonly tags = ['core', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private registrars = new Map<string, Registrar>();
  private meta = new Map<string, RegistrarRecord>();
  private defaultPriceBook: PriceBook = { baseCreate: 9.99, baseRenew: 9.99, baseRestore: 65, currency: 'USD' };

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('registrar', this);
    kernel.logger.info('registrar module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* registrars added on demand */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  private get registryModule(): RegistryModule | undefined {
    try { return this.api.getModule<RegistryModule>('registry'); } catch { return undefined; }
  }
  private get commerce(): CommerceModule | undefined {
    try { return this.api.getModule<CommerceModule>('commerce'); } catch { return undefined; }
  }

  setDefaultPriceBook(book: PriceBook): void { this.defaultPriceBook = book; }

  /** Register an accredited registrar against a TLD. */
  addRegistrar(input: { id: string; name: string; tld?: string; accreditationGrantId?: string; priceBook?: PriceBook; active?: boolean }): Registrar {
    if (this.registrars.has(input.id)) throw new Error(`registrar ${input.id} already exists`);
    const priceBook = input.priceBook ?? this.defaultPriceBook;
    const registry = input.tld ? this.registryModule?.getTld(input.tld) : undefined;
    const connection = registry ? new DirectRegistryConnection(registry, input.id) : undefined;
    const opts: RegistrarOptions = {
      id: input.id, name: input.name,
      ...(input.accreditationGrantId ? { accreditationGrantId: input.accreditationGrantId } : {}),
      priceBook,
      connection: connection ?? (NOOP_CONNECTION as never),
      commerce: this.commerce,
    };
    const reg = new Registrar(opts);
    this.registrars.set(input.id, reg);
    this.meta.set(input.id, { id: input.id, name: input.name, ...(input.accreditationGrantId ? { accreditationGrantId: input.accreditationGrantId } : {}), ...(input.tld ? { tld: input.tld } : {}), active: input.active ?? true });
    void this.api.bus.emit(RegistrarEvents.RegistrarAdded, { id: input.id });
    this.api.logger.info(`registrar ${input.id} added (tld=${input.tld ?? 'none'})`);
    return reg;
  }

  getRegistrar(id: string): Registrar | undefined {
    return this.registrars.get(id);
  }

  listRegistrars(): RegistrarRecord[] {
    return [...this.meta.values()];
  }

  /** Convenience: bind a registrar to a specific registry instance. */
  bindRegistry(registrarId: string, registry: Registry): void {
    const reg = this.registrars.get(registrarId);
    if (!reg) throw new Error(`registrar ${registrarId} not found`);
    reg.setConnection(new DirectRegistryConnection(registry, registrarId));
  }
}

/** A no-op connection used until a registrar is bound to a registry. */
const NOOP_CONNECTION = {
  async check() { return []; },
  async create() { throw new Error('registrar not bound to a registry'); },
  async renew() { throw new Error('registrar not bound to a registry'); },
  async transfer() { throw new Error('registrar not bound to a registry'); },
  async restore() { throw new Error('registrar not bound to a registry'); },
  async delete() { throw new Error('registrar not bound to a registry'); },
  async info() { return undefined; },
};

export { Registrar, DirectRegistryConnection };
export type { RegistrarOptions, PriceBook, PromoCode, Registrant };
