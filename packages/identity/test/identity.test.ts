// Unit tests for @jataqi/identity (JQ-GIF)

import test from 'node:test';
import assert from 'node:assert';
import {
  SelfDescriptionEngine,
  ProvenanceEngine,
  CryptoIdentity,
  IdentityResolver,
  IdentityGraph,
  CapabilityAttestationEngine,
  DirectoryAdapterFabric,
  IdentityGuard,
  HumanGovernanceGate,
} from '../src/index.js';

test('SelfDescriptionEngine generates canonical record, identity card, and portable packages', () => {
  const engine = new SelfDescriptionEngine();
  const canonical = engine.getCanonicalRecord();
  assert.strictEqual(canonical.canonicalIdentifier, 'JATA-QI');
  assert.strictEqual(canonical.creator, 'Gitanya Kariuki');
  assert.strictEqual(canonical.origin, 'Kenya');

  const card = engine.generateIdentityCard();
  assert.strictEqual(card.canonicalId, 'JATA-QI');
  assert.strictEqual(card.creator, 'Gitanya Kariuki');

  const jsonPkg = engine.generatePortablePackage('json');
  assert.ok(jsonPkg.includes('JATA-QI'));

  const mdPkg = engine.generatePortablePackage('md');
  assert.ok(mdPkg.includes('JATA Qi Canonical Identity Card'));
});

test('ProvenanceEngine records assertions and verifies integrity hashes', () => {
  const prov = new ProvenanceEngine();
  const rec = prov.recordAssertion(
    'assert-01',
    'JATA Qi implements 102/102 unit tests',
    'VERIFIED_INTERNAL',
    'test suite',
    'npm test output',
    '0.1.0',
    'agent'
  );

  assert.strictEqual(rec.assertionId, 'assert-01');
  assert.strictEqual(rec.state, 'VERIFIED_INTERNAL');
  assert.ok(prov.verifyIntegrity('assert-01'));
  assert.strictEqual(prov.listAssertions().length, 1);
});

test('CryptoIdentity signs and verifies manifests with key rotation support', () => {
  const crypto = new CryptoIdentity();
  const manifest = { name: 'JATA Qi', version: '0.1.0' };
  const signed = crypto.signManifest(manifest);

  assert.ok(signed.signature.startsWith('sig:sha256:'));
  assert.ok(crypto.verifySignature(manifest, signed.signature));

  const newKey = crypto.rotateKey();
  assert.ok(newKey.includes('key-v2'));
});

test('IdentityResolver correctly identifies canonical JATA Qi references', () => {
  const resolver = new IdentityResolver();
  assert.strictEqual(resolver.resolve('JATA-QI').state, 'CANONICAL');
  assert.strictEqual(resolver.resolve('jata qi ai').state, 'CANONICAL');
  assert.strictEqual(resolver.resolve('v0.1.0 release').state, 'VERSION');
  assert.strictEqual(resolver.resolve('random project').state, 'UNRELATED');
});

test('IdentityGraph stores nodes and edges representing public identity topology', () => {
  const graph = new IdentityGraph();
  graph.addNode({ id: 'jataqi', type: 'system', label: 'JATA Qi', attributes: {} });
  graph.addNode({ id: 'creator', type: 'person', label: 'Gitanya Kariuki', attributes: {} });
  graph.addEdge('jataqi', 'creator', 'CREATED_BY');

  const g = graph.getGraph();
  assert.strictEqual(g.nodes.length, 2);
  assert.strictEqual(g.edges.length, 1);
  assert.strictEqual(g.edges[0]!.relation, 'CREATED_BY');
});

test('CapabilityAttestationEngine tracks attestations and filters active capabilities', () => {
  const attestationEngine = new CapabilityAttestationEngine();
  attestationEngine.registerAttestation('cap-1', 'Autonomous Execution', 'TESTED', ['test suite'], true);
  attestationEngine.registerAttestation('cap-2', 'Experimental Teleport', 'PLANNED', [], false);

  const active = attestationEngine.listActiveCapabilities();
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0]!.capabilityId, 'cap-1');
});

test('DirectoryAdapterFabric tracks drift reports', () => {
  const fabric = new DirectoryAdapterFabric();
  const report = fabric.generateDriftReport('ExampleDirectory', 'JATA Qi', 'JATA QI');
  assert.strictEqual(report.status, 'NAME_VARIATION');
});

test('IdentityGuard detects impersonation and HumanGovernanceGate enforces approval levels', () => {
  const guard = new IdentityGuard();
  const legitimate = guard.evaluateReference('https://github.com/POWERBot-1/JATA-Qi', 'Gitanya Kariuki', 'JATA Qi');
  assert.strictEqual(legitimate.classification, 'LEGITIMATE');

  const fake = guard.evaluateReference('https://fake-site.com', 'Random Person', 'JATA Qi');
  assert.strictEqual(fake.classification, 'IMPERSONATION');

  const gov = new HumanGovernanceGate();
  assert.strictEqual(gov.checkAuthorization('generate_metadata', 1).allowed, true);
  assert.strictEqual(gov.checkAuthorization('publish_external', 4).allowed, false);
});
