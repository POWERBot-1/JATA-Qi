// @jataqi/fx — KARIS FX Foreign Exchange Intelligence (Phase 6). Public API.

export { FxModule, FxEvents } from './fx-module.js';
export type { FxModuleConfig } from './fx-module.js';
export { FxEngine, pairKey } from './engine.js';
export type { SetRateInput, ConvertInput } from './engine.js';
export type {
  CurrencyPair, RateQuote, ConversionResult, RatePoint, PairAnalytics, FxStats,
} from './types.js';
