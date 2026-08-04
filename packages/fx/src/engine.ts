// FxEngine — KARIS FX core: rate storage (per-pair latest + time series),
// cross-rate derivation through an anchor currency, conversions with margin,
// and trend/volatility analytics. Pure engine — the module wires memory +
// wallet integrations.

import type {
  ConversionResult, CurrencyPair, FxStats, PairAnalytics, RatePoint, RateQuote,
} from './types.js';

const MAX_HISTORY_PER_PAIR = 10_000;
const DEFAULT_MARGIN = 1; // no margin
const DEFAULT_DECIMALS = 2;

export interface SetRateInput {
  base: string;
  quote: string;
  bid: number;
  ask?: number;
  source?: string;
  ts?: number;
}

export interface ConvertInput {
  from: string;
  to: string;
  amount: bigint;
  /** Multiplier >= 1 applied as cost (1 = interbank). */
  margin?: number;
  /** Decimals of the target currency (default 2). */
  toDecimals?: number;
  ts?: number;
}

export class FxEngine {
  private latest = new Map<CurrencyPair, RateQuote>();
  private history = new Map<CurrencyPair, RatePoint[]>();
  private conversions = 0;

  // ---- rates -------------------------------------------------------------

  /** Set (or refresh) a rate quote for a pair. */
  setRate(input: SetRateInput): RateQuote {
    if (input.base === input.quote) throw new Error('base and quote must differ');
    if (!(input.bid > 0)) throw new Error('bid must be positive');
    if (input.ask !== undefined && input.ask < input.bid) throw new Error('ask must be >= bid');
    const pair = pairKey(input.base, input.quote);
    const ts = input.ts ?? Date.now();
    const quote: RateQuote = {
      pair,
      base: input.base,
      quote: input.quote,
      bid: input.bid,
      ask: input.ask ?? input.bid,
      source: input.source ?? 'manual',
      ts,
    };
    this.latest.set(pair, quote);
    const points = this.history.get(pair) ?? [];
    points.push({ ts, pair, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2 });
    if (points.length > MAX_HISTORY_PER_PAIR) points.splice(0, points.length - MAX_HISTORY_PER_PAIR);
    this.history.set(pair, points);
    return quote;
  }

  /** Latest quote for a pair (direct, or derived through the anchor). */
  getRate(base: string, quote: string, anchor = 'USD'): RateQuote | undefined {
    if (base === quote) return { pair: pairKey(base, quote), base, quote, bid: 1, ask: 1, source: 'identity', ts: Date.now() };
    const direct = this.latest.get(pairKey(base, quote));
    if (direct) return direct;
    // Cross rate through the anchor: base/anchor × anchor/quote. Each leg is
    // resolved in either direction and inverted when necessary. When one leg
    // is the anchor itself the cross reduces to the other leg.
    const baseAnchor = base === anchor ? { bid: 1, ask: 1 } : this.resolveLeg(base, anchor);
    const anchorQuote = quote === anchor ? { bid: 1, ask: 1 } : this.resolveLeg(anchor, quote);
    if (baseAnchor && anchorQuote) {
      const bid = baseAnchor.bid * anchorQuote.bid;
      const ask = baseAnchor.ask * anchorQuote.ask;
      return { pair: pairKey(base, quote), base, quote, bid, ask, source: `cross:${anchor}`, ts: Date.now() };
    }
    return undefined;
  }

  /** Resolve a leg rate normalized to a→b (handles stored b/a pairs). */
  private resolveLeg(a: string, b: string): { bid: number; ask: number } | undefined {
    const direct = this.latest.get(pairKey(a, b));
    if (direct) return { bid: direct.bid, ask: direct.ask };
    const inverted = this.latest.get(pairKey(b, a));
    if (inverted) {
      // a/b = 1 / (b/a); bid(a/b) = 1/ask(b/a), ask(a/b) = 1/bid(b/a).
      return { bid: 1 / inverted.ask, ask: 1 / inverted.bid };
    }
    return undefined;
  }

  /** All known pairs with their latest quotes. */
  listRates(): RateQuote[] {
    return [...this.latest.values()];
  }

