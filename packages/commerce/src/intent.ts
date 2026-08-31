// Natural-language payment intent parser & extractor.

import type { PaymentIntent } from './types.js';

export class PaymentIntentExtractor {
  extractFromPrompt(prompt: string, payerId: string, tenantId = 'default-tenant', idempotencyKey = `idemp-${Date.now()}`): PaymentIntent {
    const lower = prompt.toLowerCase();
    
    // Simple heuristic parser for demo & natural language prompts
    // e.g., "Pay John KES 2,500 for vegetables" or "Send $100 to supplier"
    let amount = 1000;
    let currency = 'KES';
    let payeeName = 'Recipient';
    let purpose = 'General transfer';

    const currencyMatch = prompt.match(/(KES|USD|EUR|KRT|\$|KES\s|USD\s)/i);
    if (currencyMatch) {
      const matchStr = currencyMatch[0]!.trim().toUpperCase();
      if (matchStr === '$') currency = 'USD';
      else currency = matchStr;
    }

    const numMatch = prompt.match(/([\d,]+\.?\d*)/);
    if (numMatch && numMatch[1]) {
      amount = parseFloat(numMatch[1].replace(/,/g, ''));
    }

    if (lower.includes('for ')) {
      const parts = prompt.split(/for\s+/i);
      if (parts[1]) purpose = parts[1]!.trim();
    }

    if (lower.includes('pay ')) {
      const payPart = prompt.split(/pay\s+/i)[1] ?? '';
      const namePart = payPart.split(/\s+(KES|USD|EUR|KRT|\$|\d)/i)[0];
      if (namePart && namePart.trim().length > 0) {
        payeeName = namePart.trim();
      }
    }

    return {
      paymentIntentId: `pi-${Math.random().toString(36).substring(2, 10)}`,
      tenantId,
      payerId,
      payee: { type: 'PERSON', identifier: payeeName.toLowerCase().replace(/\s+/g, '_'), name: payeeName },
      amount,
      currency,
      purpose,
      status: 'DRAFT',
      idempotencyKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
