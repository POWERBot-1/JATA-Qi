// Registry catalog policy — reserved names, premium pricing, sunrise and
// trademark claims (TMCH). Implements the eligibility and pricing rules a
// registrar must satisfy before a create/renew is committed.

import type { CatalogPolicy, PremiumRule } from './types.js';

/** ICANN/RFC-9225-style reserved labels applied within a TLD. */
export const DEFAULT_RESERVED = new Set<string>([
  // ICANN reserved two-character labels (ISO 3166 + special).
  'aa', 'ac', 'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'an', 'ao', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax', 'az',
  'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bm', 'bn', 'bo', 'br', 'bs', 'bt', 'bv', 'bw', 'by', 'bz',
  // RFC 2606 reserved / well-known special-use labels.
  'example', 'test', 'invalid', 'localhost',
  // Common infrastructure / abuse reserved.
  'www', 'nic', 'registry', 'registrar', 'dns', 'ns', 'ns1', 'ns2', 'whois', 'rdap',
  'root', 'arpa', 'iana', 'icann', 'admin', 'administrator', 'hostmaster', 'postmaster',
  'abuse', 'security', 'noc', 'soa', 'ftp', 'mail', 'smtp', 'webmail', 'imap', 'pop', 'pop3',
]);

const DEFAULT_POLICY: CatalogPolicy = {
  reserved: DEFAULT_RESERVED,
  reservedPatterns: ['^..$', '^[0-9]+$', '^[a-z]{1}$'], // 1-2 char + all-digit + single char
  premium: [
    { pattern: 'short', kind: 'multiplier', value: 50 }, // <=3 chars premium
  ],
  basePriceCreate: 9.99,
  basePriceRenew: 9.99,
  basePriceRestore: 65.0,
  currency: 'USD',
  sunriseActive: false,
  claimsNoticeDays: 90,
  maxTermYears: 10,
};

export function defaultPolicy(overrides: Partial<CatalogPolicy> = {}): CatalogPolicy {
  return {
    ...DEFAULT_POLICY,
    reserved: overrides.reserved ?? new Set(DEFAULT_RESERVED),
    reservedPatterns: overrides.reservedPatterns ?? [...DEFAULT_POLICY.reservedPatterns],
    premium: overrides.premium ?? [...DEFAULT_POLICY.premium],
    ...overrides,
  };
}

/** Extract the SLD label from a fully-qualified domain name. */
export function sldOf(name: string): string {
  const n = name.replace(/\.+$/, '').toLowerCase();
  const dot = n.indexOf('.');
  return dot < 0 ? n : n.slice(0, dot);
}

/** Whether a name is reserved and therefore not registrable. */
export function isReserved(policy: CatalogPolicy, name: string): boolean {
  const sld = sldOf(name);
  if (policy.reserved.has(sld)) return true;
  return policy.reservedPatterns.some((p) => new RegExp(p).test(sld));
}

/** Whether the SLD is "short" (premium category). */
export function isShort(sld: string): boolean {
  return sld.length <= 3;
}

/** Match a name against the premium rules and return the create price. */
export function premiumPrice(policy: CatalogPolicy, name: string, kind: 'create' | 'renew'): number {
  const base = kind === 'create' ? policy.basePriceCreate : policy.basePriceRenew;
  const sld = sldOf(name);
  let price = base;
  if (isShort(sld)) price = base * 50;
  for (const rule of policy.premium) {
    if (matchesRule(rule, sld)) {
      price = rule.kind === 'fixed' ? rule.value : base * rule.value;
    }
  }
  return Math.round(price * 100) / 100;
}

function matchesRule(rule: PremiumRule, sld: string): boolean {
  if (rule.pattern === 'short') return isShort(sld);
  if (rule.pattern === 'one-word') return sld.length > 3 && /^[a-z]+$/.test(sld);
  // Glob pattern with * wildcards.
  const re = new RegExp('^' + rule.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(sld);
}

/** Whether a registration term is within policy limits. */
export function validTerm(policy: CatalogPolicy, years: number): boolean {
  return Number.isInteger(years) && years >= 1 && years <= policy.maxTermYears;
}

/** Whether a claims notice is required/valid for a name in the claims window. */
export function claimsRequired(policy: CatalogPolicy, name: string, trademarkClaimed: Set<string>): boolean {
  return trademarkClaimed.has(sldOf(name));
}
