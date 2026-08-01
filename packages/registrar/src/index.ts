// @jataqi/registrar — Domain Registrar Platform (PRX Part B). Public API.

export { RegistrarModule, RegistrarEvents } from './registrar-module.js';
export type { RegistrarRecord } from './registrar-module.js';
export { Registrar } from './registrar.js';
export type { RegistrarOptions } from './registrar.js';
export { DirectRegistryConnection, EppRegistryConnection } from './connection.js';
export { IdentityStore } from './identity.js';
export { evaluateCompliance } from './compliance.js';
export type { ComplianceOptions } from './compliance.js';
export { createPrice, renewPrice, restorePrice, applyPromo, termTotal } from './pricing.js';
export type { PriceBook } from './pricing.js';
export type {
  KycStatus, Registrant, DomainOrder, BulkJob, PromoCode, ComplianceResult,
  DomainInfo, RegistryConnection,
} from './types.js';
