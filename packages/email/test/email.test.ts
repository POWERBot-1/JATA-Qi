// PRX Email Provider tests: domains with MX/SPF/DKIM/DMARC, mailboxes with
// quotas, outbound delivery with signing + policy checks, inbound receipt
// with DMARC disposition, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailEngine } from '../src/index.js';
import { EmailModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('EmailEngine', () => {
  it('registers domains with DNS records and verification', () => {
    const e = new EmailEngine();
    const domain = e.registerDomain({ domain: 'acme.co.ke', mxHosts: ['mx1.acme.co.ke'], dmarcPolicy: 'quarantine' });
    assert.equal(domain.verified, false);
    assert.equal(e.getDomainByName('acme.co.ke')!.id, domain.id);
    assert.equal(e.listDomains().length, 1);
    assert.equal(e.listDomains(true).length, 0);

    const records = e.dnsRecords(domain.id);
    assert.equal(records.length, 4); // MX + SPF + DKIM + DMARC
    assert.ok(records.some((r) => r.type === 'MX' && r.name === 'acme.co.ke'));
    assert.ok(records.some((r) => r.type === 'TXT' && r.name.startsWith('_dmarc.')));
    assert.ok(records.some((r) => r.name.includes('._domainkey.')));

    e.verifyDomain(domain.id);
    assert.equal(domain.verified, true);
    assert.equal(e.listDomains(true).length, 1);
    assert.throws(() => e.registerDomain({ domain: '' }), /required/);
  });

  it('creates mailboxes with quotas', () => {
    const e = new EmailEngine();
    const domain = e.registerDomain({ domain: 'acme.co.ke' });
    const mailbox = e.createMailbox({ domainId: domain.id, address: 'alice', displayName: 'Alice', quotaMb: 512 });
    assert.equal(mailbox.address, 'alice@acme.co.ke');
    assert.equal(mailbox.quotaMb, 512);
    assert.equal(e.getMailboxByAddress('alice@acme.co.ke')!.id, mailbox.id);
    assert.equal(e.listMailboxes(domain.id).length, 1);
    assert.throws(() => e.createMailbox({ domainId: 'nope', address: 'x' }), /unknown domain/);
    assert.throws(() => e.createMailbox({ domainId: domain.id, address: '' }), /required/);
  });

  it('sends outbound messages with DKIM + SPF + DMARC checks', () => {
    const e = new EmailEngine();
    const domain = e.registerDomain({ domain: 'acme.co.ke', dmarcPolicy: 'none' });
    e.registerDomain({ domain: 'partner.io', dmarcPolicy: 'quarantine' });
    e.verifyDomain(domain.id);

    // Unverified domain blocks sending.
    const unverified = e.registerDomain({ domain: 'unverified.test' });
    const mb = e.createMailbox({ domainId: unverified.id, address: 'x' });
    void mb;
    assert.throws(() => e.send({ from: 'x@unverified.test', to: ['y@partner.io'], subject: 'Hi', body: 'yo' }), /not verified/);

    const message = e.send({ from: 'alice@acme.co.ke', to: ['bob@partner.io', 'carol@other.io'], subject: 'Hello', body: 'World' });
    assert.equal(message.status, 'sent');
    assert.equal(message.dkimSigned, true);
    assert.equal(message.spfChecked, true);
    assert.equal(message.dmarcEvaluated, true); // partner.io is a known domain
    assert.ok(message.sentAt);
    assert.equal(e.listMessages('sent').length, 1);

    // Deterministic DKIM signature.
    const sig = e.dkimSignature(message.id, domain.dkimSelector);
    assert.match(sig, /^v=1; a=rsa-sha256; s=/);
    assert.equal(e.dkimSignature(message.id, domain.dkimSelector), sig);
  });

  it('receives inbound mail with DMARC disposition and quota accounting', () => {
    const e = new EmailEngine();
    const local = e.registerDomain({ domain: 'acme.co.ke' });
    const external = e.registerDomain({ domain: 'spammy.io', dmarcPolicy: 'reject' });
    const mailbox = e.createMailbox({ domainId: local.id, address: 'alice' });

    const normal = e.receive({ to: 'alice@acme.co.ke', from: 'friend@other.io', subject: 'Hi', body: 'Hello there' });
    assert.equal(normal.status, 'received');
    assert.equal(normal.dmarcDisposition, undefined);

    const rejected = e.receive({ to: 'alice@acme.co.ke', from: 'spammer@spammy.io', subject: 'Win!', body: 'Click now' });
    assert.equal(rejected.status, 'quarantined');
    assert.equal(rejected.dmarcDisposition, 'reject');

    assert.equal(e.listInbound(mailbox.id).length, 2);
    assert.equal(e.listInbound(undefined, 'quarantined').length, 1);
    assert.ok(mailbox.usedMb > 0);
    assert.equal(e.getMailboxByAddress('nobody@acme.co.ke'), undefined);
  });

  it('computes deliverability analytics', () => {
    const e = new EmailEngine();
    const domain = e.registerDomain({ domain: 'acme.co.ke' });
    e.verifyDomain(domain.id);
    const mailbox = e.createMailbox({ domainId: domain.id, address: 'a' });
    e.send({ from: 'a@acme.co.ke', to: ['b@other.io'], subject: '1', body: 'x' });
    e.send({ from: 'a@acme.co.ke', to: ['b@other.io'], subject: '2', body: 'x' });
    e.receive({ to: 'a@acme.co.ke', from: 'x@y.io', subject: 'in', body: 'hi' });
    e.receive({ to: 'a@acme.co.ke', from: 'x@y.io', subject: 'spam', body: 'hi' });
    const stats = e.stats();
    assert.equal(stats.domains, 1);
    assert.equal(stats.verifiedDomains, 1);
    assert.equal(stats.mailboxes, 1);
    assert.equal(stats.outbound, 2);
    assert.equal(stats.sent, 2);
    assert.equal(stats.deliveredRate, 1);
    assert.equal(stats.inbound, 2);
    // y.io has no registered domain policy, so both messages are 'received'.
    assert.equal(stats.spam, 0);
  });
});
