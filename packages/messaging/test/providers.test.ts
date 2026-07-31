// Provider adapter tests against local mock API servers.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SendGridProvider, TwilioProvider, AfricasTalkingProvider, MessagingError } from '../src/index.js';

function mockServer(routes: Record<string, (body: string, req: http.IncomingMessage) => { status: number; json: unknown; headers?: Record<string, string> }>): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
        const key = `${req.method} ${req.url}`;
        const handler = routes[key];
        if (handler) { const { status, json, headers } = handler(body, req); res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(json)); }
        else { res.writeHead(404); res.end('{}'); }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

// --- SendGrid ----------------------------------------------------------------

describe('SendGridProvider (email)', () => {
  let srv: { server: http.Server; port: number };
  let provider: SendGridProvider;
  const received: { body: string; auth?: string }[] = [];

  before(async () => {
    srv = await mockServer({
      'POST /v3/mail/send': (body) => { received.push({ body, auth: undefined }); return { status: 202, json: {}, headers: { 'x-message-id': 'sg_123' } }; },
    });
    provider = new SendGridProvider({ apiKey: 'SG.test', apiBase: `http://127.0.0.1:${srv.port}`, timeoutMs: 3000 });
  });
  after(async () => { srv.server.closeAllConnections?.(); await new Promise<void>((r) => srv.server.close(() => r())); });

  it('sends an email and returns a queued result', async () => {
    received.length = 0;
    const result = await provider.send({ to: 'user@example.com', from: 'noreply@app.com', subject: 'Welcome', html: '<h1>Hi</h1>' });
    assert.equal(result.status, 'queued');
    assert.equal(result.messageId, 'sg_123');
    assert.equal(result.providerId, 'sendgrid');
    const parsed = JSON.parse(received[0]!.body);
    assert.equal(parsed.personalizations[0].to[0].email, 'user@example.com');
    assert.equal(parsed.from.email, 'noreply@app.com');
    assert.equal(parsed.subject, 'Welcome');
  });

  it('throws MessagingError on a 4xx response', async () => {
    const failSrv = await mockServer({ 'POST /v3/mail/send': () => ({ status: 400, json: { errors: [{ message: 'invalid email' }] } }) });
    const fp = new SendGridProvider({ apiKey: 'SG.x', apiBase: `http://127.0.0.1:${failSrv.port}`, timeoutMs: 3000 });
    await assert.rejects(() => fp.send({ to: 'bad', from: 'x@y.com', subject: 's' }), MessagingError);
    failSrv.server.closeAllConnections?.(); await new Promise<void>((r) => failSrv.server.close(() => r()));
  });
});

// --- Twilio ------------------------------------------------------------------

describe('TwilioProvider (SMS)', () => {
  let srv: { server: http.Server; port: number };
  let provider: TwilioProvider;

  before(async () => {
    srv = await mockServer({
      'POST /2010-04-01/Accounts/AC_test/Messages.json': (body, req) => ({
        status: 201, json: { sid: 'SM_test_1', status: 'queued' },
      }),
    });
    provider = new TwilioProvider({ accountSid: 'AC_test', authToken: 'tok', fromNumber: '+1234567890', apiBase: `http://127.0.0.1:${srv.port}`, timeoutMs: 3000 });
  });
  after(async () => { srv.server.closeAllConnections?.(); await new Promise<void>((r) => srv.server.close(() => r())); });

  it('sends an SMS and returns the message SID', async () => {
    const result = await provider.send({ to: '+254712345678', body: 'Your code is 1234' });
    assert.equal(result.status, 'queued');
    assert.equal(result.messageId, 'SM_test_1');
    assert.equal(result.providerId, 'twilio');
  });
});

// --- Africa's Talking --------------------------------------------------------

describe('AfricasTalkingProvider (SMS, KE locale)', () => {
  let srv: { server: http.Server; port: number };
  let provider: AfricasTalkingProvider;
  const received: { body: string; apiKey?: string | string[] | undefined }[] = [];

  before(async () => {
    srv = await mockServer({
      'POST /version1/messaging': (body, req) => {
        received.push({ body, apiKey: req.headers['apikey'] });
        return { status: 201, json: { SMSMessageData: { Message: 'Sent to 1/1 Total Cost: KES 1.0', Messages: [{ messageId: 'AT_msg_1', status: 'Success', cost: 'KES 1.0', number: '+254712345678' }] } } };
      },
    });
    provider = new AfricasTalkingProvider({ apiKey: 'atsk_test', username: 'sandbox', apiBase: `http://127.0.0.1:${srv.port}`, timeoutMs: 3000 });
  });
  after(async () => { srv.server.closeAllConnections?.(); await new Promise<void>((r) => srv.server.close(() => r())); });

  it('sends an SMS via Africa\u2019s Talking and parses the cost', async () => {
    received.length = 0;
    const result = await provider.send({ to: '+254712345678', body: 'Habari! Your JATA Qi account is ready.' });
    assert.equal(result.status, 'sent');
    assert.equal(result.providerId, 'africas-talking');
    assert.equal(result.messageId, 'AT_msg_1');
    assert.equal(result.cost, 1.0);
    // Verify the API key header + form body.
    assert.equal(received[0]!.apiKey, 'atsk_test');
    assert.ok(received[0]!.body.includes('username=sandbox'));
    assert.ok(received[0]!.body.includes('254712345678'));
  });
});
