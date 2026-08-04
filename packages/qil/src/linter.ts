// QiL semantic linter — static analysis beyond the validator. Where the
// validator checks language rules, the linter checks *program quality*:
// duplicate declarations, dangling references, unused agents, unreachable
// steps, and empty missions. All findings are warnings (the program still
// compiles); editors and CI can treat them as actionable.

import type { Diagnostic, QiLProgram, QiLStatement } from './types.js';
import { ALL_KEYWORDS } from './types.js';
import { compile } from './lowerer.js';

/** Flatten structural statements into a single ordered list. */
function flatten(stmts: readonly QiLStatement[], acc: QiLStatement[] = []): QiLStatement[] {
  for (const s of stmts) {
    acc.push(s);
    if (s.children.length) flatten(s.children, acc);
  }
  return acc;
}

/** A lint run over QiL source (parses internally; returns [] on syntax errors). */
export function lintSource(source: string): Diagnostic[] {
  let program: QiLProgram;
  try {
    program = parseQuiet(source);
  } catch {
    return []; // syntax errors are reported by validate/compile
  }
  return lint(program);
}

/**
 * Lint a parsed program. Combines validator diagnostics with semantic
 * warnings. Never throws.
 */
export function lint(program: QiLProgram): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const flat = flatten(program.statements);

  // ---- declaration bookkeeping ------------------------------------------

  const declaredAgents = new Map<string, QiLStatement>();
  const declaredTeams = new Map<string, QiLStatement>();
  const declaredModels = new Map<string, QiLStatement>();
  const declaredDatasets = new Map<string, QiLStatement>();
  const missions: QiLStatement[] = [];
  const routedTo = new Set<string>();
  const afterRefs: Array<{ ref: string; stmt: QiLStatement }> = [];

  for (const s of flat) {
    const name = s.subject ?? s.argument;
    switch (s.keyword) {
      case 'MISSION':
        missions.push(s);
        break;
      case 'AGENT':
        if (name) registerUnique(declaredAgents, name, s, diags, 'agent');
        break;
      case 'TEAM':
        if (name) registerUnique(declaredTeams, name, s, diags, 'team');
        break;
      case 'MODEL':
        if (name) registerUnique(declaredModels, name, s, diags, 'model');
        break;
      case 'DATASET':
        if (name) registerUnique(declaredDatasets, name, s, diags, 'dataset');
        break;
      default:
        break;
    }
    // Trailing `-> agent` routing.
    const agent = s.properties['agent'];
    if (typeof agent === 'string') routedTo.add(agent);
    // Explicit dependency references.
    const after = s.properties['after'];
    if (typeof after === 'string') {
      for (const part of after.split(',').map((x) => x.trim()).filter(Boolean)) {
        afterRefs.push({ ref: part, stmt: s });
      }
    }
  }

  // ---- semantic checks ---------------------------------------------------

  // Multiple missions: only one MISSION per program is meaningful.
  if (missions.length > 1) {
    for (const m of missions.slice(1)) {
      diags.push(warn(`program has multiple MISSION blocks (first at line ${missions[0]!.line}); only the first is compiled`, m));
    }
  }

  // A mission with no action statements produces an empty plan.
  const actionCount = flat.filter((s) => s.keyword in ACTION_KEYWORDS_SET).length;
  if (missions.length > 0 && actionCount === 0) {
    diags.push(warn('MISSION declares no action statements — the compiled plan will be empty', missions[0]!));
  }

  // Route to undeclared agent.
  for (const target of routedTo) {
    if (!declaredAgents.has(target) && !declaredTeams.has(target) && !ALL_KEYWORDS.has(target.toUpperCase())) {
      diags.push(warn(`step routed to "${target}" which is never declared with AGENT/TEAM`, firstMention(flat, target)));
    }
  }

  // Declared agents never used.
  for (const [name, stmt] of declaredAgents) {
    if (!routedTo.has(name)) {
      diags.push(warn(`agent "${name}" is declared but no step routes to it`, stmt));
    }
  }

  // `after:` references that cannot resolve to a known step id. Step ids are
  // compiler-generated (`step-N`); validate them against the compiled plan.
  const stepIds = new Set(compile(program).steps.map((s) => s.id));
  for (const { ref, stmt } of afterRefs) {
    if (!stepIds.has(ref)) {
      diags.push(warn(`"after: ${ref}" does not match any step id in the compiled plan`, stmt));
    }
  }

  // Unreachable steps after STOP.
  const flatActions = flat.filter((s) => s.keyword in ACTION_KEYWORDS_SET);
  const stopIndex = flatActions.findIndex((s) => s.keyword === 'STOP');
  if (stopIndex >= 0 && stopIndex < flatActions.length - 1) {
    diags.push(warn('statements after STOP will never execute', flatActions[stopIndex + 1]!));
  }

  return diags;
}

// ---- helpers --------------------------------------------------------------

const ACTION_KEYWORDS_SET: Record<string, boolean> = {
  OBSERVE: true, RETRIEVE: true, LEARN: true, REASON: true, PLAN: true,
  SIMULATE: true, SYNTHESIZE: true, ANALYZE: true, VERIFY: true, OPTIMIZE: true,
  EXECUTE: true, REPORT: true, AUDIT: true, DEPLOY: true, STOP: true,
};

function registerUnique(
  map: Map<string, QiLStatement>,
  name: string,
  stmt: QiLStatement,
  diags: Diagnostic[],
  kind: string,
): void {
  if (map.has(name)) {
    diags.push(warn(`duplicate ${kind} declaration "${name}" (first declared at line ${map.get(name)!.line})`, stmt));
  } else {
    map.set(name, stmt);
  }
}

function firstMention(flat: QiLStatement[], name: string): QiLStatement {
  return flat.find((s) => (s.subject ?? s.argument) === name) ?? flat[0]!;
}

function warn(message: string, stmt: QiLStatement): Diagnostic {
  return { severity: 'warning', message, line: stmt.line, col: stmt.col };
}

/** Local parse import (avoids a circular import through the index). */
import { parse as parseQuiet } from './parser.js';
