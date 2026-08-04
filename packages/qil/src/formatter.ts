// QiL formatter — canonical pretty-printer for the Quantum Intelligence
// Language. Turn any syntactically valid QiL source into the canonical style:
//   2-space indentation, one statement per line, `keyword subject "arg"` then
//   properties as `key: value`, blocks on their own lines.
//
// Round-trip guarantee: `format` is idempotent — parse(format(src)) yields an
// equivalent AST, and format(format(src)) === format(src). This makes the
// formatter safe to run in CI / editors.

import type { Literal, QiLProgram, QiLStatement } from './types.js';
import { parse } from './parser.js';

/** Canonical indentation unit. */
const INDENT = '  ';

/** Render a literal in canonical form. */
export function renderLiteral(value: Literal): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/** Render a single statement (without indentation) on one line. */
export function renderStatementLine(stmt: QiLStatement): string {
  const parts: string[] = [stmt.keyword];
  if (stmt.subject !== undefined) parts.push(stmt.subject);
  if (stmt.argument !== undefined) parts.push(JSON.stringify(stmt.argument));
  // The arrow target (`-> agent`) is stored as the `agent` property by the
  // parser; render it back as a trailing arrow for readability.
  const { agent, ...rest } = stmt.properties;
  const propEntries = Object.entries(rest);
  if (propEntries.length > 0) {
    for (const [key, value] of propEntries) {
      parts.push(`${key}: ${renderLiteral(value)}`);
    }
  }
  if (typeof agent === 'string') parts.push(`-> ${agent}`);
  return parts.join(' ');
}

/**
 * Format a parsed program into canonical QiL source. Statements render in
 * order; structural statements (MISSION/GOAL) render their children in a
 * `{ }` block, one statement per line, indented by 2 spaces per level.
 */
export function formatProgram(program: QiLProgram): string {
  const lines: string[] = [];
  for (const stmt of program.statements) {
    renderStatement(stmt, 0, lines);
  }
  return lines.join('\n') + '\n';
}

/**
 * Format QiL source text into canonical style. Throws ParseError on syntax
 * errors (use lint/compileSource for non-throwing diagnostics).
 */
export function format(source: string): string {
  return formatProgram(parse(source));
}

/** Format a string literal for embedding in a diagnostic/error message. */
export function quote(text: string): string {
  return JSON.stringify(text);
}

// ---- internals ------------------------------------------------------------

function renderStatement(stmt: QiLStatement, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  if (stmt.children.length === 0) {
    lines.push(pad + renderStatementLine(stmt));
    return;
  }
  // Structural statement with a block: header on its own line, then `{`,
  // children indented, then `}`.
  lines.push(pad + renderStatementLine(stmt) + ' {');
  for (const child of stmt.children) {
    renderStatement(child, depth + 1, lines);
  }
  lines.push(pad + '}');
}
