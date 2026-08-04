// Default product & plan templates. These are CONFIGURABLE seed data (admins can
// edit/create freely) — the engine never hard-codes prices, limits or names.

import { randomUUID } from 'node:crypto';
import type { Plan, Product } from './types.js';

const now = Date.now();

export const DEFAULT_PRODUCTS: Product[] = [
  {
    id: randomUUID(),
    name: 'JATA Qi Platform',
    slug: 'jata-qi-platform',
    family: 'JATA Qi Platform',
    description: 'The core JATA Qi modular AI operating system.',
    category: 'platform',
    version: '0.1.0',
    status: 'ACTIVE',
    availablePlans: [], // filled post-hoc with plan slugs
    deployments: ['SAAS', 'DOCKER', 'KUBERNETES', 'ON_PREMISE', 'AIR_GAPPED'],
    licenseModel: 'HYBRID',
    createdAt: now,
  },
];

function plan(p: Omit<Plan, 'id' | 'createdAt'> & { slug: string }): Plan {
  return { ...p, id: randomUUID(), createdAt: now };
}

/** USD price helper. */
function usd(amount: number) {
  return { amount, currency: 'USD' };
}

export const DEFAULT_PLANS: Plan[] = [
  plan({
    name: 'JATA Qi Free', slug: 'free', productFamily: 'JATA Qi Platform', edition: 'FREE',
    pricingModel: 'FREE', prices: { USD: usd(0), KES: { amount: 0, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 1000, 'agents.runs': 100, 'tools.calls': 500, 'api.requests': 1000, 'storage.gb': 1, 'knowledge.bases': 1, workflows: 5, marketplace: true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Personal', slug: 'personal', productFamily: 'JATA Qi Platform', edition: 'PERSONAL',
    pricingModel: 'FLAT_RATE', prices: { USD: usd(12), KES: { amount: 500, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 20000, 'agents.runs': 1000, 'tools.calls': 5000, 'api.requests': 10000, 'storage.gb': 20, 'knowledge.bases': 5, workflows: 50, 'models.advanced': true, marketplace: true },
    status: 'ACTIVE', trial: { days: 14, conversionTargetSlug: 'personal' },
  }),
  plan({
    name: 'JATA Qi Developer', slug: 'developer', productFamily: 'JATA Qi Developer', edition: 'DEVELOPER',
    pricingModel: 'FLAT_RATE', prices: { USD: usd(0), KES: { amount: 0, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 5000, 'agents.runs': 500, 'tools.calls': 2000, 'api.requests': 5000, 'storage.gb': 5, 'knowledge.bases': 3, workflows: 20, marketplace: true, 'api.access': true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Team', slug: 'team', productFamily: 'JATA Qi Platform', edition: 'TEAM',
    pricingModel: 'PER_SEAT', prices: { USD: usd(29), KES: { amount: 1200, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 100000, 'agents.runs': 5000, 'tools.calls': 25000, 'api.requests': 50000, 'storage.gb': 200, 'knowledge.bases': 25, workflows: 500, 'models.advanced': true, marketplace: true, 'api.access': true, seats: 5 },
    status: 'ACTIVE', trial: { days: 14 },
  }),
  plan({
    name: 'JATA Qi Business', slug: 'business', productFamily: 'JATA Qi Business', edition: 'BUSINESS',
    pricingModel: 'PER_SEAT', prices: { USD: usd(49), KES: { amount: 2000, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 500000, 'agents.runs': 25000, 'tools.calls': 100000, 'api.requests': 250000, 'storage.gb': 1000, 'knowledge.bases': 100, workflows: 5000, 'models.advanced': true, marketplace: true, 'api.access': true, seats: 20, 'enterprise.audit': true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Enterprise', slug: 'enterprise', productFamily: 'JATA Qi Enterprise', edition: 'ENTERPRISE',
    pricingModel: 'CONTRACT', prices: { USD: usd(0) }, billingCycle: 'ANNUAL',
    entitlements: { 'ai.requests': Number.POSITIVE_INFINITY, 'agents.runs': Number.POSITIVE_INFINITY, 'api.requests': Number.POSITIVE_INFINITY, 'storage.gb': Number.POSITIVE_INFINITY, 'models.advanced': true, marketplace: true, 'api.access': true, 'enterprise.sso': true, 'enterprise.audit': true, 'private.deployment': true, seats: Number.POSITIVE_INFINITY },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Student', slug: 'student', productFamily: 'JATA Qi Education', edition: 'STUDENT',
    pricingModel: 'FLAT_RATE', prices: { USD: usd(5), KES: { amount: 200, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 30000, 'agents.runs': 1500, 'tools.calls': 5000, 'api.requests': 15000, 'storage.gb': 15, 'knowledge.bases': 5, workflows: 50, marketplace: true, 'api.access': true },
    status: 'ACTIVE', trial: { days: 30 },
  }),
  plan({
    name: 'JATA Qi Education', slug: 'education', productFamily: 'JATA Qi Education', edition: 'EDUCATION',
    pricingModel: 'PER_SEAT', prices: { USD: usd(4), KES: { amount: 150, currency: 'KES' } }, billingCycle: 'ANNUAL',
    entitlements: { 'ai.requests': 200000, 'agents.runs': 10000, 'api.requests': 100000, 'storage.gb': 500, seats: 500, marketplace: true, 'api.access': true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Research', slug: 'research', productFamily: 'JATA Qi Research', edition: 'RESEARCH',
    pricingModel: 'FLAT_RATE', prices: { USD: usd(20), KES: { amount: 800, currency: 'KES' } }, billingCycle: 'MONTHLY',
    entitlements: { 'ai.requests': 200000, 'agents.runs': 10000, 'tools.calls': 50000, 'api.requests': 100000, 'storage.gb': 500, workflows: 1000, 'api.access': true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi Government', slug: 'government', productFamily: 'JATA Qi Government', edition: 'GOVERNMENT',
    pricingModel: 'CONTRACT', prices: { USD: usd(0) }, billingCycle: 'ANNUAL',
    entitlements: { 'ai.requests': Number.POSITIVE_INFINITY, 'storage.gb': Number.POSITIVE_INFINITY, 'private.deployment': true, 'enterprise.sso': true, 'enterprise.audit': true, seats: Number.POSITIVE_INFINITY },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi OEM', slug: 'oem', productFamily: 'JATA Qi OEM', edition: 'OEM',
    pricingModel: 'REVENUE_SHARE', prices: { USD: usd(0) }, billingCycle: 'MONTHLY',
    entitlements: { 'private.deployment': true, 'api.access': true },
    status: 'ACTIVE',
  }),
  plan({
    name: 'JATA Qi White Label', slug: 'white-label', productFamily: 'JATA Qi White Label', edition: 'WHITE_LABEL',
    pricingModel: 'CONTRACT', prices: { USD: usd(0) }, billingCycle: 'ANNUAL',
    entitlements: { 'private.deployment': true, 'api.access': true },
    status: 'ACTIVE',
  }),
];
