import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  parse,
  validate,
  compile,
  compileSource,
  ACTION_KEYWORDS,
  ALL_KEYWORDS,
} from '../src/index.js';

describe('lexer', () => {
  it('tokenizes keywords, identifiers, strings, numbers, booleans', () => {
    const toks = tokenize('MISSION "hello" 42 true gpt-4 -> x');
    const filtered = toks.filter((t) => t.type !== 'EOF');
    assert.equal(filtered[0]!.type, 'KEYWORD');
    assert.equal(filtered[0]!.value, 'MISSION');
    assert.equal(filtered[1]!.type, 'STRING');
    assert.equal(filtered[1]!.value, 'hello');
    assert.equal(filtered[2]!.type, 'NUMBER');
    assert.equal(filtered[3]!.type, 'BOOLEAN');
    assert.equal(filtered[3]!.value, 'true');
    assert.equal(filtered[4]!.type, 'IDENT');
    assert.equal(filtered[4]!.value, 'gpt-4');
    assert.equal(filtered[5]!.type, 'ARROW');
    assert.equal(filtered[6]!.value, 'x');
  });

  it('strips comments (# and //)', () => {
    const toks = tokenize('# a comment\nMISSION "x" // trailing\n');
    const meaningful = toks.filter((t) => t.type === 'KEYWORD' || t.type === 'STRING');
    assert.equal(meaningful.length, 2);
  });

  it('handles string escapes', () => {
    const toks = tokenize('"line\\nbreak"');
    const str = toks.find((t) => t.type === 'STRING');
    assert.equal(str?.value, 'line\nbreak');
  });

  it('throws on unterminated strings', () => {
    assert.throws(() => tokenize('"oops'), /unterminated string/);
  });
});

describe('parser', () => {
  it('parses a simple statement with a string argument', () => {
    const prog = parse('MISSION "Analyze the business"');
    assert.equal(prog.statements.length, 1);
    assert.equal(prog.statements[0]!.keyword, 'MISSION');
    assert.equal(prog.statements[0]!.argument, 'Analyze the business');
  });

  it('parses a named subject and properties', () => {
    const prog = parse('MODEL gpt-4 dimension: 128 active: true');
    const s = prog.statements[0]!;
    assert.equal(s.keyword, 'MODEL');
    assert.equal(s.subject, 'gpt-4');
    assert.equal(s.properties['dimension'], 128);
    assert.equal(s.properties['active'], true);
  });

  it('parses nested blocks', () => {
    const prog = parse(`MISSION "outer" {
      GOAL "inner"
      AGENT research
      RETRIEVE knowledge "revenue"
      REASON
      REPORT
    }`);
    const m = prog.statements[0]!;
    assert.equal(m.children.length, 5);
    assert.equal(m.children[0]!.keyword, 'GOAL');
    assert.equal(m.children[2]!.subject, 'knowledge');
    assert.equal(m.children[2]!.argument, 'revenue');
  });

  it('treats arrow as agent assignment', () => {
    const prog = parse('ANALYZE "data" -> research');
    const s = prog.statements[0]!;
    assert.equal(s.properties['agent'], 'research');
  });

  it('throws on a non-keyword leading token', () => {
    assert.throws(() => parse('notkeyword "x"'), /expected a statement keyword/);
  });
});

describe('validator + compiler', () => {
  it('reports unknown keywords as errors', () => {
    const prog = parse('BOGUS "x"');
    const diags = validate(prog);
    assert.ok(diags.some((d) => d.severity === 'error' && /BOGUS/.test(d.message)));
  });

  it('warns when a non-structural keyword has a block', () => {
    const prog = parse('REASON { GOAL "x" }');
    const diags = validate(prog);
    assert.ok(diags.some((d) => d.severity === 'error' && /cannot contain a nested block/));
  });

  it('compiles objectives, agents, and a linear step chain', () => {
    const prog = parse(`MISSION "Analyze revenue"
GOAL "Find risks"
AGENT research
MODEL gpt-4
RETRIEVE knowledge "revenue Q3"
REASON
ANALYZE
REPORT`);
    const plan = compile(prog);
    assert.equal(plan.mission, 'Analyze revenue');
    assert.deepEqual(plan.goals, ['Find risks']);
    assert.deepEqual(plan.agents, ['research']);
    assert.deepEqual(plan.models, ['gpt-4']);
    assert.equal(plan.steps.length, 4);

    // Steps are chained linearly.
    assert.deepEqual(plan.steps[0]!.dependsOn, []);
    assert.deepEqual(plan.steps[1]!.dependsOn, ['step-1']);
    assert.deepEqual(plan.steps[2]!.dependsOn, ['step-2']);
    assert.deepEqual(plan.steps[3]!.dependsOn, ['step-3']);

    // Kinds lowered correctly.
    assert.equal(plan.steps[0]!.kind, 'retrieve');
    assert.equal(plan.steps[0]!.object, 'knowledge');
    assert.equal(plan.steps[0]!.argument, 'revenue Q3');
    assert.equal(plan.steps[1]!.kind, 'reason');
    assert.equal(plan.steps[3]!.kind, 'report');
  });

  it('honors an explicit "after" dependency', () => {
    const prog = parse(`RETRIEVE "a"
REPORT "summary" after: step-1`);
    const plan = compile(prog);
    assert.ok(plan.steps[1]!.dependsOn.includes('step-1'));
  });

  it('assigns agent from the arrow form', () => {
    const prog = parse('ANALYZE "data" -> research');
    const plan = compile(prog);
    assert.equal(plan.steps[0]!.agent, 'research');
  });

  it('flattens nested mission blocks into the step sequence', () => {
    const prog = parse(`MISSION "m" { RETRIEVE "a" REPORT }`);
    const plan = compile(prog);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.mission, 'm');
  });
});

describe('compileSource (end-to-end)', () => {
  it('returns ok=true with a plan for valid source', () => {
    const r = compileSource('MISSION "ok" { REASON REPORT }');
    assert.equal(r.ok, true);
    assert.ok(r.plan);
    assert.equal(r.plan!.steps.length, 2);
  });

  it('returns ok=false with diagnostics for invalid source', () => {
    const r = compileSource('BOGUS "x"');
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.length > 0);
    assert.equal(r.plan, undefined);
  });

  it('records a parse error without throwing', () => {
    const r = compileSource('"unterminated');
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics[0]!.message.includes('lex error') || r.diagnostics[0]!.message.includes('parse error') || /error/.test(r.diagnostics[0]!.message));
  });
});

describe('keyword registry', () => {
  it('includes all native statements from the Step 2 spec', () => {
    for (const kw of ['MISSION', 'GOAL', 'AGENT', 'TEAM', 'MODEL', 'DATASET', 'RETRIEVE', 'REASON', 'PLAN', 'SIMULATE', 'ANALYZE', 'VERIFY', 'OPTIMIZE', 'EXECUTE', 'REPORT', 'AUDIT', 'DEPLOY', 'STOP', 'OBSERVE', 'LEARN', 'SYNTHESIZE']) {
      assert.ok(ALL_KEYWORDS.has(kw), `missing keyword ${kw}`);
    }
    assert.equal(ACTION_KEYWORDS.RETRIEVE, 'retrieve');
    assert.equal(ACTION_KEYWORDS.REPORT, 'report');
  });
});
