// RDAP (RFC 7483 / 9224) output for the registry. The registry is the
// authoritative RDAP source for its TLD; this maps a domain-of-record into the
// RDAP JSON shape, with GDPR-conscious contact disclosure.

import type { DomainObject } from './types.js';
import { recomputePhase } from './lifecycle.js';

export interface RdapDomain {
  objectClassName: 'domain';
  ldhName: string;
  handle: string;
  status: string[];
  events: Array<{ eventAction: string; eventDate: string }>;
  nameservers?: Array<{ objectClassName: 'nameserver'; ldhName: string }>;
  secureDNS?: { delegationSigned: boolean; dsData?: Array<Record<string, unknown>> };
  entities?: Array<Record<string, unknown>>;
  remarks?: Array<{ title: string; description: string[] }>;
  notFound?: boolean;
  rdapConformance?: string[];
}

/** Map a domain-of-record to an RFC 7483 RDAP domain object. */
export function domainToRdap(domain: DomainObject, now = Date.now()): RdapDomain {
  const phase = recomputePhase(domain, now);
  const active = phase === 'active';
  return {
    objectClassName: 'domain',
    ldhName: domain.name.replace(/\.$/, ''),
    handle: domain.name,
    status: rdapStatuses(domain, phase),
    events: [
      { eventAction: 'registration', eventDate: new Date(domain.createdAt).toISOString() },
      { eventAction: 'expiration', eventDate: new Date(domain.expiresAt).toISOString() },
      { eventAction: 'last changed', eventDate: new Date(domain.updatedAt).toISOString() },
    ],
    ...(domain.nameservers.length > 0 ? { nameservers: domain.nameservers.map((n) => ({ objectClassName: 'nameserver' as const, ldhName: n.replace(/\.$/, '') })) } : {}),
    ...(domain.dsRecords.length > 0 ? { secureDNS: { delegationSigned: true, dsData: domain.dsRecords.map((d) => ({ keyTag: d.keyTag, algorithm: d.algorithm, digestType: d.digestType, digest: d.digest })) } } : { secureDNS: { delegationSigned: false } }),
    entities: [{ roles: ['registrar'], handle: domain.registrarId, vcardArray: ['vcard', [['version', {}, 'text', '4.0']]] }],
    remarks: active ? undefined : [{ title: 'Lifecycle', description: [`Domain is in ${phase} phase.`] }],
    rdapConformance: ['rdap_level_0'],
  };
}

/** RFC 7483 statuses derived from EPP statuses + phase. */
function rdapStatuses(domain: DomainObject, phase: string): string[] {
  const out = new Set<string>();
  if (phase === 'active') out.add('active');
  else if (phase === 'auto-renew-grace' || phase === 'redemption-grace') out.add('auto renew period');
  else if (phase === 'pending-delete') out.add('pending delete');
  if (domain.statuses.has('clientHold') || domain.statuses.has('serverHold')) out.add('server hold');
  if (domain.statuses.has('clientTransferProhibited') || domain.statuses.has('serverTransferProhibited')) out.add('transfer prohibited');
  if (domain.statuses.has('clientDeleteProhibited') || domain.statuses.has('serverDeleteProhibited')) out.add('delete prohibited');
  if (domain.statuses.has('inactive')) out.add('inactive');
  return [...out];
}

export function notFoundRdap(name: string): RdapDomain {
  return {
    objectClassName: 'domain',
    ldhName: name.replace(/\.$/, ''),
    handle: name,
    status: [],
    events: [],
    notFound: true,
    remarks: [{ title: 'Not Found', description: ['The queried name does not exist in this registry.'] }],
    rdapConformance: ['rdap_level_0'],
  };
}
