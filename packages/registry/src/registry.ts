// Registry — the authoritative database for a TLD. Holds domain, contact and
// host objects and implements the full domain lifecycle (create, renew,
// transfer, restore, delete, DNSSEC delegation) under the catalog policy. All
// mutating operations emit lifecycle events for the audit log.

import { createHash, randomUUID } from 'node:crypto';
import { GracePeriods, addYears, renew as renewDomain, restore as restoreDomain, softDelete, refreshPhase, recomputePhase } from './lifecycle.js';
import { defaultPolicy, isReserved, premiumPrice, validTerm, claimsRequired, sldOf } from './catalog.js';
import type { CatalogPolicy, ContactObject, DomainObject, DomainStatus, DsRecord, HostObject, LifecycleResult, RegistrarAccount, TransferRecord } from './types.js';

export interface RegistryOptions {
  tld: string;
  policy?: CatalogPolicy;
  /** SLDs with active trademark claims (TMCH). */
  trademarkClaims?: string[];
  /** Transfer auto-approve window (default 5 days). */
  transferWindow?: number;
  /** Lifecycle-event hook (e.g. to forward to the kernel event bus). */
  onEvent?: (e: { ts: number; event: string; domain?: string; registrar?: string }) => void;
}

export class Registry {
  readonly tld: string;
  readonly policy: CatalogPolicy;
  private domains = new Map<string, DomainObject>();
  private contacts = new Map<string, ContactObject>();
  private hosts = new Map<string, HostObject>();
  private registrars = new Map<string, RegistrarAccount>();
  private claims = new Set<string>();
  private transferWindow: number;
  private events: Array<{ ts: number; event: string; domain?: string; registrar?: string }> = [];
  private depositSeq = 0;
  private onEvent?: (e: { ts: number; event: string; domain?: string; registrar?: string }) => void;

  constructor(opts: RegistryOptions) {
    this.tld = opts.tld.startsWith('.') ? opts.tld : '.' + opts.tld;
    this.policy = opts.policy ?? defaultPolicy({ reserved: new Set(), reservedPatterns: [] });
    this.claims = new Set((opts.trademarkClaims ?? []).map((s) => s.toLowerCase()));
    this.transferWindow = opts.transferWindow ?? 5 * 86400_000;
    this.onEvent = opts.onEvent;
  }

  // ---- registrars ---------------------------------------------------------

  addRegistrar(account: RegistrarAccount): void {
    this.registrars.set(account.id, account);
  }

  getRegistrar(id: string): RegistrarAccount | undefined {
    return this.registrars.get(id);
  }

  /** Authenticate an EPP/registrar login by id + password. */
  authenticateRegistrar(id: string, password: string): RegistrarAccount | undefined {
    const r = this.registrars.get(id);
    if (!r || !r.active) return undefined;
    return hash(password) === r.passwordHash ? r : undefined;
  }

  listRegistrars(): RegistrarAccount[] {
    return [...this.registrars.values()];
  }

  // ---- availability & pricing --------------------------------------------

  checkAvailability(name: string, now = Date.now()): { available: boolean; reason?: string; premium?: boolean; price?: number } {
    const n = normalize(name);
    if (!this.inTld(n)) return { available: false, reason: 'not in this TLD' };
    if (isReserved(this.policy, n)) return { available: false, reason: 'reserved' };
    const existing = this.domains.get(n);
    if (existing) {
      const phase = recomputePhase(existing, now);
      if (phase !== 'released') return { available: false, reason: 'registered' };
    }
    const price = premiumPrice(this.policy, n, 'create');
    return { available: true, premium: price > this.policy.basePriceCreate, price };
  }

  /** Check many names at once (EPP domain:check). */
  checkAvailabilityBatch(names: string[], now = Date.now()): Array<{ name: string; available: boolean; reason?: string; premium?: boolean; price?: number }> {
    return names.map((n) => ({ name: n, ...this.checkAvailability(n, now) }));
  }

  // ---- domain lifecycle ---------------------------------------------------

