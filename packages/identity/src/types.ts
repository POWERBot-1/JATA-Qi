// Types for JATA Qi Global Identity Fabric (JQ-GIF)

export type ProvenanceState =
  | 'SELF_DECLARED'
  | 'VERIFIED_INTERNAL'
  | 'VERIFIED_EXTERNAL'
  | 'INDEPENDENTLY_CORROBORATED'
  | 'UNVERIFIED'
  | 'DISPUTED'
  | 'RETIRED';

export type ResolutionState =
  | 'CANONICAL'
  | 'ALIAS'
  | 'VERSION'
  | 'MODULE'
  | 'THIRD_PARTY_REFERENCE'
  | 'UNRELATED'
  | 'AMBIGUOUS';

export interface ProvenanceRecord {
  assertionId: string;
  assertion: string;
  state: ProvenanceState;
  timestamp: string;
  source: string;
  evidence: string;
  version: string;
  hash: string;
  signature?: string;
  actor: string;
}

export interface GlobalIdentityRecord {
  entityType: string;
  canonicalName: string;
  canonicalIdentifier: string;
  creator: string;
  origin: string;
  description: string;
  identityVersion: string;
  recordVersion: string;
  identityStatus: string;
  canonicalIdentityNamespace: string;
  capabilityManifest: string[];
  architectureManifest: string[];
  softwareRepositories: string[];
  documentationEndpoints: string[];
  releaseRecords: string[];
  verificationRecords: string[];
  cryptographicProofs: string[];
  externalReferences: string[];
  directoryRecords: string[];
  provenance: {
    creatorAssertion: boolean;
    sourceProvenance: boolean;
    releaseProvenance: boolean;
    tamperEvidentRecord: boolean;
  };
  discovery: {
    selfDescription: boolean;
    machineReadable: boolean;
    directoryReady: boolean;
    searchEngineReady: boolean;
    knowledgeGraphReady: boolean;
    apiDiscoveryReady: boolean;
  };
}

export interface IdentityGraphNode {
  id: string;
  type: string;
  label: string;
  attributes: Record<string, unknown>;
}

export interface IdentityGraphEdge {
  source: string;
  target: string;
  relation: string;
}

export interface IdentityCard {
  canonicalName: string;
  canonicalId: string;
  entityType: string;
  creator: string;
  origin: string;
  identityRoot: string;
  status: string;
  architecture: string;
  primaryDomains: string[];
  currentVersion: string;
}
