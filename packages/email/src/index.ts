// @jataqi/email — PRX Email Provider. Public API.

export { EmailModule, EmailEvents } from './email-module.js';
export { EmailEngine } from './engine.js';
export type { RegisterDomainInput, CreateMailboxInput, SendMessageInput } from './engine.js';
export type {
  EmailDomain, Mailbox, OutboundMessage, MessageStatus, InboundMessage,
  InboundStatus, EmailStats,
} from './types.js';
