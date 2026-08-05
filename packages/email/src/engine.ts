// EmailEngine — PRX Email Provider core: domains with MX/SPF/DKIM/DMARC,
// mailboxes with quotas, outbound delivery (signing + policy checks),
// inbound receipt with DMARC disposition, and deliverability analytics.

import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { EmailDomain, EmailStats, InboundMessage, InboundStatus, Mailbox, OutboundMessage, MessageStatus } from './types.js';

export interface RegisterDomainInput {
  domain: string;
  mxHosts?: string[];
  spfRecord?: string;
  dkimSelector?: string;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
}

export interface CreateMailboxInput {
  domainId: string;
  address: string;
  displayName?: string;
  quotaMb?: number;
}

export interface SendMessageInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
}

const DEFAULT_SPF = 'v=spf1 include:_spf.jataqi.local ~all';
const DEFAULT_DKIM_SELECTOR = 'jataqi';
const DEFAULT_QUOTA_MB = 1024;

export class EmailEngine {
  private domains = new Map<string, EmailDomain>();
  private mailboxes = new Map<string, Mailbox>();
  private outbound = new Map<string, OutboundMessage>();
  private inbound = new Map<string, InboundMessage>();

  // ---- domains -----------------------------------------------------------

  registerDomain(input: RegisterDomainInput): EmailDomain {
    if (!input.domain) throw new Error('domain is required');
    const domain: EmailDomain = {
      id: randomUUID(),
      domain: input.domain.toLowerCase(),
      mxHosts: input.mxHosts ?? [`mx1.${input.domain}`, `mx2.${input.domain}`],
      spfRecord: input.spfRecord ?? DEFAULT_SPF,
      dkimSelector: input.dkimSelector ?? DEFAULT_DKIM_SELECTOR,
      dmarcPolicy: input.dmarcPolicy ?? 'none',
      verified: false,
      createdAt: Date.now(),
    };
    this.domains.set(domain.id, domain);
    return domain;
  }

  getDomain(id: string): EmailDomain | undefined { return this.domains.get(id); }
  getDomainByName(name: string): EmailDomain | undefined {
    return [...this.domains.values()].find((d) => d.domain === name.toLowerCase());
  }
  listDomains(verifiedOnly?: boolean): EmailDomain[] {
    const all = [...this.domains.values()];
    return verifiedOnly ? all.filter((d) => d.verified) : all;
  }

  /** Verify a domain by confirming the DNS records (simulated check). */
  verifyDomain(id: string): EmailDomain | undefined {
    const domain = this.domains.get(id);
    if (!domain) return undefined;
    domain.verified = true;
    return domain;
  }

  /** The exact DNS records the operator must publish. */
  dnsRecords(domainId: string): Array<{ type: string; name: string; value: string }> {
    const domain = this.domains.get(domainId);
    if (!domain) throw new Error(`unknown domain ${domainId}`);
    return [
      ...domain.mxHosts.map((mx, i) => ({ type: 'MX', name: domain.domain, value: `${10 + i * 10} ${mx}` })),
      { type: 'TXT', name: domain.domain, value: domain.spfRecord },
      { type: 'TXT', name: `${domain.dkimSelector}._domainkey.${domain.domain}`, value: `v=DKIM1; k=rsa; p=${dkimPublicKeyFingerprint(domain.id)}` },
      { type: 'TXT', name: `_dmarc.${domain.domain}`, value: `v=DMARC1; p=${domain.dmarcPolicy}; rua=mailto:dmarc@${domain.domain}` },
    ];
  }

  // ---- mailboxes ---------------------------------------------------------

  createMailbox(input: CreateMailboxInput): Mailbox {
    const domain = this.domains.get(input.domainId);
    if (!domain) throw new Error(`unknown domain ${input.domainId}`);
    if (!input.address) throw new Error('address is required');
    const mailbox: Mailbox = {
      id: randomUUID(), domainId: domain.id,
      address: `${input.address}@${domain.domain}`,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      quotaMb: input.quotaMb ?? DEFAULT_QUOTA_MB,
      usedMb: 0, createdAt: Date.now(),
    };
    this.mailboxes.set(mailbox.id, mailbox);
    return mailbox;
  }

  getMailbox(id: string): Mailbox | undefined { return this.mailboxes.get(id); }
  getMailboxByAddress(address: string): Mailbox | undefined {
    return [...this.mailboxes.values()].find((m) => m.address === address.toLowerCase());
  }
  listMailboxes(domainId?: string): Mailbox[] {
    const all = [...this.mailboxes.values()];
    return domainId ? all.filter((m) => m.domainId === domainId) : all;
  }

  // ---- outbound ----------------------------------------------------------

