// Knowledge graph data model: entities, relations, triples.
// Property-graph style: entities and relations can carry arbitrary properties.

export type EntityId = string;
export type RelationType = string;
export type TripleId = string;

export interface Entity {
  id: EntityId;
  /** Entity type label, e.g. 'Person', 'Document', 'Concept', 'Organization'. */
  type: string;
  /** Human-readable name, used in rendering and disambiguation. */
  name: string;
  /** Free-form attributes. */
  properties?: Record<string, unknown>;
  /** Optional vector embedding id for semantic similarity over entities. */
  embeddingId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Relation {
  type: RelationType;
  // Could add directionality, weight, properties later.
}

export interface Triple {
  id: TripleId;
  subject: EntityId;
  predicate: RelationType;
  object: EntityId;
  properties?: Record<string, unknown>;
  /** Confidence score in [0,1], used when fusing evidence. */
  confidence?: number;
  /** Provenance: chunk/document id that supports this triple. */
  source?: { chunkId?: string; documentId?: string };
  createdAt: number;
}

export interface TraversalStep {
  triple: Triple;
  /** Whether the step was taken forward (subject→object) or backward. */
  direction: 'out' | 'in';
  /** The entity at the end of this step. */
  entity: Entity;
}

export interface TraversalOptions {
  /** Maximum depth from the starting entity. */
  maxDepth?: number;
  /** If set, only follow these predicate types. */
  followPredicates?: RelationType[];
  /** If set, stop traversal when a matching entity type is reached. */
  stopAtTypes?: string[];
  /** Maximum total paths to return (safety bound; default 100). */
  limit?: number;
}

export interface Path {
  entities: Entity[];
  triples: Triple[];
  score: number; // product of confidences, damped by length
}

export interface GraphStats {
  entities: number;
  triples: number;
  entityTypes: Record<string, number>;
  predicateTypes: Record<string, number>;
}

export const GraphEvents = Object.freeze({
  EntityAdded: 'graph.entity.added',
  EntityUpdated: 'graph.entity.updated',
  EntityRemoved: 'graph.entity.removed',
  TripleAdded: 'graph.triple.added',
  TripleRemoved: 'graph.triple.removed',
  Traversed: 'graph.traversed',
} as const);
