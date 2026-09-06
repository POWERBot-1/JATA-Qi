// R-4 `jataqi {ask,ingest,stats,search,entities}` — tenant-explicit operator
// knowledge commands.
//
// Why this module exists
// ----------------------
// T-08.1 K1 removed the implicit `NODE_ENV`/`VITEST` authorization for the
// knowledge `DEFAULT_TENANT_ID` fallback: only an explicit
// `JATAQI_ALLOW_DEFAULT_TENANT_FALLBACK=1` /
// `JATAQI_TEST_ONLY_DEFAULT_TENANT_FALLBACK=1` may authorize it, so every
// tenant-less knowledge call now fails closed. The CLI's agent-oriented
// commands predate that change and passed no tenant at all:
//
//   * `ingest`, `stats`, `entities` threw at runtime (guard fail-closed);
//   * `search` called `KnowledgeService.retrieve()` with `tenantId: undefined`,
//     which is the legacy UNSCOPED path — no vector filter and no post-filter —
//     so one tenant's CLI search could return another tenant's chunks;
//   * `ask`/`repl` ran the agent with no `metadata.tenantId`, so the built-in
//     `knowledge.search` / `graph.*` / `vector.search` tools resolved no tenant
//     either (retrieval unscoped, graph calls fail-closed).
//
// The boundary chosen here is the smallest architecturally correct one, and it
// mirrors conventions this CLI already uses:
//
//   1. The operator tenant is a property of the DEPLOYMENT, read from
//      `JATAQI_OPERATOR_TENANT` — the same operator-tenant variable the
//      read-only `host:*` inspection commands use. It is never established by
//      argv alone: a caller cannot self-declare tenant authority (the doctrine
//      `host:enqueue` already states for principals and methods).
//   2. `--tenant <tenantId>` is a CONSISTENCY CHECK ONLY, exactly like
//      `host:enqueue --tenant`: it must equal the configured operator tenant or
//      the command is refused. It can never override, widen, or substitute it.
//   3. When no tenant can be established the command FAILS CLOSED before any
//      data-plane call: nothing is read, written, searched, or listed, and no
//      default tenant is silently substituted.
//   4. The reserved test-only `DEFAULT_TENANT_ID` is refused as an operator
//      tenant, so no CLI invocation can operate inside (or read out of) the
//      shared default bucket that T-08/T-08.1 deprecated.
//   5. The T-08.1 fallback flags are never set, exported, or hinted at here: the
//      service-level guard stays armed for every other caller.
//
// Retrieval is additionally narrowed at this boundary (belt and braces): a hit
// whose chunk or document is not tagged with the operator tenant is dropped
// before it can be printed, so a service-level regression could not turn into a
// cross-tenant disclosure through the CLI.

import { DEFAULT_TENANT_ID } from '@jataqi/knowledge-service';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';

/** Operator knowledge commands handled by this module. */
export type KnowledgeCommand = 'ask' | 'ingest' | 'stats' | 'search' | 'entities';

export const KNOWLEDGE_COMMANDS: readonly KnowledgeCommand[] = Object.freeze([
  'ask',
  'ingest',
  'stats',
  'search',
  'entities',
]);

export function isKnowledgeCommand(cmd: string): cmd is KnowledgeCommand {
  return (KNOWLEDGE_COMMANDS as readonly string[]).includes(cmd);
}

/** Why a tenant could not be established. Every reason is a refusal. */
export type CliTenantRefusalReason =
  /** No `JATAQI_OPERATOR_TENANT` and no `--tenant`: nothing to scope to. */
  | 'missing'
  /** `JATAQI_OPERATOR_TENANT` present but empty/whitespace. */
  | 'blank'
  /** The resolved tenant is the reserved test-only `DEFAULT_TENANT_ID`. */
  | 'reserved-default'
  /** `--tenant` disagrees with the configured operator tenant. */
  | 'mismatch'
  /** `--tenant` supplied with no configured tenant: self-declared authority. */
  | 'self-declared';

/**
 * Thrown when the operator tenant cannot be established. It is a refusal, not a
 * partial success: callers must perform no data-plane work at all.
 */
export class CliTenantRefusal extends Error {
  readonly reason: CliTenantRefusalReason;

