// SDK streaming demo — typed WebSocket client for the /ws realtime channel.
//
// Usage (server must be running, e.g. `npm start` / `jataqi serve 7400`):
//   node examples/sdk-streaming.mjs <baseUrl> <username> <password>
//   node examples/sdk-streaming.mjs http://localhost:7400 admin admin
//
// Demonstrates:
//   1. StreamingClient — TANYA conversational streaming (tanya.chunk…)
//   2. QiL live plan execution (qil.step…) with a natural-language objective
//   3. Unified chat streaming (chat.chunk…)

import { JataQiClient } from '../packages/sdk/dist/src/index.js';

const baseUrl = process.argv[2] ?? 'http://localhost:7400';
const username = process.argv[3] ?? 'admin';
const password = process.argv[4] ?? 'admin';

const client = new JataQiClient({ baseUrl });

// 1. Authenticate — the SDK bearer token also authenticates the WebSocket.
try {
  await client.auth.login(username, password);
} catch (e) {
  // Fresh servers have no users yet — register as a developer, then log in.
  await client.auth.register(username, password, ['developer']);
  await client.auth.login(username, password);
}
console.log(`✓ authenticated as ${username}`);

// 2. TANYA conversational streaming — word chunks reassemble into the reply.
console.log('\n— TANYA streaming —');
const tanya = await client.streaming.tanyaChat('Give me a one-line summary of the platform', {
  onChunk: (c) => process.stdout.write(c),
});
process.stdout.write('\n');
console.log(`✓ conversation ${tanya.conversationId} (${tanya.messageCount} messages, persona ${tanya.persona})`);

// 3. QiL live plan execution — every step streams as it completes.
console.log('\n— QiL live execution —');
const qil = await client.streaming.qilObjective('Analyze the platform status', {
  onStep: (step, index, total) => {
    const icon = step.status === 'success' ? '✓' : step.status === 'error' ? '✗' : '·';
    console.log(`  ${icon} [${index + 1}/${total}] ${step.kind} (${step.durationMs}ms)`);
  },
});
console.log(`✓ run ${qil.runId} ${qil.status} · ${qil.stepCount} steps`);
console.log(`  report: ${String(qil.finalReport).slice(0, 140)}…`);

// 4. Unified chat streaming.
console.log('\n— unified chat streaming —');
const chat = await client.streaming.chat('Hello from the SDK', {
  onChunk: (c) => process.stdout.write(c),
});
process.stdout.write('\n');
console.log(`✓ chat done (${chat.conversationId ?? 'no conversation id'})`);

client.streaming.close();
console.log('\ndone.');
