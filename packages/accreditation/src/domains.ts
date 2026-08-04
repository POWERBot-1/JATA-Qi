// The catalog of accreditation domains — the public-trust and delegated
// Internet authority classes the platform may operate as, per the PRX
// objective. Each is marked with whether external accreditation is required
// before public operation, the bodies that accredit it, and the control
// frameworks it must satisfy (Part J).

import type { AccreditationDomain } from './types.js';

export const ACCREDITATION_DOMAINS: readonly AccreditationDomain[] = [
  {
    id: 'tld-registry',
    name: 'Top-Level Domain Registry',
    description:
      'Operates a top-level domain registry: domain lifecycle, EPP, WHOIS/RDAP, DNSSEC, escrow, sunrise, claims, transfers, renewals, redemption, deletion, disputes, reporting.',
    requiresAccreditation: true,
    accreditationBodies: ['ICANN', 'IANA'],
    controlFrameworks: [
      'ICANN-Registry-Agreement',
      'RFC-9224-RDAP',
      'RFC-5730-EPP',
      'ICANN-Registry-Data-Escrow',
      'DNSSEC-Operational-Practices',
      'SOC2',
      'ISO-27001',
    ],
  },
  {
    id: 'registrar',
    name: 'Domain Name Registrar',
    description:
      'Accepts domain registrations, renewals, transfers, restores on behalf of registrants; bulk registration, portfolio, brokerage, auctions, pricing, billing, identity verification, compliance.',
    requiresAccreditation: true,
    accreditationBodies: ['ICANN', 'Regional-Registries'],
    controlFrameworks: [
      'ICANN-Registrar-Accreditation-Agreement',
      '2013-Raar',
      'ICANN-Consensus-Policies',
      'GDPR',
      'PCI-DSS',
      'SOC2',
    ],
  },
  {
    id: 'dns-operator',
    name: 'DNS Operator',
    description:
      'Operates authoritative and recursive DNS infrastructure for zones under management. Operational authority; public delegation is governed by dns-authority.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['DNSSEC-Operational-Practices', 'ISO-27001', 'SOC2'],
  },
  {
    id: 'dns-authority',
    name: 'Global Anycast DNS Authority',
    description:
      'Holds IANA-delegated authority over a zone (e.g. a TLD) on the global root. Anycast network, zone signing with KSK in the root, failover. Requires root/delegation from IANA/parent.',
    requiresAccreditation: true,
    accreditationBodies: ['IANA', 'ICANN'],
    controlFrameworks: [
      'IANA-Root-Zone-Management',
      'DNSSEC-KSK-Operational-Practices',
      'KSK-Rollover-Practices',
      'ISO-27001',
    ],
  },
  {
    id: 'rir-member',
    name: 'Regional Internet Registry Resource Holder',
    description:
      'Holds autonomous system numbers (ASN) and IP allocations from a Regional Internet Registry (AFRINIC/APNIC/ARIN/RIPE/LACNIC) for anycast and infrastructure announcement.',
    requiresAccreditation: true,
    accreditationBodies: ['AFRINIC', 'APNIC', 'ARIN', 'RIPE-NCC', 'LACNIC'],
    controlFrameworks: ['RIR-Membership-Agreement', 'ISO-27001'],
  },
  {
    id: 'ca-root',
    name: 'Public Certificate Authority (root)',
    description:
      'Operates an offline root hierarchy that participates in a public root program. Offline root key, intermediate issuance, CT logging, WebTrust audit. Requires root-store inclusion.',
    requiresAccreditation: true,
    accreditationBodies: ['CA-Browser-Forum', 'Microsoft', 'Apple', 'Mozilla', 'Google'],
    controlFrameworks: [
      'CA-Browser-Forum-Baseline-Requirements',
      'WebTrust-for-CAs',
      'RFC-6962-Certificate-Transparency',
      'ISO-27001',
    ],
  },
  {
    id: 'ca-intermediate',
    name: 'Public Certificate Authority (intermediate)',
    description:
      'Issues publicly trusted end-entity certificates under a root. Constrained by BR, audited, CT-logged. Requires an active public-trust chain.',
    requiresAccreditation: true,
    accreditationBodies: ['CA-Browser-Forum'],
    controlFrameworks: [
      'CA-Browser-Forum-Baseline-Requirements',
      'WebTrust-for-CAs',
      'RFC-8555-ACME',
      'RFC-6962-Certificate-Transparency',
      'GDPR',
      'SOC2',
    ],
  },
  {
    id: 'ra',
    name: 'Registration Authority',
    description:
      'Validates domain control and applicant identity for certificate issuance, per CA/B Forum BR. Operates in support of a CA.',
    requiresAccreditation: true,
    accreditationBodies: ['CA-Browser-Forum'],
    controlFrameworks: ['CA-Browser-Forum-Baseline-Requirements', 'WebTrust-for-CAs'],
  },
  {
    id: 'cloud',
    name: 'Cloud Infrastructure Provider',
    description:
      'Provisions virtual machines, containers, Kubernetes, object/block/network storage, GPU scheduling, autoscaling, snapshots, backups, firewalls, load balancers, multi-region.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['ISO-27001', 'ISO-27017', 'ISO-27018', 'SOC2', 'GDPR', 'PCI-DSS'],
  },
  {
    id: 'vps',
    name: 'VPS Provider',
    description: 'Virtual private server provisioning, billing, and management.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['ISO-27001', 'SOC2', 'PCI-DSS'],
  },
  {
    id: 'hosting',
    name: 'Hosting Provider',
    description:
      'Shared/VPS/dedicated/managed hosting, WordPress, container, static, serverless, database, email hosting, SSL/DNS automation, backup, CDN integration.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['ISO-27001', 'ISO-27018', 'SOC2', 'GDPR'],
  },
  {
    id: 'email-provider',
    name: 'Email Provider',
    description:
      'Operates email hosting and delivery (MX, SPF, DKIM, DMARC). Not a regulated authority, but subject to deliverability and anti-abuse frameworks.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['RFC-7208-SPF', 'RFC-6376-DKIM', 'RFC-7489-DMARC', 'ISO-27001'],
  },
  {
    id: 'idp',
    name: 'Identity Provider',
    description:
      'Issues identity assertions (OIDC/SAML/OAuth2). May participate in federations. Data controller under GDPR.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['RFC-6749-OAuth2', 'OIDC', 'GDPR', 'ISO-27018', 'SOC2'],
  },
  {
    id: 'cdn',
    name: 'CDN Provider',
    description: 'Content delivery network: edge caching, origin shield, purge, TLS termination.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['ISO-27001', 'SOC2'],
  },
  {
    id: 'marketplace',
    name: 'Digital Asset Marketplace',
    description:
      'Buy/sell/transfer/manage domains, brands, SSL, hosting, cloud, VPS, software, agents, sites, apps, APIs, businesses. Valuation, escrow, delivery, billing, taxation, reporting.',
    requiresAccreditation: false,
    accreditationBodies: [],
    controlFrameworks: ['PCI-DSS', 'GDPR', 'SOC2', 'ISO-27001'],
  },
];

/** Quick lookup of a domain by id. */
export function getDomain(id: string): AccreditationDomain | undefined {
  return ACCREDITATION_DOMAINS.find((d) => d.id === id);
}

/** Whether a domain requires external accreditation to operate publicly. */
export function requiresAccreditation(id: string): boolean {
  return getDomain(id)?.requiresAccreditation ?? false;
}
