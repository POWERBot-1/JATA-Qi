// Built-in jurisdiction profiles for major regions. These are CONFIGURABLE
// templates — administrators can create custom profiles for any jurisdiction.
// No legal claims are made; these are engineering configuration profiles only.

export interface JurisdictionProfile {
  id: string;
  countryCode: string;          // ISO 3166-1 alpha-2
  countryName: string;
  region?: string;              // e.g. 'EU', 'East Africa', 'GCC'
  dataResidency: 'strict' | 'preferred' | 'unrestricted';
  allowedDataRegions: string[]; // e.g. ['KE'], ['EU'], ['*']
  encryptionStandard: string;   // e.g. 'AES-256-GCM', 'SM4'
  keyManagementLocation: string; // where keys must be stored
  complianceFrameworks: string[]; // e.g. ['GDPR', 'HIPAA', 'PDPA', 'POPIA']
  authenticationRequirements: string[]; // e.g. ['MFA-required', 'local-idp']
  dataRetentionMaxDays?: number;
  crossBorderTransferAllowed: boolean;
  governmentCloudRequired: boolean;
  auditLogRetentionDays: number;
  language: string;
  currency: string;
  notes?: string;
}

export const PROFILES: JurisdictionProfile[] = [
  {
    id: 'kenya',
    countryCode: 'KE', countryName: 'Kenya', region: 'East Africa',
    dataResidency: 'preferred', allowedDataRegions: ['KE', '*'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'in-country-or-approved',
    complianceFrameworks: ['Kenya-DPA-2019', 'Constitution-Article-31'],
    authenticationRequirements: ['MFA-recommended'],
    crossBorderTransferAllowed: true, governmentCloudRequired: false,
    auditLogRetentionDays: 2555, language: 'en', currency: 'KES',
    notes: 'Kenya Data Protection Act 2019 applies. Consent-based processing.',
  },
  {
    id: 'eu',
    countryCode: 'EU', countryName: 'European Union', region: 'EU',
    dataResidency: 'strict', allowedDataRegions: ['EU', 'EEA'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'within-EU-EEA',
    complianceFrameworks: ['GDPR', 'ePrivacy', 'DSA', 'AI-Act'],
    authenticationRequirements: ['MFA-required', 'SSO-recommended'],
    dataRetentionMaxDays: 365, crossBorderTransferAllowed: false,
    governmentCloudRequired: false, auditLogRetentionDays: 3650,
    language: 'en', currency: 'EUR',
    notes: 'GDPR strict data residency. Right to erasure. DPO may be required.',
  },
  {
    id: 'usa',
    countryCode: 'US', countryName: 'United States', region: 'North America',
    dataResidency: 'unrestricted', allowedDataRegions: ['*'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'any',
    complianceFrameworks: ['CCPA', 'HIPAA', 'SOC2', 'FedRAMP-optional'],
    authenticationRequirements: ['MFA-recommended'],
    crossBorderTransferAllowed: true, governmentCloudRequired: false,
    auditLogRetentionDays: 2555, language: 'en', currency: 'USD',
    notes: 'Sectoral regulation. HIPAA for health. FedRAMP for government.',
  },
  {
    id: 'china',
    countryCode: 'CN', countryName: 'China', region: 'East Asia',
    dataResidency: 'strict', allowedDataRegions: ['CN'],
    encryptionStandard: 'SM4', keyManagementLocation: 'within-China',
    complianceFrameworks: ['PIPL', 'DSL', 'Cybersecurity-Law'],
    authenticationRequirements: ['local-idp', 'real-name-verification'],
    crossBorderTransferAllowed: false, governmentCloudRequired: true,
    auditLogRetentionDays: 1825, language: 'zh', currency: 'CNY',
    notes: 'Data must remain in China. SM4 encryption preferred. CAC approval.',
  },
  {
    id: 'india',
    countryCode: 'IN', countryName: 'India', region: 'South Asia',
    dataResidency: 'preferred', allowedDataRegions: ['IN', '*'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'in-country-preferred',
    complianceFrameworks: ['DPDPA-2023'],
    authenticationRequirements: ['MFA-recommended'],
    crossBorderTransferAllowed: true, governmentCloudRequired: false,
    auditLogRetentionDays: 1825, language: 'en', currency: 'INR',
    notes: 'Digital Personal Data Protection Act 2023. Consent-based.',
  },
  {
    id: 'nigeria',
    countryCode: 'NG', countryName: 'Nigeria', region: 'West Africa',
    dataResidency: 'preferred', allowedDataRegions: ['NG', '*'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'any',
    complianceFrameworks: ['NDPR-2023'],
    authenticationRequirements: ['MFA-recommended'],
    crossBorderTransferAllowed: true, governmentCloudRequired: false,
    auditLogRetentionDays: 2555, language: 'en', currency: 'NGN',
    notes: 'Nigeria Data Protection Regulation 2023.',
  },
  {
    id: 'south-africa',
    countryCode: 'ZA', countryName: 'South Africa', region: 'Southern Africa',
    dataResidency: 'preferred', allowedDataRegions: ['ZA', '*'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'any',
    complianceFrameworks: ['POPIA'],
    authenticationRequirements: ['MFA-recommended'],
    crossBorderTransferAllowed: true, governmentCloudRequired: false,
    auditLogRetentionDays: 2555, language: 'en', currency: 'ZAR',
    notes: 'Protection of Personal Information Act.',
  },
  {
    id: 'saudi-arabia',
    countryCode: 'SA', countryName: 'Saudi Arabia', region: 'GCC',
    dataResidency: 'strict', allowedDataRegions: ['SA'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'within-KSA',
    complianceFrameworks: ['PDPL'],
    authenticationRequirements: ['MFA-required'],
    crossBorderTransferAllowed: false, governmentCloudRequired: true,
    auditLogRetentionDays: 1825, language: 'ar', currency: 'SAR',
    notes: 'Personal Data Protection Law. Data must reside in KSA.',
  },
  {
    id: 'government-generic',
    countryCode: 'GOV', countryName: 'Government (Generic)', region: 'Sovereign',
    dataResidency: 'strict', allowedDataRegions: ['SOVEREIGN'],
    encryptionStandard: 'AES-256-GCM', keyManagementLocation: 'air-gapped-or-sovereign-cloud',
    complianceFrameworks: ['SOVEREIGN-DEPLOYMENT', 'GOVERNMENT-SECURITY'],
    authenticationRequirements: ['MFA-required', 'local-idp', 'hardware-tokens'],
    dataRetentionMaxDays: 3650, crossBorderTransferAllowed: false,
    governmentCloudRequired: true, auditLogRetentionDays: 3650,
    language: 'en', currency: 'LOCAL',
    notes: 'Generic government sovereign profile. Air-gapped option. Customize per country.',
  },
];
