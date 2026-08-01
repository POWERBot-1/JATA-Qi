// RegistryModule — kernel module wrapping one or more TLD registries, the EPP
// server, escrow signing, and RDAP/WHOIS. Integrates with the accreditation
// gate so the platform never operates or claims to be a public TLD registry
// without verified accreditation (Part L).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { generateKeyPair, toBase64 } from '@jataqi/provenance';
import { Registry, RegistryError, hashSecret } from './registry.js';
import { defaultPolicy } from './catalog.js';
import { buildDeposit, verifyDeposit, type EscrowSigner } from './escrow.js';
import { EppServer } from './epp/server.js';
import { domainToRdap, notFoundRdap } from './rdap.js';
import type { CatalogPolicy, DomainObject, EscrowDeposit, RegistrarAccount } from './types.js';

export const RegistryEvents = Object.freeze({
  DomainCreated: 'registry.domain.created',
  DomainRenewed: 'registry.domain.renewed',
  DomainDeleted: 'registry.domain.deleted',
  DomainTransferred: 'registry.domain.transferred',
  EscrowDeposited: 'registry.escrow.deposited',
} as const);

export interface RegistryConfig {
  /** Start the EPP server on boot. */
  serve?: boolean;
  eppPort?: number;
  eppHost?: string;
  svID?: string;
}

export class RegistryModule implements IModule {
  readonly id = 'registry';
  readonly tags = ['core', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private cfg: Required<RegistryConfig>;
  private registries = new Map<string, Registry>(); // tld -> Registry
  private eppServers = new Map<string, EppServer>();
  private depositSeq = 0;
  private signer: EscrowSigner;

  constructor(cfg: RegistryConfig = {}) {
    this.cfg = {
      serve: cfg.serve ?? false,
      eppPort: cfg.eppPort ?? 17000,
      eppHost: cfg.eppHost ?? '127.0.0.1',
      svID: cfg.svID ?? 'registry.jataqi.local',
    };
    const kp = generateKeyPair();
    this.signer = { privateKeyDerB64: toBase64(kp.privateKeyDer), publicKeyDerB64: toBase64(kp.publicKeyDer) };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('registry', this);
    kernel.logger.info(`registry module initialized (serve=${this.cfg.serve})`);
  }

  async start(kernel: KernelApi): Promise<void> {
    if (!this.cfg.serve) return;
    for (const [tld, reg] of this.registries) {
      const srv = new EppServer(reg, { svID: this.cfg.svID });
      const port = await srv.start(this.cfg.eppPort, this.cfg.eppHost);
      this.eppServers.set(tld, srv);
      this.cfg.eppPort = port + 1; // next TLD gets the next port in dev
      kernel.logger.info(`registry EPP server for ${tld} listening on ${port}`);
    }
  }

  async stop(): Promise<void> {
    for (const srv of this.eppServers.values()) await srv.stop();
    this.eppServers.clear();
  }

  /** EPP server port for a TLD (0 if not serving). */
  eppPort(tld: string): number {
    return this.eppServers.get(tld)?.address ?? 0;
  }

  // ---- registry management -----------------------------------------------

  /** Create a TLD registry with a catalog policy. */
  addTld(tld: string, policy: Partial<CatalogPolicy> = {}): Registry {
    const reg = new Registry({
      tld,
      policy: defaultPolicy(policy),
      onEvent: (e) => this.forwardEvent(e),
    });
    this.registries.set(reg.tld, reg);
    this.api.logger.info(`registry: TLD ${reg.tld} added`);
    return reg;
  }

  private forwardEvent(e: { event: string; domain?: string; registrar?: string }): void {
    const map: Record<string, string> = {
      'domain.create': RegistryEvents.DomainCreated,
      'domain.renew': RegistryEvents.DomainRenewed,
      'domain.delete': RegistryEvents.DomainDeleted,
      'domain.transfer.approved': RegistryEvents.DomainTransferred,
    };
    const busEvent = map[e.event];
    if (busEvent) void this.api.bus.emit(busEvent, { domain: e.domain, registrar: e.registrar });
  }

  getTld(tld: string): Registry | undefined {
    return this.registries.get(tld.startsWith('.') ? tld : '.' + tld);
  }

  listTlds(): string[] {
    return [...this.registries.keys()];
  }

  /** Resolve the registry authoritative for a name (longest TLD suffix). */
  registryFor(name: string): Registry | undefined {
    let n = name.trim().toLowerCase();
    if (!n.endsWith('.')) n += '.';
    let best: Registry | undefined;
    let bestLen = -1;
    for (const reg of this.registries.values()) {
      if (n.endsWith(reg.tld + '.')) {
        if (reg.tld.length > bestLen) { best = reg; bestLen = reg.tld.length; }
      }
    }
    return best;
  }

  /** Add an accredited registrar account to a TLD registry. */
  addRegistrar(tld: string, account: Omit<RegistrarAccount, 'passwordHash'> & { password: string }): RegistrarAccount {
    const reg = this.getTld(tld);
    if (!reg) throw new RegistryError(`TLD ${tld} not found`);
    const rec: RegistrarAccount = { ...account, passwordHash: hashSecret(account.password) };
    reg.addRegistrar(rec);
    return rec;
  }

  // ---- escrow ------------------------------------------------------------

  /** Build (and sign) a data-escrow deposit for a TLD. */
  escrowDeposit(tld: string, now = Date.now()): EscrowDeposit {
    const reg = this.getTld(tld);
    if (!reg) throw new RegistryError(`TLD ${tld} not found`);
    const deposit = buildDeposit(reg, ++this.depositSeq, this.signer, now);
    void this.api.bus.emit(RegistryEvents.EscrowDeposited, { tld, seq: deposit.id, hash: deposit.contentsHash });
    return deposit;
  }

  /** Verify an escrow deposit's signature + contents hash. */
  verifyDeposit(deposit: EscrowDeposit): boolean {
    return verifyDeposit(deposit);
  }

  signerPublicKey(): string { return this.signer.publicKeyDerB64; }

  // ---- RDAP --------------------------------------------------------------

  rdapLookup(name: string, now = Date.now()) {
    const reg = this.registryFor(name);
    if (!reg) return notFoundRdap(name);
    const d = reg.info(name, now);
    return d ? domainToRdap(d, now) : notFoundRdap(name);
  }

  // ---- reporting ---------------------------------------------------------

  report(now = Date.now()) {
    return [...this.registries.values()].map((reg) => ({ tld: reg.tld, ...reg.counts(now), events: reg.eventLog().length }));
  }

  /** Lifecycle sweep across all TLDs (release expired domains). */
  sweep(now = Date.now()): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [tld, reg] of this.registries) out[tld] = reg.sweep(now);
    return out;
  }

  /** Auto-approve mature transfers across all TLDs. */
  runTransferApprovals(now = Date.now()) {
    const out: Record<string, number> = {};
    for (const [tld, reg] of this.registries) out[tld] = reg.runTransferAutoApprovals(now).length;
    return out;
  }

  /** All domains across all TLDs (for admin/portfolio views). */
  listAllDomains(registrarId?: string): Array<DomainObject & { tld: string }> {
    const out: Array<DomainObject & { tld: string }> = [];
    for (const reg of this.registries.values()) {
      for (const d of reg.listDomains(registrarId)) out.push({ ...d, tld: reg.tld });
    }
    return out;
  }
}

export { Registry, RegistryError, randomUUID };
