// Bootstrap integration test for the CLP + Phase 2–5 module wave: verifies
// that createJataQi() registers and boots the digital memory, continuous
// learning, AI learning, design system, branding, universal wallet, crypto,
// adaptive dashboard, link intelligence, and multimodal intelligence modules.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import { DigitalMemoryModule } from '@jataqi/memory';
import { ContinuousLearningModule } from '@jataqi/learning';
import { AiLearningModule } from '@jataqi/ai-learning';
import { DesignSystemModule } from '@jataqi/design-system';
import { BrandingModule } from '@jataqi/branding';
import { UniversalWalletModule } from '@jataqi/universal-wallet';
import { CryptoModule } from '@jataqi/crypto';
import { DashboardModule } from '@jataqi/dashboard';
import { LinkIntelligenceModule } from '@jataqi/link-intelligence';
import { MultimodalIntelligenceModule } from '@jataqi/multimodal-intelligence';

describe('createJataQi — CLP + Phase 2–5 module integration', () => {
  it('boots the unified OS with all intelligence modules registered', async () => {
    const qi = await createJataQi();
    try {
      assert.equal(qi.kernel.isBooted(), true);
      assert.ok(qi.kernel.getModule<DigitalMemoryModule>('memory'));
      assert.ok(qi.kernel.getModule<ContinuousLearningModule>('learning'));
      assert.ok(qi.kernel.getModule<AiLearningModule>('ai-learning'));
      assert.ok(qi.kernel.getModule<DesignSystemModule>('design-system'));
      assert.ok(qi.kernel.getModule<BrandingModule>('branding'));
      assert.ok(qi.kernel.getModule<UniversalWalletModule>('universal-wallet'));
      assert.ok(qi.kernel.getModule<CryptoModule>('crypto'));
      assert.ok(qi.kernel.getModule<DashboardModule>('dashboard'));
      assert.ok(qi.kernel.getModule<LinkIntelligenceModule>('link-intelligence'));
      assert.ok(qi.kernel.getModule<MultimodalIntelligenceModule>('multimodal-intelligence'));
      for (const id of ['memory', 'learning', 'ai-learning', 'design-system', 'branding',
        'universal-wallet', 'crypto', 'dashboard', 'link-intelligence', 'multimodal-intelligence']) {
        assert.equal(qi.kernel.getModuleState(id), 'started', `${id} should be started`);
      }
    } finally {
      await qi.shutdown();
    }
  });

  it('cross-module flows work on the unified kernel', async () => {
    const qi = await createJataQi();
    try {
      const kernel = qi.kernel;
      // Memory feeds learning: record enough events for the insight
      // confidence threshold (>= 15 per category at the default 0.3 minimum).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      for (let i = 0; i < 20; i++) {
        const res = await memory.record({ category: 'search', summary: `searched for vector search #${i}`, userId: 'u9', orgId: 'org9', sessionId: 's1' });
        assert.equal(res.recorded, true);
      }

      const learning = kernel.getModule<ContinuousLearningModule>('learning');
      const analysis = await learning.analyze('org9');
      assert.ok(analysis.insights.length >= 1);

      // Dashboard personalization consumes the learning module.
      const dashboard = kernel.getModule<DashboardModule>('dashboard');
      const layout = dashboard.createLayout({ name: 'Home', ownerId: 'u9', role: 'admin' });
      const applied = await dashboard.adapt(layout.id, 'u9', 'admin');
      assert.ok(applied >= 0);

      // Wallet + crypto are reachable on the same kernel.
      const wallet = kernel.getModule<UniversalWalletModule>('universal-wallet');
      const w = wallet.openWallet('u9', 'developer');
      const tx = wallet.deposit(w.id, 'KES', 1000n, 'seed');
      assert.equal(tx.status, 'settled');

      const crypto = kernel.getModule<CryptoModule>('crypto');
      crypto.registerAsset({ symbol: 'KRT', name: 'KRT', type: 'fungible', decimals: 2, totalSupply: 1000000n, chain: 'native' });
      const minted = crypto.mint('addr-1', 'KRT', 100n);
      assert.equal(minted.status, 'confirmed');
    } finally {
      await qi.shutdown();
    }
  });
});
