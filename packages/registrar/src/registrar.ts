// Registrar — an accredited domain registrar. Implements the registrant-facing
// flows (Part B): search, register, renew, transfer, restore, bulk registration,
// portfolio management, pricing, billing, identity verification, compliance.
// Provisions through a RegistryConnection (direct or EPP).

import { randomUUID } from 'node:crypto';
import type { CommerceModule, Money } from '@jataqi/commerce';
import { IdentityStore } from './identity.js';
import { evaluateCompliance, type ComplianceOptions } from './compliance.js';
import { createPrice, renewPrice, restorePrice, applyPromo, termTotal, type PriceBook } from './pricing.js';
import type { BulkJob, ComplianceResult, DomainInfo, DomainOrder, PromoCode, Registrant, RegistryConnection } from './types.js';

export interface RegistrarOptions {
  id: string;
  name: string;
  /** Accreditation grant id authorizing this registrar (Part L). */
  accreditationGrantId?: string;
  priceBook: PriceBook;
  connection: RegistryConnection;
  compliance?: Partial<ComplianceOptions>;
  /** Commerce module for billing (optional; orders are recorded regardless). */
  commerce?: CommerceModule;
  currency?: string;
}

export class Registrar {
  readonly id: string;
  readonly name: string;
  readonly accreditationGrantId?: string;
  readonly priceBook: PriceBook;
  readonly identities = new IdentityStore();
  private conn: RegistryConnection;
  private compliance: ComplianceOptions;
  private commerce?: CommerceModule;
  private promos = new Map<string, PromoCode>();
  private orders: DomainOrder[] = [];
  private portfolios = new Map<string, Set<string>>(); // registrantId -> domain names

  constructor(opts: RegistrarOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.accreditationGrantId = opts.accreditationGrantId;
    this.priceBook = opts.priceBook;
    this.conn = opts.connection;
    this.commerce = opts.commerce;
    this.compliance = {
      requireKyc: opts.compliance?.requireKyc ?? false,
      blockedRegistrants: opts.compliance?.blockedRegistrants ?? new Set(),
      trademarkClaims: opts.compliance?.trademarkClaims ?? new Set(),
    };
  }

  setConnection(conn: RegistryConnection): void { this.conn = conn; }
  getConnection(): RegistryConnection { return this.conn; }

  // ---- promotions --------------------------------------------------------

  addPromo(promo: PromoCode): void { this.promos.set(promo.code, promo); }
  getPromo(code: string): PromoCode | undefined { return this.promos.get(code); }

  // ---- search ------------------------------------------------------------

  /** Search availability for one or more names. */
  async search(names: string[]): Promise<DomainInfo[]> {
    return this.conn.check(names);
  }

  // ---- compliance --------------------------------------------------------

  async evaluate(name: string, registrantId?: string): Promise<{ check: DomainInfo; compliance: ComplianceResult }> {
    const checks = await this.conn.check([name]);
    const check = checks[0]!;
    const registrant = registrantId ? this.identities.get(registrantId) : undefined;
    return { check, compliance: evaluateCompliance(check, registrant, this.compliance) };
  }

  // ---- register ----------------------------------------------------------

  /**
   * Register a domain: search → compliance → pricing → bill → create. Returns
   * the completed order. Throws on compliance failure or registry error.
   */
  async register(input: {
    name: string; registrantId: string; periodYears: number; nameservers?: string[];
    promoCode?: string; claimsNoticeId?: string;
  }): Promise<DomainOrder> {
    const { check, compliance } = await this.evaluate(input.name, input.registrantId);
    if (!compliance.ok) {
      return this.failOrder(input, `compliance: ${compliance.reasons.join('; ')}`);
    }
    const order = this.newOrder(input, 'create');
    let price = termTotal(createPrice(this.priceBook, input.name, check.premium ? 50 : 1), input.periodYears);
    if (input.promoCode) {
      const applied = applyPromo(price, this.promos.get(input.promoCode));
      if (applied.applied) { price = applied.price; order.promoCode = input.promoCode; }
    }
    order.price = price;
    await this.bill(order, input.registrantId);
    try {
      const result = await this.conn.create(input.name, {
        periodYears: input.periodYears,
        registrant: input.registrantId,
        nameservers: input.nameservers,
        ...(input.claimsNoticeId ? { authInfo: input.claimsNoticeId } : {}),
      });
      order.status = 'completed';
      this.portfolios.set(input.registrantId, (this.portfolios.get(input.registrantId) ?? new Set()).add(result.name));
    } catch (e) {
      order.status = 'failed';
      order.error = e instanceof Error ? e.message : 'create failed';
      await this.refund(order);
    }
    this.orders.push(order);
    return order;
  }

