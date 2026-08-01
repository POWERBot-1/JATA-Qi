// Catalog policy tests — reserved names, premium pricing, sunrise/claims.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy, isReserved, premiumPrice, validTerm, sldOf, DEFAULT_RESERVED } from '../src/index.js';

describe('catalog — reserved names', () => {
  it('reserves well-known infrastructure labels', () => {
    const p = defaultPolicy({ reserved: DEFAULT_RESERVED });
    assert.equal(isReserved(p, 'www.jq.'), true);
    assert.equal(isReserved(p, 'ns1.jq.'), true);
    assert.equal(isReserved(p, 'example.jq.'), true);
  });

  it('allows a normal label', () => {
    const p = defaultPolicy();
    assert.equal(isReserved(p, 'mybrand.jq.'), false);
  });

  it('sldOf strips the TLD/zone', () => {
    assert.equal(sldOf('mybrand.jq.'), 'mybrand');
    assert.equal(sldOf('Foo.JQ'), 'foo');
  });
});

describe('catalog — premium pricing', () => {
  it('marks short SLDs as premium', () => {
    const p = defaultPolicy();
    assert.ok(premiumPrice(p, 'ab.jq.', 'create') > p.basePriceCreate);
  });

  it('charges the base price for ordinary names', () => {
    const p = defaultPolicy();
    assert.equal(premiumPrice(p, 'mybrand.jq.', 'create'), p.basePriceCreate);
  });

  it('validTerm enforces 1..maxTermYears', () => {
    const p = defaultPolicy();
    assert.equal(validTerm(p, 0), false);
    assert.equal(validTerm(p, 1), true);
    assert.equal(validTerm(p, p.maxTermYears), true);
    assert.equal(validTerm(p, p.maxTermYears + 1), false);
  });
});
