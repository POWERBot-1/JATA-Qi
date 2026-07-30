// JATA Qi SDK — Basic Usage Example
//
// This example demonstrates all major SDK operations against a running JATA Qi server.
// Start a server first:
//   node packages/cli/dist/src/index.js serve
//
// Then run:
//   node packages/sdk/examples/basic-usage.mjs

import { JataQiClient } from '../dist/src/index.js';

const BASE = process.env.JATAQI_URL ?? 'http://127.0.0.1:7400';

async function main() {
  const client = new JataQiClient({ baseUrl: BASE });

  // 1. Health check.
  const health = await client.health.check();
  console.log(`✓ Server: ${health.status} (${health.modules.length} modules)`);

  // 2. Identity (creator: GITANYA K).
  const identity = await client.identity.creator();
  console.log(`✓ Creator: ${identity.creator.display_name}`);

  // 3. Readiness.
  const readiness = await client.readiness.summary();
  console.log(`✓ Readiness: ${readiness.overall} (${readiness.total} capabilities)`);

  // 4. Register + login.
  await client.auth.register('demo-user', 'demo-pw', ['developer']);
  await client.auth.login('demo-user', 'demo-pw');
  console.log('✓ Authenticated as demo-user');

  // 5. Run a QiL workflow.
  const result = await client.qil.objective('Analyze quarterly performance');
  console.log(`✓ Workflow: ${result.result.status} (${result.result.steps.length} steps)`);
  console.log(`  Report: ${result.result.finalReport.slice(0, 100)}...`);

  // 6. Check entitlements.
  const entitlement = await client.commerce.check('ai.requests');
  console.log(`✓ Entitlement: ai.requests = ${entitlement.decision.quota} (remaining: ${entitlement.decision.remaining})`);

  // 7. List models.
  const models = await client.models.list();
  console.log(`✓ Models: ${models.models.length} available`);

  // 8. Governance.
  const gov = await client.gov.evaluate('knowledge.read');
  console.log(`✓ Governance: knowledge.read → ${gov.decision.decision}`);

  // 9. Feature flags.
  await client.flags.set('new-dashboard', true, 100);
  const flag = await client.flags.check('new-dashboard');
  console.log(`✓ Feature flag: new-dashboard = ${flag.enabled}`);

  // 10. Notifications.
  const notifs = await client.notifications.list();
  console.log(`✓ Notifications: ${notifs.unread} unread`);

  await client.auth.logout();
  console.log('✓ Logged out. Done!');
}

main().catch((err) => { console.error('Error:', err.message); process.exit(1); });
