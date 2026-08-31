// Payment Policy Engine and Agent Authority Rules.

import type { PaymentIntent, PaymentAuthorityRule } from './types.js';

export class PaymentPolicyEngine {
  private readonly rules = new Map<string, PaymentAuthorityRule>();

  setRule(rule: PaymentAuthorityRule): void {
    this.rules.set(rule.userId, rule);
  }

  evaluate(intent: PaymentIntent): { permitted: boolean; requiresApproval: boolean; reason: string } {
    const rule = this.rules.get(intent.payerId) ?? {
      userId: intent.payerId,
      maxPerTransaction: 50000,
      maxDaily: 200000,
      allowedCurrencies: ['KES', 'USD', 'EUR'],
      requiresApprovalAbove: 10000,
    };

    if (!rule.allowedCurrencies.includes(intent.currency)) {
      return { permitted: false, requiresApproval: false, reason: `Currency ${intent.currency} is not permitted by policy.` };
    }

    if (intent.amount > rule.maxPerTransaction) {
      return { permitted: false, requiresApproval: true, reason: `Amount ${intent.amount} ${intent.currency} exceeds per-transaction limit (${rule.maxPerTransaction}).` };
    }

    const requiresApproval = intent.amount >= rule.requiresApprovalAbove;

    return {
      permitted: true,
      requiresApproval,
      reason: requiresApproval ? 'Amount requires explicit user/business approval.' : 'Amount within autonomous threshold.',
    };
  }
}
