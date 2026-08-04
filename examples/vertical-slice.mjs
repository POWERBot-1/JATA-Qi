// Alpha vertical slice (Step 93 success criteria) — programmatic version.
//
// This demo boots the full JATA Qi stack and walks through the seven success
// criteria from the JATA AI specification (Step 93):
//   1. Authenticate
//   2. Submit a request
//   3. Have QiL generate a workflow
//   4. Execute one or more agents
//   5. Retrieve relevant knowledge
//   6. Receive a structured response
//   7. Produce an auditable execution record

import { createJataQi } from '../packages/cli/dist/src/bootstrap.js';

const qi = await createJataQi({ security: { bootstrapAdmin: { username: 'root', password: 'toor' } } });
const { kernel } = qi;

const sec = kernel.getModule('security');
const orch = kernel.getModule('orchestrator');
const knowledge = kernel.getModule('knowledge');

// --- Seed a little knowledge so retrieval has something to find. ---
await knowledge.ingestText('Acme Corporation revenue grew 12% in Q3, driven by enterprise contracts.');
await knowledge.ingestText('JATA Qi is a modular AI operating system with a QiL orchestration language.');

// 1. Authenticate (bootstrap admin).
const login = await sec.login('root', 'toor');
console.log('1. Authenticated as:', login.principal.username, '(', login.principal.roles.join(', '), ')');

// 2 & 3. Submit a request as a QiL program — the compiler generates a workflow.
const program = `
MISSION "Analyze Acme revenue"
GOAL "Identify growth drivers"
AGENT research
RETRIEVE knowledge "Acme revenue Q3"
REASON "Summarize the key revenue findings"
REPORT
`;

// 4, 5, 6, 7. The orchestrator executes the workflow: retrieval (5), agent
// reasoning (4), a structured report (6), and writes an audit record (7).
const result = await orch.runSource(program, { principal: login.principal, topK: 3 });

console.log('\n2-3. Compiled workflow (', result.steps.length, 'steps):');
for (const s of result.steps) console.log('   -', s.keyword, s.status);

console.log('\n5. Retrieved', result.retrieved.length, 'knowledge snippet(s).');
console.log('\n6. Structured response:\n' + result.finalReport);
console.log('\n7. Audit record id:', result.auditRecordId);

// Read back the audit ledger.
const ledger = await sec.getAuditLog().query({ action: 'orchestrator.run' });
console.log('   (', ledger.length, 'orchestration run(s) recorded in the ledger )');

await qi.shutdown();
