// SDK platform tour — the multi-user + governance surface via the SDK.
//
// Usage (server must be running, e.g. `jataqi serve 7400`):
//   node examples/sdk-platform.mjs http://localhost:7400 admin admin
//
// Demonstrates:
//   1. TanyaClient — org-scoped chat, share by IdP email, shared inbox, export
//   2. AlertsClient — governance SLA rule evaluation
//   3. OrgClient — create, invite, accept, members
//   4. AuditClient — compliance export (CSV)

import { JataQiClient } from '../packages/sdk/dist/src/index.js';

const baseUrl = process.argv[2] ?? 'http://localhost:7400';
const username = process.argv[3] ?? 'admin';
const password = process.argv[4] ?? 'admin';

const client = new JataQiClient({ baseUrl });
try {
  await client.auth.login(username, password);
} catch {
  await client.auth.register(username, password, ['developer']);
  await client.auth.login(username, password);
}
console.log(`✓ authenticated as ${username}`);

// 1. Organization: create + invite + accept.
let orgId;
try {
  const org = await client.org.create('SDK Tour Org', 'sdk-tour');
  orgId = org.organization.id;
  console.log(`✓ org created: ${orgId}`);
  const invitation = await client.org.invite(orgId, 'tour-colleague@example.com');
  console.log(`✓ invitation token: ${invitation.invitation.token.slice(0, 8)}…`);
} catch (e) {
  console.log(`· org step skipped: ${e.message}`);
}

// 2. TANYA: org-scoped chat + export.
const chat = await client.tanya.chat('SDK platform tour', { ...(orgId ? { orgId } : {}) });
console.log(`✓ tanya chat: ${chat.conversationId.slice(0, 8)}… (${chat.messageCount} messages)`);
const md = await client.tanya.export(chat.conversationId, 'markdown');
console.log(`✓ conversation export (markdown): ${md.split('\n').length} lines`);
const stats = await client.tanya.stats();
console.log(`✓ tanya stats: ${stats.conversations} conversations`);

// 3. Governance alerts.
const { alerts } = await client.alerts.list();
console.log(`✓ SLA rules: ${alerts.map((a) => `${a.id}=${a.state}`).join(', ')}`);

// 4. Audit export (CSV).
const csv = await client.audit.exportCsv({ limit: 5 });
console.log(`✓ audit CSV: header "${csv.split('\r\n')[0]}"`);

client.streaming.close();
console.log('\n✓ SDK platform tour complete');
