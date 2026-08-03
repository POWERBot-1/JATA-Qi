// LiveOpsModule — the live-operations control plane (section 15). Integrates the
// event scheduler, analytics, experimentation, feature flags, offer targeting,
// remote configuration, and season management behind one kernel module, and
// publishes a full live-ops event stream on the bus.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { EventScheduler } from './schedule.js';
import { Analytics, dayKey } from './analytics.js';
import { ExperimentManager, FeatureFlagManager, segmentMatches } from './experiments.js';
import type { LiveEvent, Offer, TelemetryEvent } from './types.js';

export const LiveOpsEvents = Object.freeze({
  EventStarted: 'liveops.event.started',
  EventEnded: 'liveops.event.ended',
  OfferShown: 'liveops.offer.shown',
  OfferPurchased: 'liveops.offer.purchased',
  ExperimentAssigned: 'liveops.experiment.assigned',
  ExperimentCompleted: 'liveops.experiment.completed',
  TelemetryReceived: 'liveops.telemetry.received',
  RetentionUpdated: 'liveops.retention.updated',
} as const);

/** A live-ops season (e.g. a ranked or themed period). */
export interface Season { id: number; name: string; startAt: number; endAt?: number; theme?: string }

/** Remote-config value, optionally bound to an experiment for variant overrides. */
export interface RemoteConfigEntry { key: string; value: unknown; experimentId?: string }

export interface OfferShown { offerId: string; playerId: string; at: number }
export interface OfferPurchase { offerId: string; playerId: string; revenue: number; at: number }

