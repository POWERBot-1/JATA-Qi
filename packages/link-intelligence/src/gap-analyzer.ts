// Gap Analyzer (Phase 4) — compares extracted intelligence against the JATA Qi
// readiness matrix to detect missing capabilities, duplicates, and inferior
// implementations. Produces a CapabilityGap list with severity + value scoring.

import { randomUUID } from 'node:crypto';
import type { CapabilityGap, Classification, IntelligenceExtract } from './types.js';

/** Known JATA Qi capability keywords (mapped from the readiness matrix). */
const PLATFORM_CAPABILITIES: Set<string> = new Set([
  'kernel', 'storage', 'vector-search', 'identity', 'security', 'rbac', 'audit',
  'api', 'api-gateway', 'tls', 'cors', 'versioning', 'observability', 'tracing',
  'metrics', 'monitoring', 'mfa', 'conversations', 'agents', 'workflows',
  'knowledge', 'knowledge-graph', 'teams', 'compute', 'simulation', 'scheduler',
  'readiness', 'provenance', 'commerce', 'marketplace', 'organizations',
  'notifications', 'policies', 'feature-flags', 'privacy', 'policy-governance',
  'finance', 'supply-chain', 'education', 'health', 'research', 'communication',
  'multimedia', 'enterprise', 'disaster-recovery', 'optimization', 'synthetic-data',
  'business-intelligence', 'web-ui', 'multimodal', 'sovereign', 'llm-gateway',
  'cli', 'sdk', 'design-system', 'memory', 'learning', 'ai-learning',
  'self-evolution', 'universal-wallet', 'accreditation', 'dns', 'registry',
  'registrar', 'game-engine', 'game-world', 'game-physics', 'game-architect',
  'game-ai', 'game-net', 'game-economy', 'game-audio', 'game-esports',
  'game-publish', 'game-liveops', 'ai-safety', 'model-registry', 'model-runtime',
]);

/** Patterns that indicate a capability the platform does NOT have. */
const GAP_INDICATORS: Array<{ patterns: RegExp[]; category: CapabilityGap['category']; label: string }> = [
  { patterns: [/oauth|oidc|openid|saml/i], category: 'missing_security', label: 'Enterprise SSO/OIDC/SAML' },
  { patterns: [/abac|rebac/i], category: 'missing_security', label: 'ABAC/ReBAC' },
  { patterns: [/graphql/i], category: 'missing_api', label: 'GraphQL Federation' },
  { patterns: [/webhook/i], category: 'missing_integration', label: 'Webhook Platform' },
  { patterns: [/mpesa|flutterwave|pesapal|airtel\s*money/i], category: 'missing_integration', label: 'African Payment Providers' },
  { patterns: [/nft|smart\s+contract|blockchain|web3|solidity/i], category: 'missing_module', label: 'Blockchain/Crypto Platform' },
  { patterns: [/data\s+lake|data\s+warehouse|etl\s+pipeline/i], category: 'missing_module', label: 'Data Lake/Warehouse' },
  { patterns: [/chaos\s+engineering|fault\s+injection/i], category: 'missing_tooling', label: 'Chaos Engineering Platform' },
  { patterns: [/lsp|language\s+server\s+protocol/i], category: 'missing_tooling', label: 'Language Server Protocol' },
  { patterns: [/service\s+mesh|istio|linkerd/i], category: 'missing_module', label: 'Service Mesh' },
];

/**
 * Analyze an extract against the platform's known capabilities to detect gaps.
 * @param existingCapabilities Optional set of capability IDs the platform has.
 */
export function analyzeGaps(
  classification: Classification,
  extract: IntelligenceExtract,
  rawContent?: string,
  existingCapabilities?: Set<string>,
): CapabilityGap[] {
  const known = existingCapabilities ?? PLATFORM_CAPABILITIES;
  const gaps: CapabilityGap[] = [];
  // Check both the structured extract AND the raw content for gap indicators.
  const checkText = (rawContent ?? '') + ' ' + JSON.stringify(extract).toLowerCase();

  // 1. Check gap indicators (explicit missing-capability patterns).
  for (const indicator of GAP_INDICATORS) {
    for (const pattern of indicator.patterns) {
      if (pattern.test(checkText)) {
        gaps.push(makeGap(indicator.category, `${indicator.label} detected in source but not in platform`, classification, extract, 'warning', 'high'));
        break;
      }
    }
  }

  // 2. Check for AI capabilities not in the platform.
  for (const wf of extract.aiWorkflows) {
    const wfLower = wf.toLowerCase();
    if (wfLower.includes('autonomous') && !known.has('autonomous-agents')) {
      gaps.push(makeGap('missing_ai', `Autonomous AI capability: ${wf}`, classification, extract, 'info', 'medium'));
    }
    if (wfLower.includes('multimodal') && !known.has('multimodal-ai')) {
      gaps.push(makeGap('missing_ai', `Multimodal AI: ${wf}`, classification, extract, 'info', 'medium'));
    }
  }

  // 3. Check for infrastructure patterns not in the platform.
  for (const infra of extract.infrastructurePatterns) {
    if (infra.includes('Multi-Region') && !known.has('multi-region')) {
      gaps.push(makeGap('missing_optimization', 'Multi-region active-active deployment', classification, extract, 'warning', 'strategic'));
    }
  }

  // 4. Check for security models the platform lacks.
  for (const sec of extract.securityModels) {
    if (sec.includes('Zero Trust') && !known.has('zero-trust')) {
      gaps.push(makeGap('missing_security', 'Zero Trust architecture', classification, extract, 'warning', 'high'));
    }
  }

  // 5. Check for deployment models the platform could adopt.
  for (const dep of extract.deploymentModels) {
    if (dep.includes('Blue-Green') && !known.has('blue-green-deploy')) {
      gaps.push(makeGap('missing_optimization', 'Blue-Green deployment strategy', classification, extract, 'info', 'medium'));
    }
  }

  return dedupe(gaps);
}

function makeGap(
  category: CapabilityGap['category'],
  description: string,
  _classification: Classification,
  extract: IntelligenceExtract,
  severity: CapabilityGap['severity'],
  value: CapabilityGap['estimatedValue'],
): CapabilityGap {
  return {
    id: randomUUID(),
    category,
    description,
    sourceRef: extract.extractedAt.toString(),
    severity,
    estimatedValue: value,
    detectedAt: Date.now(),
  };
}

function dedupe(gaps: CapabilityGap[]): CapabilityGap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const key = g.description.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