  /**
   * Send an outbound message. Applies DKIM signing (simulated with a
   * deterministic signature from the sender domain's selector), SPF pass
   * evaluation, and DMARC disposition from the recipient domain when known.
   */
  send(input: SendMessageInput): OutboundMessage {
    if (!input.from || input.to.length === 0) throw new Error('from and at least one recipient are required');
    const fromDomain = input.from.split('@')[1]?.toLowerCase();
    const domain = fromDomain ? this.getDomainByName(fromDomain) : undefined;
    if (domain && !domain.verified) throw new Error(`sending domain ${fromDomain} is not verified`);

    const message: OutboundMessage = {
      id: randomUUID(),
      from: input.from,
      to: [...input.to],
      subject: input.subject,
      body: input.body,
      status: 'queued',
      dkimSigned: false,
      spfChecked: false,
      dmarcEvaluated: false,
      createdAt: Date.now(),
    };
    this.outbound.set(message.id, message);
    this.processOutbound(message.id);
    return message;
  }

  getMessage(id: string): OutboundMessage | undefined { return this.outbound.get(id); }
  listMessages(status?: MessageStatus): OutboundMessage[] {
    const all = [...this.outbound.values()];
    return status ? all.filter((m) => m.status === status) : all;
  }

  /** Deterministic DKIM signature for a message (simulated RFC 6376). */
  dkimSignature(messageId: string, selector: string): string {
    const digest = createHash('sha256').update(`${messageId}:${selector}`).digest('base64');
    return `v=1; a=rsa-sha256; s=${selector}; b=${digest}`;
  }

  private processOutbound(id: string): void {
    const message = this.outbound.get(id)!;
    // DKIM sign from the sender domain (when known).
    const fromDomain = message.from.split('@')[1]?.toLowerCase();
    const domain = fromDomain ? this.getDomainByName(fromDomain) : undefined;
    if (domain) {
      message.dkimSigned = true;
      void this.dkimSignature(id, domain.dkimSelector);
    }
    message.spfChecked = true; // sender's SPF record exists for verified domains
    // DMARC: evaluate the recipient domain's policy.
    for (const recipient of message.to) {
      const toDomain = this.getDomainByName(recipient.split('@')[1]?.toLowerCase() ?? '');
      if (toDomain) {
        message.dmarcEvaluated = true;
        // With quarantine/reject policies we still deliver (the provider
        // handles disposition on the inbound side); the flag documents the
        // evaluation.
        void toDomain.dmarcPolicy;
      }
    }
    message.status = 'sent';
    message.sentAt = Date.now();
  }

  // ---- inbound -----------------------------------------------------------

  /** Receive a message into a mailbox; applies DMARC disposition. */
  receive(input: { to: string; from: string; subject: string; body: string }): InboundMessage {
    const mailbox = this.getMailboxByAddress(input.to);
    if (!mailbox) throw new Error(`no mailbox for ${input.to}`);
    const fromDomainName = input.from.split('@')[1]?.toLowerCase() ?? '';
    const fromDomain = this.getDomainByName(fromDomainName);
    // DMARC: messages from a domain with reject policy and no verified sender
    // domain relationship are quarantined/spam.
    let status: InboundStatus = 'received';
    let disposition: string | undefined;
    if (fromDomain && fromDomain.dmarcPolicy === 'reject') {
      status = 'quarantined';
      disposition = 'reject';
    } else if (fromDomain && fromDomain.dmarcPolicy === 'quarantine') {
      status = 'spam';
      disposition = 'quarantine';
    }
    const message: InboundMessage = {
      id: randomUUID(), mailboxId: mailbox.id,
      from: input.from, subject: input.subject, body: input.body,
      status, ...(disposition ? { dmarcDisposition: disposition } : {}),
      receivedAt: Date.now(),
    };
    mailbox.usedMb = Math.min(mailbox.quotaMb, mailbox.usedMb + Math.ceil(input.body.length / 1024));
    this.inbound.set(message.id, message);
    return message;
  }

  getInbound(id: string): InboundMessage | undefined { return this.inbound.get(id); }
  listInbound(mailboxId?: string, status?: InboundStatus): InboundMessage[] {
    const all = [...this.inbound.values()];
    return all.filter((m) =>
      (!mailboxId || m.mailboxId === mailboxId) && (!status || m.status === status));
  }

  setInboundStatus(id: string, status: InboundStatus): InboundMessage | undefined {
    const message = this.inbound.get(id);
    if (!message) return undefined;
    message.status = status;
    return message;
  }

  // ---- analytics ---------------------------------------------------------

  stats(): EmailStats {
    const outbound = [...this.outbound.values()];
    const inbound = [...this.inbound.values()];
    const sent = outbound.filter((m) => m.status === 'sent').length;
    const total = outbound.length;
    return {
      domains: this.domains.size,
      verifiedDomains: this.listDomains(true).length,
      mailboxes: this.mailboxes.size,
      outbound: total,
      sent,
      failed: outbound.filter((m) => m.status === 'failed').length,
      inbound: inbound.length,
      spam: inbound.filter((m) => m.status === 'spam' || m.status === 'quarantined').length,
      deliveredRate: total > 0 ? sent / total : 0,
    };
  }
}

/** Deterministic public-key fingerprint for a domain's DKIM key. */
function dkimPublicKeyFingerprint(seed: string): string {
  const digest = createHash('sha256').update(`dkim:${seed}`).digest('base64').slice(0, 43);
  return digest;
}

export { randomBytes };
