// EPP XML codec tests — round-trip of EPP-shaped documents.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, serializeXml, child, children, el, EPP_NS } from '../src/index.js';

describe('EPP XML — parse/serialize', () => {
  it('round-trips a simple element with attributes and text', () => {
    const doc = '<?xml version="1.0"?><root a="1"><child>hello &amp; bye</child></root>';
    const root = parseXml(doc);
    assert.equal(root.local, 'root');
    assert.equal(root.attrs.a, '1');
    const c = child(root, 'child')!;
    assert.equal(c.text, 'hello & bye');
    const back = serializeXml(root);
    const reparsed = parseXml(back);
    assert.equal(child(reparsed, 'child')!.text, 'hello & bye');
  });

  it('resolves namespaces from xmlns declarations', () => {
    const doc = `<epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><domain:create xmlns:domain="urn:ietf:params:xml:ns:domain-1.0"><domain:name>x.jq</domain:name></domain:create></epp>`;
    const root = parseXml(doc);
    assert.equal(root.ns, EPP_NS);
    const create = root.children[0]!;
    assert.equal(create.local, 'create');
    assert.equal(create.prefix, 'domain');
    assert.equal(create.ns, 'urn:ietf:params:xml:ns:domain-1.0');
    const name = create.children[0]!;
    assert.equal(name.local, 'name');
    assert.equal(name.text, 'x.jq');
  });

  it('handles self-closing and nested children', () => {
    const doc = `<a><b/><c><d/></c></a>`;
    const root = parseXml(doc);
    assert.equal(children(root, 'b').length, 1);
    assert.equal(child(root, 'c')!.children[0]!.local, 'd');
  });

  it('serializes builder elements back to parseable XML', () => {
    const epp = el('epp', EPP_NS, '');
    const cmd = el('command', EPP_NS, '');
    cmd.children.push(el('clTRID', EPP_NS, 'ABC-123'));
    epp.children = [cmd];
    const xml = serializeXml(epp);
    const reparsed = parseXml(xml);
    assert.equal(child(reparsed, 'command')!.children[0]!.text, 'ABC-123');
  });

  it('decodes numeric and named entities', () => {
    const doc = `<a>&#65; &lt; &quot;Z&quot;</a>`;
    assert.equal(parseXml(doc).text, 'A < "Z"');
  });

  it('throws on mismatched closing tag', () => {
    assert.throws(() => parseXml('<a></b>'));
  });
});
