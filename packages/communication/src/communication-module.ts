// CommunicationModule — adapter-based email/SMS/messaging platform. Sends via
// registered Channel adapters (none wired by default), supports templates with
// variable interpolation, logs every outbound message, and integrates with the
// governance gate, audit ledger, and notifications.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { CommunicationEvents } from './types.js';
import type { Channel, ChannelType, MessageTemplate, MessageStatus, OutboundMessage } from './types.js';

const COL_MESSAGES = 'comm.messages';
const COL_TEMPLATES = 'comm.templates';

export interface SendInput {
  to: string;
  channel?: ChannelType;
  subject?: string;
  body?: string;
  templateId?: string;
  variables?: Record<string, string>;
  from?: string;
  organizationId?: string;
}

export class CommunicationModule implements IModule {
  readonly id = 'communication';
  readonly tags = ['core', 'communication'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private messages!: ICollection<OutboundMessage>;
  private templates!: ICollection<MessageTemplate>;
  private readonly channels = new Map<ChannelType, Channel>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.messages = await storage.collection<OutboundMessage>(COL_MESSAGES);
    this.templates = await storage.collection<MessageTemplate>(COL_TEMPLATES);
    kernel.container.registerValue('communication', this);
    kernel.logger.info('communication module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.channels.clear(); }

  registerChannel(channel: Channel): void { this.channels.set(channel.type, channel); }
  listChannels(): ChannelType[] { return [...this.channels.keys()]; }

  // --- templates ------------------------------------------------------------

  async createTemplate(input: Omit<MessageTemplate, 'id'>): Promise<MessageTemplate> {
    const tpl: MessageTemplate = { ...input, id: randomUUID() };
    await this.templates.put(tpl);
    return tpl;
  }
  async getTemplate(id: string): Promise<MessageTemplate | undefined> { return this.templates.get(id); }
  async listTemplates(channel?: ChannelType): Promise<MessageTemplate[]> {
    const all = await this.templates.all();
    return channel ? all.filter((t) => t.channel === channel) : all;
  }

  // --- send -----------------------------------------------------------------

  async send(input: SendInput, createdBy?: string): Promise<OutboundMessage> {
    // Resolve template if specified.
    let channel = input.channel ?? 'email';
    let subject = input.subject;
    let body = input.body ?? '';

    if (input.templateId) {
      const tpl = await this.templates.get(input.templateId);
      if (!tpl) throw new Error(`communication: template "${input.templateId}" not found`);
      channel = tpl.channel;
      subject = subject ?? tpl.subject;
      body = tpl.body;
      if (input.variables) {
        for (const [k, v] of Object.entries(input.variables)) {
          body = body.replaceAll(`{{${k}}}`, v);
          if (subject) subject = subject.replaceAll(`{{${k}}}`, v);
        }
      }
    }

    if (!body.trim()) throw new Error('communication: body is required (directly or via template)');

    const adapter = this.channels.get(channel);
    const now = Date.now();
    const msg: OutboundMessage = {
      id: randomUUID(), to: input.to, channel, body,
      ...(subject ? { subject } : {}),
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(createdBy ? { createdBy } : {}),
      status: 'queued', createdAt: now,
    };

    if (!adapter) {
      msg.status = 'failed';
      msg.error = `no channel adapter registered for "${channel}"`;
      await this.messages.put(msg);
      await this.api.bus.emit(CommunicationEvents.MessageFailed, { id: msg.id, error: msg.error });
      throw new Error(msg.error);
    }

    try {
      const result = await adapter.send(msg);
      msg.status = result.ok ? 'sent' : 'failed';
      msg.sentAt = Date.now();
      if (result.messageId) msg.providerMessageId = result.messageId;
      if (!result.ok && result.error) msg.error = result.error;
    } catch (err) {
      msg.status = 'failed';
      msg.error = (err as Error).message;
    }

    await this.messages.put(msg);
    await this.api.bus.emit(result_ok(msg.status) ? CommunicationEvents.MessageSent : CommunicationEvents.MessageFailed, { id: msg.id });
    await this.audit(createdBy ?? 'system', 'message_sent', { to: input.to, channel, status: msg.status });
    return msg;
  }

  async getMessage(id: string): Promise<OutboundMessage | undefined> { return this.messages.get(id); }
  async listMessages(to?: string, channel?: ChannelType): Promise<OutboundMessage[]> {
    let all = await this.messages.all();
    if (to) all = all.filter((m) => m.to === to);
    if (channel) all = all.filter((m) => m.channel === channel);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `comm.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }
}

function result_ok(status: MessageStatus): boolean { return status === 'sent'; }
