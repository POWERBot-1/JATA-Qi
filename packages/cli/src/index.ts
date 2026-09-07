#!/usr/bin/env node
// JATA Qi CLI — boots the OS and offers simple commands.

import { createJataQiFromEnv } from './bootstrap.js';
import { loadEnv } from './config.js';
import { parseHostArgs, runHostCommand } from './host-command.js';
import { runHostInspectCommand } from './host-inspect.js';
import { runHostEnqueueCommand } from './host-ingress-command.js';
import {
  isKnowledgeCommand,
  parseKnowledgeCommandArgs,
  resolveOperatorTenant,
  runKnowledgeCommand,
  type KnowledgeCommandDeps,
} from './knowledge-command.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';

const HELP = `
JATA Qi CLI
-----------
Commands:
  ask <question>      Run a single question through the default agent and exit.
  ingest <file>       Ingest a text file into the knowledge base.
  stats               Print knowledge/vector/graph stats.
  search <query>      Semantic search (no agent) — top 3 chunks.
  entities [<type>]   List entities in the knowledge graph.
  repl                Start an interactive REPL.
  help                Show this help.
  exit / quit         Exit REPL.

Operator tenant (R-4):
  Every knowledge-facing command (ask, ingest, stats, search, entities, repl)
  operates as exactly one tenant, taken from the deployment configuration:

        JATAQI_OPERATOR_TENANT=<tenantId>   Required. The tenant this CLI
                                            process operates as.

  Without it the command FAILS CLOSED before the kernel boots: nothing is read,
  written, searched, or listed, and NO default tenant is ever substituted. The
  reserved test-only default tenant is refused as an operator tenant.

        --tenant <tenantId>                 Optional consistency check ONLY.
                                            Must equal JATAQI_OPERATOR_TENANT or
                                            the command is refused; it can never
                                            override or widen it, and it can
                                            never establish a tenant on its own.

  Tenant scoping is end to end: ingest stamps the tenant on the document, its
  chunks, and the extracted graph; search and stats are filtered to it; and
  ask/repl pass it to the agent as the execution tenant for the built-in
  knowledge.search / graph.* / vector.search tools.

Host runtime (R-01):
  host [options]      Run the supervised, unattended governed host process.
                      Requires a durable storage driver (STORAGE_DRIVER=postgres
                      + JATAQI_PG_CONNECTION_STRING); refuses to start on
                      development-only storage. Ctrl-C / SIGTERM drains cleanly.
        --max-cycles <n>              Stop after n supervision cycles.
        --min-idle-ms <n>             Floor on the pause between cycles.
        --max-idle-ms <n>             Ceiling on the pause between cycles.
        --allow-non-durable-storage   Local development only; state is lost.

  host:work [status]  Read-only: list hosted work items (operator inspection).
  host:dlq            Read-only: list dead-lettered / quarantined work items.
  host:health         Read-only: print host lifecycle, storage driver, next wake, delivery health.
  host:outbox [state] Read-only: list unified-outbox records for the operator tenant (T-05).
  host:inbox [state]  Read-only: list durable subscriber inbox records for the operator tenant (T-05).

Authenticated work ingress (T-03):
  host:enqueue [options]
                      Create durable work behind the T-01/T-03 principal
                      boundary. Fails closed unless an authentication method is
                      configured; never self-attests a principal.
        --objective <text>          Required. What the loop is asked to do.
        --correlation-id <id>       Optional correlation identity.
        --idempotency-key <key>     Optional; re-submitting returns the same item.
        --tenant <tenantId>         Optional consistency check ONLY. Must equal
                                    the authenticated tenant or the request is
                                    refused; it can never override it.
        --roles <r1,r2>             Optional role NARROWING. Widening is refused.
        --knowledge-query <text>    Optional retrieval query for the loop.

      Credential material is read from JATAQI_AUTH_TOKEN (never argv), and the
      authentication METHOD comes from the configured JATAQI_AUTH_MODE — a
      caller cannot choose it. With no method configured the command refuses.

Host inspection commands are strictly read-only: they never dispatch, resume,
retry, approve, or settle anything. host:enqueue creates work; it never
dispatches, and the full 34-stage governed loop remains the only executor.
`;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'repl';

  // R-01: the host runtime and its read-only inspection commands own their own
  // kernel lifecycle (the host module must be explicitly enabled for them), so
  // they are dispatched before the standard agent-oriented boot below.
  if (cmd === 'host') {
    const code = await runHostCommand(parseHostArgs(args.slice(1)));
    process.exit(code);
  }
  if (cmd === 'host:work' || cmd === 'host:dlq' || cmd === 'host:health' || cmd === 'host:outbox' || cmd === 'host:inbox') {
    const code = await runHostInspectCommand(cmd, args.slice(1));
    process.exit(code);
  }
  // T-03: authenticated work ingress. Creates durable work and nothing else.
  if (cmd === 'host:enqueue') {
    const code = await runHostEnqueueCommand(args.slice(1));
    process.exit(code);
  }

  // `help` is pure text: it needs no tenant and boots nothing.
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  // R-4: the operator tenant is resolved BEFORE anything boots, so a
  // tenant-less invocation performs no data-plane work at all — no read, no
  // write, no search — and can never land in another tenant's (or the shared
  // default) knowledge. `--tenant` is only ever a consistency check.
  let requestedTenant: string | undefined;
  try {
    requestedTenant = parseKnowledgeCommandArgs(args.slice(1)).tenantId;
  } catch (error) {
    console.error(`${cmd}: ${(error as Error).message}`);
    process.exit(1);
  }
  let tenantId: string;
  try {
    tenantId = resolveOperatorTenant(process.env, requestedTenant);
  } catch (error) {
    console.error(
      `${cmd}: refused (no tenant context; nothing was booted, read, written, or searched): ${(error as Error).message}`,
    );
    process.exit(1);
  }

  const jataqi = await createJataQiFromEnv();
  const kernel = jataqi.kernel;
  const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
  const knowledge = kernel.getModule<KnowledgeService>('knowledge');
  const graph = kernel.getModule<KnowledgeGraphModule>('knowledge-graph');
  const deps: KnowledgeCommandDeps = {
    knowledge,
    graph,
    // The resolved tenant is threaded into the run metadata, which is the
    // execution tenant every built-in tool reads (knowledge.search, graph.*,
    // vector.search). Without it those tools retrieve unscoped or fail closed.
    runAgent: (message, opts) => agents.run(message, opts),
    env: process.env,
  };

  try {
    if (isKnowledgeCommand(cmd)) {
      const code = await runKnowledgeCommand(cmd, args.slice(1), deps);
      // Non-zero is recorded rather than process.exit()ed so the kernel is
      // still shut down cleanly by the finally block below.
      if (code !== 0) process.exitCode = code;
      return;
    }

    // repl (also the default for an unrecognized command)
    const rl = readline.createInterface({ input, output });
    console.log(`JATA Qi REPL [tenant ${tenantId}]. Type "help" for commands, "exit" to quit.`);
    while (true) {
      const line = (await rl.question('jataqi> ')).trim();
      if (!line) continue;
      if (line === 'exit' || line === 'quit') break;
      if (line === 'help') {
        console.log(HELP);
        continue;
      }
      const parts = line.split(/\s+/);
      const inner = parts[0] ?? '';
      if (isKnowledgeCommand(inner)) {
        // R-4: REPL sub-commands go through the SAME tenant-scoped path as the
        // top-level dispatch. They no longer mutate process.argv and re-enter
        // main() (which re-booted a second kernel per command and gave the
        // sub-command a fresh, unverified argv).
        const code = await runKnowledgeCommand(inner, parts.slice(1), deps);
        if (code !== 0) console.error(`(refused: exit ${code})`);
        continue;
      }
      const res = await agents.run(line, { metadata: { tenantId } });
      console.log(res.answer);
    }
    rl.close();
  } finally {
    await jataqi.shutdown();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
