import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import type { JqRuntimeCapability } from '@jataqi/permanence-fabric';

/** Extensible capability taxonomy; OTHER requires a caller-provided class label. */
export type JqCapabilityClass =
  | 'COGNITION'
  | 'REASONING'
  | 'MEMORY'
  | 'LANGUAGE'
  | 'VISION'
  | 'AUDIO'
  | 'ROBOTICS'
  | 'SCIENTIFIC'
  | 'MATHEMATICAL'
  | 'SIMULATION'
  | 'GEOSPATIAL'
  | 'SATELLITE_DATA'
  | 'FINANCIAL'
  | 'COMMERCIAL'
  | 'MEDICAL'
  | 'EDUCATIONAL'
  | 'MANUFACTURING'
  | 'TRANSPORTATION'
  | 'CYBERSECURITY'
  | 'COMMUNICATION'
  | 'OPTIMIZATION'
  | 'SEARCH'
  | 'DATABASE'
  | 'DEVELOPER'
  | 'CREATIVE'
  | 'AGENT_ORCHESTRATION'
  | 'DIGITAL_TWIN'
  | 'INFRASTRUCTURE'
  | 'DATA_ANALYSIS'
  | 'OTHER';

/** Higher classes do not receive autonomous activation from this registry. */
export type JqSafetyClass = 'CLASS_0_INFORMATIONAL' | 'CLASS_1_REVERSIBLE_DIGITAL' | 'CLASS_2_CONSEQUENTIAL_DIGITAL' | 'CLASS_3_PHYSICAL_OR_HIGH_IMPACT';

export type CapabilityLifecycleState = 'PROPOSED' | 'DISCOVERED' | 'REGISTERED' | 'VERIFIED' | 'SANDBOXED' | 'CERTIFIED' | 'AVAILABLE' | 'ACTIVE' | 'MONITORED' | 'UPDATED' | 'RETIRED' | 'BLOCKED';

