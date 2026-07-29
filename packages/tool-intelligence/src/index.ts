// Public API for @jataqi/tool-intelligence.
export { ToolIntelligenceModule } from './tool-intelligence-module.js';
export type { RegisterToolInput } from './tool-intelligence-module.js';
export { needsApproval, suitability, riskDescription } from './risk.js';
export { APPROVAL_REQUIRED_CLASSES, ToolEvents } from './types.js';
export type {
  ToolEntity,
  ToolStatus,
  RiskClass,
  PrivacyClass,
  Protocol,
  ToolAdapter,
  InvocationContext,
  InvocationResult,
  ApprovalRequest,
  ApprovalDecision,
  ToolEvaluation,
} from './types.js';
