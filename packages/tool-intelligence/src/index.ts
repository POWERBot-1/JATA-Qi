// Public API for @jataqi/tool-intelligence.
export { ToolIntelligenceModule } from './tool-intelligence-module.js';
export type { RegisterToolInput } from './tool-intelligence-module.js';
export { needsApproval, suitability, riskDescription } from './risk.js';
export { APPROVAL_REQUIRED_CLASSES, ToolEvents } from './types.js';
export {
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_CATALOG_BY_NAME,
  AGENT_TOOL_NAMES,
  APPROVAL_GATED_AGENT_TOOLS,
} from './catalog.js';
export type { AgentToolCatalogEntry } from './catalog.js';
export type {
  ToolEntity,
  ToolStatus,
  RiskClass,
  PrivacyClass,
  Protocol,
  ToolAdapter,
  AgentToolDescriptor,
  InvocationContext,
  InvocationResult,
  ApprovalRequest,
  ApprovalDecision,
  ToolEvaluation,
} from './types.js';
