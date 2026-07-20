// In-memory triple store with SPO/POS/OPS indexes for fast traversal in any direction.
// Persistence is handled by the knowledge-graph module via storage collections.

import { randomUUID } from 'node:crypto';
import type {
  Entity,
  EntityId,
  GraphStats,
  Path,
  RelationType,
  Triple,
  TripleId,
  TraversalOptions,
} from './types.js';

export interface ITripleStore {
  upsertEntity(entity: Entity): Entity;
  getEntity(id: EntityId): Entity | undefined;
  removeEntity(id: EntityId): boolean;
  entitiesByType(type: string): Entity[];
  allEntities(): Entity[];

  addTriple(t: Omit<Triple, 'id' | 'createdAt'>): Triple;
  removeTriple(id: TripleId): boolean;
  getTriple(id: TripleId): Triple | undefined;
  triplesFrom(subject: EntityId, predicate?: RelationType): Triple[];
  triplesTo(object: EntityId, predicate?: RelationType): Triple[];
  triplesBetween(a: EntityId, b: EntityId, predicate?: RelationType): Triple[];
  hasTriple(subject: EntityId, predicate: RelationType, object: EntityId): boolean;

  traverse(start: EntityId, opts?: TraversalOptions): Path[];
  stats(): GraphStats;
  clear(): void;
}

export class MemoryTripleStore implements ITripleStore {
  private entities = new Map<EntityId, Entity>();
  private triples = new Map<TripleId, Triple>();

  // Indexes:
  private spo = new Map<EntityId, Map<RelationType, Set<TripleId>>>(); // subject → predicate → {triple ids}
  private ops = new Map<EntityId, Map<RelationType, Set<TripleId>>>(); // object → predicate → {triple ids}

  upsertEntity(input: Entity): Entity {
    const existing = this.entities.get(input.id);
    const now = Date.now();
    const entity: Entity = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  removeEntity(id: EntityId): boolean {
    if (!this.entities.has(id)) return false;
    // Drop all triples connected to this entity.
    const toRemove: TripleId[] = [];
    const outMap = this.spo.get(id);
    if (outMap) for (const ids of outMap.values()) for (const tid of ids) toRemove.push(tid);
    const inMap = this.ops.get(id);
    if (inMap) for (const ids of inMap.values()) for (const tid of ids) toRemove.push(tid);
    for (const tid of toRemove) this.removeTriple(tid);
    this.entities.delete(id);
    return true;
  }

  entitiesByType(type: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities.values()) if (e.type === type) out.push(e);
    return out;
  }

  allEntities(): Entity[] {
    return [...this.entities.values()];
  }

  addTriple(input: Omit<Triple, 'id' | 'createdAt'>): Triple {
    if (!this.entities.has(input.subject)) {
      throw new Error(`TripleStore: unknown subject entity "${input.subject}"`);
    }
    if (!this.entities.has(input.object)) {
      throw new Error(`TripleStore: unknown object entity "${input.object}"`);
    }
    const id = randomUUID();
    const triple: Triple = { ...input, id, createdAt: Date.now() };
    this.triples.set(id, triple);
    indexAdd(this.spo, triple.subject, triple.predicate, id);
    indexAdd(this.ops, triple.object, triple.predicate, id);
    return triple;
  }

  removeTriple(id: TripleId): boolean {
    const t = this.triples.get(id);
    if (!t) return false;
    indexDel(this.spo, t.subject, t.predicate, id);
    indexDel(this.ops, t.object, t.predicate, id);
    this.triples.delete(id);
    return true;
  }

  getTriple(id: TripleId): Triple | undefined {
    return this.triples.get(id);
  }

  triplesFrom(subject: EntityId, predicate?: RelationType): Triple[] {
    return collectFromIndex(this.spo, subject, predicate, this.triples);
  }

  triplesTo(object: EntityId, predicate?: RelationType): Triple[] {
    return collectFromIndex(this.ops, object, predicate, this.triples);
  }

  triplesBetween(a: EntityId, b: EntityId, predicate?: RelationType): Triple[] {
    const out: Triple[] = [];
    for (const t of this.triplesFrom(a, predicate)) {
      if (t.object === b) out.push(t);
    }
    for (const t of this.triplesTo(a, predicate)) {
      if (t.subject === b) out.push(t);
    }
    return dedupTriples(out);
  }

