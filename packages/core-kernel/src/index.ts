// Public API for @jataqi/core-kernel
export { Kernel } from './kernel.js';
export type { KernelOptions } from './kernel.js';
export { EventBus } from './event-bus.js';
export type { EnvelopedHandler } from './event-bus.js';
export { CANONICAL_HASH_VERSION, canonicalJson, sha256Hex, canonicalHash } from './canonical.js';
export {
  EVENT_ENVELOPE_VERSION,
  SYSTEM_TENANT,
  isEventEnvelope,
  isCommercialEventLike,
  toEnvelopeFromCommercial,
  wrapPlainEnvelope,
  toEnvelopedDelivery,
  emitPlainEnveloped,
  extractPayload,
  envelopeHashCore,
  hashEnvelopeV1,
  sealEnvelopeChain,
  verifyEnvelopeChain,
  F01_NOMINATED_SUBSCRIPTIONS,
  isNominatedSubscription,
  auditSubscriptionCoverage,
  payloadOf,
} from './event-envelope.js';
export type {
  EventEnvelope,
  EnvelopedEmitter,
  EmitPlainEnvelopedOptions,
  NominatedSubscription,
  CommercialEventLike,
  EnvelopePrivacyClassification,
  EnvelopeProvenance,
  WrapPlainEnvelopeOptions,
} from './event-envelope.js';
export { Container } from './container.js';
export { Logger } from './logger.js';
export type { LogEntry, LogLevel, LogSink, LoggerOptions } from './logger.js';
export { Config, ObjectConfigSource, EnvConfigSource } from './config.js';
export type { ConfigSource } from './config.js';
export {
  JataQiError,
  ModuleNotFoundError,
  DependencyError,
  ConfigError,
} from './errors.js';
export { KernelEvents } from './types.js';
export type {
  IModule,
  KernelApi,
  ModuleId,
  ModuleState,
  KernelEventName,
} from './types.js';
