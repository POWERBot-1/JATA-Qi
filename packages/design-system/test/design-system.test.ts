// Design system tests — tokens, WCAG AA color science, theme/brand resolution,
// CSS generation determinism, and the kernel module.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  DesignSystemModule, DesignSystemEvents, resolveTheme, themeForHour,
  hexToRgb, rgbToHex, relativeLuminance, contrastRatio, passesAA, legibleTextOn, mix, darken,
  LIGHT_COLORS, DARK_COLORS, SPACING, RADIUS, generateThemeVars, generateStylesheet,
} from '../src/index.js';

describe('tokens — structure & 8px grid', () => {
  it('exposes light and dark color sets with every role', () => {
    assert.ok(Object.keys(LIGHT_COLORS).length >= 16);
    assert.ok(Object.keys(DARK_COLORS).length >= 16);
    assert.notEqual(LIGHT_COLORS.background, DARK_COLORS.background);
  });

  it('spacing follows the 8px grid (with a 4px half-step)', () => {
    assert.equal(SPACING[1], 8);
    assert.equal(SPACING[2], 16);
    assert.equal(SPACING[3], 24);
    assert.equal(SPACING[4], 32);
    assert.equal(SPACING['0.5'], 4);
  });

  it('radius includes the 16–24px premium range', () => {
    assert.equal(RADIUS.lg, 16);
    assert.equal(RADIUS.xl, 24);
  });
});

describe('color science — WCAG AA', () => {
  it('converts hex <-> rgb', () => {
    assert.deepEqual(hexToRgb('#5b5bd6'), { r: 91, g: 91, b: 214 });
    assert.equal(rgbToHex({ r: 91, g: 91, b: 214 }), '#5b5bd6');
  });

  it('black/white contrast is the maximum (21:1)', () => {
    assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.1);
  });

  it('passesAA enforces 4.5:1 for normal text', () => {
    assert.equal(passesAA('#000000', '#ffffff'), true);
    assert.equal(passesAA('#999999', '#ffffff'), false);
  });

  it('legibleTextOn picks a high-contrast foreground', () => {
    assert.equal(legibleTextOn('#ffffff'), '#000000');
    assert.equal(legibleTextOn('#000000'), '#ffffff');
  });

  it('mix/darken shift colors predictably', () => {
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(darken('#ffffff', 1), '#000000');
  });

  it('luminance is bounded in [0,1]', () => {
    const l = relativeLuminance('#5b5bd6');
    assert.ok(l >= 0 && l <= 1);
  });
});

describe('theme resolution — modes + brand overrides', () => {
  it('resolves distinct light/dark bundles', () => {
    const light = resolveTheme('light');
    const dark = resolveTheme('dark');
    assert.equal(light.mode, 'light');
    assert.notEqual(light.colors.background, dark.colors.background);
    assert.equal(light.spacing, SPACING); // shared structural tokens
  });

  it('brand override recolors primary + derived dim + legible foreground', () => {
    const branded = resolveTheme('dark', { primary: '#10b981' }); // emerald
    assert.equal(branded.colors.primary, '#10b981');
    assert.notEqual(branded.colors.primaryDim, '#10b981'); // derived
    // Legible text on emerald is dark.
    assert.equal(branded.colors.textOnPrimary, legibleTextOn('#10b981'));
  });

  it('themeForHour maps day->light, night->dark', () => {
    assert.equal(themeForHour(12), 'light');
    assert.equal(themeForHour(22), 'dark');
  });
});

describe('CSS generation — determinism + content', () => {
  it('emits theme variable blocks for light and dark', () => {
    const css = generateThemeVars('dark');
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /--jq-color-primary:/);
    assert.match(css, /--jq-space-2:/);
  });

  it('the full stylesheet contains both themes + components', () => {
    const css = generateStylesheet();
    assert.match(css, /\[data-theme="light"\]/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /\.jq-btn-primary/);
    assert.match(css, /\.jq-card/);
    assert.match(css, /\.jq-glass/);
    assert.match(css, /jq-shimmer/); // loading state
  });

  it('is deterministic: same input -> identical output', () => {
    const a = generateStylesheet({ brand: { primary: '#ff0000' } });
    const b = generateStylesheet({ brand: { primary: '#ff0000' } });
    assert.equal(a, b);
  });

  it('brand override flows into the generated vars', () => {
    const css = generateStylesheet({ brand: { primary: '#10b981' } });
    assert.match(css, /--jq-color-primary: #10b981;/);
  });
});

describe('DesignSystemModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: DesignSystemModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new DesignSystemModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('resolves tokens and generates a stylesheet', () => {
    const t = mod.tokens();
    assert.equal(t.mode, 'dark'); // default
    assert.ok(mod.stylesheet().length > 0);
  });

  it('emits theme-change events on setMode', async () => {
    let to: string | undefined;
    kernel.bus.on(DesignSystemEvents.ThemeChanged, (e: { to: string }) => { to = e.to; });
    mod.setMode('light');
    await new Promise((r) => setImmediate(r));
    assert.equal(to, 'light');
    assert.equal(mod.currentMode, 'light');
  });

  it('applies adaptive theming from hour', () => {
    const day = mod.applyAdaptive({ hour: 12 });
    const night = mod.applyAdaptive({ hour: 23 });
    assert.equal(day, 'light');
    assert.equal(night, 'dark');
  });

  it('preference overrides time-of-day', () => {
    assert.equal(mod.resolveAdaptive({ preference: 'dark', hour: 12 }), 'dark');
  });

  it('brand override propagates to tokens', () => {
    mod.setBrand({ primary: '#ff00ff' });
    assert.equal(mod.tokens().colors.primary, '#ff00ff');
  });
});
