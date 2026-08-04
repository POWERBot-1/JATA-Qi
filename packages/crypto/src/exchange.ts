// Exchange Abstraction — provides quote generation, swap execution, and
// liquidity pool tracking. Blockchain-agnostic; rates are configurable
// (oracle-fed in production).

import { randomUUID } from 'node:crypto';
import type { ExchangeQuote } from './types.js';

interface LiquidityPool {
  id: string;
  assetA: string;
  assetB: string;
  reserveA: bigint;
  reserveB: bigint;
  feeBps: number; // fee in basis points (e.g. 30 = 0.3%)
}

export class ExchangeEngine {
  private pools = new Map<string, LiquidityPool>();
  private swaps: Array<{ id: string; from: string; to: string; fromAmount: bigint; toAmount: bigint; timestamp: number }> = [];
  private manualRates = new Map<string, number>(); // 'A->B' -> rate

  /** Set a manual exchange rate (oracle override). */
  setRate(fromAsset: string, toAsset: string, rate: number): void {
    this.manualRates.set(`${fromAsset}->${toAsset}`, rate);
  }

  getRate(fromAsset: string, toAsset: string): number {
    return this.manualRates.get(`${fromAsset}->${toAsset}`) ?? 1;
  }

  /** Create an automated market maker (AMM) liquidity pool. */
  createPool(assetA: string, assetB: string, reserveA: bigint, reserveB: bigint, feeBps = 30): LiquidityPool {
    const pool: LiquidityPool = { id: `${assetA}/${assetB}`, assetA, assetB, reserveA, reserveB, feeBps };
    this.pools.set(pool.id, pool);
    return pool;
  }

  /** Generate a quote for swapping fromAsset → toAsset. */
  quote(fromAsset: string, toAsset: string, fromAmount: bigint): ExchangeQuote {
    const rate = this.getRate(fromAsset, toAsset);
    const pool = this.findPool(fromAsset, toAsset);
    let toAmount: bigint;
    let fee: bigint;

    if (pool) {
      // AMM constant-product (x * y = k).
      const isReversed = pool.assetB === fromAsset;
      const inReserve = isReversed ? pool.reserveB : pool.reserveA;
      const outReserve = isReversed ? pool.reserveA : pool.reserveB;
      const feeAmount = (fromAmount * BigInt(pool.feeBps)) / 10000n;
      const amountIn = fromAmount - feeAmount;
      toAmount = (amountIn * outReserve) / (inReserve + amountIn);
      fee = feeAmount;
    } else {
      // Manual rate.
      toAmount = BigInt(Math.floor(Number(fromAmount) * rate));
      fee = (fromAmount * 30n) / 10000n; // 0.3% default
    }

    return {
      fromAsset, toAsset, fromAmount, toAmount, rate: Number(toAmount) / Number(fromAmount),
      fee, expiresAt: Date.now() + 60_000, // 60-second quote validity
    };
  }

  /** Execute a swap based on a quote. */
  swap(quote: ExchangeQuote, fromAddress: string): { id: string; toAmount: bigint } {
    if (quote.expiresAt < Date.now()) throw new Error('quote expired');
    const pool = this.findPool(quote.fromAsset, quote.toAsset);
    if (pool) {
      // Update reserves.
      const isReversed = pool.assetB === quote.fromAsset;
      if (isReversed) {
        pool.reserveB += quote.fromAmount;
        pool.reserveA -= quote.toAmount;
      } else {
        pool.reserveA += quote.fromAmount;
        pool.reserveB -= quote.toAmount;
      }
    }
    const swapId = randomUUID();
    this.swaps.push({ id: swapId, from: quote.fromAsset, to: quote.toAsset, fromAmount: quote.fromAmount, toAmount: quote.toAmount, timestamp: Date.now() });
    void fromAddress;
    return { id: swapId, toAmount: quote.toAmount };
  }

  getPool(id: string): LiquidityPool | undefined { return this.pools.get(id); }
  listPools(): LiquidityPool[] { return [...this.pools.values()]; }
  swapHistory(limit = 100): typeof this.swaps { return this.swaps.slice(-limit); }
  get swapCount(): number { return this.swaps.length; }

  private findPool(a: string, b: string): LiquidityPool | undefined {
    return this.pools.get(`${a}/${b}`) ?? this.pools.get(`${b}/${a}`);
  }
}
