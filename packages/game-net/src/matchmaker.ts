// Matchmaker — forms matches from queued players by skill proximity and region
// (§9 "matchmaking"). Greedy nearest-skill grouping within a configurable window.

export interface MatchRequest {
  peer: string;
  skill: number; // MMR-style rating
  region: string;
  /** Peers that must be in the same match (a party). */
  party?: string[];
  /** Requested team/match size. */
  size: number;
  queuedAt: number;
}

export interface FormedMatch {
  peers: string[];
  averageSkill: number;
  region: string;
}

export class Matchmaker {
  private queue: MatchRequest[] = [];
  private formed: FormedMatch[] = [];
  /** Maximum skill spread within a match. */
  skillWindow: number;

  constructor(skillWindow = 150) { this.skillWindow = skillWindow; }

  enqueue(req: Omit<MatchRequest, 'queuedAt'>): MatchRequest {
    const full: MatchRequest = { ...req, queuedAt: Date.now() };
    this.queue.push(full);
    return full;
  }

  remove(peer: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((r) => r.peer !== peer);
    return this.queue.length !== before;
  }

  get waiting(): number { return this.queue.length; }
  lastFormed(): FormedMatch[] { return this.formed; }

  /** Attempt to form as many matches as possible from the current queue. */
  tick(): FormedMatch[] {
    this.formed = [];
    // Parties are matched wholesale if they meet the size.
    const parties = new Map<string, MatchRequest[]>();
    const solo: MatchRequest[] = [];
    for (const r of this.queue) {
      if (r.party && r.party.length > 1) {
        const key = [...r.party].sort().join(',');
        const arr = parties.get(key) ?? [];
        arr.push(r);
        parties.set(key, arr);
      } else solo.push(r);
    }
    for (const [, members] of parties) {
      if (members.length >= members[0]!.size) this.formed.push(this.make(members));
    }
    // Solos grouped by region, then by nearest skill within the window.
    const byRegion = new Map<string, MatchRequest[]>();
    for (const r of solo) (byRegion.get(r.region) ?? byRegion.set(r.region, []).get(r.region)!).push(r);
    for (const [, list] of byRegion) {
      list.sort((a, b) => a.skill - b.skill);
      for (const req of list) {
        if ((req as { matched?: boolean }).matched) continue;
        const team = [req];
        for (const other of list) {
          if (other === req || (other as { matched?: boolean }).matched) continue;
          if (team.length >= req.size) break;
          if (Math.abs(other.skill - req.skill) <= this.skillWindow) { team.push(other); (other as { matched?: boolean }).matched = true; }
        }
        (req as { matched?: boolean }).matched = true;
        if (team.length >= req.size) this.formed.push(this.make(team));
      }
    }
    // Remove matched requests from the queue.
    const matchedPeers = new Set(this.formed.flatMap((m) => m.peers));
    this.queue = this.queue.filter((r) => !matchedPeers.has(r.peer));
    return this.formed;
  }

  private make(members: MatchRequest[]): FormedMatch {
    const peers = members.map((m) => m.peer);
    const averageSkill = members.reduce((s, m) => s + m.skill, 0) / members.length;
    return { peers, averageSkill, region: members[0]!.region };
  }
}
