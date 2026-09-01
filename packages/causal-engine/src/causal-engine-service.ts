import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import type { CommercialActor, CommercialEvidence } from '@jataqi/commercial-control-plane';
import { WorldModelModule } from '@jataqi/world-model';
import type { WorldModelService } from '@jataqi/world-model';
import {
  CausalEngineEvents,
  type AddCausalEdgeInput,
  type CausalModel,
  type CausalVariable,
  type CounterfactualScenario,
  type CreateCausalModelInput,
  type SimulateInterventionInput,
} from './types.js';

const MODELS_COLLECTION = 'causal-engine.models';
const SCENARIOS_COLLECTION = 'causal-engine.scenarios';
const STRONG_EVIDENCE = new Set(['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);

export class CausalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CausalEngineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Classical local-linear structural causal model implementation. It is useful
 * for explicit, bounded what-if analysis, but does not perform causal discovery
 * and labels all intervention output as simulated.
 */
export class CausalEngineService {
  private api!: KernelApi;
  private models!: ICollection<CausalModel>;
  private scenarios!: ICollection<CounterfactualScenario>;
  private world!: WorldModelService;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.models = await kernel.getModule<StorageModule>('storage').collection<CausalModel>(MODELS_COLLECTION);
    this.scenarios = await kernel.getModule<StorageModule>('storage').collection<CounterfactualScenario>(SCENARIOS_COLLECTION);
    this.world = kernel.getModule<WorldModelModule>('world-model').getService();
  }

  async createModel(actor: CommercialActor, input: CreateCausalModelInput): Promise<CausalModel> {
    assertActor(actor);
    if (!input.name.trim() || !input.variables.length || !input.assumptions.length || !input.provenance.source.trim()) throw new CausalEngineError('Causal model name, variables, assumptions, and provenance are required.');
    if (input.worldModelId && !await this.world.getModel(actor, input.worldModelId)) throw new CausalEngineError('Referenced world model is not available for this tenant.');
    validateVariables(input.variables);
    const now = Date.now();
    const model: CausalModel = {
      id: randomUUID(), tenantId: actor.tenantId, worldModelId: input.worldModelId, name: input.name, variables: copy(input.variables), edges: [],
      assumptions: unique(input.assumptions), provenance: copy(input.provenance), createdAt: now, updatedAt: now,
    };
    await this.models.put(model);
    await this.api.bus.emit(CausalEngineEvents.ModelCreated, { modelId: model.id, tenantId: model.tenantId, variables: model.variables.length });
    return copy(model);
  }

  async addEdge(actor: CommercialActor, modelId: string, input: AddCausalEdgeInput): Promise<CausalModel> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    validateEdgeInput(input);
    const variableIds = new Set(model.variables.map((variable) => variable.id));
    if (!variableIds.has(input.fromVariableId) || !variableIds.has(input.toVariableId) || input.fromVariableId === input.toVariableId) throw new CausalEngineError('Causal edge variables must be distinct variables in this model.');
    if (input.status === 'CAUSAL_EVIDENCE') {
      const sources = new Set(input.evidence.map((evidence) => evidence.source));
      if (sources.size < 2 || input.evidence.some((evidence) => !STRONG_EVIDENCE.has(evidence.status))) {
        throw new CausalEngineError('Causal evidence requires at least two independent measured/demonstrated/repeated/verified sources.');
      }
    }
    const edge = { id: randomUUID(), ...copy(input) };
    const candidate: CausalModel = { ...model, edges: [...model.edges, edge], updatedAt: Date.now() };
    assertAcyclic(candidate);
    await this.models.put(candidate);
    await this.api.bus.emit(CausalEngineEvents.EdgeAdded, { modelId: candidate.id, edgeId: edge.id, status: edge.status });
    return copy(candidate);
  }

  async simulate(actor: CommercialActor, modelId: string, input: SimulateInterventionInput): Promise<CounterfactualScenario> {
    assertActor(actor);
    const model = await this.requireModel(actor, modelId);
    if (!Object.keys(input.interventions).length || !input.evidence.length) throw new CausalEngineError('Simulation requires interventions and supporting evidence.');
    const variables = new Map(model.variables.map((variable) => [variable.id, variable]));
    for (const [id, value] of Object.entries(input.interventions)) {
      const variable = variables.get(id);
      if (!variable || !Number.isFinite(value)) throw new CausalEngineError(`Invalid intervention for variable ${id}.`);
      assertBounds(variable, value);
    }
    const values = new Map(model.variables.map((variable) => [variable.id, variable.baseline]));
    const fixed = new Set(Object.keys(input.interventions));
    for (const [id, value] of Object.entries(input.interventions)) values.set(id, value);
    const order = topologicalOrder(model);
    const outgoing = new Map<string, typeof model.edges>();
    for (const edge of model.edges) {
      const edges = outgoing.get(edge.fromVariableId) ?? [];
      edges.push(edge);
      outgoing.set(edge.fromVariableId, edges);
    }
    for (const variableId of order) {
      const source = variables.get(variableId)!;
      const sourceValue = values.get(variableId)!;
      const delta = sourceValue - source.baseline;
      for (const edge of outgoing.get(variableId) ?? []) {
        if (fixed.has(edge.toVariableId)) continue;
        values.set(edge.toVariableId, values.get(edge.toVariableId)! + delta * edge.effect);
      }
    }
    for (const [id, value] of values) assertBounds(variables.get(id)!, value);
    const uncertainty = [
      ...model.assumptions.map((assumption) => `Assumption: ${assumption}`),
      ...model.edges.filter((edge) => edge.status === 'CAUSAL_HYPOTHESIS').map((edge) => `Hypothesized causal edge: ${edge.id}`),
      ...model.edges.filter((edge) => edge.confidence < 70).map((edge) => `Low-confidence edge: ${edge.id}`),
    ];
    const scenario: CounterfactualScenario = {
      id: randomUUID(), tenantId: model.tenantId, modelId: model.id, interventions: copy(input.interventions),
      predictedValues: Object.fromEntries(values), assumptions: unique([...(input.assumptions ?? []), ...model.assumptions]), uncertainty,
      evidence: copy(input.evidence), simulated: true, method: 'CLASSICAL_LINEAR_STRUCTURAL_CAUSAL_MODEL', createdAt: Date.now(),
    };
    await this.scenarios.put(scenario);
    await this.api.bus.emit(CausalEngineEvents.ScenarioSimulated, { modelId: model.id, scenarioId: scenario.id, simulated: true, method: scenario.method });
    return copy(scenario);
  }

  async getModel(actor: CommercialActor, modelId: string): Promise<CausalModel | undefined> {
    const model = await this.models.get(modelId);
    return model && canRead(actor, model.tenantId) ? copy(model) : undefined;
  }

  async listScenarios(actor: CommercialActor, modelId: string): Promise<CounterfactualScenario[]> {
    await this.requireModel(actor, modelId);
    return (await this.scenarios.query({ where: (scenario) => scenario.modelId === modelId, orderBy: 'createdAt', order: 'asc' })).map(copy);
  }

  private async requireModel(actor: CommercialActor, modelId: string): Promise<CausalModel> {
    const model = await this.getModel(actor, modelId);
    if (!model) throw new CausalEngineError('Causal model not found.');
    return model;
  }
}

