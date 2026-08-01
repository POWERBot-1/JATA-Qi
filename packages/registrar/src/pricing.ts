// Pricing engine — compute create/renew/restore prices from a base + premium
// multiplier + promo discounts. Currency-aware (ISO 4217).

import type { Money } from '@jataqi/commerce';
import type { PromoCode } from './types.js';

export interface PriceBook {
  baseCreate: number;
  baseRenew: number;
  baseRestore: number;
  currency: string;
}

/** Compute the create price for a name, honoring a premium multiplier. */
export function createPrice(book: PriceBook, name: string, premiumMultiplier = 1): Money {
  const amount = round2(book.baseCreate * premiumMultiplier);
  return { amount, currency: book.currency };
}

/** Compute the renew price. Premium renewals use the same multiplier. */
export function renewPrice(book: PriceBook, name: string, premiumMultiplier = 1): Money {
  return { amount: round2(book.baseRenew * premiumMultiplier), currency: book.currency };
}

export function restorePrice(book: PriceBook): Money {
  return { amount: round2(book.baseRestore), currency: book.currency };
}

/** Apply a promo code to a price; returns the discounted price and consumes a use. */
export function applyPromo(price: Money, promo: PromoCode | undefined, now = Date.now()): { price: Money; applied: boolean } {
  if (!promo || !promo.active || promo.validUntil < now) return { price, applied: false };
  if (promo.maxUses > 0 && promo.uses >= promo.maxUses) return { price, applied: false };
  promo.uses += 1;
  const discounted = round2(price.amount * (1 - promo.discountPct));
  return { price: { amount: discounted, currency: price.currency }, applied: true };
}

/** Total price for a multi-year term (price is per-year). */
export function termTotal(perYear: Money, years: number): Money {
  return { amount: round2(perYear.amount * years), currency: perYear.currency };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
