// Event scheduler — manages live events with active-window checks and optional
// daily/weekly recurrence (§15 "events", "new missions", "new maps").

import type { EventStatus, LiveEvent } from './types.js';

export class EventScheduler {
  private events = new Map<string, LiveEvent>();

  add(event: LiveEvent): LiveEvent { this.events.set(event.id, event); return event; }
  remove(id: string): boolean { return this.events.delete(id); }
  get(id: string): LiveEvent | undefined { return this.events.get(id); }
  list(): LiveEvent[] { return [...this.events.values()]; }

  /** Status of an event at time `now`. */
  status(event: LiveEvent, now = Date.now()): EventStatus {
    if (!event.enabled) return now < event.startAt ? 'scheduled' : 'ended';
    if (now < event.startAt) return 'scheduled';
    if (now > event.endAt) return 'ended';
    return 'active';
  }

  /** Events currently active at `now`. */
  active(now = Date.now()): LiveEvent[] {
    return this.list().filter((e) => this.status(e, now) === 'active');
  }

  /** Advance recurring events: roll a daily/weekly event forward past its end. */
  rollForward(now = Date.now()): LiveEvent[] {
    const rolled: LiveEvent[] = [];
    for (const e of this.events.values()) {
      if (!e.recurrence || now <= e.endAt) continue;
      const span = e.endAt - e.startAt;
      while (e.endAt < now) {
        const step = e.recurrence === 'daily' ? 86400_000 : 7 * 86400_000;
        e.startAt += step;
        e.endAt = e.startAt + span;
      }
      rolled.push(e);
    }
    return rolled;
  }
}
