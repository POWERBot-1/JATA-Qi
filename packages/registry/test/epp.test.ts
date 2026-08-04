// EPP codec + server/client integration tests over real TCP (RFC 5734 framing).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  Registry, defaultPolicy, EppServer, EppClient, parseCommand, encodeGreeting, encodeResponse,
  ResultCode, domainCheckResData, serializeXml,
} from '../src/index.js';

function hashOf(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }

function setupRegistry(): Registry {
  const reg = new Registry({ tld: '.jq', policy: defaultPolicy({ reserved: new Set(), reservedPatterns: [] }) });
  reg.addRegistrar({ id: 'reg-a', name: 'A', passwordHash: hashOf('pw-a'), active: true });
  reg.addRegistrar({ id: 'reg-b', name: 'B', passwordHash: hashOf('pw-b'), active: true });
  return reg;
}

describe('EPP codec — parseCommand', () => {
  it('parses a login command', () => {
    const xml = `<?xml version="1.0"?>
<epp xmlns="urn:ietf:params:xml:ns:epp-1.0">
  <command>
    <login>
      <clID>reg-a</clID>
      <pw>pw-a</pw>
      <options><version>1.0</version><lang>en</lang></options>
      <svcs><objURI>urn:ietf:params:xml:ns:domain-1.0</objURI></svcs>
    </login>
    <clTRID>abc</clTRID>
  </command>
</epp>`;
    const cmd = parseCommand(xml);
    assert.equal(cmd.type, 'login');
    if (cmd.type === 'login') {
      assert.equal(cmd.clID, 'reg-a');
      assert.equal(cmd.pw, 'pw-a');
      assert.equal(cmd.clTRID, 'abc');
    }
  });

  it('parses a domain:create command', () => {
    const xml = `<epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><command><create>
      <domain:create xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">
        <domain:name>example.jq</domain:name>
        <domain:period unit="y">2</domain:period>
        <domain:ns><domain:hostObj>ns1.example.jq</domain:hostObj></domain:ns>
        <domain:registrant>c1</domain:registrant>
        <domain:authInfo><domain:pw>secret</domain:pw></domain:authInfo>
      </domain:create></create><clTRID>c1</clTRID></command></epp>`;
    const cmd = parseCommand(xml);
    assert.equal(cmd.type, 'domain:create');
    if (cmd.type === 'domain:create') {
      assert.equal(cmd.name, 'example.jq');
      assert.equal(cmd.periodYears, 2);
      assert.deepEqual(cmd.ns, ['ns1.example.jq']);
      assert.equal(cmd.registrant, 'c1');
      assert.equal(cmd.authInfo, 'secret');
    }
  });

  it('encodes a greeting and a response', () => {
    const g = encodeGreeting({ svID: 'test' });
    assert.match(g.toString(), /greeting/);
    const r = encodeResponse({ code: ResultCode.SuccessCompleted, msg: 'ok', svTRID: 'sv-1', clTRID: 'cl-1' });
    assert.match(r.toString(), /sv-1/);
  });

  it('builds a domain:check resData document', () => {
    const node = domainCheckResData([{ name: 'a.jq', avail: true }, { name: 'b.jq', avail: false, reason: 'registered' }]);
    assert.match(serialize(node), /chkData/);
  });
});

function serialize(node: unknown): string {
  return serializeXml(node as never);
}

describe('EPP server + client (TCP)', () => {
  let reg: Registry;
  let server: EppServer;
  let port: number;

  before(async () => {
    reg = setupRegistry();
    server = new EppServer(reg, { svID: 'epp.test' });
    port = await server.start(0, '127.0.0.1');
  });
  after(async () => { await server.stop(); });

  it('greets on connect and accepts login', async () => {
    const client = new EppClient();
    const greeting = await client.connect('127.0.0.1', port);
    assert.equal(greeting.local, 'epp');
    const r = await client.login('reg-a', 'pw-a', 'login-1');
    assert.equal(r.code, ResultCode.SuccessCompleted);
    await client.logout();
  });

  it('rejects bad login', async () => {
    const client = new EppClient();
    await client.connect('127.0.0.1', port);
    const r = await client.login('reg-a', 'wrong', 'login-2');
    assert.equal(r.code, ResultCode.AuthenticationError);
    client.close();
  });

  it('checks, creates, and info over EPP', async () => {
    const client = new EppClient();
    await client.connect('127.0.0.1', port);
    await client.login('reg-a', 'pw-a', 'l1');

    const check = await client.check(['newbrand.jq', 'www.jq'], 'c1');
    assert.equal(check.code, ResultCode.SuccessCompleted);
    assert.match(check.raw, /chkData/);

    const create = await client.create('newbrand.jq', { periodYears: 2, authInfo: 'secret', registrant: 'c1' }, 'c2');
    assert.equal(create.code, ResultCode.SuccessCompleted);

    const info = await client.info('newbrand.jq', undefined, 'i1');
    assert.equal(info.code, ResultCode.SuccessCompleted);

    await client.logout();
  });

  it('returns the right error for an already-registered name', async () => {
    const client = new EppClient();
    await client.connect('127.0.0.1', port);
    await client.login('reg-a', 'pw-a', 'l2');
    await client.create('taken.jq', { authInfo: 's', registrant: 'c1' }, 'c');
    const dup = await client.create('taken.jq', { authInfo: 's', registrant: 'c1' }, 'd');
    assert.equal(dup.code, ResultCode.ObjectExists);
    await client.logout();
  });

  it('renews and deletes a domain', async () => {
    const client = new EppClient();
    await client.connect('127.0.0.1', port);
    await client.login('reg-a', 'pw-a', 'l3');
    await client.create('renewable.jq', { authInfo: 's', registrant: 'c1' }, 'c');
    const exp = reg.info('renewable.jq.')!.expiresAt;
    const renew = await client.renew('renewable.jq', new Date(exp).toISOString().slice(0, 10), 1, 'r1');
    assert.equal(renew.code, ResultCode.SuccessCompleted);
    const del = await client.delete('renewable.jq', 'd1');
    assert.equal(del.code, ResultCode.SuccessCompleted);
    await client.logout();
  });

  it('refuses object commands before login', async () => {
    const client = new EppClient();
    await client.connect('127.0.0.1', port);
    const check = await client.check(['x.jq'], 'c');
    assert.equal(check.code, ResultCode.AuthenticationError);
    client.close();
  });
});
