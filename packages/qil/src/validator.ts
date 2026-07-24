// QiL semantic validator — checks a parsed program against the language rules
// and returns structured diagnostics. Does not throw on user errors; it collects
// them so tooling can report many problems at once.

import type { Diagnostic, QiLProgram, QiLStatement } from './types.js';
import { ACTION_KEYWORDS, ALL_KEYWORDS } from './types.js';

export function validate(program: QiLProgram): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const stmt of program.statements) {
    validateStatement(stmt, diags, new Set<string>());
  }
  return diags;
}

function validateStatement(stmt: QiLStatement, diags: Diagnostic[], ancestors: Set<string>): void {
  // Unknown keyword.
  if (!ALL_KEYWORDS.has(stmt.keyword)) {
    diags.push({
      severity: 'error',
      message: `unknown statement "${stmt.keyword}" — not a recognized QiL keyword`,
      line: stmt.line,
      col: stmt.col,
    });
  }

  // MISSION should be a top-level concern; warn if deeply nested.
  if (stmt.keyword === 'MISSION' && ancestors.size > 0) {
    diags.push({
      severity: 'warning',
      message: 'MISSION is usually a top-level statement',
      line: stmt.line,
      col: stmt.col,
    });
  }

  // Only structural keywords (MISSION, GOAL) may contain child blocks.
  const allowsChildren = stmt.keyword === 'MISSION' || stmt.keyword === 'GOAL';
  if (!allowsChildren && stmt.children.length > 0) {
    diags.push({
      severity: 'error',
      message: `"${stmt.keyword}" cannot contain a nested block`,
      line: stmt.line,
      col: stmt.col,
    });
  }

  // AGENT / TEAM / MODEL / DATASET should name their subject.
  const needsSubject = stmt.keyword === 'AGENT' || stmt.keyword === 'TEAM' || stmt.keyword === 'MODEL' || stmt.keyword === 'DATASET';
  if (needsSubject && !stmt.subject && !stmt.argument) {
    diags.push({
      severity: 'warning',
      message: `"${stmt.keyword}" is missing a name`,
      line: stmt.line,
      col: stmt.col,
    });
  }

  // Action keywords lower to steps; validate they are known actions.
  if (stmt.keyword in ACTION_KEYWORDS) {
    // ok — recognized action
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(stmt.keyword);
  for (const child of stmt.children) {
    validateStatement(child, diags, nextAncestors);
  }
}

/** True if any diagnostic is an error. */
export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
