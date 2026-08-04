// QiL tooling tests: formatter (canonical style, idempotence, round-trip)
// and semantic linter (duplicate declarations, dangling refs, unused agents,
// unreachable steps, empty missions).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { format, lint, lintSource, parse, compileSource, formatProgram } from '../src/index.js';

describe('QiL formatter', () => {
  it('formats a mission block in canonical style', () => {
    const source = `MISSION "Analyze quarterly revenue" { GOAL "Identify risks" AGENT research RETRIEVE knowledge "revenue Q3" REASON "Summarize the findings" REPORT }`;
    const formatted = format(source);
    assert.equal(formatted, [
      'MISSION "Analyze quarterly revenue" {',
      '  GOAL "Identify risks"',
      '  AGENT research',
      '  RETRIEVE knowledge "revenue Q3"',
      '  REASON "Summarize the findings"',
      '  REPORT',
      '}',
      '',
    ].join('\n'));
  });

  it('is idempotent — format(format(src)) === format(src)', () => {
    const source = `MISSION "x"{RETRIEVE "a" RETRIEVE "b" after: "step-1" REPORT}`;
    const once = format(source);
    const twice = format(once);
    assert.equal(twice, once);
  });

  it('round-trips through the parser to an equivalent program', () => {
    const source = `MISSION "m" { GOAL "g" AGENT a1 AGENT a2 RETRIEVE knowledge "q" -> a1 ANALYZE "risks" after: "step-1", "step-2" SIMULATE "scenario" trials: 1000 REPORT }`;
    const program = parse(source);
    const reformatted = parse(format(source));
    assert.equal(reformatted.statements.length, program.statements.length);
    // Compare ASTs ignoring source locations (formatting changes line/col by
    // design, but the structure and values must be identical).
    const stripLoc = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stripLoc);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k === 'line' || k === 'col' || k === 'source') continue;
          out[k] = stripLoc(val);
        }
        return out;
      }
      return v;
    };
    assert.deepEqual(stripLoc(reformatted), stripLoc(program));
  });

  it('renders properties and arrow routing canonically', () => {
    const source = 'SIMULATE "scenario" trials: 1000 confidence=0.9 -> analyst';
    const formatted = format(source);
    assert.equal(formatted, 'SIMULATE "scenario" trials: 1000 confidence: 0.9 -> analyst\n');
    // The parser stores the arrow target as properties.agent; rendering puts
    // it back as a trailing arrow (after regular properties).
    const program = parse(formatted);
    const stmt = program.statements[0]!;
    assert.equal(stmt.properties['agent'], 'analyst');
    assert.equal(stmt.properties['trials'], 1000);
  });

  it('formatProgram renders a parsed program directly', () => {
    const program = parse('REPORT');
    assert.equal(formatProgram(program), 'REPORT\n');
  });
});

describe('QiL semantic linter', () => {
  it('flags duplicate agent declarations', () => {
    const diags = lintSource('AGENT a1\nAGENT a1\nRETRIEVE "x" -> a1');
    const dup = diags.find((d) => d.message.includes('duplicate agent'));
    assert.ok(dup, 'expected duplicate-agent warning');
    assert.equal(dup!.severity, 'warning');
  });

  it('flags routes to undeclared agents and unused declared agents', () => {
    const diags = lintSource('AGENT research\nRETRIEVE "x" -> mystery');
    assert.ok(diags.some((d) => d.message.includes('never declared')));
    assert.ok(diags.some((d) => d.message.includes('"research" is declared but no step routes to it')));
  });

  it('flags dangling after: references', () => {
    const diags = lintSource('RETRIEVE "a"\nRETRIEVE "b" after: "step-99"');
    assert.ok(diags.some((d) => d.message.includes('after: step-99')));
  });

  it('flags statements after STOP as unreachable', () => {
    const diags = lintSource('RETRIEVE "a"\nSTOP\nREPORT');
    assert.ok(diags.some((d) => d.message.includes('after STOP will never execute')));
  });

  it('flags an empty mission and multiple missions', () => {
    const diags = lintSource('MISSION "empty"\nMISSION "second"');
    assert.ok(diags.some((d) => d.message.includes('no action statements')));
    assert.ok(diags.some((d) => d.message.includes('multiple MISSION')));
  });

  it('returns no warnings for a clean program', () => {
    const diags = lintSource('MISSION "clean" { AGENT a RETRIEVE "x" -> a REPORT }');
    assert.equal(diags.length, 0);
  });

  it('returns [] on syntax errors (delegates to compile diagnostics)', () => {
    assert.deepEqual(lintSource('MISSION "unterminated { RETRIEVE'), []);
  });

  it('works on a parsed program via lint()', () => {
    const diags = lint(parse('AGENT dup\nAGENT dup\nREPORT -> dup'));
    assert.ok(diags.some((d) => d.message.includes('duplicate agent')));
  });

  it('lint and compile agree on clean programs', () => {
    const source = 'MISSION "m" { AGENT a RETRIEVE "x" -> a REPORT }';
    const result = compileSource(source);
    assert.equal(result.ok, true);
    assert.equal(lintSource(source).length, 0);
  });
});