  createDomain(input: {
    name: string;
    registrarId: string;
    registrant: string;
    contacts?: { type: string; id: string }[];
    nameservers?: string[];
    periodYears?: number;
    authInfo: string;
    claimsNoticeId?: string;
  }, now = Date.now()): DomainObject {
    const n = normalize(input.name);
    this.requireInTld(n);
    const avail = this.checkAvailability(n, now);
    if (!avail.available) throw new RegistryError(`domain ${n} not available: ${avail.reason ?? 'registered'}`);
    const years = input.periodYears ?? 1;
    if (!validTerm(this.policy, years)) throw new RegistryError(`invalid term ${years} years`);
    if (claimsRequired(this.policy, n, this.claims) && !input.claimsNoticeId) {
      throw new RegistryError(`trademark claims notice required for ${n}`);
    }
    if (!this.registrars.has(input.registrarId)) throw new RegistryError(`unknown registrar ${input.registrarId}`);

    const domain: DomainObject = {
      name: n,
      tld: this.tld,
      registrarId: input.registrarId,
      creatingRegistrarId: input.registrarId,
      registrant: input.registrant,
      contacts: input.contacts ?? [],
      nameservers: input.nameservers ?? [],
      authInfoHash: hash(input.authInfo),
      statuses: new Set<DomainStatus>(['ok']),
      phase: 'active',
      createdAt: now,
      expiresAt: addYears(now, years),
      updatedAt: now,
      dsRecords: [],
      transfers: [],
      ...(input.claimsNoticeId ? { claimsNoticeId: input.claimsNoticeId } : {}),
    };
    if (domain.nameservers.length === 0) domain.statuses.add('inactive');
    this.domains.set(n, domain);
    this.emit('domain.create', n, input.registrarId);
    return { ...domain, statuses: new Set(domain.statuses) };
  }

  info(name: string, now = Date.now()): DomainObject | undefined {
    const d = this.domains.get(normalize(name));
    if (!d) return undefined;
    refreshPhase(d, now);
    return { ...d, statuses: new Set(d.statuses), dsRecords: [...d.dsRecords], transfers: [...d.transfers] };
  }

  listDomains(registrarId?: string): DomainObject[] {
    const all = [...this.domains.values()];
    return (registrarId ? all.filter((d) => d.registrarId === registrarId) : all)
      .map((d) => ({ ...d, statuses: new Set(d.statuses) }));
  }

  renew(name: string, registrarId: string, periodYears = 1, now = Date.now()): LifecycleResult {
    const d = this.mustOwn(name, registrarId);
    refreshPhase(d, now);
    renewDomain(d, periodYears, now);
    this.emit('domain.renew', d.name, registrarId);
    return { domain: this.info(name, now)!, event: `renewed ${d.name} for ${periodYears}y` };
  }

  /** Soft-delete: move the domain into redemption grace. */
  deleteDomain(name: string, registrarId: string, now = Date.now()): LifecycleResult {
    const d = this.mustOwn(name, registrarId);
    softDelete(d, now);
    this.emit('domain.delete', d.name, registrarId);
    return { domain: this.info(name, now)!, event: `deleted ${d.name} (redemption grace)` };
  }

  /** Restore a domain from redemption grace (RGP restore). */
  restoreDomain(name: string, registrarId: string, now = Date.now()): LifecycleResult {
    const d = this.mustOwn(name, registrarId);
    restoreDomain(d, now);
    this.emit('domain.restore', d.name, registrarId);
    return { domain: this.info(name, now)!, event: `restored ${d.name}` };
  }

  /** Request an RGP restore (pending restore). */
  requestRestore(name: string, registrarId: string, now = Date.now()): LifecycleResult {
    const d = this.mustOwn(name, registrarId);
    if (d.phase !== 'redemption-grace' && d.phase !== 'auto-renew-grace') {
      throw new RegistryError(`restore request requires grace phase, ${name} is ${d.phase}`);
    }
    d.restoreRequestedAt = now;
    d.statuses.add('pendingUpdate');
    refreshPhase(d, now);
    this.emit('domain.restore.request', d.name, registrarId);
    return { domain: this.info(name, now)!, event: `restore requested for ${d.name}` };
  }

