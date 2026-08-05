// EmailModule — PRX Email Provider kernel module. Wraps the engine, emits bus
// events, and records mail milestones into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { EmailEngine, type CreateMailboxInput, type RegisterDomainInput, type SendMessageInput } from './engine.js';
import type {
  EmailDomain, EmailStats, InboundMessage, InboundStatus, Mailbox,
  OutboundMessage, MessageStatus,
} from './types.js';

export const EmailEvents = Object.freeze({
  DomainRegistered: 'email.domain.registered',
  DomainVerified: 'email.domain.verified',
  MailboxCreated: 'email.mailbox.created',
  MessageSent: 'email.message.sent',
  MessageReceived: 'email.message.received',
} as const);

export class EmailModule implements IModule {
  readonly id = 'email';
  readonly tags = ['core', 'email', 'communication'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new EmailEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('email', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('email module initialized (PRX Email Provider)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerDomain(input: RegisterDomainInput): EmailDomain {
    const domain = this.engine.registerDomain(input);
    void this.api.bus.emit(EmailEvents.DomainRegistered, { id: domain.id, domain: domain.domain });
    return domain;
  }
  getDomain(id: string): EmailDomain | undefined { return this.engine.getDomain(id); }
  getDomainByName(name: string): EmailDomain | undefined { return this.engine.getDomainByName(name); }
  listDomains(verifiedOnly?: boolean): EmailDomain[] { return this.engine.listDomains(verifiedOnly); }
  verifyDomain(id: string): EmailDomain | undefined {
    const domain = this.engine.verifyDomain(id);
    if (domain) void this.api.bus.emit(EmailEvents.DomainVerified, { id: domain.id, domain: domain.domain });
    return domain;
  }
  dnsRecords(domainId: string): Array<{ type: string; name: string; value: string }> {
    return this.engine.dnsRecords(domainId);
  }

  createMailbox(input: CreateMailboxInput): Mailbox {
    const mailbox = this.engine.createMailbox(input);
    void this.api.bus.emit(EmailEvents.MailboxCreated, { id: mailbox.id, address: mailbox.address });
    return mailbox;
  }
  getMailbox(id: string): Mailbox | undefined { return this.engine.getMailbox(id); }
  getMailboxByAddress(address: string): Mailbox | undefined { return this.engine.getMailboxByAddress(address); }
  listMailboxes(domainId?: string): Mailbox[] { return this.engine.listMailboxes(domainId); }

  async send(input: SendMessageInput): Promise<OutboundMessage> {
    const message = this.engine.send(input);
    void this.api.bus.emit(EmailEvents.MessageSent, { id: message.id, to: message.to.length, dkimSigned: message.dkimSigned });
    await this.recordMemory('email_outbound', `sent "${message.subject}" to ${message.to.length} recipient(s)`, {
      messageId: message.id, to: message.to, dkimSigned: message.dkimSigned,
    });
    return message;
  }
  listMessages(status?: MessageStatus): OutboundMessage[] { return this.engine.listMessages(status); }

  async receive(input: { to: string; from: string; subject: string; body: string }): Promise<InboundMessage> {
    const message = this.engine.receive(input);
    void this.api.bus.emit(EmailEvents.MessageReceived, { id: message.id, mailboxId: message.mailboxId, status: message.status });
    await this.recordMemory('email_inbound', `received "${message.subject}" from ${message.from} [${message.status}]`, {
      messageId: message.id, mailboxId: message.mailboxId, status: message.status,
    });
    return message;
  }
  listInbound(mailboxId?: string, status?: InboundStatus): InboundMessage[] {
    return this.engine.listInbound(mailboxId, status);
  }
  setInboundStatus(id: string, status: InboundStatus): InboundMessage | undefined {
    return this.engine.setInboundStatus(id, status);
  }

  dkimSignature(messageId: string, selector: string): string {
    return this.engine.dkimSignature(messageId, selector);
  }

  stats(): EmailStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['email', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
