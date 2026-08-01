// JATA Qi Registrar — type definitions.
//
// Part B of the Autonomous Internet Infrastructure Platform. A Registrar is an
// accredited entity that provisions domains through a Registry on behalf of
// registrants: search, register, renew, transfer, restore, bulk registration,
// portfolio management, pricing, billing, identity verification, compliance.

import type { Money } from '@jataqi/commerce';

/** KYC / identity-verification status for a registrant. */
export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';

/** A registrant (the domain owner) known to the registrar. */
export interface Registrant {
  id: string;
  /** Display / legal name. */
  name: string;
  email: string;
  /** Optional organization. */
  organization?: string;
  country?: string;
  kyc: KycStatus;
  /** Evidence refs (document ids, verification provider refs). */
  kycEvidence: string[];
  verifiedAt?: number;
  createdAt: number;
  updatedAt?: number;
}

/** A registration order placed by a registrant. */
export interface DomainOrder {
  id: string;
  registrantId: string;
  kind: 'create' | 'renew' | 'transfer' | 'restore';
  domain: string;
  periodYears: number;
  price: Money;
  /** Promo code applied, if any. */
  promoCode?: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  /** Commerce payment reference, if billed. */
  paymentRef?: string;
  invoiceId?: string;
  createdAt: number;
  error?: string;
}

/** A bulk-registration job (many names at once). */
export interface BulkJob {
  id: string;
  registrantId: string;
  requests: Array<{ domain: string; periodYears: number }>;
  results: Array<{ domain: string; ok: boolean; expiresAt?: number; error?: string }>;
  status: 'running' | 'completed' | 'partial';
  createdAt: number;
}

/** A promotion / discount code. */
export interface PromoCode {
  code: string;
  /** Fraction off (0..1). */
  discountPct: number;
  /** Maximum uses; 0 = unlimited. */
  maxUses: number;
  uses: number;
  validUntil: number;
  active: boolean;
}

/** Compliance check result before a registration is committed. */
export interface ComplianceResult {
  ok: boolean;
  /** Blocking reasons (empty when ok). */
  reasons: string[];
  /** Whether a trademark claims notice is required. */
  claimsNoticeRequired: boolean;
}

/** Domain info returned by the registry connection. */
export interface DomainInfo {
  name: string;
  available: boolean;
  phase?: string;
  registrarId?: string;
  expiresAt?: number;
  premium?: boolean;
  price?: Money;
  reason?: string;
}

/** Abstraction over how the registrar reaches the registry (direct or EPP). */
export interface RegistryConnection {
  check(names: string[]): Promise<DomainInfo[]>;
  create(name: string, opts: { periodYears: number; registrant?: string; authInfo?: string; nameservers?: string[] }): Promise<{ name: string; expiresAt: number }>;
  renew(name: string, periodYears: number): Promise<{ expiresAt: number }>;
  transfer(name: string, authInfo: string): Promise<{ state: string }>;
  restore(name: string): Promise<{ expiresAt: number }>;
  delete(name: string): Promise<void>;
  info(name: string): Promise<DomainInfo | undefined>;
}
