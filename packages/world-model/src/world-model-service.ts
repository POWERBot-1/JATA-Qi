import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor, CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';
import {
  WorldModelEvents,
  type AddWorldEntityInput,
  type AddWorldRelationInput,
  type CreateWorldModelInput,
  type RecordWorldEventInput,
  type WorldEntity,
  type WorldEvent,
  type WorldModel,
  type WorldPath,
  type WorldRelation,
} from './types.js';

const MODELS_COLLECTION = 'world-model.models';
const ENTITIES_COLLECTION = 'world-model.entities';
const RELATIONS_COLLECTION = 'world-model.relations';
const EVENTS_COLLECTION = 'world-model.events';
const CAUSAL_STATUSES = new Set(['CAUSAL_HYPOTHESIS', 'CAUSAL_EVIDENCE']);
const STRONG_EVIDENCE = new Set(['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);

export class WorldModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldModelError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Tenant-bound world representation; association and causation stay explicitly separate. */
export class WorldModelService {
  private api!: KernelApi;
  private models!: ICollection<WorldModel>;
  private entities!: ICollection<WorldEntity>;
  private relations!: ICollection<WorldRelation>;
  private events!: ICollection<WorldEvent>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.models = await storage.collection<WorldModel>(MODELS_COLLECTION);
    this.entities = await storage.collection<WorldEntity>(ENTITIES_COLLECTION);
    this.relations = await storage.collection<WorldRelation>(RELATIONS_COLLECTION);
    this.events = await storage.collection<WorldEvent>(EVENTS_COLLECTION);
  }

  async createModel(actor: CommercialActor, input: CreateWorldModelInput): Promise<WorldModel> {
    assertActor(actor);
    if (!input.name.trim()) throw new WorldModelError('World model name is required.');
    const now = Date.now();
    const model: WorldModel = { id: randomUUID(), tenantId: actor.tenantId, name: input.name, cognitiveStateId: input.cognitiveStateId, description: input.description, createdAt: now, updatedAt: now };
    await this.models.put(model);
    await this.api.bus.emit(WorldModelEvents.ModelCreated, { modelId: model.id, tenantId: model.tenantId });
    return copy(model);
  }

  async addEntity(actor: CommercialActor, modelId: string, input: AddWorldEntityInput): Promise<WorldEntity> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    validateEntity(input);
    const now = Date.now();
    const entity: WorldEntity = {
      id: randomUUID(), tenantId: model.tenantId, modelId: model.id, type: input.type, name: input.name, properties: copy(input.properties ?? {}),
      epistemicStatus: input.epistemicStatus, confidence: input.confidence, provenance: copy(input.provenance), temporalValidity: input.temporalValidity ? copy(input.temporalValidity) : undefined,
      createdAt: now, updatedAt: now,
    };
    await this.entities.put(entity);
    await this.api.bus.emit(WorldModelEvents.EntityAdded, { modelId: model.id, entityId: entity.id, type: entity.type, epistemicStatus: entity.epistemicStatus });
    return copy(entity);
  }

  async addRelation(actor: CommercialActor, modelId: string, input: AddWorldRelationInput): Promise<WorldRelation> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    validateRelation(input);
    const [subject, object] = await Promise.all([this.entities.get(input.subjectId), this.entities.get(input.objectId)]);
    if (!subject || !object || subject.tenantId !== model.tenantId || object.tenantId !== model.tenantId || subject.modelId !== model.id || object.modelId !== model.id) {
      throw new WorldModelError('World relation entities must exist in the same tenant and model.');
    }
    if (input.status === 'CAUSAL_HYPOTHESIS' && !input.causalMethod?.trim()) throw new WorldModelError('Causal hypothesis requires a stated method or rationale.');
    if (input.status === 'CAUSAL_EVIDENCE') {
      const independentSources = new Set(input.evidence.map((evidence) => evidence.source)).size;
      if (!input.causalMethod?.trim() || independentSources < 2 || input.evidence.some((evidence) => !STRONG_EVIDENCE.has(evidence.status))) {
        throw new WorldModelError('Causal evidence requires method and at least two independent measured/demonstrated/repeated/verified sources.');
      }
    }
    const relation: WorldRelation = {
      id: randomUUID(), tenantId: model.tenantId, modelId: model.id, subjectId: subject.id, predicate: input.predicate, objectId: object.id,
      status: input.status, confidence: input.confidence, causalMethod: input.causalMethod, evidence: copy(input.evidence), provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.relations.put(relation);
    await this.api.bus.emit(WorldModelEvents.RelationAdded, { modelId: model.id, relationId: relation.id, status: relation.status });
    return copy(relation);
  }

  async recordEvent(actor: CommercialActor, modelId: string, input: RecordWorldEventInput): Promise<WorldEvent> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    validateEvent(input);
    for (const entityId of input.entityIds) {
      const entity = await this.entities.get(entityId);
      if (!entity || entity.tenantId !== model.tenantId || entity.modelId !== model.id) throw new WorldModelError(`Event entity ${entityId} is not in this model.`);
    }
    const event: WorldEvent = {
      id: randomUUID(), tenantId: model.tenantId, modelId: model.id, type: input.type, entityIds: [...new Set(input.entityIds)], timestamp: input.timestamp ?? Date.now(),
      epistemicStatus: input.epistemicStatus, confidence: input.confidence, payload: copy(input.payload ?? {}), evidence: copy(input.evidence), provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.events.put(event);
    await this.api.bus.emit(WorldModelEvents.EventRecorded, { modelId: model.id, eventId: event.id, type: event.type, epistemicStatus: event.epistemicStatus });
    return copy(event);
  }

  /** Bounded forward traversal over explicit relation records. */
  async traverse(actor: CommercialActor, modelId: string, startEntityId: string, maxDepth = 2, limit = 100): Promise<WorldPath[]> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 10 || !Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new WorldModelError('Traversal bounds are invalid.');
    const start = await this.entities.get(startEntityId);
    if (!start || start.tenantId !== model.tenantId || start.modelId !== model.id) return [];
    const entities = new Map((await this.entities.query({ where: (entity) => entity.modelId === model.id })).map((entity) => [entity.id, entity]));
    const bySubject = new Map<string, WorldRelation[]>();
    for (const relation of await this.relations.query({ where: (relation) => relation.modelId === model.id })) {
      const relations = bySubject.get(relation.subjectId) ?? [];
      relations.push(relation);
      bySubject.set(relation.subjectId, relations);
    }
    const paths: WorldPath[] = [];
    const visit = (current: WorldEntity, pathEntities: WorldEntity[], pathRelations: WorldRelation[], visited: Set<string>): void => {
      if (paths.length >= limit || pathRelations.length >= maxDepth) return;
      for (const relation of bySubject.get(current.id) ?? []) {
        const next = entities.get(relation.objectId);
        if (!next || visited.has(next.id)) continue;
        const nextEntities = [...pathEntities, next];
        const nextRelations = [...pathRelations, relation];
        const confidence = nextRelations.reduce((score, item) => score * (item.confidence / 100), 1);
        paths.push({ entities: nextEntities.map(copy), relations: nextRelations.map(copy), confidence });
        visit(next, nextEntities, nextRelations, new Set([...visited, next.id]));
        if (paths.length >= limit) return;
      }
    };
    visit(start, [start], [], new Set([start.id]));
    return paths.sort((a, b) => b.confidence - a.confidence);
  }

  async getModel(actor: CommercialActor, modelId: string): Promise<WorldModel | undefined> {
    const model = await this.models.get(modelId);
    return model && canRead(actor, model.tenantId) ? copy(model) : undefined;
  }

  async listEntities(actor: CommercialActor, modelId: string): Promise<WorldEntity[]> {
    await this.requireModel(actor, modelId);
    return (await this.entities.query({ where: (entity) => entity.modelId === modelId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  async listRelations(actor: CommercialActor, modelId: string): Promise<WorldRelation[]> {
    await this.requireModel(actor, modelId);
    return (await this.relations.query({ where: (relation) => relation.modelId === modelId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireModel(actor: CommercialActor, modelId: string): Promise<WorldModel> {
    const model = await this.models.get(modelId);
    if (!model || !canRead(actor, model.tenantId)) throw new WorldModelError('World model not found.');
    return model;
  }
}

function validateEntity(input: AddWorldEntityInput): void {
  if (!input.type.trim() || !input.name.trim() || !input.provenance.source.trim()) throw new WorldModelError('World entity type, name, and provenance are required.');
  assertPercent(input.confidence, 'World entity confidence');
  if (!['OBSERVED', 'INFERRED', 'HYPOTHESIZED', 'SIMULATED', 'UNKNOWN'].includes(input.epistemicStatus)) throw new WorldModelError('World entity epistemic status is invalid.');
}
function validateRelation(input: AddWorldRelationInput): void {
  if (!input.subjectId.trim() || !input.objectId.trim() || !input.predicate.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new WorldModelError('World relation entities, predicate, evidence, and provenance are required.');
  assertPercent(input.confidence, 'World relation confidence');
  if (!['ASSOCIATION', ...CAUSAL_STATUSES].includes(input.status)) throw new WorldModelError('World relation status is invalid.');
}
function validateEvent(input: RecordWorldEventInput): void {
  if (!input.type.trim() || !input.entityIds.length || !input.evidence.length || !input.provenance.source.trim()) throw new WorldModelError('World event type, entities, evidence, and provenance are required.');
  assertPercent(input.confidence, 'World event confidence');
  if (!['OBSERVED', 'INFERRED', 'HYPOTHESIZED', 'SIMULATED', 'UNKNOWN'].includes(input.epistemicStatus)) throw new WorldModelError('World event epistemic status is invalid.');
}
function assertPercent(value: number, name: string): void { if (!Number.isFinite(value) || value < 0 || value > 100) throw new WorldModelError(`${name} must be from 0 to 100.`); }
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new WorldModelError('A tenant-bound actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