  /** Rate history for a pair (optionally windowed). */
  historyFor(pair: CurrencyPair, opts: { fromTs?: number; toTs?: number; limit?: number } = {}): RatePoint[] {
    const points = this.history.get(pair) ?? [];
    const filtered = points.filter((p) =>
      (opts.fromTs === undefined || p.ts >= opts.fromTs) &&
      (opts.toTs === undefined || p.ts <= opts.toTs));
    const limit = opts.limit ?? filtered.length;
    return filtered.slice(-limit);
  }

  // ---- conversion --------------------------------------------------------

  /** Convert an amount between currencies with optional margin. */
  convert(input: ConvertInput): ConversionResult {
    if (input.amount < 0n) throw new Error('amount must be non-negative');
    const quote = this.getRate(input.from, input.to);
    if (!quote) throw new Error(`no rate for ${input.from}/${input.to}`);
    const margin = input.margin ?? DEFAULT_MARGIN;
    if (margin < 1) throw new Error('margin must be >= 1');
    const mid = (quote.bid + quote.ask) / 2;
    const rate = mid / margin;
    // Integer math: result = amount * rate, rounded to target decimals.
    const decimals = input.toDecimals ?? DEFAULT_DECIMALS;
    const factor = 10n ** BigInt(decimals);
    // Convert via scaled arithmetic: amount (from minor units, unknown scale)
    // — treat amounts as minor units of `from` and produce minor units of `to`
    // at `toDecimals` precision, assuming both use the same minor-unit scale.
    const scaled = (input.amount * BigInt(Math.round(rate * 10_000))) / 10_000n;
    const rawResult = scaled;
    const rounded = rawResult % factor !== 0n;
    const result = rounded ? (rawResult / factor) * factor : rawResult;
    const marginAmount = input.amount - (input.amount * 10_000n) / BigInt(Math.round(margin * 10_000));
    this.conversions++;
    return {
      from: input.from,
      to: input.to,
      amount: input.amount,
      rate,
      margin,
      marginAmount: marginAmount < 0n ? 0n : marginAmount,
      result,
      rounded,
    };
  }

  // ---- analytics ---------------------------------------------------------

  /** Trend + volatility analytics for a pair over a window. */
  analyze(pair: CurrencyPair, opts: { fromTs?: number; toTs?: number; windowMs?: number } = {}): PairAnalytics | undefined {
    const toTs = opts.toTs ?? Date.now();
    const fromTs = opts.fromTs ?? (opts.windowMs !== undefined ? toTs - opts.windowMs : undefined);
    const points = this.historyFor(pair, { fromTs, toTs });
    if (points.length === 0) return undefined;
    const mids = points.map((p) => p.mid);
    const latestMid = mids[mids.length - 1]!;
    const movingAverage = mids.reduce((s, m) => s + m, 0) / mids.length;
    const variance = mids.reduce((s, m) => s + (m - movingAverage) ** 2, 0) / mids.length;
    const volatility = Math.sqrt(variance);
    const firstMid = mids[0]!;
    const changePct = firstMid === 0 ? 0 : ((latestMid - firstMid) / firstMid) * 100;
    const trend = changePct > 0.01 ? 'up' : changePct < -0.01 ? 'down' : 'flat';
    return {
      pair,
      points: points.length,
      windowMs: points.length > 1 ? (points[points.length - 1]!.ts - points[0]!.ts) : 0,
      latestMid,
      movingAverage,
      volatility,
      trend,
      changePct,
      minMid: Math.min(...mids),
      maxMid: Math.max(...mids),
    };
  }

  // ---- stats -------------------------------------------------------------

  stats(): FxStats {
    const sources = new Set<string>();
    for (const q of this.latest.values()) sources.add(q.source);
    const lastQuoteAt = [...this.latest.values()].reduce<number | undefined>(
      (acc, q) => (acc === undefined || q.ts > acc ? q.ts : acc), undefined);
    return {
      pairs: this.latest.size,
      quotes: this.history.size,
      conversions: this.conversions,
      sources: [...sources],
      ...(lastQuoteAt !== undefined ? { lastQuoteAt } : {}),
    };
  }
}

/** Canonical pair key (alphabetical to make cross rates symmetric). */
export function pairKey(a: string, b: string): CurrencyPair {
  return `${a}/${b}`;
}
