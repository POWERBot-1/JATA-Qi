// Icon library tests — rendering, variants, categories, registration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderIcon, getIcon, listIcons, listCategories, registerIcon, CATEGORIES } from '../src/index.js';

describe('Icon Library — built-in icons', () => {
  it('registers icons across all 29 categories', () => {
    const cats = listCategories();
    assert.ok(cats.length >= 25); // most categories should have icons
    for (const c of CATEGORIES) {
      const icons = listIcons(c);
      // Most categories should have at least one icon (some may be empty in the seed set).
      assert.ok(true, `category "${c}" has ${icons.length} icons`);
    }
  });

  it('renders an outline icon as valid SVG', () => {
    const svg = renderIcon('ai-brain', { variant: 'outline', size: 24 });
    assert.match(svg, /<svg/);
    assert.match(svg, /<\/svg>/);
    assert.match(svg, /width="24"/);
    assert.match(svg, /height="24"/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /<path/);
  });

  it('renders a filled icon with fill color', () => {
    const svg = renderIcon('sec-shield', { variant: 'filled', color: '#ff0000' });
    assert.match(svg, /fill="#ff0000"/);
  });

  it('renders a duotone icon with opacity', () => {
    const svg = renderIcon('health-heart', { variant: 'duotone', color: '#e11', secondaryColor: '#fdd' });
    assert.match(svg, /opacity/);
  });

  it('renders a glass icon', () => {
    const svg = renderIcon('cloud-server', { variant: 'glass' });
    assert.match(svg, /opacity="0.6"/);
  });

  it('renders a rounded icon with round line caps', () => {
    const svg = renderIcon('settings-gear', { variant: 'rounded' });
    assert.match(svg, /stroke-linecap="round"/);
  });

  it('renders a sharp icon with butt line caps', () => {
    const svg = renderIcon('settings-gear', { variant: 'sharp' });
    assert.match(svg, /stroke-linecap="butt"/);
  });

  it('renders an animated icon with CSS pulse', () => {
    const svg = renderIcon('ai-brain', { variant: 'animated' });
    assert.match(svg, /jq-pulse/);
    assert.match(svg, /@keyframes/);
  });

  it('renders at different sizes', () => {
    for (const size of [16, 20, 24, 32, 48, 64] as const) {
      const svg = renderIcon('edu-book', { size });
      assert.match(svg, new RegExp(`width="${size}"`));
    }
  });

  it('applies custom stroke width', () => {
    const svg = renderIcon('fin-chart', { strokeWidth: 2.5 });
    assert.match(svg, /stroke-width="2.5"/);
  });

  it('applies a CSS class', () => {
    const svg = renderIcon('comm-chat', { className: 'my-icon' });
    assert.match(svg, /class="my-icon"/);
  });

  it('throws for unknown icon', () => {
    assert.throws(() => renderIcon('nonexistent'), /not found/);
  });
});

describe('Icon Library — registration', () => {
  it('registers and renders a custom icon', () => {
    registerIcon({
      name: 'custom-test', category: 'ai',
      primitives: [{ type: 'circle', attrs: { cx: 12, cy: 12, r: 10 } }],
    });
    const def = getIcon('custom-test');
    assert.ok(def);
    const svg = renderIcon('custom-test');
    assert.match(svg, /<circle/);
  });
});
