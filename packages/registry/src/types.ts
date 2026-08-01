// JATA Qi Registry — type definitions.
//
// Part A of the Autonomous Internet Infrastructure Platform. The Registry is
// the authoritative database for a TLD: it holds the domain, contact and host
// objects, enforces the domain lifecycle (RFC 5731 statuses + ICANN grace
// periods), manages DNSSEC delegation, and is the authoritative RDAP/WHOIS and
// EPP source for the zone.

/** Domain lifecycle phases (ICANN grace-period model). */
export type DomainPhase =
  | 'available' // not registered
  | 'active' // registered, delegatable
  | 'auto-renew-grace' // ARG: expired, auto-renew pending
  | 'redemption-grace' // RGP: redemptionPeriod
  | 'pending-restore' // restore requested, awaiting review
  | 'pending-delete' // pendingDelete, about to be released
  | 'released' // dropped back to the pool
  | 'transfer-pending' // a transfer is in progress (overlay status)
  | 'pending-create'; // create accepted, not yet committed

/** Transfer request state (RFC 5731 transfer). */
export type TransferState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'timeout';

/** Domain status values (RFC 5731 §2.3). */
export type DomainStatus =
  | 'ok' | 'inactive'
  | 'clientDeleteProhibited' | 'serverDeleteProhibited'
  | 'clientHold' | 'serverHold'
  | 'clientRenewProhibited' | 'serverRenewProhibited'
  | 'clientTransferProhibited' | 'serverTransferProhibited'
  | 'clientUpdateProhibited' | 'serverUpdateProhibited'
  | 'pendingCreate' | 'pendingDelete' | 'pendingRenew' | 'pendingTransfer' | 'pendingUpdate';

/** A registered domain object (registry-of-record). */
export interface DomainObject {
  /** Fully-qualified, lowercased, with trailing dot. */
  name: string;
  /** The TLD this domain belongs to (e.g. '.jq'). */
  tld: string;
  /** Owning registrar id. */
  registrarId: string;
  /** Registrant contact id. */
  registrant: string;
  /** Associated contacts: { type: contactId }. */
  contacts: { type: string; id: string }[];
  /** Authoritative nameserver host names. */
  nameservers: string[];
  /** Authorization info (hashed) for transfers. */
  authInfoHash: string;
  /** Status set. */
  statuses: Set<DomainStatus>;
  /** Computed lifecycle phase. */
  phase: DomainPhase;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms — registration expiry. */
  expiresAt: number;
  /** Last updated. */
  updatedAt: number;
  /** Delegated DNSSEC DS records (RFC 4034). */
  dsRecords: DsRecord[];
  /** Creation registrar (set on first create; differs from registrarId after transfer). */
  creatingRegistrarId: string;
  /** RGP restore-request timestamp, if any. */
  restoreRequestedAt?: number;
  /** Transfer history. */
  transfers: TransferRecord[];
  /** Trademark-notice acknowledged (for sunrise/claims). */
  claimsNoticeId?: string;
}

/** DS record (delegation signer) stored at the registry. */
export interface DsRecord {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

/** A transfer request/decision record. */
export interface TransferRecord {
  id: string;
  domain: string;
  fromRegistrar: string;
  toRegistrar: string;
  state: TransferState;
  requestedAt: number;
  /** Auto-approve deadline (epoch ms). */
  autoApproveAt: number;
  decidedAt?: number;
  authInfoHash: string;
}

/** A contact object (registrant/admin/tech/billing). */
export interface ContactObject {
  id: string;
  registrarId: string;
  type: string; // registrant | admin | tech | billing
  name?: string;
  email?: string;
  voice?: string;
  fax?: string;
  /** Postal address (disclosure-governed under GDPR). */
  street?: string[];
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  // Redacted public representation (WHOIS/RDAP privacy).
  disclose?: string[];
  createdAt: number;
  updatedAt: number;
}

/** A host (nameserver) object. */
export interface HostObject {
  name: string; // FQDN
  registrarId: string;
  addresses: string[]; // IPv4/IPv6
  createdAt: number;
  updatedAt: number;
  statuses: Set<string>;
}

/** Premium-domain pricing rule. */
export interface PremiumRule {
  /** Glob pattern for the SLD, e.g. 'short' or '*gold*'. */
  pattern: string;
  /** Multiplier over the base price, or an absolute price. */
  kind: 'multiplier' | 'fixed';
  value: number;
}

/** Catalog policy: reserved names, sunrise, trademark claims. */
export interface CatalogPolicy {
  /** Reserved SLDs that can never be registered (ICANN reserved + RFC 9225). */
  reserved: Set<string>;
  /** Two-letter country codes, IDN, etc. reserved at the TLD level. */
  reservedPatterns: string[];
  /** Premium pricing rules. */
  premium: PremiumRule[];
  /** Base prices. */
  basePriceCreate: number;
  basePriceRenew: number;
  basePriceRestore: number;
  currency: string;
  /** Sunrise active (trademark holders get priority). */
  sunriseActive: boolean;
  /** Trademark claims (TMCH) notice period in days. */
  claimsNoticeDays: number;
  /** Maximum registration term in years. */
  maxTermYears: number;
}

/** A registry escrow deposit (RFC 8909 data escrow). */
export interface EscrowDeposit {
  id: number;
  watermark: string; // ISO timestamp of the deposit point-in-time
  tld: string;
  registrarCount: number;
  domainCount: number;
  hostCount: number;
  contactCount: number;
  /** Canonical serialized contents (JSON of the snapshot). */
  contents: string;
  /** SHA-256 of the contents. */
  contentsHash: string;
  /** Ed25519 signature over contentsHash (registry governance key). */
  signature: string;
  signedBy: string;
  createdAt: number;
}

/** Lifecycle transition result. */
export interface LifecycleResult {
  domain: DomainObject;
  /** Human-readable event for the audit log. */
  event: string;
}

/** A registrar account known to the registry (EPP login subject). */
export interface RegistrarAccount {
  id: string;
  name: string;
  /** Password hash for EPP login. */
  passwordHash: string;
  /** Accreditation grant id (Part L) authorizing this registrar. */
  accreditationGrantId?: string;
  active: boolean;
}
