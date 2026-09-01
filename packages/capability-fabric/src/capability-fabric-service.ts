import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { PermanenceFabricModule } from '@jataqi/permanence-fabric';
import type { JqRuntimeCapability, PermanenceFabricService } from '@jataqi/permanence-fabric';
import type { CommercialActor, CommercialEvidence, CommercialProvenance, PrivacyClassification } from '@jataqi/commercial-control-plane';
import {
  CapabilityFabricEvents,
  type AssessJqCapabilityAccessInput,
  type CapabilityAccessAssessment,
  type CapabilityAccessOutcome,
  type CapabilityFabricAuditEntry,
  type CapabilityFabricIntegrityResult,
  type CapabilityGraph,
  type CapabilityGraphEdge,
  type CapabilityGraphNode,
  type CapabilityLifecycleState,
  type EngineGenome,
  type EngineSchemaReference,
  type GrantJqCapabilityInput,
  type JqCapability,
  type JqCapabilityClass,
  type JqCapabilityGrant,
  type JqSafetyClass,
  type RegisterEngineGenomeInput,
  type RegisterJqCapabilityInput,
  type RevokeJqCapabilityGrantInput,
  type TransitionEngineGenomeInput,
  type TransitionJqCapabilityInput,
} from './types.js';

const COLLECTIONS = Object.freeze({
  capabilities: 'capability-fabric.capabilities',
  grants: 'capability-fabric.grants',
  assessments: 'capability-fabric.access-assessments',
  engines: 'capability-fabric.engines',
  audit: 'capability-fabric.audit',
});

