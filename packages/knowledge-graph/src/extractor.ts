// Lightweight heuristic extractor for dev/test. In production this is replaced by
// an LLM-powered extractor; the interface is what matters.

import { createEntity, createTriple } from './factories.js';
import type { Entity, Triple } from './types.js';

export interface ExtractionResult {
  entities: Array<Omit<Entity, 'createdAt' | 'updatedAt'>>;
  triples: Array<Omit<Triple, 'id' | 'createdAt'>>;
}

export interface Extractor {
  extract(text: string, opts?: { source?: { chunkId?: string; documentId?: string } }): ExtractionResult;
}

/** Capitalized-phrase heuristic: looks for multi-word capitalized noun phrases as entities,
 *  and produces "relatedTo" edges when they appear in the same sentence. Also recognizes
 *  the pattern "<ProperNoun> <verb-phrase> <ProperNoun>" for typed relations. */
export class HeuristicExtractor implements Extractor {
  extract(text: string, opts: { source?: { chunkId?: string; documentId?: string } } = {}): ExtractionResult {
    const entityMap = new Map<string, Omit<Entity, 'createdAt' | 'updatedAt'>>();
    const triplesOut: Array<Omit<Triple, 'id' | 'createdAt'>> = [];

    // 1. Find capitalized single-word proper nouns or known suffixes. We keep it simple:
    // single capitalized words, plus two-word combinations where the second is a known
    // corporate suffix (Inc, Corp, LLC, Ltd, Co.) to capture "Acme Corp" without swallowing
    // "Alice and Bob".
    const capWord = /\b([A-Z][a-zA-Z]+)\b/g;
    const suffixes = /\b([A-Z][a-zA-Z]+\s+(?:Inc|Corp|Corporation|Company|Co\.|Ltd|LLC|University|Institute))\b/g;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    const spans: Array<[number, number, string]> = [];
    while ((m = suffixes.exec(text)) !== null) spans.push([m.index, m.index + m[0].length, m[0].trim()]);
    while ((m = capWord.exec(text)) !== null) {
      // Skip if this position is inside a multi-word suffix span.
      const inside = spans.some(([s, e]) => m!.index >= s && m!.index < e);
      if (inside) continue;
      matches.push(m[0]!);
    }
    for (const [, , name] of spans) matches.push(name);

    // Filter out common sentence-starter false positives and stopwords at edges.
    const stop = new Set(['I', 'The', 'A', 'An', 'This', 'That', 'It', 'He', 'She', 'They', 'We', 'You', 'When', 'Where', 'Who', 'What']);
    const cleaned = new Set<string>();
    for (const p of matches) {
      const first = p.split(/\s/)[0]!;
      if (stop.has(first) && p.split(/\s/).length === 1) continue;
      cleaned.add(p);
    }
    const entities = [...cleaned];

    // 2. Create Entity objects (type-guessing heuristics).
    for (const name of entities) {
      const id = 'ent:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48);
      const type = guessType(name);
      entityMap.set(name, createEntity({ id, type, name }));
    }

    // 3. Pattern: "<X> <is|are|was|were> <a|an|the?>? <Y>" -> rdf:type / instanceOf
    const isA = /([A-Z][\w ]{1,40}?)\s+(?:is|are|was|were)\s+(?:a|an|the)?\s*([A-Z][\w ]{1,40}?)(?:\.|,|\s|;|$)/g;
    const addTriple = (subjName: string, pred: string, objName: string) => {
      const s = entityMap.get(subjName.trim());
      const o = entityMap.get(objName.trim());
      if (!s || !o) return;
      triplesOut.push(createTriple({
        subject: s.id,
        predicate: pred,
        object: o.id,
        confidence: 0.5,
        source: opts.source,
      }));
    };
    while ((m = isA.exec(text)) !== null) {
      addTriple(m[1]!, 'instanceOf', m[2]!);
    }

    // 4. Pattern: "<X> <verb> <Y>" for a small set of transitive verbs.
    const verbs = ['founded', 'created', 'invented', 'discovered', 'wrote', 'authored', 'works at', 'lives in', 'located in', 'part of', 'located in', 'CEO of', 'president of', 'capital of'];
    for (const v of verbs) {
      const re = new RegExp(`([A-Z][\\w ]{1,30}?)\\s+${v.replace(/ /g, '\\s+')}\\s+([A-Z][\\w ]{1,30}?)(?:\\.|,|\\s|;|$)`, 'g');
      while ((m = re.exec(text)) !== null) {
        addTriple(m[1]!, v.replace(/\s+/g, '_'), m[2]!);
      }
    }

    // 5. Co-occurrence: entities in same sentence get relatedTo (weaker).
    const sentences = text.split(/[.!?]+/);
    for (const s of sentences) {
      const present = entities.filter((e) => s.includes(e));
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          addTriple(present[i]!, 'relatedTo', present[j]!);
        }
      }
    }

    return { entities: [...entityMap.values()], triples: dedupTriplesRaw(triplesOut) };
  }
}

function guessType(name: string): string {
  if (/\b(Inc|Corp|Company|Co\.|Ltd|LLC)\b/.test(name)) return 'Organization';
  if (/\b(City|Country|State|Republic|Kingdom|Province)\b/.test(name)) return 'Location';
  if (/\b(University|College|Institute|School)\b/.test(name)) return 'Organization';
  if (name.split(/\s/).length <= 2 && /^[A-Z]/.test(name)) return 'Person';
  return 'Concept';
}

function dedupTriplesRaw(ts: Array<Omit<Triple, 'id' | 'createdAt'>>): Array<Omit<Triple, 'id' | 'createdAt'>> {
  const seen = new Set<string>();
  const out: Array<Omit<Triple, 'id' | 'createdAt'>> = [];
  for (const t of ts) {
    const k = `${t.subject}|${t.predicate}|${t.object}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
