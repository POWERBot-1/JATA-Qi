// QiL compiler — lowers a parsed QiL program into an ExecutionPlan (a DAG of
// steps) that the orchestrator can execute.
//
// Lowering rules (see Step 2/3 of the JATA AI specification):
//   - MISSION (argument)  -> plan.mission
//   - GOAL   (argument)   -> plan.goals[]
//   - AGENT  (subject)    -> plan.agents[]
//   - TEAM   (subject)    -> plan.teams[]
//   - MODEL  (subject)    -> plan.models[]
//   - DATASET(subject)    -> plan.datasets[]
//   - action statements   -> plan steps, in source order
//
// Steps form a linear chain by default (each step depends on the previous one).
// A trailing `-> agentName` routes a step to a named agent; an `after: "id"`
// property adds an explicit dependency edge.

import { randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  ExecutionPlan,
  PlanStep,
  QiLProgram,
  QiLStatement,
  QiLCompileResult,
  StepKind,
} from './types.js';
import { ACTION_KEYWORDS } from './types.js';
import { validate, hasErrors } from './validator.js';
import { parse } from './parser.js';

/** Flatten structural statements into a single ordered list of all statements. */
function flatten(stmts: readonly QiLStatement[], acc: QiLStatement[] = []): QiLStatement[] {
  for (const s of stmts) {
    acc.push(s);
    if (s.children.length) flatten(s.children, acc);
  }
  return acc;
}

export function compile(program: QiLProgram): ExecutionPlan {
  const flat = flatten(program.statements);

  const goals: string[] = [];
  const agents: string[] = [];
  const teams: string[] = [];
  const models: string[] = [];
  const datasets: string[] = [];
  let mission: string | undefined;

  const steps: PlanStep[] = [];
  let counter = 0;
  let prevId: string | undefined;

  for (const s of flat) {
    switch (s.keyword) {
      case 'MISSION':
        if (s.argument) mission = s.argument;
        break;
      case 'GOAL':
        if (s.argument) goals.push(s.argument);
        break;
      case 'AGENT':
        if (s.subject) agents.push(s.subject);
        break;
      case 'TEAM':
        if (s.subject) teams.push(s.subject);
        break;
      case 'MODEL':
        if (s.subject) models.push(s.subject);
        break;
      case 'DATASET':
        if (s.subject) datasets.push(s.subject);
        break;
      default: {
        const kind = (ACTION_KEYWORDS as Record<string, StepKind>)[s.keyword];
        if (!kind) break; // unknown keyword — left to the validator to report
        counter++;
        const id = `step-${counter}`;
        const dependsOn: string[] = prevId ? [prevId] : [];

        const after = s.properties['after'];
        if (typeof after === 'string') {
          for (const part of after.split(',').map((x) => x.trim()).filter(Boolean)) {
            if (!dependsOn.includes(part)) dependsOn.push(part);
          }
        }

        const label = s.argument ?? s.subject;
        const agentFromProp = s.properties['agent'];
        const step: PlanStep = {
          id,
          kind,
          keyword: s.keyword,
          dependsOn,
          properties: { ...s.properties },
          line: s.line,
          ...(label !== undefined ? { label } : {}),
          ...(s.argument !== undefined ? { argument: s.argument } : {}),
          ...(s.subject !== undefined ? { object: s.subject } : {}),
          ...(typeof agentFromProp === 'string' ? { agent: agentFromProp } : {}),
        };

        steps.push(step);
        prevId = id;
        break;
      }
    }
  }

  return {
    id: randomUUID(),
    mission,
    goals,
    agents,
    teams,
    models,
    datasets,
    steps,
    source: program.source,
  };
}

/** Parse + validate + lower, returning a structured result with diagnostics. */
export function compileSource(source: string): QiLCompileResult {
  const diagnostics: Diagnostic[] = [];
  let program: QiLProgram | undefined;
  try {
    program = parse(source);
  } catch (err) {
    const e = err as { line?: number; col?: number; message: string };
    diagnostics.push({
      severity: 'error',
      message: e.message,
      line: e.line,
      col: e.col,
    });
    return { ok: false, diagnostics };
  }
  diagnostics.push(...validate(program));
  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, program };
  }
  const plan = compile(program);
  return { ok: true, diagnostics, program, plan };
}
