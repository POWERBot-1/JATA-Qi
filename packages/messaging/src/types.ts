// Provider-agnostic messaging types.

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
}

export interface SmsMessage {
  to: string;
  from?: string;
  body: string;
}

export interface DeliveryResult {
  messageId?: string;
  status: 'sent' | 'queued' | 'failed';
  providerId: string;
  cost?: number;
  error?: string;
}

export interface EmailProvider {
  readonly id: string;
  send(message: EmailMessage): Promise<DeliveryResult>;
}

export interface SmsProvider {
  readonly id: string;
  send(message: SmsMessage): Promise<DeliveryResult>;
}

export class MessagingError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'MessagingError';
    this.statusCode = statusCode;
  }
}
