// Staking Engine — manages staking positions, reward accrual (APR-based),
// lockup periods, and unstaking. Blockchain-agnostic.

import { randomUUID } from 'node:crypto';
import type { StakePosition } from './types.js';

export class StakingEngine {
  private positions = new Map<string, StakePosition>();
  private defaultApr: number;
  private defaultLockupDays: number;

  constructor(opts: { defaultApr?: number; defaultLockupDays?: number } = {}) {
    this.defaultApr = opts.defaultApr ?? 0.05; // 5%
    this.defaultLockupDays = opts.defaultLockupDays ?? 30;
  }

  /** Stake tokens. Returns the staking position. */
  stake(staker: string, assetSymbol: string, amount: bigint, opts?: { apr?: number; lockupDays?: number }): StakePosition {
    const apr = opts?.apr ?? this.defaultApr;
    const lockupDays = opts?.lockupDays ?? this.defaultLockupDays;
    const now = Date.now();
    const pos: StakePosition = {
      id: randomUUID(), staker, assetSymbol, amount, apr,
      stakedAt: now, unlockAt: now + lockupDays * 86_400_000,
      rewardsAccrued: 0n, lastRewardCalc: now, status: 'active',
    };
    this.positions.set(pos.id, pos);
    return pos;
  }

  /** Calculate and accrue pending rewards for a position. */
  accrueRewards(positionId: string, now = Date.now()): bigint {
    const pos = this.positions.get(positionId);
    if (!pos || pos.status !== 'active') return 0n;
    const elapsedSec = (now - pos.lastRewardCalc) / 1000;
    const reward = BigInt(Math.floor(Number(pos.amount) * pos.apr * (elapsedSec / (365 * 24 * 3600))));
    pos.rewardsAccrued += reward;
    pos.lastRewardCalc = now;
    return reward;
  }

  /** Accrue rewards for all active positions. */
  accrueAll(now = Date.now()): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.status === 'active') { this.accrueRewards(pos.id, now); count++; }
    }
    return count;
  }

  /** Initiate unstaking (requires lockup period to have elapsed). */
  unstake(positionId: string, now = Date.now()): StakePosition {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`position ${positionId} not found`);
    if (pos.status !== 'active') throw new Error(`position is ${pos.status}`);
    if (now < pos.unlockAt) throw new Error(`lockup period not elapsed (unlocks at ${new Date(pos.unlockAt).toISOString()})`);
    this.accrueRewards(positionId, now);
    pos.status = 'unstaking';
    return pos;
  }

  /** Withdraw an unstaking position (returns principal + rewards). */
  withdraw(positionId: string): { principal: bigint; rewards: bigint } {
    const pos = this.positions.get(positionId);
    if (!pos) throw new Error(`position ${positionId} not found`);
    if (pos.status !== 'unstaking') throw new Error(`position must be unstaking (current: ${pos.status})`);
    pos.status = 'withdrawn';
    return { principal: pos.amount, rewards: pos.rewardsAccrued };
  }

  getPosition(id: string): StakePosition | undefined { return this.positions.get(id); }
  positionsByStaker(staker: string): StakePosition[] { return [...this.positions.values()].filter((p) => p.staker === staker); }
  positionsByAsset(symbol: string): StakePosition[] { return [...this.positions.values()].filter((p) => p.assetSymbol === symbol); }
  listPositions(status?: StakePosition['status']): StakePosition[] {
    const all = [...this.positions.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  /** Total value staked by asset. */
  totalStaked(symbol?: string): bigint {
    let total = 0n;
    for (const p of this.positions.values()) {
      if (p.status !== 'active') continue;
      if (symbol && p.assetSymbol !== symbol) continue;
      total += p.amount;
    }
    return total;
  }

  get positionCount(): number { return this.positions.size; }
}