function validateVariables(variables: readonly CausalVariable[]): void {
  const ids = new Set<string>();
  for (const variable of variables) {
    if (!variable.id.trim() || !variable.label.trim() || !variable.unit.trim() || !Number.isFinite(variable.baseline)) throw new CausalEngineError('Causal variables require id, label, unit, and finite baseline.');
    if (ids.has(variable.id)) throw new CausalEngineError(`Duplicate causal variable ${variable.id}.`);
    ids.add(variable.id);
    if (variable.bounds?.min !== undefined && variable.bounds?.max !== undefined && variable.bounds.min > variable.bounds.max) throw new CausalEngineError(`Invalid bounds for variable ${variable.id}.`);
    assertBounds(variable, variable.baseline);
  }
}
function validateEdgeInput(input: AddCausalEdgeInput): void {
  if (!input.fromVariableId.trim() || !input.toVariableId.trim() || !Number.isFinite(input.effect) || !input.causalMethod.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new CausalEngineError('Causal edge variables, effect, method, evidence, and provenance are required.');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new CausalEngineError('Causal edge confidence must be from 0 to 100.');
}
function assertBounds(variable: CausalVariable, value: number): void {
  if (variable.bounds?.min !== undefined && value < variable.bounds.min || variable.bounds?.max !== undefined && value > variable.bounds.max) throw new CausalEngineError(`Value ${value} violates bounds for ${variable.id}.`);
}
function assertAcyclic(model: CausalModel): void { topologicalOrder(model); }
function topologicalOrder(model: CausalModel): string[] {
  const incoming = new Map(model.variables.map((variable) => [variable.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of model.edges) {
    incoming.set(edge.toVariableId, (incoming.get(edge.toVariableId) ?? 0) + 1);
    const targets = outgoing.get(edge.fromVariableId) ?? [];
    targets.push(edge.toVariableId);
    outgoing.set(edge.fromVariableId, targets);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, next);
      if (next === 0) queue.push(target);
    }
    queue.sort();
  }
  if (order.length !== model.variables.length) throw new CausalEngineError('Causal model contains a directed cycle.');
  return order;
}
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function assertActor(actor: CommercialActor): void { if (!actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new CausalEngineError('A tenant-bound actor is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