  async renew(input: { name: string; registrantId: string; periodYears: number; promoCode?: string }): Promise<DomainOrder> {
    const order = this.newOrder(input, 'renew');
    let price = termTotal(renewPrice(this.priceBook, input.name), input.periodYears);
    if (input.promoCode) {
      const applied = applyPromo(price, this.promos.get(input.promoCode));
      if (applied.applied) { price = applied.price; order.promoCode = input.promoCode; }
    }
    order.price = price;
    await this.bill(order, input.registrantId);
    try {
      await this.conn.renew(input.name, input.periodYears);
      order.status = 'completed';
    } catch (e) {
      order.status = 'failed';
      order.error = e instanceof Error ? e.message : 'renew failed';
      await this.refund(order);
    }
    this.orders.push(order);
    return order;
  }

  async transfer(input: { name: string; registrantId: string; authInfo: string; periodYears?: number }): Promise<DomainOrder> {
    const order = this.newOrder({ ...input, periodYears: input.periodYears ?? 1 }, 'transfer');
    order.price = termTotal(createPrice(this.priceBook, input.name, 1), input.periodYears ?? 1);
    await this.bill(order, input.registrantId);
    try {
      const r = await this.conn.transfer(input.name, input.authInfo);
      order.status = r.state === 'rejected' ? 'failed' : 'completed';
      if (order.status === 'completed') this.portfolios.set(input.registrantId, (this.portfolios.get(input.registrantId) ?? new Set()).add(input.name));
      else order.error = 'transfer rejected';
    } catch (e) {
      order.status = 'failed';
      order.error = e instanceof Error ? e.message : 'transfer failed';
      await this.refund(order);
    }
    this.orders.push(order);
    return order;
  }

  async restore(input: { name: string; registrantId: string }): Promise<DomainOrder> {
    const order = this.newOrder({ ...input, periodYears: 1 }, 'restore');
    order.price = restorePrice(this.priceBook);
    await this.bill(order, input.registrantId);
    try {
      await this.conn.restore(input.name);
      order.status = 'completed';
    } catch (e) {
      order.status = 'failed';
      order.error = e instanceof Error ? e.message : 'restore failed';
      await this.refund(order);
    }
    this.orders.push(order);
    return order;
  }

  // ---- bulk --------------------------------------------------------------

  /** Register many names for a registrant in one job. */
  async bulkRegister(input: { registrantId: string; requests: Array<{ domain: string; periodYears: number }>; nameservers?: string[] }): Promise<BulkJob> {
    const job: BulkJob = { id: randomUUID(), registrantId: input.registrantId, requests: input.requests, results: [], status: 'running', createdAt: Date.now() };
    for (const req of input.requests) {
      try {
        const order = await this.register({ name: req.domain, registrantId: input.registrantId, periodYears: req.periodYears, nameservers: input.nameservers });
        if (order.status === 'completed') job.results.push({ domain: req.domain, ok: true });
        else job.results.push({ domain: req.domain, ok: false, error: order.error });
      } catch (e) {
        job.results.push({ domain: req.domain, ok: false, error: e instanceof Error ? e.message : 'failed' });
      }
    }
    const failures = job.results.filter((r) => !r.ok).length;
    job.status = failures === 0 ? 'completed' : 'partial';
    return job;
  }

  // ---- portfolio ---------------------------------------------------------

  /** Domains owned by a registrant (per the registrar's records). */
  portfolio(registrantId: string): string[] {
    return [...(this.portfolios.get(registrantId) ?? new Set<string>())];
  }

  /** All orders (audit / billing history). */
  listOrders(registrantId?: string): DomainOrder[] {
    const all = [...this.orders];
    return registrantId ? all.filter((o) => o.registrantId === registrantId) : all;
  }

  // ---- internals ---------------------------------------------------------

  private newOrder(input: { name: string; registrantId: string; periodYears: number }, kind: DomainOrder['kind']): DomainOrder {
    return {
      id: randomUUID(), registrantId: input.registrantId, kind, domain: input.name, periodYears: input.periodYears,
      price: { amount: 0, currency: this.priceBook.currency }, status: 'pending', createdAt: Date.now(),
    };
  }

  private failOrder(input: { name: string; registrantId: string; periodYears: number }, error: string): DomainOrder {
    const order = this.newOrder(input, 'create');
    order.status = 'failed';
    order.error = error;
    this.orders.push(order);
    return order;
  }

  private async bill(order: DomainOrder, customerId: string): Promise<void> {
    if (!this.commerce) return;
    try {
      const payment = await this.commerce.charge(customerId, order.price, `domain:${order.kind}:${order.domain}`, {});
      order.paymentRef = payment.reference;
      const invoice = await this.commerce.createInvoice(customerId, [{
        description: `${order.kind} ${order.domain} (${order.periodYears}y)`,
        quantity: 1, unitPrice: order.price, total: order.price,
      }], { currency: order.price.currency });
      order.invoiceId = invoice.id;
    } catch (e) {
      order.status = 'failed';
      order.error = `billing: ${e instanceof Error ? e.message : 'charge failed'}`;
    }
  }

  private async refund(order: DomainOrder): Promise<void> {
    if (!this.commerce || !order.paymentRef || order.status !== 'failed') return;
    try {
      await this.commerce.refund(order.paymentRef);
      order.status = 'refunded';
    } catch { /* refund best-effort */ }
  }
}

export type { Money };