  constructor(reason: CliTenantRefusalReason, message: string) {
    super(message);
    this.name = 'CliTenantRefusal';
    this.reason = reason;
  }
}

export interface KnowledgeCommandArgs {
  /** Value of `--tenant`, when present. Consistency check only. */
  tenantId?: string;
  /** Remaining tokens: the file (`ingest`), query words (`search`/`ask`), or entity type (`entities`). */
  positional: string[];
}

/**
 * Parse the flags of an operator knowledge command. Unknown flags are rejected
 * (fail closed), so a mistyped or smuggled flag such as `--tenant=other` or
 * `--admin` can never be silently ignored or reinterpreted.
 */
export function parseKnowledgeCommandArgs(args: readonly string[]): KnowledgeCommandArgs {
  const out: KnowledgeCommandArgs = { positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      if (arg !== '--tenant') {
        throw new Error(`Unknown option for this command: ${arg} (only --tenant is accepted, and only as a consistency check).`);
      }
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--tenant requires a value.');
      }
      if (out.tenantId !== undefined && out.tenantId !== next) {
        throw new Error('--tenant was supplied twice with different values.');
      }
      out.tenantId = next;
      i += 1;
      continue;
    }
    out.positional.push(arg);
  }
  return out;
}

/**
 * Resolve the operator tenant, or refuse.
 *
 * The configured deployment value (`JATAQI_OPERATOR_TENANT`) is authoritative.
 * `requested` (from `--tenant`) can only AGREE with it; it can never establish,
 * override, or widen it. No value is ever substituted for a missing tenant, and
 * the reserved test-only `DEFAULT_TENANT_ID` is never an acceptable operator
 * tenant.
 */
export function resolveOperatorTenant(env: NodeJS.ProcessEnv, requested?: string): string {
  const configuredRaw = env.JATAQI_OPERATOR_TENANT;
  const configured = typeof configuredRaw === 'string' ? configuredRaw.trim() : '';
  const wanted = typeof requested === 'string' ? requested.trim() : '';

  if (wanted.length > 0) {
    if (configured.length === 0) {
      throw new CliTenantRefusal(
        'self-declared',
        '--tenant cannot establish tenant authority on its own: the operator tenant comes from the deployment ' +
          'configuration (JATAQI_OPERATOR_TENANT), never from the command line. Failing closed.',
      );
    }
    if (wanted !== configured) {
      throw new CliTenantRefusal(
        'mismatch',
        `--tenant "${wanted}" does not equal the configured operator tenant. --tenant is a consistency check only; ` +
          'it can never override or widen the operator tenant. Refusing. Failing closed.',
      );
    }
  }

  if (configuredRaw === undefined) {
    throw new CliTenantRefusal(
      'missing',
      'No operator tenant is configured. Set JATAQI_OPERATOR_TENANT to the tenant this CLI process operates as. ' +
        'No default tenant is substituted and no knowledge data is read or written without one. Failing closed.',
    );
  }
  if (configured.length === 0) {
    throw new CliTenantRefusal(
      'blank',
      'JATAQI_OPERATOR_TENANT is set but empty. A blank tenant is not a tenant. Failing closed.',
    );
  }
  if (configured === DEFAULT_TENANT_ID) {
    throw new CliTenantRefusal(
      'reserved-default',
      `JATAQI_OPERATOR_TENANT is set to the reserved test-only DEFAULT_TENANT_ID ("${DEFAULT_TENANT_ID}"). The ` +
        'operator CLI may never read or write the shared default bucket. Failing closed.',
    );
  }
  return configured;
}

/** Agent runner narrowed to what the CLI needs, so the tenant is always passed. */
export type AgentRunner = (
  message: string,
  opts: { metadata: Record<string, unknown> },
) => Promise<{ answer: string }>;

