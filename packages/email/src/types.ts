// JATA Qi PRX Email Provider types.

export interface EmailDomain {
  id: string;
  domain: string;
  /** MX host records (RFC 5321). */
  mxHosts: string[];
  /** SPF record (RFC 7208). */
  spfRecord: string;
  /** DKIM selector (RFC 6376). */
  dkimSelector: string;
  /** DMARC policy (RFC 7489): none / quarantine / reject. */
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  verified: boolean;
  createdAt: number;
}

export interface Mailbox {
  id: string;
  domainId: string;
  address: string;
  displayName?: string;
  quotaMb: number;
  usedMb: number;
  createdAt: number;
}

export type MessageStatus = 'queued' | 'signed' | 'sent' | 'failed';

export interface OutboundMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  status: MessageStatus;
  /** Whether DKIM was applied. */
  dkimSigned: boolean;
  /** Whether the sending domain's SPF was checked. */
  spfChecked: boolean;
  /** Whether the recipient domain's DMARC was evaluated. */
  dmarcEvaluated: boolean;
  createdAt: number;
  sentAt?: number;
  error?: string;
}

export type InboundStatus = 'received' | 'spam' | 'quarantined' | 'read' | 'archived';

export interface InboundMessage {
  id: string;
  mailboxId: string;
  from: string;
  subject: string;
  body: string;
  status: InboundStatus;
  /** DMARC disposition applied on receipt. */
  dmarcDisposition?: string;
  receivedAt: number;
}

export interface EmailStats {
  domains: number;
  verifiedDomains: number;
  mailboxes: number;
  outbound: number;
  sent: number;
  failed: number;
  inbound: number;
  spam: number;
  deliveredRate: number;
}
