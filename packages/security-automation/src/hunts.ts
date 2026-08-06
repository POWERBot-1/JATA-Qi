// Scheduled continuous threat hunting.
//
// Runs the SOC's hunt playbooks on a configurable interval (like the DR
// backup scheduler pattern) and records each sweep. Manual runs are supported
// for on-demand hunts (and tests).

import type { HuntSession } from '@jataqi/soc';

export interface HuntScheduleConfig {
  /** Interval between sweeps in ms (0 = disabled). */
  intervalMs: number;
  /** Specific playbook ids; empty = all playbooks. */
  playbooks?: string[];
  /** Look-back window for each hunt (ms); undefined = full lake. */
  sinceMs?: number;
}

export interface HuntSweepResult {
  at: number;
  sessions: HuntSession[];
  totalHits: number;
  triggered: boolean;
}

export interface HuntRunner {
  hunt(playbookId: string, opts?: { since?: number; limit?: number }): HuntSession;
  huntAll(opts?: { since?: number }): HuntSession[];
}

export class HuntScheduler {
  private timer: NodeJS.Timeout | null = null;
  private sweeps: HuntSweepResult[] = [];
  private config: HuntScheduleConfig = { intervalMs: 0 };
  private runner: HuntRunner;
  /** Callback fired after each sweep (e.g. to emit bus events). */
  private onSweep?: (result: HuntSweepResult) => void;

  constructor(runner: HuntRunner, onSweep?: (result: HuntSweepResult) => void) {
    this.runner = runner;
    this.onSweep = onSweep;
  }

  configure(config: HuntScheduleConfig): HuntScheduleConfig {
    this.config = config;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (config.intervalMs > 0) {
      this.timer = setInterval(() => { void this.runSweep(); }, config.intervalMs);
      this.timer.unref?.();
    }
    return this.config;
  }

  configValue(): HuntScheduleConfig {
    return { ...this.config };
  }

  /** Run a full hunt sweep now (all configured playbooks). */
  async runSweep(): Promise<HuntSweepResult> {
    const since = this.config.sinceMs !== undefined ? Date.now() - this.config.sinceMs : undefined;
    const sessions = this.config.playbooks && this.config.playbooks.length > 0
      ? this.config.playbooks.map((id) => this.runner.hunt(id, since !== undefined ? { since } : undefined))
      : this.runner.huntAll(since !== undefined ? { since } : undefined);
    const totalHits = sessions.reduce((s, x) => s + x.hits.length, 0);
    const result: HuntSweepResult = {
      at: Date.now(), sessions, totalHits,
      triggered: sessions.some((s) => s.hits.length > 0),
    };
    this.sweeps.push(result);
    this.onSweep?.(result);
    return result;
  }

  sweepsList(): HuntSweepResult[] {
    return [...this.sweeps].reverse();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
