// Unit tests for FXL™ Fingerprint Experience Layer

import test from 'node:test';
import assert from 'node:assert';
import { FingerprintManager, FXLComposer, ExperienceDiversityEngine, FingerprintMemoryManager } from '../src/index.js';

test('FingerprintManager creates and evolves user Experience Fingerprint through stages', () => {
  const manager = new FingerprintManager();
  const fp = manager.getOrCreate('user-gitanya');
  assert.strictEqual(fp.stage, 'DISCOVERY');
  assert.strictEqual(fp.interactionCount, 0);

  // Simulate interactions to advance stage
  for (let i = 0; i < 25; i++) {
    manager.recordInteraction('user-gitanya', 'business-review', 'knowledge.search');
  }

  const evolved = manager.getOrCreate('user-gitanya');
  assert.strictEqual(evolved.interactionCount, 25);
  assert.strictEqual(evolved.stage, 'ADAPTATION');
});

test('FXLComposer dynamically constructs Living Command Surface according to intent and fingerprint', () => {
  const manager = new FingerprintManager();
  const composer = new FXLComposer();
  const fp = manager.getOrCreate('user-alice');
  manager.setPersonality('user-alice', 'executive');

  const layout = composer.compose(fp, {
    userId: 'user-alice',
    currentIntent: 'Prepare today\'s business revenue and orders',
    deviceType: 'desktop',
    timeOfDay: 'morning',
    activeRole: 'operator',
  });

  assert.ok(layout.primaryCards.includes('Orders & Revenue'));
  assert.strictEqual(layout.personality, 'executive');
});

test('ExperienceDiversityEngine calculates diversity index and FingerprintMemoryManager supports export/import/delete', () => {
  const diversityEngine = new ExperienceDiversityEngine();
  const memoryManager = new FingerprintMemoryManager();
  const manager = new FingerprintManager();
  const composer = new FXLComposer();

  const fp1 = manager.getOrCreate('user-1');
  const fp2 = manager.getOrCreate('user-2');
  manager.setPersonality('user-2', 'minimalist');

  const l1 = composer.compose(fp1, { userId: 'user-1', currentIntent: 'Sales', deviceType: 'desktop', timeOfDay: 'morning', activeRole: 'admin' });
  const l2 = composer.compose(fp2, { userId: 'user-2', currentIntent: 'Coding', deviceType: 'mobile', timeOfDay: 'night', activeRole: 'engineer' });

  const score = diversityEngine.calculateDiversityIndex([l1, l2]);
  assert.ok(score > 0.0);

  // Test memory operations
  memoryManager.importProfile(JSON.stringify(fp1));
  const exported = memoryManager.exportProfile('user-1');
  assert.ok(exported.includes('user-1'));

  assert.strictEqual(memoryManager.deleteProfile('user-1'), true);
});
