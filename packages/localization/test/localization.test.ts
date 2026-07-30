import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { LocalizationModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('LocalizationModule', () => {
  let kernel: Kernel; let loc: LocalizationModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new LocalizationModule()); await kernel.boot(); loc = kernel.getModule<LocalizationModule>('localization'); });

  it('seeds default locales and currencies', async () => {
    const locales = await loc.listLocales();
    const currencies = await loc.listCurrencies();
    assert.ok(locales.length >= 4);
    assert.ok(currencies.length >= 4);
    assert.ok(locales.some((l) => l.code === 'sw'));
    assert.ok(currencies.some((c) => c.code === 'KES'));
  });

  it('adds custom locales and currencies', async () => {
    await loc.addLocale('zh', '中文');
    await loc.addCurrency('JPY', '¥', 0);
    assert.ok((await loc.listLocales()).some((l) => l.code === 'zh'));
    assert.ok((await loc.listCurrencies()).some((c) => c.code === 'JPY'));
  });

  it('sets and retrieves translations with fallback', async () => {
    await loc.setTranslation('sw', 'welcome', 'Karibu');
    assert.equal(await loc.getTranslation('sw', 'welcome'), 'Karibu');
    assert.equal(await loc.t('sw', 'nonexistent'), 'nonexistent'); // fallback to key
  });

  it('interpolates variables in translations', async () => {
    await loc.setTranslation('en', 'greeting', 'Hello {name}!');
    assert.equal(await loc.tv('en', 'greeting', { name: 'Alice' }), 'Hello Alice!');
  });

  it('formats money with correct symbol and precision', async () => {
    assert.match(await loc.formatMoney(42.5, 'USD'), /\$42\.50/);
    assert.match(await loc.formatMoney(1000, 'KES'), /KSh.*1000/);
  });
});
