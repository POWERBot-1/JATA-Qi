// Compliance engine — pre-registration eligibility checks a registrar must pass
// before committing a create/transfer: availability, reserved names, trademark
// claims (TMCH), registrant KYC, and abuse/sanctions screening.

import type { ComplianceResult, DomainInfo, Registrant } from './types.js';

export interface ComplianceOptions {
  /** Require verified KYC before any registration. */
  requireKyc: boolean;
  /** Blocked registrant ids / emails (abuse, fraud, sanctions). */
  blockedRegistrants: Set<string>;
  /** SLDs with active trademark claims. */
  trademarkClaims: Set<string>;
}

/**
 * Evaluate whether a registration may proceed given the registry availability
 * result, the registrant's KYC status, and the abuse/claims policy.
 */
export function evaluateCompliance(
  check: DomainInfo,
  registrant: Registrant | undefined,
  opts: ComplianceOptions,
): ComplianceResult {
  const reasons: string[] = [];
  let claimsNoticeRequired = false;

  if (!check.available) {
    reasons.push(check.reason ? `unavailable: ${check.reason}` : 'unavailable');
  }
  if (check.reason === 'reserved') reasons.push('reserved name');
  if (opts.requireKyc) {
    if (!registrant) reasons.push('registrant required');
    else if (registrant.kyc !== 'verified') reasons.push(`kyc not verified (${registrant.kyc})`);
  }
  if (registrant && (opts.blockedRegistrants.has(registrant.id) || opts.blockedRegistrants.has(registrant.email))) {
    reasons.push('registrant blocked (abuse/sanctions)');
  }
  const sld = sldOf(check.name);
  if (opts.trademarkClaims.has(sld)) {
    claimsNoticeRequired = true;
  }

  return { ok: reasons.length === 0, reasons, claimsNoticeRequired };
}

function sldOf(name: string): string {
  const n = name.replace(/\.+$/, '').toLowerCase();
  const dot = n.indexOf('.');
  return dot < 0 ? n : n.slice(0, dot);
}
