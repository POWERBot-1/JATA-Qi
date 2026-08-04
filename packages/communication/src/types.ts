// JATA Qi Communication — types. An adapter-based messaging platform (#27).
// Real providers (SendGrid/Twilio/etc.) plug in as Channel adapters; none are
// wired by default (honest abstraction).

export type ChannelType = 'email' | 'sms' | 'push' | 'whatsapp' | 'inapp';

export interface SendResult { ok: boolean; messageId?: string; error?: string; }

/** A pluggable delivery channel adapter. */
export interface Channel {
  readonly id: string;
  readonly type: ChannelType;
  send(message: OutboundMessage): Promise<SendResult>;
}

export interface MessageTemplate {
  id: string;
  name: string;
  channel: ChannelType;
  subject?: string;
  body: string;
  variables?: string[];
}

export type MessageStatus = 'queued' | 'sent' | 'failed' | 'bounced';

export interface OutboundMessage {
  id: string;
  to: string;
  from?: string;
  channel: ChannelType;
  subject?: string;
  body: string;
  templateId?: string;
  status: MessageStatus;
  organizationId?: string;
  createdBy?: string;
  providerMessageId?: string;
  error?: string;
  createdAt: number;
  sentAt?: number;
}

export const CommunicationEvents = Object.freeze({
  MessageSent: 'comm.message.sent',
  MessageFailed: 'comm.message.failed',
} as const);
