// Money helpers. Prices are kept per-currency; the engine never silently
// converts a customer-facing price across currencies. Aggregations (e.g. MRR)
// are reported per-currency to avoid pretending mixed currencies are equal.

import type { BillingCycle, Money } from './types.js';

const MONTHS_PER_CYCLE: Record<BillingCycle, number> = {
  HOURLY: 1 / 720, DAILY: 1 / 30, WEEKLY: 1 / 4.345, MONTHLY: 1,
  QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24,
  CUSTOM: 1, ONE_TIME: 0, LIFETIME: 0,
};

export function money(amount: number, currency: string): Money {
  return { amount: Math.round(amount * 100) / 100, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`commerce: cannot add ${a.currency} + ${b.currency} (no silent conversion)`);
  return money(a.amount + b.amount, a.currency);
}

export function multiply(a: Money, factor: number): Money {
  return money(a.amount * factor, a.currency);
}

export function pct(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100 * 100) / 100;
}

/** Normalize a price to its monthly equivalent for MRR (per-currency). 0 for non-recurring. */
export function monthlyEquivalent(price: Money, cycle: BillingCycle): Money {
  const months = MONTHS_PER_CYCLE[cycle] ?? 0;
  return months > 0 ? multiply(price, 1 / months) : money(0, price.currency);
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}
