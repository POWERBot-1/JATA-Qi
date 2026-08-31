// Unit tests for Universal Prompt-to-Payment Layer (UPPL v1.0)

import test from 'node:test';
import assert from 'node:assert';
import { PaymentIntentExtractor, PaymentPolicyEngine, MockPaymentAdapter, UniversalPaymentRouter, PaymentLedger } from '../src/index.js';

test('PaymentIntentExtractor converts natural language prompts into canonical intents', () => {
  const extractor = new PaymentIntentExtractor();
  const intent = extractor.extractFromPrompt('Pay John KES 2,500 for vegetables', 'user-123');

  assert.strictEqual(intent.amount, 2500);
  assert.strictEqual(intent.currency, 'KES');
  assert.strictEqual(intent.payee.identifier, 'john');
  assert.strictEqual(intent.purpose, 'vegetables');
  assert.strictEqual(intent.payerId, 'user-123');
});

test('PaymentPolicyEngine enforces transaction limits and approval requirements', () => {
  const policy = new PaymentPolicyEngine();
  policy.setRule({
    userId: 'user-123',
    maxPerTransaction: 10000,
    maxDaily: 50000,
    allowedCurrencies: ['KES', 'USD'],
    requiresApprovalAbove: 3000,
  });

  const extractor = new PaymentIntentExtractor();
  const lowIntent = extractor.extractFromPrompt('Pay Mary KES 1,500', 'user-123');
  const lowEval = policy.evaluate(lowIntent);
  assert.strictEqual(lowEval.permitted, true);
  assert.strictEqual(lowEval.requiresApproval, false);

  const highIntent = extractor.extractFromPrompt('Pay Supplier KES 8,000', 'user-123');
  const highEval = policy.evaluate(highIntent);
  assert.strictEqual(highEval.permitted, true);
  assert.strictEqual(highEval.requiresApproval, true);

  const overIntent = extractor.extractFromPrompt('Pay Landlord KES 15,000', 'user-123');
  const overEval = policy.evaluate(overIntent);
  assert.strictEqual(overEval.permitted, false);
});

test('UniversalPaymentRouter and MockPaymentAdapter execute and verify payment flow', async () => {
  const router = new UniversalPaymentRouter();
  const mpesa = new MockPaymentAdapter('mpesa');
  router.registerProvider('mpesa', mpesa);

  const extractor = new PaymentIntentExtractor();
  const intent = extractor.extractFromPrompt('Pay John KES 5,000', 'user-123');

  const providerId = router.route(intent);
  assert.strictEqual(providerId, 'mpesa');

  const quote = router.quote(intent, providerId);
  assert.strictEqual(quote.totalDebit, 5015);

  const provider = router.getProvider(providerId);
  const tx = await provider.createPayment(intent);
  assert.ok(tx.providerTransactionId);

  const exec = await provider.executePayment(tx.providerTransactionId);
  assert.strictEqual(exec.success, true);

  const ledger = new PaymentLedger();
  const record = ledger.recordTransaction(intent, tx.providerTransactionId, providerId, exec.fees, 'SUCCEEDED', 'VERIFIED_SUCCESS');
  assert.strictEqual(record.amount, 5000);

  const receipt = ledger.generateReceipt(record);
  assert.strictEqual(receipt.status, 'SUCCEEDED');
  assert.strictEqual(receipt.verificationStatus, 'VERIFIED_SUCCESS');
});