const MAX_ITEMS = 50;
const CAPABILITY_CLASSES = new Set<JqCapabilityClass>([
  'COGNITION', 'REASONING', 'MEMORY', 'LANGUAGE', 'VISION', 'AUDIO', 'ROBOTICS', 'SCIENTIFIC', 'MATHEMATICAL', 'SIMULATION',
  'GEOSPATIAL', 'SATELLITE_DATA', 'FINANCIAL', 'COMMERCIAL', 'MEDICAL', 'EDUCATIONAL', 'MANUFACTURING', 'TRANSPORTATION',
  'CYBERSECURITY', 'COMMUNICATION', 'OPTIMIZATION', 'SEARCH', 'DATABASE', 'DEVELOPER', 'CREATIVE', 'AGENT_ORCHESTRATION',
  'DIGITAL_TWIN', 'INFRASTRUCTURE', 'DATA_ANALYSIS', 'OTHER',
]);
const SAFETY_CLASSES = new Set<JqSafetyClass>(['CLASS_0_INFORMATIONAL', 'CLASS_1_REVERSIBLE_DIGITAL', 'CLASS_2_CONSEQUENTIAL_DIGITAL', 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT']);
const LIFECYCLE_STATES = new Set<CapabilityLifecycleState>(['PROPOSED', 'DISCOVERED', 'REGISTERED', 'VERIFIED', 'SANDBOXED', 'CERTIFIED', 'AVAILABLE', 'ACTIVE', 'MONITORED', 'UPDATED', 'RETIRED', 'BLOCKED']);
const RUNTIME_CAPABILITIES = new Set<JqRuntimeCapability>(['INITIATE', 'AUTHENTICATE', 'LOAD_STATE', 'VERIFY_STATE', 'EXECUTE_CORE', 'SYNC_STATE', 'ATTEST', 'DECLARE_MANIFESTATION', 'MIGRATE', 'RECOVER', 'SHUTDOWN']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>(['UNVERIFIED', 'PARTIAL', 'OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED', 'ESTIMATED', 'ASSUMPTION', 'PREDICTION', 'STALE', 'CONFLICTING', 'UNAVAILABLE']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);

export class CapabilityFabricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityFabricError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * JQ-CAP / JQ-UCR implementation: tenant-bound capability and ENGINE_GENOME
 * registry with explicit lifecycle, grants, composition, and audit records.
 * It does not generate code, install packages, allocate hardware, call tools,
 * deploy an engine, or authorize external/physical execution.
 */
export class CapabilityFabricService {
  private api!: KernelApi;
  private permanence!: PermanenceFabricService;
  private capabilities!: ICollection<JqCapability>;
  private grants!: ICollection<JqCapabilityGrant>;
  private assessments!: ICollection<CapabilityAccessAssessment>;
  private engines!: ICollection<EngineGenome>;
  private audit!: ICollection<CapabilityFabricAuditEntry>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.capabilities = await storage.collection<JqCapability>(COLLECTIONS.capabilities);
    this.grants = await storage.collection<JqCapabilityGrant>(COLLECTIONS.grants);
    this.assessments = await storage.collection<CapabilityAccessAssessment>(COLLECTIONS.assessments);
    this.engines = await storage.collection<EngineGenome>(COLLECTIONS.engines);
    this.audit = await storage.collection<CapabilityFabricAuditEntry>(COLLECTIONS.audit);
    this.permanence = kernel.getModule<PermanenceFabricModule>('permanence-fabric').getService();
  }

  /** Register a proposed capability. Existence is intentionally separate from authorization and activation. */
  async registerCapability(actor: CommercialActor, input: RegisterJqCapabilityInput): Promise<JqCapability> {
    assertAdministrator(actor);
    validateCapabilityInput(input);
    if (input.identityId) await this.assertIdentityLink(actor, input.identityId);
    const dependencies = uniqueStrings(input.dependencies ?? [], 'Capability dependencies', MAX_ITEMS, 180);
    const all = await this.capabilitiesForTenant(actor.tenantId);
    for (const dependencyId of dependencies) {
      if (!all.some((capability) => capability.id === dependencyId)) throw new CapabilityFabricError(`Capability dependency ${dependencyId} is not registered for this tenant.`);
    }
    const capability: JqCapability = {
      id: randomUUID(), tenantId: actor.tenantId, identityId: input.identityId,
      name: cleanText(input.name, 'Capability name', 240), version: cleanText(input.version, 'Capability version', 120),
      capabilityClass: input.capabilityClass, customCapabilityClass: input.customCapabilityClass === undefined ? undefined : cleanText(input.customCapabilityClass, 'Custom capability class', 180),
      description: cleanText(input.description, 'Capability description', 1_000),
      requiredPermissionIds: uniqueStrings(input.requiredPermissionIds ?? [], 'Required permission ids', MAX_ITEMS, 180),
      requiredRuntimeCapabilities: runtimeCapabilities(input.requiredRuntimeCapabilities ?? []),
      dependencies, safetyClass: input.safetyClass, riskScore: input.riskScore,
      authorizationPolicySummary: cleanText(input.authorizationPolicySummary, 'Capability authorization policy', 800),
      verificationMethod: cleanText(input.verificationMethod, 'Capability verification method', 800),
      auditRequirements: uniqueStrings(input.auditRequirements ?? [], 'Capability audit requirements', MAX_ITEMS, 240),
      lifecycleState: 'PROPOSED', provenance: sanitizeProvenance(input.provenance), privacyClassification: privacyClassification(input.privacyClassification),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await assertNoCapabilityCycle(capability, all);
    await this.capabilities.put(capability);
    const audit = await this.appendAudit(capability.tenantId, 'CAPABILITY_REGISTERED', capability.id, actor.id, digest(capability));
    await this.api.bus.emit(CapabilityFabricEvents.CapabilityRegistered, {
      capabilityId: capability.id, tenantId: capability.tenantId, lifecycleState: capability.lifecycleState,
      safetyClass: capability.safetyClass, auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(capability);
  }

  /** Advance a capability only through explicit lifecycle transitions and evidence gates. */
  async transitionCapability(actor: CommercialActor, capabilityId: string, input: TransitionJqCapabilityInput): Promise<JqCapability> {
    assertAdministrator(actor);
    validateTransitionInput(input);
    const capability = await this.requireCapabilityForActor(actor, capabilityId);
    await assertLifecycleTransition(capability.lifecycleState, input.state, capability.safetyClass, input.evidence);
    if (requiresAvailableDependencies(input.state)) await this.assertCapabilityDependenciesAvailable(capability);
    const updated: JqCapability = { ...capability, lifecycleState: input.state, updatedAt: Date.now() };
    await this.capabilities.put(updated);
    const audit = await this.appendAudit(updated.tenantId, 'CAPABILITY_TRANSITIONED', updated.id, actor.id, digest({ from: capability.lifecycleState, to: updated.lifecycleState, reason: input.reason, provenance: input.provenance }));
    await this.api.bus.emit(CapabilityFabricEvents.CapabilityTransitioned, {
      capabilityId: updated.id, tenantId: updated.tenantId, previousState: capability.lifecycleState, lifecycleState: updated.lifecycleState,
      safetyClass: updated.safetyClass, auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(updated);
  }

  /** Issue a scoped capability grant. Permission IDs must be part of the registered capability boundary. */
  async grantCapability(actor: CommercialActor, capabilityId: string, input: GrantJqCapabilityInput): Promise<JqCapabilityGrant> {
    assertAdministrator(actor);
    validateGrantInput(input);
    const capability = await this.requireCapabilityForActor(actor, capabilityId);
    const permissions = uniqueStrings(input.permissionIds, 'Granted permission ids', MAX_ITEMS, 180);
    if (!permissions.every((permission) => capability.requiredPermissionIds.includes(permission))) throw new CapabilityFabricError('A capability grant may only grant permissions explicitly declared by that capability.');
    const now = Date.now();
    const grant: JqCapabilityGrant = {
      id: randomUUID(), tenantId: capability.tenantId, capabilityId: capability.id, subjectActorId: cleanText(input.subjectActorId, 'Grant subject actor id', 180),
      permissionIds: permissions, scope: optionalText(input.scope, 'Grant scope', 500), status: 'ACTIVE', expiresAt: optionalFutureTime(input.expiresAt, 'Grant expiry', now),
      issuedByActorId: actor.id, provenance: sanitizeProvenance(input.provenance), createdAt: now, updatedAt: now,
    };
    await this.grants.put(grant);
    const audit = await this.appendAudit(grant.tenantId, 'GRANT_ISSUED', grant.id, actor.id, digest(grant));
    await this.api.bus.emit(CapabilityFabricEvents.GrantIssued, {
      grantId: grant.id, capabilityId: grant.capabilityId, subjectActorId: grant.subjectActorId,
      expiresAt: grant.expiresAt, auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(grant);
  }

  /** Revoke a scoped grant without erasing its audit history. */
  async revokeCapabilityGrant(actor: CommercialActor, grantId: string, input: RevokeJqCapabilityGrantInput): Promise<JqCapabilityGrant> {
    assertAdministrator(actor);
    if (!input || typeof input !== 'object') throw new CapabilityFabricError('Capability grant revocation input is required.');
    const grant = await this.requireGrantForActor(actor, grantId);
    if (grant.status === 'REVOKED') return copy(grant);
    const updated: JqCapabilityGrant = {
      ...grant, status: 'REVOKED', revokedAt: Date.now(), revocationReason: cleanText(input.reason, 'Grant revocation reason', 640),
      provenance: sanitizeProvenance(input.provenance), updatedAt: Date.now(),
    };
    await this.grants.put(updated);
    const audit = await this.appendAudit(updated.tenantId, 'GRANT_REVOKED', updated.id, actor.id, digest({ grantId: updated.id, reason: updated.revocationReason, provenance: updated.provenance }));
    await this.api.bus.emit(CapabilityFabricEvents.GrantRevoked, {
      grantId: updated.id, capabilityId: updated.capabilityId, subjectActorId: updated.subjectActorId,
      auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(updated);
  }

  /**
   * Determine only whether a capability is locally available and scoped to the
   * requesting actor/runtime. This assessment never invokes an engine/tool.
   */
  async assessCapabilityAccess(actor: CommercialActor, capabilityId: string, input: AssessJqCapabilityAccessInput = {}): Promise<CapabilityAccessAssessment> {
    assertActor(actor);
    const capability = await this.requireCapabilityForActor(actor, capabilityId);
    const checks: CapabilityAccessAssessment['checks'] = [];
    const lifecycleReady = ['AVAILABLE', 'ACTIVE', 'MONITORED'].includes(capability.lifecycleState);
    checks.push({ name: 'lifecycle', passed: lifecycleReady, detail: lifecycleReady ? 'Capability lifecycle is locally available.' : `Capability lifecycle is ${capability.lifecycleState}.` });
    const requiredPermissions = capability.requiredPermissionIds;
    const activeGrants = await this.grants.query({ where: (grant) => grant.tenantId === capability.tenantId && grant.capabilityId === capability.id && grant.subjectActorId === actor.id && grant.status === 'ACTIVE' && !isExpired(grant.expiresAt, Date.now()) });
    const granted = requiredPermissions.length === 0 || activeGrants.some((grant) => requiredPermissions.every((permission) => grant.permissionIds.includes(permission)));
    checks.push({ name: 'grant', passed: granted, detail: granted ? (requiredPermissions.length ? 'An active scoped grant covers required permissions.' : 'No explicit permission ids are required by this capability.') : 'No active scoped grant covers every required permission.' });
    const runtimeReady = await this.runtimeRequirementMet(actor, capability, input.runtimeAuthorizationId);
    checks.push({ name: 'runtime', passed: runtimeReady.passed, detail: runtimeReady.detail });
    const safetyReady = capability.safetyClass !== 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT';
    checks.push({ name: 'safety', passed: safetyReady, detail: safetyReady ? 'Capability safety class does not require an external physical/high-impact execution review.' : 'Physical/high-impact capability execution is blocked by this registry pending separate safety, regulatory, and execution controls.' });
    const outcome: CapabilityAccessOutcome = !safetyReady
      ? 'BLOCKED_SAFETY_REVIEW'
      : !lifecycleReady
        ? 'UNAVAILABLE'
        : !granted
          ? 'AVAILABLE_REQUIRES_GRANT'
          : !runtimeReady.passed
            ? 'AVAILABLE_REQUIRES_RUNTIME'
            : 'AVAILABLE_AND_AUTHORIZED';
    const assessment: CapabilityAccessAssessment = {
      id: randomUUID(), tenantId: capability.tenantId, capabilityId: capability.id, actorId: actor.id, runtimeAuthorizationId: input.runtimeAuthorizationId,
      outcome, checks, reason: checks.filter((check) => !check.passed).map((check) => check.detail).join(' ') || 'Capability is locally available and scoped; this does not authorize execution.',
      doesNotAuthorizeExecution: true, createdAt: Date.now(),
    };
    await this.assessments.put(assessment);
    const audit = await this.appendAudit(assessment.tenantId, 'ACCESS_ASSESSED', assessment.id, actor.id, digest({ capabilityId: capability.id, outcome: assessment.outcome, checks }));
    await this.api.bus.emit(CapabilityFabricEvents.AccessAssessed, {
      assessmentId: assessment.id, capabilityId: capability.id, actorId: actor.id, outcome: assessment.outcome,
      auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(assessment);
  }

  /** Register an ENGINE_GENOME metadata record. It remains PROPOSED and cannot execute code. */
  async registerEngineGenome(actor: CommercialActor, input: RegisterEngineGenomeInput): Promise<EngineGenome> {
    assertAdministrator(actor);
    validateEngineInput(input);
    if (input.identityId) await this.assertIdentityLink(actor, input.identityId);
    const capabilities = await this.capabilitiesForTenant(actor.tenantId);
    const capabilityIds = uniqueStrings(input.capabilityIds, 'Engine capability ids', MAX_ITEMS, 180);
    if (capabilityIds.length === 0) throw new CapabilityFabricError('ENGINE_GENOME requires at least one registered capability id.');
    if (!capabilityIds.every((id) => capabilities.some((capability) => capability.id === id))) throw new CapabilityFabricError('Every engine capability id must be registered in this tenant.');
    const engines = await this.enginesForTenant(actor.tenantId);
    const composedEngineIds = uniqueStrings(input.composedEngineIds ?? [], 'Composed engine ids', MAX_ITEMS, 180);
    if (!composedEngineIds.every((id) => engines.some((engine) => engine.id === id))) throw new CapabilityFabricError('Every composed engine id must be registered in this tenant.');
    const actuatorsRequired = uniqueStrings(input.actuatorsRequired ?? [], 'Engine actuator requirements', MAX_ITEMS, 240);
    if (actuatorsRequired.length > 0 && input.safetyClass !== 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT') {
      throw new CapabilityFabricError('An ENGINE_GENOME that declares actuators must use CLASS_3_PHYSICAL_OR_HIGH_IMPACT and cannot activate through this registry.');
    }
    if (engines.some((engine) => engine.engineId === input.engineId && engine.version === input.version)) throw new CapabilityFabricError(`Engine ${input.engineId}@${input.version} is already registered.`);
    const now = Date.now();
    const engine: EngineGenome = {
      id: randomUUID(), tenantId: actor.tenantId, identityId: input.identityId, engineId: cleanText(input.engineId, 'Engine id', 180),
      name: cleanText(input.name, 'Engine name', 240), version: cleanText(input.version, 'Engine version', 120), description: cleanText(input.description, 'Engine description', 1_000),
      capabilityIds, composedEngineIds, inputSchema: schemaReference(input.inputSchema, 'Engine input schema'), outputSchema: schemaReference(input.outputSchema, 'Engine output schema'),
      stateModelSummary: cleanText(input.stateModelSummary, 'Engine state model summary', 800),
      memoryRequirements: uniqueStrings(input.memoryRequirements ?? [], 'Engine memory requirements', MAX_ITEMS, 240),
      computeRequirements: uniqueStrings(input.computeRequirements ?? [], 'Engine compute requirements', MAX_ITEMS, 240),
      dataRequirements: uniqueStrings(input.dataRequirements ?? [], 'Engine data requirements', MAX_ITEMS, 240),
      toolsRequired: uniqueStrings(input.toolsRequired ?? [], 'Engine tool requirements', MAX_ITEMS, 240),
      sensorsRequired: uniqueStrings(input.sensorsRequired ?? [], 'Engine sensor requirements', MAX_ITEMS, 240),
      actuatorsRequired,
      apiRequirements: uniqueStrings(input.apiRequirements ?? [], 'Engine API requirements', MAX_ITEMS, 240),
      modelDependencies: uniqueStrings(input.modelDependencies ?? [], 'Engine model dependencies', MAX_ITEMS, 240),
      securityPolicySummary: cleanText(input.securityPolicySummary, 'Engine security policy', 800),
      resourcePolicySummary: cleanText(input.resourcePolicySummary, 'Engine resource policy', 800),
      authorizationPolicySummary: cleanText(input.authorizationPolicySummary, 'Engine authorization policy', 800),
      latencyProfileSummary: cleanText(input.latencyProfileSummary, 'Engine latency profile', 800), reliabilityTarget: input.reliabilityTarget,
      costModelSummary: cleanText(input.costModelSummary, 'Engine cost model', 800), energyModelSummary: cleanText(input.energyModelSummary, 'Engine energy model', 800),
      validationRequirements: uniqueStrings(input.validationRequirements ?? [], 'Engine validation requirements', MAX_ITEMS, 240),
      failureModes: uniqueStrings(input.failureModes ?? [], 'Engine failure modes', MAX_ITEMS, 240),
      observabilityRequirements: uniqueStrings(input.observabilityRequirements ?? [], 'Engine observability requirements', MAX_ITEMS, 240),
      owner: cleanText(input.owner, 'Engine owner', 240), safetyClass: input.safetyClass, lifecycleState: 'PROPOSED', provenance: sanitizeProvenance(input.provenance),
      createdAt: now, updatedAt: now,
    };
    assertNoEngineCycle(engine, engines);
    await this.engines.put(engine);
    const audit = await this.appendAudit(engine.tenantId, 'ENGINE_REGISTERED', engine.id, actor.id, digest(engine));
    await this.api.bus.emit(CapabilityFabricEvents.EngineRegistered, {
      engineGenomeId: engine.id, engineId: engine.engineId, tenantId: engine.tenantId, lifecycleState: engine.lifecycleState,
      safetyClass: engine.safetyClass, auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(engine);
  }

  /** Explicitly transition engine metadata; high-impact engines cannot be activated by this registry. */
  async transitionEngineGenome(actor: CommercialActor, engineGenomeId: string, input: TransitionEngineGenomeInput): Promise<EngineGenome> {
    assertAdministrator(actor);
    validateTransitionInput(input);
    const engine = await this.requireEngineForActor(actor, engineGenomeId);
    await assertLifecycleTransition(engine.lifecycleState, input.state, engine.safetyClass, input.evidence);
    if (requiresAvailableDependencies(input.state)) {
      const capabilities = await this.capabilitiesForTenant(engine.tenantId);
      const unavailable = engine.capabilityIds.filter((id) => !capabilities.some((capability) => capability.id === id && ['AVAILABLE', 'ACTIVE', 'MONITORED'].includes(capability.lifecycleState)));
      if (unavailable.length) throw new CapabilityFabricError(`Engine cannot become ${input.state}; capabilities are not locally available: ${unavailable.join(', ')}.`);
      const engines = await this.enginesForTenant(engine.tenantId);
      const unavailableEngines = engine.composedEngineIds.filter((id) => !engines.some((candidate) => candidate.id === id && ['AVAILABLE', 'ACTIVE', 'MONITORED'].includes(candidate.lifecycleState)));
      if (unavailableEngines.length) throw new CapabilityFabricError(`Engine cannot become ${input.state}; composed engines are not locally available: ${unavailableEngines.join(', ')}.`);
    }
    const updated: EngineGenome = { ...engine, lifecycleState: input.state, updatedAt: Date.now() };
    await this.engines.put(updated);
    const audit = await this.appendAudit(updated.tenantId, 'ENGINE_TRANSITIONED', updated.id, actor.id, digest({ from: engine.lifecycleState, to: updated.lifecycleState, reason: input.reason, provenance: input.provenance }));
    await this.api.bus.emit(CapabilityFabricEvents.EngineTransitioned, {
      engineGenomeId: updated.id, engineId: updated.engineId, tenantId: updated.tenantId,
      previousState: engine.lifecycleState, lifecycleState: updated.lifecycleState, auditReference: audit.id, doesNotAuthorizeExecution: true,
    });
    return copy(updated);
  }

  /** Read-only graph of currently registered capability/engine metadata. */
  async graph(actor: CommercialActor): Promise<CapabilityGraph> {
    assertActor(actor);
    const [capabilities, engines] = await Promise.all([this.capabilitiesForRead(actor), this.enginesForRead(actor)]);
    const nodes: CapabilityGraphNode[] = [
      ...capabilities.map((capability) => ({ id: capability.id, type: 'CAPABILITY' as const, name: capability.name, lifecycleState: capability.lifecycleState, safetyClass: capability.safetyClass })),
      ...engines.map((engine) => ({ id: engine.id, type: 'ENGINE' as const, name: engine.name, lifecycleState: engine.lifecycleState, safetyClass: engine.safetyClass })),
    ];
    const edges: CapabilityGraphEdge[] = [
      ...capabilities.flatMap((capability) => capability.dependencies.map((dependency) => ({ fromId: capability.id, toId: dependency, type: 'DEPENDS_ON' as const }))),
      ...engines.flatMap((engine) => [
        ...engine.capabilityIds.map((capabilityId) => ({ fromId: engine.id, toId: capabilityId, type: 'REQUIRES_CAPABILITY' as const })),
        ...engine.composedEngineIds.map((engineId) => ({ fromId: engine.id, toId: engineId, type: 'COMPOSES' as const })),
      ]),
    ];
    return { tenantId: actor.tenantId, nodes: nodes.sort((first, second) => first.id.localeCompare(second.id)), edges: edges.sort((first, second) => first.fromId.localeCompare(second.fromId) || first.toId.localeCompare(second.toId) || first.type.localeCompare(second.type)), generatedAt: Date.now() };
  }

  async getCapability(actor: CommercialActor, capabilityId: string): Promise<JqCapability | undefined> {
    const capability = await this.capabilities.get(capabilityId);
    return capability && canRead(actor, capability.tenantId) ? copy(capability) : undefined;
  }

  async listCapabilities(actor: CommercialActor): Promise<JqCapability[]> {
    return sorted(await this.capabilitiesForRead(actor)).map(copy);
  }

  async getGrant(actor: CommercialActor, grantId: string): Promise<JqCapabilityGrant | undefined> {
    const grant = await this.grants.get(grantId);
    return grant && canRead(actor, grant.tenantId) ? copy(grant) : undefined;
  }

  async listGrants(actor: CommercialActor, capabilityId?: string): Promise<JqCapabilityGrant[]> {
    if (capabilityId) await this.requireCapabilityForActor(actor, capabilityId);
    return sorted(await this.grants.query({ where: (grant) => canRead(actor, grant.tenantId) && (capabilityId === undefined || grant.capabilityId === capabilityId) })).map(copy);
  }

  async listAccessAssessments(actor: CommercialActor, capabilityId?: string): Promise<CapabilityAccessAssessment[]> {
    if (capabilityId) await this.requireCapabilityForActor(actor, capabilityId);
    return sorted(await this.assessments.query({ where: (assessment) => canRead(actor, assessment.tenantId) && (capabilityId === undefined || assessment.capabilityId === capabilityId) })).map(copy);
  }

  async getEngineGenome(actor: CommercialActor, engineGenomeId: string): Promise<EngineGenome | undefined> {
    const engine = await this.engines.get(engineGenomeId);
    return engine && canRead(actor, engine.tenantId) ? copy(engine) : undefined;
  }

  async listEngineGenomes(actor: CommercialActor): Promise<EngineGenome[]> {
    return sorted(await this.enginesForRead(actor)).map(copy);
  }

  async verifyAuditIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<CapabilityFabricIntegrityResult> {
    assertActor(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new CapabilityFabricError('Only a global administrator can verify another tenant capability audit.');
    const entries = (await this.audit.query({ where: (entry) => entry.tenantId === tenantId }))
      .sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.sequence !== index + 1) return { tenantId, valid: false, entries: entries.length, failure: `Unexpected audit sequence at ${entry.id}.` };
      if (entry.previousHash !== previousHash) return { tenantId, valid: false, entries: entries.length, failure: `Previous audit hash mismatch at ${entry.id}.` };
      if (entry.hash !== hashAudit({ ...entry, hash: '' })) return { tenantId, valid: false, entries: entries.length, failure: `Audit hash mismatch at ${entry.id}.` };
      previousHash = entry.hash;
    }
    return { tenantId, valid: true, entries: entries.length };
  }

  private async requireCapabilityForActor(actor: CommercialActor, capabilityId: string): Promise<JqCapability> {
    const capability = await this.getCapability(actor, capabilityId);
    if (!capability || capability.tenantId !== actor.tenantId) throw new CapabilityFabricError('JQ capability not found for this tenant.');
    return capability;
  }

  private async requireGrantForActor(actor: CommercialActor, grantId: string): Promise<JqCapabilityGrant> {
    const grant = await this.getGrant(actor, grantId);
    if (!grant || grant.tenantId !== actor.tenantId) throw new CapabilityFabricError('JQ capability grant not found for this tenant.');
    return grant;
  }

  private async requireEngineForActor(actor: CommercialActor, engineGenomeId: string): Promise<EngineGenome> {
    const engine = await this.getEngineGenome(actor, engineGenomeId);
    if (!engine || engine.tenantId !== actor.tenantId) throw new CapabilityFabricError('ENGINE_GENOME not found for this tenant.');
    return engine;
  }

  private async capabilitiesForTenant(tenantId: string): Promise<JqCapability[]> {
    return this.capabilities.query({ where: (capability) => capability.tenantId === tenantId });
  }

  private async capabilitiesForRead(actor: CommercialActor): Promise<JqCapability[]> {
    return this.capabilities.query({ where: (capability) => canRead(actor, capability.tenantId) });
  }

  private async enginesForTenant(tenantId: string): Promise<EngineGenome[]> {
    return this.engines.query({ where: (engine) => engine.tenantId === tenantId });
  }

  private async enginesForRead(actor: CommercialActor): Promise<EngineGenome[]> {
    return this.engines.query({ where: (engine) => canRead(actor, engine.tenantId) });
  }

  private async assertCapabilityDependenciesAvailable(capability: JqCapability): Promise<void> {
    const all = await this.capabilitiesForTenant(capability.tenantId);
    const unavailable = capability.dependencies.filter((id) => !all.some((candidate) => candidate.id === id && ['AVAILABLE', 'ACTIVE', 'MONITORED'].includes(candidate.lifecycleState)));
    if (unavailable.length) throw new CapabilityFabricError(`Capability cannot become available; dependencies are not locally available: ${unavailable.join(', ')}.`);
  }

  private async runtimeRequirementMet(actor: CommercialActor, capability: JqCapability, runtimeAuthorizationId: string | undefined): Promise<{ passed: boolean; detail: string }> {
    if (capability.requiredRuntimeCapabilities.length === 0) return { passed: true, detail: 'No runtime capability requirements are declared.' };
    if (!capability.identityId) return { passed: false, detail: 'Capability declares runtime requirements but is not linked to a JQ-ID identity.' };
    if (!runtimeAuthorizationId) return { passed: false, detail: 'Capability requires an authorized runtime, but no runtime authorization id was supplied.' };
    const runtimes = await this.permanence.listRuntimeAuthorizations(actor, capability.identityId);
    const runtime = runtimes.find((candidate) => candidate.id === runtimeAuthorizationId);
    if (!runtime || runtime.status !== 'AUTHORIZED' || isExpired(runtime.expiresAt, Date.now())) return { passed: false, detail: 'Supplied runtime authorization is unavailable, revoked, or expired.' };
    const missing = capability.requiredRuntimeCapabilities.filter((requirement) => !runtime.capabilities.includes(requirement));
    return missing.length
      ? { passed: false, detail: `Runtime authorization lacks required capabilities: ${missing.join(', ')}.` }
      : { passed: true, detail: 'Root-authorized runtime capabilities satisfy this registry requirement.' };
  }

  private async assertIdentityLink(actor: CommercialActor, identityId: string): Promise<void> {
    const identity = await this.permanence.getIdentity(actor, identityId);
    if (!identity || identity.tenantId !== actor.tenantId) throw new CapabilityFabricError('Capability/engine JQ-ID link is not available in this tenant.');
  }

  private async appendAudit(tenantId: string, eventType: CapabilityFabricAuditEntry['eventType'], subjectId: string, actorId: string, detailHash: string): Promise<CapabilityFabricAuditEntry> {
    const previous = (await this.audit.query({ where: (entry) => entry.tenantId === tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<CapabilityFabricAuditEntry, 'hash'> = {
      id: randomUUID(), tenantId, sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? 'GENESIS',
      eventType, subjectId, actorId, detailHash, createdAt: Date.now(),
    };
    const entry: CapabilityFabricAuditEntry = { ...draft, hash: hashAudit({ ...draft, hash: '' }) };
    await this.audit.put(entry);
    return entry;
  }
}

function validateCapabilityInput(input: RegisterJqCapabilityInput): void {
  if (!input || typeof input !== 'object') throw new CapabilityFabricError('Capability input is required.');
  if (input.identityId !== undefined) cleanText(input.identityId, 'Capability identity id', 180);
  cleanText(input.name, 'Capability name', 240);
  cleanText(input.version, 'Capability version', 120);
  if (!CAPABILITY_CLASSES.has(input.capabilityClass)) throw new CapabilityFabricError('Capability class is invalid.');
  if (input.capabilityClass === 'OTHER' && !input.customCapabilityClass?.trim()) throw new CapabilityFabricError('OTHER capability class requires a custom capability class label.');
  if (input.capabilityClass !== 'OTHER' && input.customCapabilityClass !== undefined) throw new CapabilityFabricError('Custom capability class is only valid for OTHER capabilities.');
  cleanText(input.description, 'Capability description', 1_000);
  uniqueStrings(input.requiredPermissionIds ?? [], 'Required permission ids', MAX_ITEMS, 180);
  runtimeCapabilities(input.requiredRuntimeCapabilities ?? []);
  uniqueStrings(input.dependencies ?? [], 'Capability dependencies', MAX_ITEMS, 180);
  if (!SAFETY_CLASSES.has(input.safetyClass)) throw new CapabilityFabricError('Capability safety class is invalid.');
  assertPercent(input.riskScore, 'Capability risk score');
  cleanText(input.authorizationPolicySummary, 'Capability authorization policy', 800);
  cleanText(input.verificationMethod, 'Capability verification method', 800);
  uniqueStrings(input.auditRequirements ?? [], 'Capability audit requirements', MAX_ITEMS, 240);
  sanitizeProvenance(input.provenance);
  privacyClassification(input.privacyClassification);
}

function validateEngineInput(input: RegisterEngineGenomeInput): void {
  if (!input || typeof input !== 'object') throw new CapabilityFabricError('ENGINE_GENOME input is required.');
  if (input.identityId !== undefined) cleanText(input.identityId, 'Engine identity id', 180);
  for (const [name, value] of Object.entries({ engineId: input.engineId, name: input.name, version: input.version, description: input.description, stateModelSummary: input.stateModelSummary, securityPolicySummary: input.securityPolicySummary, resourcePolicySummary: input.resourcePolicySummary, authorizationPolicySummary: input.authorizationPolicySummary, latencyProfileSummary: input.latencyProfileSummary, costModelSummary: input.costModelSummary, energyModelSummary: input.energyModelSummary, owner: input.owner })) cleanText(value, `Engine ${name}`, 1_000);
  uniqueStrings(input.capabilityIds, 'Engine capability ids', MAX_ITEMS, 180);
  uniqueStrings(input.composedEngineIds ?? [], 'Composed engine ids', MAX_ITEMS, 180);
  schemaReference(input.inputSchema, 'Engine input schema');
  schemaReference(input.outputSchema, 'Engine output schema');
  for (const [name, values] of Object.entries({ memoryRequirements: input.memoryRequirements ?? [], computeRequirements: input.computeRequirements ?? [], dataRequirements: input.dataRequirements ?? [], toolsRequired: input.toolsRequired ?? [], sensorsRequired: input.sensorsRequired ?? [], actuatorsRequired: input.actuatorsRequired ?? [], apiRequirements: input.apiRequirements ?? [], modelDependencies: input.modelDependencies ?? [], validationRequirements: input.validationRequirements ?? [], failureModes: input.failureModes ?? [], observabilityRequirements: input.observabilityRequirements ?? [] })) uniqueStrings(values, `Engine ${name}`, MAX_ITEMS, 240);
  assertPercent(input.reliabilityTarget, 'Engine reliability target');
  if (!SAFETY_CLASSES.has(input.safetyClass)) throw new CapabilityFabricError('Engine safety class is invalid.');
  sanitizeProvenance(input.provenance);
}

function validateTransitionInput(input: TransitionJqCapabilityInput | TransitionEngineGenomeInput): void {
  if (!input || typeof input !== 'object' || !LIFECYCLE_STATES.has(input.state)) throw new CapabilityFabricError('Capability/engine lifecycle state is invalid.');
  cleanText(input.reason, 'Lifecycle transition reason', 800);
  if (input.evidence) sanitizeEvidence(input.evidence);
  sanitizeProvenance(input.provenance);
}

function validateGrantInput(input: GrantJqCapabilityInput): void {
  if (!input || typeof input !== 'object') throw new CapabilityFabricError('Capability grant input is required.');
  cleanText(input.subjectActorId, 'Grant subject actor id', 180);
  const permissions = uniqueStrings(input.permissionIds, 'Granted permission ids', MAX_ITEMS, 180);
  if (permissions.length === 0) throw new CapabilityFabricError('A capability grant needs at least one permission id.');
  optionalText(input.scope, 'Grant scope', 500);
  optionalFutureTime(input.expiresAt, 'Grant expiry', Date.now());
  sanitizeProvenance(input.provenance);
}

async function assertLifecycleTransition(from: CapabilityLifecycleState, to: CapabilityLifecycleState, safetyClass: JqSafetyClass, evidence: CommercialEvidence[] | undefined): Promise<void> {
  if (from === to) throw new CapabilityFabricError('Lifecycle transition must change state.');
  const allowed: Record<CapabilityLifecycleState, CapabilityLifecycleState[]> = {
    PROPOSED: ['DISCOVERED', 'REGISTERED', 'BLOCKED', 'RETIRED'],
    DISCOVERED: ['REGISTERED', 'BLOCKED', 'RETIRED'],
    REGISTERED: ['VERIFIED', 'BLOCKED', 'RETIRED'],
    VERIFIED: ['SANDBOXED', 'BLOCKED', 'RETIRED'],
    SANDBOXED: ['CERTIFIED', 'BLOCKED', 'RETIRED'],
    CERTIFIED: ['AVAILABLE', 'BLOCKED', 'RETIRED'],
    AVAILABLE: ['ACTIVE', 'MONITORED', 'UPDATED', 'BLOCKED', 'RETIRED'],
    ACTIVE: ['MONITORED', 'UPDATED', 'BLOCKED', 'RETIRED'],
    MONITORED: ['ACTIVE', 'UPDATED', 'BLOCKED', 'RETIRED'],
    UPDATED: ['VERIFIED', 'BLOCKED', 'RETIRED'],
    RETIRED: [],
    BLOCKED: ['REGISTERED', 'RETIRED'],
  };
  if (!allowed[from].includes(to)) throw new CapabilityFabricError(`Lifecycle transition ${from} -> ${to} is not allowed.`);
  if (['VERIFIED', 'SANDBOXED', 'CERTIFIED', 'AVAILABLE', 'ACTIVE', 'MONITORED'].includes(to) && !(evidence?.length)) {
    throw new CapabilityFabricError(`Lifecycle transition to ${to} requires evidence.`);
  }
  if (safetyClass === 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT' && to === 'ACTIVE') {
    throw new CapabilityFabricError('Physical/high-impact capability or engine activation is blocked in the registry; separate safety, regulatory, and execution controls are required.');
  }
}

function requiresAvailableDependencies(state: CapabilityLifecycleState): boolean {
  return ['AVAILABLE', 'ACTIVE', 'MONITORED'].includes(state);
}

async function assertNoCapabilityCycle(candidate: JqCapability, existing: readonly JqCapability[]): Promise<void> {
  const all = new Map([...existing, candidate].map((capability) => [capability.id, capability]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CapabilityFabricError('Capability dependency graph contains a cycle.');
    const capability = all.get(id);
    if (!capability) throw new CapabilityFabricError(`Unknown capability dependency ${id}.`);
    visiting.add(id);
    for (const dependencyId of capability.dependencies) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  visit(candidate.id);
}

function assertNoEngineCycle(candidate: EngineGenome, existing: readonly EngineGenome[]): void {
  const all = new Map([...existing, candidate].map((engine) => [engine.id, engine]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CapabilityFabricError('Engine composition graph contains a cycle.');
    const engine = all.get(id);
    if (!engine) throw new CapabilityFabricError(`Unknown composed engine ${id}.`);
    visiting.add(id);
    for (const childId of engine.composedEngineIds) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  visit(candidate.id);
}

function schemaReference(value: unknown, name: string): EngineSchemaReference {
  const schema = record(value, name);
  const contentHash = schema.contentHash === undefined ? undefined : digestValue(schema.contentHash, `${name} content hash`);
  return { id: cleanText(schema.id, `${name} id`, 240), version: cleanText(schema.version, `${name} version`, 120), contentHash };
}

function runtimeCapabilities(value: unknown): JqRuntimeCapability[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new CapabilityFabricError(`Runtime capabilities must be an array with at most ${MAX_ITEMS} values.`);
  const capabilities = value.map((item) => {
    if (typeof item !== 'string' || !RUNTIME_CAPABILITIES.has(item as JqRuntimeCapability)) throw new CapabilityFabricError('Runtime capability is invalid.');
    return item as JqRuntimeCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) throw new CapabilityFabricError('Runtime capabilities must be distinct.');
  return capabilities;
}

function sanitizeEvidence(value: unknown): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) throw new CapabilityFabricError(`Evidence must contain one to ${MAX_ITEMS} records.`);
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = cleanText(evidence.id, 'Evidence id', 180);
    if (ids.has(id)) throw new CapabilityFabricError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = cleanText(evidence.status, 'Evidence status', 80) as CommercialEvidence['status'];
    if (!EVIDENCE_STATUSES.has(status)) throw new CapabilityFabricError('Evidence status is invalid.');
    return {
      id, status, source: cleanText(evidence.source, 'Evidence source', 240), observedAt: positiveTimestamp(evidence.observedAt, 'Evidence observation time'),
      confidence: assertPercent(evidence.confidence, 'Evidence confidence'), summary: cleanText(evidence.summary, 'Evidence summary', 800),
      provenance: sanitizeProvenance(evidence.provenance), validUntil: optionalFinite(evidence.validUntil, 'Evidence validity time'), privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: cleanText(provenance.source, 'Provenance source', 240), collectedAt: positiveTimestamp(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180), causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 640), contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new CapabilityFabricError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function uniqueStrings(value: unknown, name: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new CapabilityFabricError(`${name} must be an array with at most ${maximumItems} values.`);
  const values = value.map((item) => cleanText(item, name, maximumLength));
  if (new Set(values).size !== values.length) throw new CapabilityFabricError(`${name} must not contain duplicates.`);
  return values;
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : cleanText(value, name, maximumLength);
}

function optionalFutureTime(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = positiveTimestamp(value, name);
  if (timestamp <= now) throw new CapabilityFabricError(`${name} must be in the future.`);
  return timestamp;
}

function isExpired(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt <= now;
}

function digestValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new CapabilityFabricError(`${name} must be a SHA-256 hex digest.`);
  return value.toLowerCase();
}

function assertPercent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new CapabilityFabricError(`${name} must be a finite number from 0 to 100.`);
  return value;
}

function positiveTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new CapabilityFabricError(`${name} must be a positive finite timestamp.`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CapabilityFabricError(`${name} must be finite.`);
  return value;
}

function cleanText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new CapabilityFabricError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new CapabilityFabricError(`${name} is required.`);
  return clean.length <= maximumLength ? clean : `${clean.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new CapabilityFabricError('A tenant-bound capability actor is required.');
}

function assertAdministrator(actor: CommercialActor): void {
  assertActor(actor);
  if (!actor.roles.some((role) => role === 'admin' || role === 'global_admin' || role === 'system')) throw new CapabilityFabricError('Capability/engine registry changes require an administrator or system actor.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CapabilityFabricError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function hashAudit(entry: CapabilityFabricAuditEntry): string {
  return digest(entry);
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).filter((key) => recordValue[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(recordValue[key])}`).join(',')}}`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
