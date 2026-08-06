// @jataqi/dlp — Data Loss Prevention. Public API.

export { DlpModule, DlpEngine, shannonEntropy, DEFAULT_DLP_RULES, DlpEvents } from './dlp-module.js';
export type { DlpScanResultLike } from './dlp-module.js';
export type {
  SensitiveDataType, DlpAction, DlpChannel, DlpRule, DlpScanResult, DlpIncident, DlpPolicyStats,
} from './types.js';