  /** Update domain attributes (nameservers, statuses, authInfo, contacts). */
  updateDomain(name: string, registrarId: string, patch: {
    addNameservers?: string[]; remNameservers?: string[];
    addStatuses?: DomainStatus[]; remStatuses?: DomainStatus[];
    authInfo?: string; registrant?: string;
    addContacts?: { type: string; id: string }[]; remContacts?: { type: string; id: string }[];
  }, now = Date.now()): DomainObject {
    const d = this.mustOwn(name, registrarId);
    if (d.statuses.has('clientUpdateProhibited') || d.statuses.has('serverUpdateProhibited')) {
      throw new RegistryError(`update prohibited for ${name}`);
    }
    if (patch.addNameservers) d.nameservers.push(...patch.addNameservers);
    if (patch.remNameservers) d.nameservers = d.nameservers.filter((ns) => !patch.remNameservers!.includes(ns));
    if (patch.addStatuses) patch.addStatuses.forEach((s) => d.statuses.add(s));
    if (patch.remStatuses) patch.remStatuses.forEach((s) => d.statuses.delete(s));
    if (patch.authInfo) d.authInfoHash = hash(patch.authInfo);
    if (patch.registrant) d.registrant = patch.registrant;
    if (patch.addContacts) d.contacts.push(...patch.addContacts);
    if (patch.remContacts) d.contacts = d.contacts.filter((c) => !patch.remContacts!.some((r) => r.type === c.type && r.id === c.id));
    d.statuses.delete('inactive');
    if (d.nameservers.length === 0) d.statuses.add('inactive');
    refreshPhase(d, now);
    this.emit('domain.update', d.name, registrarId);
    return this.info(name, now)!;
  }

  // ---- DNSSEC delegation --------------------------------------------------

  setDsRecords(name: string, registrarId: string, ds: DsRecord[], now = Date.now()): DomainObject {
    const d = this.mustOwn(name, registrarId);
    d.dsRecords = ds;
    refreshPhase(d, now);
    this.emit('domain.dnssec.update', d.name, registrarId);
    return this.info(name, now)!;
  }

  clearDsRecords(name: string, registrarId: string, now = Date.now()): DomainObject {
    return this.setDsRecords(name, registrarId, [], now);
  }

  // ---- transfers (RFC 5731) ----------------------------------------------

  requestTransfer(name: string, toRegistrarId: string, authInfo: string, now = Date.now()): TransferRecord {
    const d = this.domains.get(normalize(name));
    if (!d) throw new RegistryError(`domain ${name} not found`);
    if (d.registrarId === toRegistrarId) throw new RegistryError('domain already with gaining registrar');
    if (d.statuses.has('clientTransferProhibited') || d.statuses.has('serverTransferProhibited')) {
      throw new RegistryError(`transfer prohibited for ${name}`);
    }
    const from = d.registrarId;
    // Wrong authInfo → immediate rejection (auth error).
    if (hash(authInfo) !== d.authInfoHash) {
      const rec: TransferRecord = {
        id: randomUUID(), domain: d.name, fromRegistrar: from, toRegistrar: toRegistrarId,
        state: 'rejected', requestedAt: now, autoApproveAt: now, decidedAt: now, authInfoHash: hash(authInfo),
      };
      d.transfers.push(rec);
      this.emit('domain.transfer.rejected', d.name, toRegistrarId);
      return rec;
    }
    const rec: TransferRecord = {
      id: randomUUID(), domain: d.name, fromRegistrar: from, toRegistrar: toRegistrarId,
      state: 'pending', requestedAt: now, autoApproveAt: now + this.transferWindow, authInfoHash: hash(authInfo),
    };
    d.transfers.push(rec);
    d.statuses.add('pendingTransfer');
    this.emit('domain.transfer.requested', d.name, toRegistrarId);
    return rec;
  }

  approveTransfer(transferId: string, now = Date.now()): TransferRecord {
    const { d, rec } = this.findTransfer(transferId);
    if (rec.state !== 'pending') throw new RegistryError(`transfer ${transferId} not pending`);
    rec.state = 'approved';
    rec.decidedAt = now;
    d.registrarId = rec.toRegistrar;
    d.authInfoHash = hash(randomUUID()); // rotate authInfo
    d.expiresAt = addYears(Math.max(d.expiresAt, now), 1); // transfer extends by 1 year
    d.statuses.delete('pendingTransfer');
    refreshPhase(d, now);
    this.emit('domain.transfer.approved', d.name, rec.toRegistrar);
    return rec;
  }

  rejectTransfer(transferId: string, now = Date.now()): TransferRecord {
    const { d, rec } = this.findTransfer(transferId);
    if (rec.state !== 'pending') throw new RegistryError(`transfer ${transferId} not pending`);
    rec.state = 'rejected';
    rec.decidedAt = now;
    d.statuses.delete('pendingTransfer');
    this.emit('domain.transfer.rejected', d.name, rec.toRegistrar);
    return rec;
  }

