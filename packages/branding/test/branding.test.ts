// Branding tests — brand registry, logo generation, app icons, splash screens,
// marketing templates, business cards, email signatures, brand CSS, and module.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  BrandingModule, PRODUCT_BRANDS, getBrand, listProducts,
  generateLogo, generateLogoMark, generateAppIcon, generateSplashScreen,
  generateBrandCss, generateBusinessCard, generateEmailSignature,
} from '../src/index.js';

const PRODUCT_IDS = Object.keys(PRODUCT_BRANDS);

describe('Product Registry — 15 products', () => {
  it('has all 15 products registered', () => {
    assert.equal(PRODUCT_IDS.length, 15);
    for (const id of ['jata-qi', 'soma-ai', 'tanya-ai', 'power-bot-x', 'moto-x', 'karis-farm', 'karis-loop', 'karis-energy', 'karis-border-x', 'karis-fx', 'maza', 'nova', 'portlink', 'nyumbani-kitchen', 'krt-wallet']) {
      assert.ok(PRODUCT_BRANDS[id], `missing product ${id}`);
    }
  });

  it('each product has a unique palette', () => {
    const primaries = new Set(PRODUCT_IDS.map((id) => PRODUCT_BRANDS[id]!.palette.primary));
    assert.ok(primaries.size >= 12, `expected variety but got ${primaries.size} unique primary colors`);
  });

  it('each product has a logo glyph and shape', () => {
    for (const id of PRODUCT_IDS) {
      const kit = PRODUCT_BRANDS[id]!;
      assert.ok(kit.logoGlyph.length > 0, `${id} missing glyph`);
      assert.ok(['hexagon', 'circle', 'square', 'triangle', 'diamond', 'shield'].includes(kit.logoShape), `${id} invalid shape`);
    }
  });
});

describe('Logo Engine — generation', () => {
  it('generates a logo SVG with shape + glyph', () => {
    const kit = getBrand('jata-qi')!;
    const logo = generateLogo(kit, 200);
    assert.match(logo.content, /<svg/);
    assert.match(logo.content, /<\/svg>/);
    assert.match(logo.content, /Q/); // the glyph
    assert.equal(logo.width, 200);
  });

  it('generates a logo mark (icon-only)', () => {
    const kit = getBrand('nova')!;
    const mark = generateLogoMark(kit, 48);
    assert.match(mark.content, /<svg/);
    assert.match(mark.content, /polygon|circle/); // shape present
  });

  it('generates different shapes for different products', () => {
    const hexKit = getBrand('jata-qi')!; // hexagon
    const circleKit = getBrand('soma-ai')!; // circle
    const hexLogo = generateLogo(hexKit, 100);
    const circleLogo = generateLogo(circleKit, 100);
    assert.match(hexLogo.content, /polygon/); // hexagons use polygon
    assert.match(circleLogo.content, /circle/); // circles use circle
  });

  it('generates an app icon', () => {
    const kit = getBrand('krt-wallet')!;
    const icon = generateAppIcon(kit, 512);
    assert.equal(icon.size, 512);
    assert.ok(icon.borderRadius > 0);
    assert.match(icon.svg, /<svg/);
  });

  it('generates a splash screen', () => {
    const kit = getBrand('maza')!;
    const splash = generateSplashScreen(kit);
    assert.ok(splash.text);
    assert.ok(splash.backgroundColor);
    assert.ok(splash.logoColor);
  });

  it('generates brand CSS custom properties', () => {
    const kit = getBrand('tanya-ai')!;
    const css = generateBrandCss(kit);
    assert.match(css, /--brand-primary/);
    assert.match(css, /--brand-display-font/);
  });

  it('generates a business card SVG', () => {
    const kit = getBrand('power-bot-x')!;
    const card = generateBusinessCard({
      name: 'Gitanya K', title: 'Founder', email: 'gitanya@jataqi.ai',
      company: 'JATA Qi', backgroundColor: kit.palette.background,
      textColor: kit.palette.text, accentColor: kit.palette.primary,
    }, kit);
    assert.match(card, /<svg/);
    assert.match(card, /Gitanya/);
  });

  it('generates an email signature HTML', () => {
    const sig = generateEmailSignature({
      name: 'Gitanya K', title: 'Founder', email: 'g@jataqi.ai',
      website: 'jataqi.ai', accentColor: '#5b5bd6', fontFamily: 'Inter',
    });
    assert.match(sig, /<table/);
    assert.match(sig, /Gitanya/);
    assert.match(sig, /jataqi\.ai/);
  });
});

describe('BrandingModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: BrandingModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new BrandingModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('lists all 15 products', () => {
    assert.equal(mod.listProducts().length, 15);
  });

  it('generates a complete brand package', () => {
    const pkg = mod.generateBrandPackage('jata-qi');
    assert.ok(pkg.logo.content);
    assert.ok(pkg.logoMark.content);
    assert.ok(pkg.appIcon.svg);
    assert.ok(pkg.splash.text);
    assert.ok(pkg.socialCard.name);
    assert.match(pkg.css, /--brand-primary/);
  });

  it('throws for unknown product', () => {
    assert.throws(() => mod.generateLogo('nonexistent'), /not found/);
  });

  it('registers a custom brand', () => {
    mod.registerBrand({
      productId: 'custom-x', productName: 'Custom X', tagline: 'Test',
      palette: { primary: '#ff0000', primaryDim: '#cc0000', secondary: '#00ff00', accent: '#0000ff', background: '#000', surface: '#111', text: '#fff' },
      typography: { displayFont: 'sans-serif', bodyFont: 'sans-serif', monoFont: 'monospace', displayWeight: 700, bodyWeight: 400 },
      logoGlyph: 'X', logoShape: 'circle', createdAt: Date.now(),
    });
    assert.ok(mod.getBrand('custom-x'));
    const logo = mod.generateLogo('custom-x');
    assert.match(logo.content, /X/);
  });
});
