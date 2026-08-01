// @jataqi/registry — TLD Registry Platform (PRX Part A). Public API.

export { RegistryModule, RegistryEvents } from './registry-module.js';
export type { RegistryConfig } from './registry-module.js';
export { Registry, RegistryError, hashSecret } from './registry.js';
export type { RegistryOptions } from './registry.js';
export {
  defaultPolicy, isReserved, premiumPrice, validTerm, claimsRequired, sldOf, isShort, DEFAULT_RESERVED,
} from './catalog.js';
export {
  GracePeriods, addYears, recomputePhase, refreshPhase, renew, restore, softDelete, LifecycleError,
} from './lifecycle.js';
export { buildDeposit, verifyDeposit } from './escrow.js';
export type { EscrowSigner } from './escrow.js';
export { domainToRdap, notFoundRdap } from './rdap.js';
export type { RdapDomain } from './rdap.js';
// EPP
export { EppServer } from './epp/server.js';
export type { EppServerOptions } from './epp/server.js';
export { EppClient } from './epp/client.js';
export type { EppResponse } from './epp/client.js';
export {
  encodeGreeting, encodeResponse, parseCommand, ResultCode,
  domainCheckResData, domainCreateResData, domainInfoResData,
  EPP_DOMAIN_NS, EPP_CONTACT_NS, EPP_HOST_NS, EPP_NS, XmlProtocolError,
} from './epp/codec.js';
export type { EppCommand, EppResponse as EppResponseData, GreetingOptions } from './epp/codec.js';
export { parseXml, serializeXml, el, child, children } from './epp/xml.js';
export type { XmlNode } from './epp/xml.js';
// Types
export type {
  DomainPhase, TransferState, DomainStatus, DomainObject, DsRecord, TransferRecord,
  ContactObject, HostObject, PremiumRule, CatalogPolicy, EscrowDeposit, LifecycleResult,
  RegistrarAccount,
} from './types.js';
