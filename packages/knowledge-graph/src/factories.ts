// Factory helpers for building entities and triples with sensible defaults.

import { randomUUID } from 'node:crypto';
import type { Entity, Triple } from './types.js';

export interface EntityInput {
  id?: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  embeddingId?: string;
  createdAt?: number;
}

export interface TripleInput {
  subject: string;
  predicate: string;
  object: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  source?: { chunkId?: string; documentId?: string };
}

export function createEntity(input: EntityInput): Entity {
  const now = input.createdAt ?? Date.now();
  return {
    id: input.id ?? `${slug(input.type)}_${randomUUID().slice(0, 8)}`,
    type: input.type,
    name: input.name,
    properties: input.properties ?? {},
    embeddingId: input.embeddingId,
    createdAt: now,
    updatedAt: now,
  };
}

export function createTriple(input: TripleInput): Omit<Triple, 'id' | 'createdAt'> {
  const conf = input.confidence ?? 1.0;
  if (conf < 0 || conf > 1) throw new Error(`createTriple: confidence must be in [0,1], got ${conf}`);
  return {
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    properties: input.properties ?? {},
    confidence: conf,
    source: input.source,
  };
}

/** Lowercase slug helper for generating readable ids. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
