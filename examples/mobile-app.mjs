// TANYA Mobile Native demo — the full mobile surface via the SDK.
//
// Usage (server must be running, e.g. `jataqi serve 7400`):
//   node examples/mobile-app.mjs http://localhost:7400 admin admin
//
// Demonstrates:
//   1. Device registration (FCM token)
//   2. Home-screen snapshot (personas, orgs, conversations, counts)
//   3. Push notification payloads (APNs + FCM) via notify
//   4. Offline outbox sync replayed through TANYA chat
//   5. Event → push bridge (emitPush to any user)

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

// 1. Register a device.
const reg = await client.mobile.registerDevice('android', { pushToken: 'fcm-demo-token-1', name: 'Demo Pixel', locale: 'en' });
console.log(`✓ device registered: ${reg.device.id} (${reg.device.platform})`);

// 2. Home-screen snapshot.
const snap = await client.mobile.snapshot();
console.log(`✓ snapshot: ${snap.personas.length} persona(s), ${snap.myOrgs.length} org(s), ${snap.recentConversations.length} recent conversation(s), shared=${snap.sharedWithMeCount}, approvals=${snap.pendingApprovalCount}`);

// 3. Push payloads (APNs + FCM).
const notify = await client.mobile.notify('Hello', 'TANYA Mobile Native', { event: 'tanya.hello' });
console.log(`✓ push delivered to ${notify.delivered} device(s) — APNs title "${notify.payloads[0]?.apns.aps.alert.title}", FCM priority ${notify.payloads[0]?.fcm.priority}`);

// 4. Offline outbox sync through TANYA chat.
const outbox = await client.mobile.syncOutbox([{ id: 'demo-om-1', message: 'Message composed offline' }]);
console.log(`✓ outbox: ${outbox.results[0]?.status} — reply: "${outbox.results[0]?.reply?.slice(0, 60)}…" (conversation ${outbox.results[0]?.conversationId?.slice(0, 8)})`);

// 5. Event → push bridge (generic channel).
const pushed = await client.mobile.emitPush(snap.userId, 'Bridge event', 'Delivered through mobile.push.requested', { event: 'demo.bridge' });
console.log(`✓ bridge push delivered to ${pushed.delivered} device(s)`);

client.streaming.close();
console.log('\n✓ TANYA Mobile Native demo complete');