export class LiveOpsModule implements IModule {
  readonly id = 'game-liveops';
  readonly tags = ['core', 'game'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly scheduler = new EventScheduler();
  readonly analytics = new Analytics();
  readonly experiments = new ExperimentManager();
  readonly flags = new FeatureFlagManager();
  private offers = new Map<string, Offer>();
  private remoteConfig = new Map<string, RemoteConfigEntry>();
  private seasons: Season[] = [];
  private currentSeason: Season | undefined;
  private shown: OfferShown[] = [];
  private purchases: OfferPurchase[] = [];

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('game-liveops', this);
    kernel.logger.info('game-liveops initialized');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- telemetry pipeline -----------------------------------------------

  /** Ingest a telemetry event into analytics and the event bus. */
  track(event: TelemetryEvent): void {
    this.analytics.track(event);
    void this.api.bus.emit(LiveOpsEvents.TelemetryReceived, { ...event });
    // Signal retention whenever a returning player is seen today.
    const p = this.analytics.profile(event.playerId);
    if (p && dayKey(p.firstSeen) !== dayKey(event.ts)) {
      const d1 = this.analytics.retention(dayKey(p.firstSeen), 1).rate;
      void this.api.bus.emit(LiveOpsEvents.RetentionUpdated, { playerId: event.playerId, d1 });
    }
  }

  /** Convenience: track many events. */
  trackAll(events: TelemetryEvent[]): void { for (const e of events) this.track(e); }

  // ---- live events ------------------------------------------------------

  /** Register + (optionally) activate a live event. */
  scheduleEvent(event: LiveEvent): LiveEvent {
    this.scheduler.add(event);
    if (this.scheduler.status(event) === 'active') void this.api.bus.emit(LiveOpsEvents.EventStarted, { id: event.id });
    return event;
  }

  /** End an event early. */
  endEvent(id: string, now = Date.now()): boolean {
    const e = this.scheduler.get(id);
    if (!e) return false;
    e.endAt = now;
    void this.api.bus.emit(LiveOpsEvents.EventEnded, { id });
    return true;
  }

  // ---- offers -----------------------------------------------------------

  addOffer(offer: Offer): Offer { this.offers.set(offer.id, offer); return offer; }
  getOffer(id: string): Offer | undefined { return this.offers.get(id); }
  listOffers(): Offer[] { return [...this.offers.values()]; }

  /** Offers a player is eligible for (segment match + active), ranked by priority. */
  offersFor(playerId: string): Offer[] {
    const p = this.analytics.profile(playerId);
    const profile = p ? { level: p.level, country: p.country, paying: p.paying, firstSeen: p.firstSeen } : undefined;
    return this.listOffers()
      .filter((o) => o.active && segmentMatches(o.segment, profile))
      .sort((a, b) => b.priority - a.priority);
  }

  /** Record that an offer was shown to a player. */
  showOffer(offerId: string, playerId: string, now = Date.now()): OfferShown {
    const rec: OfferShown = { offerId, playerId, at: now };
    this.shown.push(rec);
    void this.api.bus.emit(LiveOpsEvents.OfferShown, { offerId, playerId });
    return rec;
  }

  /** Record an offer purchase; attributes revenue to the player + offer. */
  purchaseOffer(offerId: string, playerId: string, now = Date.now()): OfferPurchase | undefined {
    const offer = this.offers.get(offerId);
    if (!offer) return undefined;
    const rec: OfferPurchase = { offerId, playerId, revenue: offer.price.amount, at: now };
    this.purchases.push(rec);
    // Feed the purchase back into analytics as a revenue event.
    this.analytics.track({ playerId, name: 'purchase', ts: now, value: offer.price.amount, dims: { offer: offerId } });
    void this.api.bus.emit(LiveOpsEvents.OfferPurchased, { offerId, playerId, revenue: offer.price.amount });
    return rec;
  }

  offerStats(): { shown: number; purchased: number; revenue: number; conversion: number } {
    const revenue = this.purchases.reduce((s, p) => s + p.revenue, 0);
    return { shown: this.shown.length, purchased: this.purchases.length, revenue, conversion: this.shown.length > 0 ? this.purchases.length / this.shown.length : 0 };
  }

  // ---- experiments (event-emitting wrappers) ----------------------------

  assignVariant(playerId: string, experimentId: string): string {
    const exp = this.experiments.get(experimentId);
    const wasAssigned = exp?.assignment.has(playerId) ?? false;
    const variant = this.experiments.assign(playerId, experimentId);
    if (!wasAssigned) void this.api.bus.emit(LiveOpsEvents.ExperimentAssigned, { experimentId, playerId, variant });
    return variant;
  }

  completeExperiment(experimentId: string): string | null {
    this.experiments.complete(experimentId);
    const winner = this.experiments.pickWinner(experimentId);
    void this.api.bus.emit(LiveOpsEvents.ExperimentCompleted, { experimentId, winner });
    return winner;
  }

  // ---- remote configuration ---------------------------------------------

  /** Set a remote-config value; optionally bind it to an experiment for overrides. */
  setConfig(key: string, value: unknown, experimentId?: string): void {
    this.remoteConfig.set(key, { key, value, ...(experimentId ? { experimentId } : {}) });
  }
  getConfig(key: string, playerId?: string): unknown {
    const entry = this.remoteConfig.get(key);
    if (!entry) return undefined;
    if (entry.experimentId && playerId) {
      const exp = this.experiments.get(entry.experimentId);
      if (exp && exp.assignment.has(playerId)) {
        const variant = exp.assignment.get(playerId)!;
        // Variant-named override (e.g. "key.variantA") wins if present.
        const override = this.remoteConfig.get(`${key}.${variant}`);
        if (override) return override.value;
      }
    }
    return entry.value;
  }
  /** Hot-reload the remote config from a fresh map (live configuration reload). */
  reloadConfig(entries: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(entries)) this.remoteConfig.set(k, { key: k, value: v });
  }
  configSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, e] of this.remoteConfig) out[k] = e.value;
    return out;
  }

  // ---- seasons ----------------------------------------------------------

  startSeason(name: string, theme?: string, now = Date.now()): Season {
    if (this.currentSeason) this.currentSeason.endAt = now;
    const season: Season = { id: (this.currentSeason?.id ?? 0) + 1, name, startAt: now, ...(theme ? { theme } : {}) };
    this.seasons.push(season);
    this.currentSeason = season;
    return season;
  }
  endSeason(now = Date.now()): Season | undefined {
    if (!this.currentSeason) return undefined;
    this.currentSeason.endAt = now;
    return this.currentSeason;
  }
  get activeSeason(): Season | undefined { return this.currentSeason; }
  seasonHistory(): Season[] { return [...this.seasons]; }

  /** Unique id helper (for offer/event ids created by the module). */
  newId(prefix: string): string { return `${prefix}-${randomUUID()}`; }
}

export { Analytics, EventScheduler, ExperimentManager, FeatureFlagManager, segmentMatches };
