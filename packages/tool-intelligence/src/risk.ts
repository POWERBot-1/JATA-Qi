// Risk classification helpers (tool directive #18). Determines when a tool
// invocation must be gated behind human approval.

import { APPROVAL_REQUIRED_CLASSES } from './types.js';
import type { RiskClass, ToolEntity } from './types.js';

/** True if a tool's risk class requires human approval before invocation. */
export function needsApproval(tool: ToolEntity): boolean {
  return APPROVAL_REQUIRED_CLASSES.has(tool.riskClass);
}

/** Rank a tool's suitability for a capability (higher is better). */
export function suitability(tool: ToolEntity): number {
  if (tool.status !== 'ACTIVE' && tool.status !== 'CONNECTED' && tool.status !== 'VERIFIED') {
    return -1;
  }
  const evalScore = tool.evaluationScore ?? 50;
  const reliability = tool.reliabilityScore ?? 50;
  return evalScore * 0.6 + reliability * 0.4;
}

/** Human-readable description of a risk class. */
export function riskDescription(risk: RiskClass): string {
  switch (risk) {
    case 'R0': return 'read-only information';
    case 'R1': return 'low-risk generation';
    case 'R2': return 'reversible external action';
    case 'R3': return 'sensitive data operation';
    case 'R4': return 'financial/infrastructure/security action';
    case 'R5': return 'potentially irreversible high-impact action';
    default: return 'unknown';
  }
}
