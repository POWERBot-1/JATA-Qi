// Real provider adapters: SendGrid (email), Twilio (SMS), Africa's Talking (SMS).
// All use the global fetch (Node 18+) — zero external dependencies.

import type { EmailMessage, SmsMessage, DeliveryResult, EmailProvider, SmsProvider } from './types.js';
import { MessagingError } from './types.js';

// === SendGrid ================================================================

export interface SendGridConfig {
  apiKey: string;
  apiBase?: string;
  timeoutMs?: number;
}

export class SendGridProvider implements EmailProvider {
  readonly id = 'sendgrid';
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: SendGridConfig) {
    this.base = cfg.apiBase ?? 'https://api.sendgrid.com';
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }
  async send(msg: EmailMessage): Promise<DeliveryResult> {
    const body = JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: msg.from },
      subject: msg.subject,
      ...(msg.html ? { content: [{ type: 'text/html', value: msg.html }] } : {}),
      ...(msg.text ? { content: [{ type: 'text/plain', value: msg.text }] } : {}),
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
    });
    const res = await this.fetch(`${this.base}/v3/mail/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
      body,
    });
    if (res.status >= 400) {
      const err = await res.json().catch(() => ({ message: 'sendgrid error' })) as { message?: string; errors?: { message: string }[] };
      throw new MessagingError(err.errors?.[0]?.message ?? err.message ?? `sendgrid ${res.status}`, res.status);
    }
    return { status: res.status === 202 ? 'queued' : 'sent', providerId: this.id, messageId: res.headers.get('x-message-id') ?? undefined };
  }
  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
}

// === Twilio ==================================================================

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  apiBase?: string;
  timeoutMs?: number;
}

export class TwilioProvider implements SmsProvider {
  readonly id = 'twilio';
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: TwilioConfig) {
    this.base = cfg.apiBase ?? 'https://api.twilio.com';
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }
  async send(msg: SmsMessage): Promise<DeliveryResult> {
    const form = new URLSearchParams({ To: msg.to, From: msg.from ?? this.cfg.fromNumber, Body: msg.body }).toString();
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const res = await this.fetch(`${this.base}/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const json = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new MessagingError((json as { message?: string }).message ?? `twilio ${res.status}`, res.status);
    return { status: (json.status as string) === 'queued' ? 'queued' : 'sent', providerId: this.id, messageId: json.sid as string };
  }
  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
}

// === Africa's Talking ========================================================

export interface AfricasTalkingConfig {
  apiKey: string;
  username: string;
  senderId?: string;
  apiBase?: string;
  timeoutMs?: number;
}

export class AfricasTalkingProvider implements SmsProvider {
  readonly id = 'africas-talking';
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: AfricasTalkingConfig) {
    this.base = cfg.apiBase ?? 'https://api.africastalking.com';
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }
  async send(msg: SmsMessage): Promise<DeliveryResult> {
    const form = new URLSearchParams({
      username: this.cfg.username,
      to: msg.to,
      message: msg.body,
      ...(this.cfg.senderId || msg.from ? { from: msg.from ?? this.cfg.senderId! } : {}),
    }).toString();
    const res = await this.fetch(`${this.base}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.cfg.apiKey, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
    });
    const json = await res.json() as { SMSMessageData?: { Message?: string; Messages?: { messageId: string; status: string; cost?: string }[] } };
    if (!res.ok) throw new MessagingError(json.SMSMessageData?.Message ?? `africas-talking ${res.status}`, res.status);
    const sent = json.SMSMessageData?.Messages?.[0];
    return { status: sent?.status === 'Success' ? 'sent' : 'failed', providerId: this.id, messageId: sent?.messageId, cost: sent?.cost ? parseFloat(sent.cost.split(' ')[1] ?? '0') : undefined };
  }
  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
}
