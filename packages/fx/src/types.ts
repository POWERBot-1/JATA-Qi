// KARIS FX — Foreign Exchange Intelligence (Phase 6) types.

/** A currency pair, e.g. 'USD/KES'. */
export type CurrencyPair = string;

/** A market rate observation for a pair. */
export interface RateQuote {
  pair: CurrencyPair;
  /** Base currency (1 unit of base = `bid` units of quote). */
  base: string;
  quote: string;
  /** Price at which the market buys the base (you sell base at bid). */
  bid: number;
  /** Price at which the market sells the base (you buy base at ask). */
  ask: number;
  /** Source/oracle identifier. */
  source: string;
  /** When the rate was observed. */
  ts: number;
}

/** A single conversion result. */
export interface ConversionResult {
  from: string;
  to: string;
  /** Amount in `from` currency (minor-unit integer). */
  amount: bigint;
  /** Mid rate applied (before margin). */
  rate: number;
  /** Margin applied as a multiplier (1 = no margin). */
  margin: number;
  /** Margin amount deducted (in `from` units). */
  marginAmount: bigint;
  /** Result in `to` currency (minor-unit integer, rounded to `to` decimals). */
  result: bigint;
  /** Rounding applied to the raw result. */
  rounded: boolean;
}

/** Historical rate point. */
export interface RatePoint {
  ts: number;
  pair: CurrencyPair;
  bid: number;
  ask: number;
  mid: number;
}

/** Trend analysis for a pair over a window. */
export interface PairAnalytics {
  pair: CurrencyPair;
  points: number;
  windowMs: number;
  latestMid: number;
  /** Simple moving average of mid over the window. */
  movingAverage: number;
  /** Population standard deviation of mid (volatility). */
  volatility: number;
  /** Direction: 'up' | 'down' | 'flat'. */
  trend: 'up' | 'down' | 'flat';
  /** Relative change over the window (latest vs first). */
  changePct: number;
  minMid: number;
  maxMid: number;
}

export interface FxStats {
  pairs: number;
  quotes: number;
  conversions: number;
  sources: string[];
  lastQuoteAt?: number;
}
