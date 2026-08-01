// Registry connections — the registrar provisions through a registry either
// directly (embedded, same-process) or over EPP (RFC 5730/5734). Both implement
// the RegistryConnection surface used by the registrar flows.

import type { Registry } from '@jataqi/registry';
import { EppClient, parseXml, child } from '@jataqi/registry';
import type { DomainInfo, RegistryConnection } from './types.js';

/** Direct (embedded) connection: operates on a Registry instance in-process. */
export class DirectRegistryConnection implements RegistryConnection {
  constructor(private registry: Registry, private registrarId: string) {}

  async check(names: string[]): Promise<DomainInfo[]> {
    return this.registry.checkAvailabilityBatch(names).map((r) => ({
      name: r.name,
      available: r.available,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.premium ? { premium: r.premium } : {}),
      ...(r.price ? { price: { amount: r.price, currency: this.registry.policy.currency } } : {}),
    }));
  }

  async create(name: string, opts: { periodYears: number; registrant?: string; authInfo?: string; nameservers?: string[] }): Promise<{ name: string; expiresAt: number }> {
    const d = this.registry.createDomain({
      name, registrarId: this.registrarId, registrant: opts.registrant ?? `${this.registrarId}-contact`,
      nameservers: opts.nameservers, periodYears: opts.periodYears, authInfo: opts.authInfo ?? random(),
    });
    return { name: d.name, expiresAt: d.expiresAt };
  }

  async renew(name: string, periodYears: number): Promise<{ expiresAt: number }> {
    const r = this.registry.renew(name, this.registrarId, periodYears);
    return { expiresAt: r.domain.expiresAt };
  }

  async transfer(name: string, authInfo: string): Promise<{ state: string }> {
    const rec = this.registry.requestTransfer(name, this.registrarId, authInfo);
    return { state: rec.state };
  }

  async restore(name: string): Promise<{ expiresAt: number }> {
    const r = this.registry.restoreDomain(name, this.registrarId);
    return { expiresAt: r.domain.expiresAt };
  }

  async delete(name: string): Promise<void> {
    this.registry.deleteDomain(name, this.registrarId);
  }

  async info(name: string): Promise<DomainInfo | undefined> {
    const d = this.registry.info(name);
    if (!d) return { name, available: true };
    return {
      name: d.name, available: false, phase: d.phase, registrarId: d.registrarId, expiresAt: d.expiresAt,
    };
  }
}

/** EPP connection: provisions through a registry over RFC 5734 (real network). */
export class EppRegistryConnection implements RegistryConnection {
  constructor(private client: EppClient) {}

  async check(names: string[]): Promise<DomainInfo[]> {
    const r = await this.client.check(names);
    const results: DomainInfo[] = [];
    if (r.resData) {
      const cds = r.resData.local === 'chkData' ? r.resData.children : [];
      for (const cd of cds) {
        const nameNode = child(cd, 'name');
        if (nameNode) results.push({ name: nameNode.text, available: nameNode.attrs.avail === '1' });
      }
    }
    return results;
  }

  async create(name: string, opts: { periodYears: number; registrant?: string; authInfo?: string; nameservers?: string[] }): Promise<{ name: string; expiresAt: number }> {
    const r = await this.client.create(name, opts);
    let expiresAt = Date.now();
    if (r.resData) {
      const ex = child(r.resData, 'exDate');
      if (ex) expiresAt = Date.parse(ex.text);
    }
    if (r.code >= 2000) throw new Error(`EPP create failed: ${r.code} ${r.msg}`);
    return { name, expiresAt };
  }

  async renew(name: string, periodYears: number): Promise<{ expiresAt: number }> {
    const r = await this.client.renew(name, new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10), periodYears);
    if (r.code >= 2000) throw new Error(`EPP renew failed: ${r.code} ${r.msg}`);
    return { expiresAt: Date.now() + periodYears * 365 * 86400_000 };
  }

  async transfer(name: string, authInfo: string): Promise<{ state: string }> {
    const r = await this.client.transfer(name, 'request', authInfo);
    if (r.code >= 2000 && r.code !== 1001) throw new Error(`EPP transfer failed: ${r.code} ${r.msg}`);
    return { state: r.code === 1001 ? 'pending' : 'approved' };
  }

  async restore(name: string): Promise<{ expiresAt: number }> {
    // RGP restore is an update with an rgp restore extension; modeled as renew here.
    return this.renew(name, 1);
  }

  async delete(name: string): Promise<void> {
    const r = await this.client.delete(name);
    if (r.code >= 2000) throw new Error(`EPP delete failed: ${r.code} ${r.msg}`);
  }

  async info(name: string): Promise<DomainInfo | undefined> {
    const r = await this.client.info(name);
    if (r.code >= 2000) return { name, available: true };
    return { name, available: false };
  }
}

function random(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export { parseXml };