export interface KnowledgeCommandDeps {
  knowledge: Pick<KnowledgeService, 'ingestText' | 'getChunk' | 'stats' | 'retrieve'>;
  graph: Pick<KnowledgeGraphModule, 'extractFromText' | 'linkMention' | 'stats' | 'allEntities' | 'entitiesByType'>;
  /** Agent entry point; the resolved tenant is always supplied as `metadata.tenantId`. */
  runAgent: AgentRunner;
  /** Injectable so tests never touch the filesystem. Defaults to `node:fs/promises`. */
  readFile?: (file: string) => Promise<string>;
  /** Injectable environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

async function defaultReadFile(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(file, 'utf8');
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Run one operator knowledge command. Returns a process exit code.
 *
 * Refusals print the reason and return 1 with NO data-plane call: tenant
 * resolution happens before the knowledge, graph, or agent dependency is
 * touched. Successful runs are strictly scoped to the resolved tenant.
 */
export async function runKnowledgeCommand(
  cmd: KnowledgeCommand,
  args: readonly string[],
  deps: KnowledgeCommandDeps,
  log: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  let parsed: KnowledgeCommandArgs;
  try {
    parsed = parseKnowledgeCommandArgs(args);
  } catch (error) {
    err(`${cmd}: ${(error as Error).message}`);
    return 1;
  }

  let tenantId: string;
  try {
    tenantId = resolveOperatorTenant(deps.env ?? process.env, parsed.tenantId);
  } catch (error) {
    const refusal = error as CliTenantRefusal;
    err(`${cmd}: refused (no tenant context; nothing was read, written, or searched): ${refusal.message}`);
    return 1;
  }

  const { knowledge, graph } = deps;
  try {
    switch (cmd) {
      case 'ingest': {
        const file = parsed.positional[0];
        if (!file) {
          err('Usage: jataqi ingest <file> [--tenant <tenantId>]');
          return 1;
        }
        const read = deps.readFile ?? defaultReadFile;
        const text = await read(file);
        const doc = await knowledge.ingestText(text, { title: file, tenantId });
        // Auto-extract entities for each chunk, tenant-scoped end to end.
        for (const cid of doc.chunkIds) {
          const c = await knowledge.getChunk(cid, { tenantId });
          if (!c) continue;
          const r = graph.extractFromText(c.text, { chunkId: cid, documentId: doc.id }, tenantId);
          for (const t of r.triples) {
            graph.linkMention(cid, t.object, 0.7, doc.id, tenantId);
          }
        }
        log(`Ingested ${file} → doc ${doc.id} (${doc.chunkIds.length} chunks) [tenant ${tenantId}]`);
        return 0;
      }
      case 'stats': {
        // Scoped counts only: the unscoped service call would report other
        // tenants' document/chunk totals.
        const ks = await knowledge.stats({ tenantId });
        const gs = graph.stats(tenantId);
        log(JSON.stringify({ tenantId, knowledge: ks, graph: gs }, null, 2));
        return 0;
      }
      case 'search': {
        const q = parsed.positional.join(' ').trim();
        if (!q) {
          err('Usage: jataqi search <query> [--tenant <tenantId>]');
          return 1;
        }
        const hits = await knowledge.retrieve(q, { tenantId, topK: 3, expandContext: false });
        // Belt and braces: never print a hit that is not tagged with the
        // operator tenant (untagged/legacy rows are dropped, not shown).
        const scoped = hits.filter((h) => h.chunk.tenantId === tenantId && h.document.tenantId === tenantId);
        for (const h of scoped) {
          log(`- [${h.score.toFixed(3)}] (doc=${h.document.id}) ${truncate(h.chunk.text)}`);
        }
        if (scoped.length === 0) log(`(no hits for tenant ${tenantId})`);
        return 0;
      }
      case 'entities': {
        const type = parsed.positional[0];
        const ents = type ? graph.entitiesByType(type, tenantId) : graph.allEntities(tenantId);
        for (const e of ents.slice(0, 50)) log(`[${e.type}] ${e.id}\t${e.name}`);
        log(`\n${ents.length} entities shown [tenant ${tenantId}]`);
        return 0;
      }
      case 'ask': {
        const q = parsed.positional.join(' ').trim();
        if (!q) {
          err('Usage: jataqi ask <question> [--tenant <tenantId>]');
          return 1;
        }
        // The tenant travels in the run metadata, which is what the built-in
        // knowledge.search / graph.* / vector.search tools read as their
        // execution tenant.
        const res = await deps.runAgent(q, { metadata: { tenantId } });
        log(res.answer);
        return 0;
      }
    }
  } catch (error) {
    const e = error as Error;
    err(`${cmd}: refused (failing closed): ${e.name}: ${e.message}`);
    return 1;
  }
}
