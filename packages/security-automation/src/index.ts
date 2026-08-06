// @jataqi/security-automation — cross-pillar security automation. Public API.

export { SecurityAutomationModule, SecurityAutomationEvents, CORRELATION_EVENTS, DEFAULT_CORRELATION_RULES } from './security-automation-module.js';
export { CorrelationEngine, mapSeverity, interpolate } from './correlation.js';
export type { CorrelationRule, CorrelatedIncident, CorrelationSink, IncidentSeverityLevel } from './correlation.js';
export { HuntScheduler } from './hunts.js';
export type { HuntScheduleConfig, HuntSweepResult } from './hunts.js';
export { ComplianceReportBuilder } from './compliance.js';
export type { ComplianceFamilyReport, ComplianceReportResult, ComplianceInputs } from './compliance.js';
