// FxModule — KARIS FX kernel module. Wraps the FxEngine, records rate feeds
// and conversions into the Digital Memory Engine (governed), and exposes the
// known currency universe from the Universal Wallet when present.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { UniversalWalletModule } from '@jataqi/universal-wallet';
import { FxEngine, type ConvertInput, type SetRateInput } from './engine.js';
import type { ConversionResult, CurrencyPair, FxStats, PairAnalytics, RatePoint, RateQuote } from './types.js';

export const FxEvents = Object.freeze({
  RateSet: 'fx.rate.set',
  Converted: 'fx.converted',
} as const);

export interface FxModuleConfig {
  /** Anchor currency used for cross rates (default USD). */
  anchor?: string;
}

export class FxModule implements IModule {
  readonly id = 'fx';
  readonly tags = ['core', 'finance', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new FxEngine();
  private readonly anchor: string;

  constructor(cfg: FxModuleConfig = {}) {
    this.anchor = cfg.anchor ?? 'USD';
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('fx', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('fx module initialized (KARIS FX, anchor USD)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- rates -------------------------------------------------------------

  setRate(input: SetRateInput): RateQuote {
    const quote = this.engine.setRate(input);
    void this.api.bus.emit(FxEvents.RateSet, { pair: quote.pair, bid: quote.bid, ask: quote.ask });
    void this.recordMemory('fx_rate', `rate ${quote.pair} bid=${quote.bid} ask=${quote.ask}`, { pair: quote.pair, bid: quote.bid, ask: quote.ask, source: quote.source });
    return quote;
  }

  getRate(base: string, quote: string): RateQuote | undefined {
    return this.engine.getRate(base, quote, this.anchor);
  }

  listRates(): RateQuote[] {
    return this.engine.listRates();
  }

  historyFor(pair: CurrencyPair, opts?: { fromTs?: number; toTs?: number; limit?: number }): RatePoint[] {
    return this.engine.historyFor(pair, opts);
  }

  // ---- conversion --------------------------------------------------------

  convert(input: ConvertInput): ConversionResult {
    const result = this.engine.convert(input);
    void this.api.bus.emit(FxEvents.Converted, { from: result.from, to: result.to, amount: result.amount.toString(), result: result.result.toString() });
    void this.recordMemory('fx_conversion', `converted ${result.amount} ${result.from} → ${result.result} ${result.to}`, {
      from: result.from, to: result.to, amount: result.amount.toString(), result: result.result.toString(), rate: result.rate,
    });
    return result;
  }

  // ---- analytics + discovery ---------------------------------------------

  analyze(pair: CurrencyPair, opts?: { fromTs?: number; toTs?: number; windowMs?: number }): PairAnalytics | undefined {
    return this.engine.analyze(pair, opts);
  }

  /** Known currency universe (from the Universal Wallet when present). */
  currencies(): string[] {
    try {
      const wallet = this.api.getModule<UniversalWalletModule>('universal-wallet');
      return wallet.listCurrencies().map((c) => c.code);
    } catch {
      return ['USD', 'EUR', 'GBP', 'KES', 'UGX', 'TZS', 'NGN', 'ZAR', 'KRT', 'USDT', 'USDC'];
    }
  }

  stats(): FxStats {
    return this.engine.stats();
  }

  get anchorCurrency(): string {
    return this.anchor;
  }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['fx', category] });
    } catch { /* memory write failed — non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