/** A separately governed capability, not proof that a tool/provider/resource actually exists. */
export interface JqCapability {
  id: string;
  tenantId: string;
  identityId?: string;
  name: string;
  version: string;
  capabilityClass: JqCapabilityClass;
  customCapabilityClass?: string;
  description: string;
  requiredPermissionIds: string[];
  requiredRuntimeCapabilities: JqRuntimeCapability[];
  dependencies: string[];
  safetyClass: JqSafetyClass;
  riskScore: number;
  authorizationPolicySummary: string;
  verificationMethod: string;
  auditRequirements: string[];
  lifecycleState: CapabilityLifecycleState;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterJqCapabilityInput {
  identityId?: string;
  name: string;
  version: string;
  capabilityClass: JqCapabilityClass;
  customCapabilityClass?: string;
  description: string;
  requiredPermissionIds?: string[];
  requiredRuntimeCapabilities?: JqRuntimeCapability[];
  dependencies?: string[];
  safetyClass: JqSafetyClass;
  riskScore: number;
  authorizationPolicySummary: string;
  verificationMethod: string;
  auditRequirements?: string[];
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
}

export interface TransitionJqCapabilityInput {
  state: CapabilityLifecycleState;
  reason: string;
  evidence?: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export type CapabilityGrantStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

/** Explicit subject grant; it never gives a model/agent unrestricted authority. */
export interface JqCapabilityGrant {
  id: string;
  tenantId: string;
  capabilityId: string;
  subjectActorId: string;
  permissionIds: string[];
  scope?: string;
  status: CapabilityGrantStatus;
  expiresAt?: number;
  issuedByActorId: string;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
  revocationReason?: string;
}

export interface GrantJqCapabilityInput {
  subjectActorId: string;
  permissionIds: string[];
  scope?: string;
  expiresAt?: number;
  provenance: CommercialProvenance;
}

export interface RevokeJqCapabilityGrantInput {
  reason: string;
  provenance: CommercialProvenance;
}

export type CapabilityAccessOutcome = 'AVAILABLE_AND_AUTHORIZED' | 'AVAILABLE_REQUIRES_GRANT' | 'AVAILABLE_REQUIRES_RUNTIME' | 'UNAVAILABLE' | 'BLOCKED_SAFETY_REVIEW';

/** Assessment only; a successful result cannot invoke an engine or an external tool. */
export interface CapabilityAccessAssessment {
  id: string;
  tenantId: string;
  capabilityId: string;
  actorId: string;
  runtimeAuthorizationId?: string;
  outcome: CapabilityAccessOutcome;
  checks: Array<{ name: 'lifecycle' | 'grant' | 'runtime' | 'safety'; passed: boolean; detail: string }>;
  reason: string;
  doesNotAuthorizeExecution: true;
  createdAt: number;
}

export interface AssessJqCapabilityAccessInput {
  runtimeAuthorizationId?: string;
}

export interface EngineSchemaReference {
  id: string;
  version: string;
  contentHash?: string;
}

/** Machine-readable ENGINE_GENOME metadata. It is not executable code or a deployment artifact. */
export interface EngineGenome {
  id: string;
  tenantId: string;
  identityId?: string;
  engineId: string;
  name: string;
  version: string;
  description: string;
  capabilityIds: string[];
  composedEngineIds: string[];
  inputSchema: EngineSchemaReference;
  outputSchema: EngineSchemaReference;
  stateModelSummary: string;
  memoryRequirements: string[];
  computeRequirements: string[];
  dataRequirements: string[];
  toolsRequired: string[];
  sensorsRequired: string[];
  actuatorsRequired: string[];
  apiRequirements: string[];
  modelDependencies: string[];
  securityPolicySummary: string;
  resourcePolicySummary: string;
  authorizationPolicySummary: string;
  latencyProfileSummary: string;
  reliabilityTarget: number;
  costModelSummary: string;
  energyModelSummary: string;
  validationRequirements: string[];
  failureModes: string[];
  observabilityRequirements: string[];
  owner: string;
  safetyClass: JqSafetyClass;
  lifecycleState: CapabilityLifecycleState;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterEngineGenomeInput {
  identityId?: string;
  engineId: string;
  name: string;
  version: string;
  description: string;
  capabilityIds: string[];
  composedEngineIds?: string[];
  inputSchema: EngineSchemaReference;
  outputSchema: EngineSchemaReference;
  stateModelSummary: string;
  memoryRequirements?: string[];
  computeRequirements?: string[];
  dataRequirements?: string[];
  toolsRequired?: string[];
  sensorsRequired?: string[];
  actuatorsRequired?: string[];
  apiRequirements?: string[];
  modelDependencies?: string[];
  securityPolicySummary: string;
  resourcePolicySummary: string;
  authorizationPolicySummary: string;
  latencyProfileSummary: string;
  reliabilityTarget: number;
  costModelSummary: string;
  energyModelSummary: string;
  validationRequirements?: string[];
  failureModes?: string[];
  observabilityRequirements?: string[];
  owner: string;
  safetyClass: JqSafetyClass;
  provenance: CommercialProvenance;
}

export interface TransitionEngineGenomeInput {
  state: CapabilityLifecycleState;
  reason: string;
  evidence?: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export type CapabilityGraphNodeType = 'CAPABILITY' | 'ENGINE';
export type CapabilityGraphEdgeType = 'DEPENDS_ON' | 'COMPOSES' | 'REQUIRES_CAPABILITY';

export interface CapabilityGraphNode {
  id: string;
  type: CapabilityGraphNodeType;
  name: string;
  lifecycleState: CapabilityLifecycleState;
  safetyClass?: JqSafetyClass;
}

export interface CapabilityGraphEdge {
  fromId: string;
  toId: string;
  type: CapabilityGraphEdgeType;
}

export interface CapabilityGraph {
  tenantId: string;
  nodes: CapabilityGraphNode[];
  edges: CapabilityGraphEdge[];
  generatedAt: number;
}

/** Per-tenant tamper-evident registry audit record. */
export interface CapabilityFabricAuditEntry {
  id: string;
  tenantId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  eventType: 'CAPABILITY_REGISTERED' | 'CAPABILITY_TRANSITIONED' | 'GRANT_ISSUED' | 'GRANT_REVOKED' | 'ACCESS_ASSESSED' | 'ENGINE_REGISTERED' | 'ENGINE_TRANSITIONED';
  subjectId: string;
  actorId: string;
  detailHash: string;
  createdAt: number;
}

export interface CapabilityFabricIntegrityResult {
  tenantId: string;
  valid: boolean;
  entries: number;
  failure?: string;
}

export const CapabilityFabricEvents = Object.freeze({
  CapabilityRegistered: 'jq.capability.registered',
  CapabilityTransitioned: 'jq.capability.transitioned',
  GrantIssued: 'jq.capability.grant.issued',
  GrantRevoked: 'jq.capability.grant.revoked',
  AccessAssessed: 'jq.capability.access.assessed',
  EngineRegistered: 'jq.engine.registered',
  EngineTransitioned: 'jq.engine.transitioned',
} as const);

export type { CommercialActor };