  hasTriple(subject: EntityId, predicate: RelationType, object: EntityId): boolean {
    const ids = this.spo.get(subject)?.get(predicate);
    if (!ids) return false;
    for (const tid of ids) {
      if (this.triples.get(tid)?.object === object) return true;
    }
    return false;
  }

  /** BFS/DFS traversal from a starting entity, returning all paths up to maxDepth. */
  traverse(start: EntityId, opts: TraversalOptions = {}): Path[] {
    const maxDepth = opts.maxDepth ?? 2;
    const limit = opts.limit ?? 100;
    const followSet = opts.followPredicates ? new Set(opts.followPredicates) : undefined;
    const stopTypes = opts.stopAtTypes ? new Set(opts.stopAtTypes) : undefined;
    const startEntity = this.entities.get(start);
    if (!startEntity) return [];

    const paths: Path[] = [];
    const visitedOnPath = new Set<EntityId>();
    const current: Entity[] = [startEntity];
    const currentTriples: Triple[] = [];
    visitedOnPath.add(start);

    const visit = (depth: number) => {
      if (paths.length >= limit) return;
      const ent = current[current.length - 1]!;
      if (depth > 0 && (!stopTypes || stopTypes.has(ent.type))) {
        const score = scorePath(currentTriples) / depth;
        paths.push({ entities: [...current], triples: [...currentTriples], score });
      }
      if (depth >= maxDepth) return;
      const outgoing = this.triplesFrom(ent.id);
      for (const t of outgoing) {
        if (followSet && !followSet.has(t.predicate)) continue;
        if (visitedOnPath.has(t.object)) continue;
        const obj = this.entities.get(t.object);
        if (!obj) continue;
        current.push(obj);
        currentTriples.push(t);
        visitedOnPath.add(t.object);
        visit(depth + 1);
        current.pop();
        currentTriples.pop();
        visitedOnPath.delete(t.object);
        if (paths.length >= limit) return;
      }
    };
    visit(0);
    paths.sort((a, b) => b.score - a.score);
    return paths;
  }

  stats(): GraphStats {
    const typeCounts: Record<string, number> = {};
    const predCounts: Record<string, number> = {};
    for (const e of this.entities.values()) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    for (const t of this.triples.values()) predCounts[t.predicate] = (predCounts[t.predicate] ?? 0) + 1;
    return { entities: this.entities.size, triples: this.triples.size, entityTypes: typeCounts, predicateTypes: predCounts };
  }

  clear(): void {
    this.entities.clear();
    this.triples.clear();
    this.spo.clear();
    this.ops.clear();
  }
}

function indexAdd(
  idx: Map<EntityId, Map<RelationType, Set<TripleId>>>,
  key: EntityId,
  pred: RelationType,
  tid: TripleId,
) {
  let byPred = idx.get(key);
  if (!byPred) { byPred = new Map(); idx.set(key, byPred); }
  let set = byPred.get(pred);
  if (!set) { set = new Set(); byPred.set(pred, set); }
  set.add(tid);
}

function indexDel(
  idx: Map<EntityId, Map<RelationType, Set<TripleId>>>,
  key: EntityId,
  pred: RelationType,
  tid: TripleId,
) {
  const byPred = idx.get(key);
  if (!byPred) return;
  const set = byPred.get(pred);
  if (!set) return;
  set.delete(tid);
  if (set.size === 0) byPred.delete(pred);
  if (byPred.size === 0) idx.delete(key);
}

function collectFromIndex(
  idx: Map<EntityId, Map<RelationType, Set<TripleId>>>,
  key: EntityId,
  pred: RelationType | undefined,
  triples: Map<TripleId, Triple>,
): Triple[] {
  const out: Triple[] = [];
  const byPred = idx.get(key);
  if (!byPred) return out;
  if (pred) {
    const set = byPred.get(pred);
    if (set) for (const tid of set) out.push(triples.get(tid)!);
  } else {
    for (const set of byPred.values()) for (const tid of set) out.push(triples.get(tid)!);
  }
  return out;
}

function dedupTriples(ts: Triple[]): Triple[] {
  const seen = new Set<TripleId>();
  const out: Triple[] = [];
  for (const t of ts) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function scorePath(triples: Triple[]): number {
  let s = 1;
  for (const t of triples) s *= t.confidence ?? 0.9;
  return s;
}