  /** Auto-approve pending transfers whose window has elapsed (silence = approval). */
  runTransferAutoApprovals(now = Date.now()): TransferRecord[] {
    const approved: TransferRecord[] = [];
    for (const d of this.domains.values()) {
      for (const rec of d.transfers) {
        if (rec.state === 'pending' && rec.autoApproveAt <= now) {
          approved.push(this.approveTransfer(rec.id, now));
        }
      }
    }
    return approved;
  }

  private findTransfer(transferId: string): { d: DomainObject; rec: TransferRecord } {
    for (const d of this.domains.values()) {
      const rec = d.transfers.find((t) => t.id === transferId);
      if (rec) return { d, rec };
    }
    throw new RegistryError(`transfer ${transferId} not found`);
  }

  // ---- contacts & hosts ---------------------------------------------------

  createContact(input: Omit<ContactObject, 'createdAt' | 'updatedAt'>, now = Date.now()): ContactObject {
    const c: ContactObject = { ...input, createdAt: now, updatedAt: now };
    this.contacts.set(c.id, c);
    this.emit('contact.create', undefined, c.registrarId);
    return { ...c };
  }

  getContact(id: string): ContactObject | undefined {
    const c = this.contacts.get(id);
    return c ? { ...c } : undefined;
  }

  createHost(input: Omit<HostObject, 'createdAt' | 'updatedAt' | 'statuses'>, now = Date.now()): HostObject {
    const h: HostObject = { ...input, statuses: new Set(['ok']), createdAt: now, updatedAt: now };
    this.hosts.set(h.name, h);
    this.emit('host.create', undefined, h.registrarId);
    return { ...h, statuses: new Set(h.statuses) };
  }

  getHost(name: string): HostObject | undefined {
    const h = this.hosts.get(normalize(name));
    return h ? { ...h, statuses: new Set(h.statuses) } : undefined;
  }

  // ---- sweep / reporting --------------------------------------------------

  /** Sweep: release domains that have passed pending-delete. */
  sweep(now = Date.now()): string[] {
    const released: string[] = [];
    for (const [name, d] of this.domains) {
      if (recomputePhase(d, now) === 'released') {
        released.push(name);
        this.domains.delete(name);
        this.emit('domain.release', name, d.registrarId);
      }
    }
    return released;
  }

  /** Event log (audit trail of lifecycle changes). */
  eventLog(): Array<{ ts: number; event: string; domain?: string; registrar?: string }> {
    return [...this.events];
  }

  counts(now = Date.now()): { domains: number; active: number; registrars: number; hosts: number; contacts: number } {
    let active = 0;
    for (const d of this.domains.values()) if (recomputePhase(d, now) === 'active') active++;
    return { domains: this.domains.size, active, registrars: this.registrars.size, hosts: this.hosts.size, contacts: this.contacts.size };
  }

  // ---- internals ----------------------------------------------------------

  private mustOwn(name: string, registrarId: string): DomainObject {
    const d = this.domains.get(normalize(name));
    if (!d) throw new RegistryError(`domain ${name} not found`);
    if (d.registrarId !== registrarId) throw new RegistryError(`registrar ${registrarId} does not sponsor ${name}`);
    return d;
  }

  private requireInTld(name: string): void {
    if (!this.inTld(name)) throw new RegistryError(`${name} not in TLD ${this.tld}`);
  }

  /** Whether a FQDN (trailing dot) belongs to this TLD. */
  private inTld(name: string): boolean {
    return name.endsWith(this.tld + '.');
  }

  private emit(event: string, domain: string | undefined, registrar: string | undefined): void {
    const entry = { ts: Date.now(), event, ...(domain ? { domain } : {}), ...(registrar ? { registrar } : {}) };
    this.events.push(entry);
    this.onEvent?.(entry);
  }

  /** Snapshot for escrow (used by escrow.ts). */
  snapshot(): {
    tld: string;
    domains: DomainObject[];
    hosts: HostObject[];
    contacts: ContactObject[];
    registrars: string[];
  } {
    return {
      tld: this.tld,
      domains: this.listDomains(),
      hosts: [...this.hosts.values()].map((h) => ({ ...h, statuses: new Set(h.statuses) })),
      contacts: [...this.contacts.values()],
      registrars: this.listRegistrars().map((r) => r.id),
    };
  }
}

export class RegistryError extends Error {
  constructor(message: string) { super(message); this.name = 'RegistryError'; }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalize(name: string): string {
  let n = name.trim().toLowerCase();
  if (!n.endsWith('.')) n += '.';
  return n;
}

export { GracePeriods, sldOf, hash as hashSecret };
