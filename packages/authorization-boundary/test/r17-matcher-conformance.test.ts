// R-17 — MATCHER CONFORMANCE SUITE (OD-4 / U-1 / E-17)
//
// Asserts that `targetMatches` (in @jataqi/authorization-boundary) and
// `delegationTargetMatches` (in @jataqi/authentication) exhibit 100% identical
// verdicts across all test vectors, faithfully implementing U-1 semantics:
//
//   * `*` matches zero or more characters EXCLUDING `/` and `.` (segment glob);
//   * Suffix-confusion bypasses (T-04) are REFUTED at the matcher;
//   * Host cross-label escapes (T-05) are REFUTED at the matcher;
//   * Dot-segment / path escapes (T-06) are REFUTED at the matcher;
//   * Byte-identical function bodies are guarded against source-level drift.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { targetMatches } from '../src/index.js';
import { delegationTargetMatches, type DelegationTargetScope } from '@jataqi/authentication';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ConformanceVector {
  readonly label: string;
  readonly pattern: { readonly system: string; readonly resourcePattern?: string } | undefined;
  readonly system: string;
  readonly resource: string | undefined;
  readonly expected: boolean;
}

const CORPUS: readonly ConformanceVector[] = Object.freeze([
  // -------------------------------------------------------------------------
  // 1. Exact Match Vectors (No wildcards)
  // -------------------------------------------------------------------------
  {
    label: 'Exact: identical system and resource',
    pattern: { system: 'docs', resourcePattern: 'doc/1' },
    system: 'docs',
    resource: 'doc/1',
    expected: true,
  },
  {
    label: 'Exact: mismatched resource',
    pattern: { system: 'docs', resourcePattern: 'doc/1' },
    system: 'docs',
    resource: 'doc/2',
    expected: false,
  },
  {
    label: 'Exact: mismatched system',
    pattern: { system: 'docs', resourcePattern: 'doc/1' },
    system: 'billing',
    resource: 'doc/1',
    expected: false,
  },
  {
    label: 'Exact: partial prefix match without wildcard is rejected',
    pattern: { system: 'docs', resourcePattern: 'doc/1' },
    system: 'docs',
    resource: 'doc/10',
    expected: false,
  },
  {
    label: 'Exact: special characters in literal pattern',
    pattern: { system: 'api', resourcePattern: 'https://api.openai.com/v1/chat' },
    system: 'api',
    resource: 'https://api.openai.com/v1/chat',
    expected: true,
  },

  // -------------------------------------------------------------------------
  // 2. Undefined Pattern and Resource Matrix
  // -------------------------------------------------------------------------
  {
    label: 'Undefined: pattern is undefined ⇒ false for any target',
    pattern: undefined,
    system: 'docs',
    resource: 'doc/1',
    expected: false,
  },
  {
    label: 'Undefined: pattern is undefined with undefined resource ⇒ false',
    pattern: undefined,
    system: 'docs',
    resource: undefined,
    expected: false,
  },
  {
    label: 'Undefined: pattern resourcePattern is undefined and resource is undefined ⇒ true',
    pattern: { system: 'docs' },
    system: 'docs',
    resource: undefined,
    expected: true,
  },
  {
    label: 'Undefined: pattern resourcePattern is undefined but resource is provided ⇒ false',
    pattern: { system: 'docs' },
    system: 'docs',
    resource: 'doc/1',
    expected: false,
  },
  {
    label: 'Undefined: pattern resourcePattern is defined but resource is undefined ⇒ false',
    pattern: { system: 'docs', resourcePattern: 'doc/1' },
    system: 'docs',
    resource: undefined,
    expected: false,
  },
  {
    label: 'Undefined: pattern resourcePattern wildcard "*" vs undefined resource ⇒ false',
    pattern: { system: 'docs', resourcePattern: '*' },
    system: 'docs',
    resource: undefined,
    expected: false,
  },

  // -------------------------------------------------------------------------
  // 3. Segment Wildcard Globbing (U-1 Semantics: * excludes / and .)
  // -------------------------------------------------------------------------
  {
    label: 'Segment: single segment wildcard matches same-segment value',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/1',
    expected: true,
  },
  {
    label: 'Segment: single segment wildcard matches multi-character token',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/alpha-beta-123',
    expected: true,
  },
  {
    label: 'Segment: single segment wildcard matches zero characters',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/',
    expected: true,
  },
  {
    label: 'Segment: * REJECTS slash / (cannot cross segments)',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/sub/1',
    expected: false,
  },
  {
    label: 'Segment: * REJECTS dot . (cannot cross label/extension boundary)',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/1.json',
    expected: false,
  },
  {
    label: 'Segment: * REJECTS multiple slashes and subpaths',
    pattern: { system: 'docs', resourcePattern: 'doc/*' },
    system: 'docs',
    resource: 'doc/a/b/c',
    expected: false,
  },
  {
    label: 'Segment: prefix-wildcard in segment',
    pattern: { system: 'docs', resourcePattern: 'doc/res-*' },
    system: 'docs',
    resource: 'doc/res-42',
    expected: true,
  },
  {
    label: 'Segment: prefix-wildcard rejects segment with dot',
    pattern: { system: 'docs', resourcePattern: 'doc/res-*' },
    system: 'docs',
    resource: 'doc/res-42.bak',
    expected: false,
  },
  {
    label: 'Segment: suffix-wildcard in segment',
    pattern: { system: 'docs', resourcePattern: 'doc/*-item' },
    system: 'docs',
    resource: 'doc/first-item',
    expected: true,
  },

  // -------------------------------------------------------------------------
  // 4. Suffix Confusion Prevention (T-04 Probe vectors)
  // -------------------------------------------------------------------------
  {
    label: 'T-04: exact base pattern matches',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com*' },
    system: 'egress',
    resource: 'https://api.openai.com',
    expected: true,
  },
  {
    label: 'T-04: suffix confusion bypass with dot REJECTED (evil.com subdomain)',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com*' },
    system: 'egress',
    resource: 'https://api.openai.com.evil.com/steal',
    expected: false,
  },
  {
    label: 'T-04: suffix confusion bypass with dot REJECTED (attacker domain)',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com*' },
    system: 'egress',
    resource: 'https://api.openai.com.attacker.net',
    expected: false,
  },
  {
    label: 'T-04: path separator after host REJECTED by trailing * without slash',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/chat',
    expected: false,
  },
  {
    label: 'T-04: hyphenated suffix allowed when no delimiter is crossed',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com*' },
    system: 'egress',
    resource: 'https://api.openai.com-internal',
    expected: true,
  },

  // -------------------------------------------------------------------------
  // 5. Host Wildcard Label Boundaries (T-05 Probe vectors)
  // -------------------------------------------------------------------------
  {
    label: 'T-05: single DNS label match succeeds',
    pattern: { system: 'egress', resourcePattern: '*.openai.com' },
    system: 'egress',
    resource: 'api.openai.com',
    expected: true,
  },
  {
    label: 'T-05: alternative single DNS label match succeeds',
    pattern: { system: 'egress', resourcePattern: '*.openai.com' },
    system: 'egress',
    resource: 'auth.openai.com',
    expected: true,
  },
  {
    label: 'T-05: multi-label cross-domain escape REJECTED (* cannot match dot)',
    pattern: { system: 'egress', resourcePattern: '*.openai.com' },
    system: 'egress',
    resource: 'evil.api.openai.com',
    expected: false,
  },
  {
    label: 'T-05: bare apex domain REJECTED (requires the label and dot)',
    pattern: { system: 'egress', resourcePattern: '*.openai.com' },
    system: 'egress',
    resource: 'openai.com',
    expected: false,
  },
  {
    label: 'T-05: internal label wildcard matches exactly one label',
    pattern: { system: 'egress', resourcePattern: 'api.*.openai.com' },
    system: 'egress',
    resource: 'api.v1.openai.com',
    expected: true,
  },
  {
    label: 'T-05: internal label wildcard rejects nested labels',
    pattern: { system: 'egress', resourcePattern: 'api.*.openai.com' },
    system: 'egress',
    resource: 'api.v1.sub.openai.com',
    expected: false,
  },

  // -------------------------------------------------------------------------
  // 6. Dot-Segment / Path Traversal Prevention (T-06 Probe vectors)
  // -------------------------------------------------------------------------
  {
    label: 'T-06: path segment wildcard matches single segment',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com/v1/*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/chat',
    expected: true,
  },
  {
    label: 'T-06: path segment wildcard matches another single segment',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com/v1/*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/models',
    expected: true,
  },
  {
    label: 'T-06: dot-segment traversal ../../admin REJECTED at matcher',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com/v1/*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/../../admin',
    expected: false,
  },
  {
    label: 'T-06: traversal .. with segment hop REJECTED at matcher',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com/v1/*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/../v2/models',
    expected: false,
  },
  {
    label: 'T-06: deeper subpath REJECTED by single segment wildcard',
    pattern: { system: 'egress', resourcePattern: 'https://api.openai.com/v1/*' },
    system: 'egress',
    resource: 'https://api.openai.com/v1/chat/completions',
    expected: false,
  },

  // -------------------------------------------------------------------------
  // 7. Multi-Wildcard and Complex Segment Scenarios
  // -------------------------------------------------------------------------
  {
    label: 'Multi: two segment wildcards match two distinct segments',
    pattern: { system: 'storage', resourcePattern: 'tenants/*/files/*' },
    system: 'storage',
    resource: 'tenants/acme/files/report',
    expected: true,
  },
  {
    label: 'Multi: two segment wildcards reject intermediate subpath in first slot',
    pattern: { system: 'storage', resourcePattern: 'tenants/*/files/*' },
    system: 'storage',
    resource: 'tenants/acme/sub/files/report',
    expected: false,
  },
  {
    label: 'Multi: two segment wildcards reject intermediate subpath in second slot',
    pattern: { system: 'storage', resourcePattern: 'tenants/*/files/*' },
    system: 'storage',
    resource: 'tenants/acme/files/dir/report',
    expected: false,
  },
  {
    label: 'Multi: two segment wildcards reject dots in either slot',
    pattern: { system: 'storage', resourcePattern: 'tenants/*/files/*' },
    system: 'storage',
    resource: 'tenants/acme.corp/files/report',
    expected: false,
  },
  {
    label: 'Multi: pair segment pattern */*',
    pattern: { system: 'app', resourcePattern: '*/*' },
    system: 'app',
    resource: 'foo/bar',
    expected: true,
  },
  {
    label: 'Multi: pair segment pattern */* rejects 3 segments',
    pattern: { system: 'app', resourcePattern: '*/*' },
    system: 'app',
    resource: 'foo/bar/baz',
    expected: false,
  },
  {
    label: 'Multi: pair segment pattern */* rejects dots in segments',
    pattern: { system: 'app', resourcePattern: '*/*' },
    system: 'app',
    resource: 'foo.1/bar',
    expected: false,
  },

  // -------------------------------------------------------------------------
  // 8. Regex Character Escaping Rigor
  // -------------------------------------------------------------------------
  {
    label: 'Regex Escape: plus + is treated literally',
    pattern: { system: 'sys', resourcePattern: 'data+set/*' },
    system: 'sys',
    resource: 'data+set/item1',
    expected: true,
  },
  {
    label: 'Regex Escape: plus + does not act as regex quantifier',
    pattern: { system: 'sys', resourcePattern: 'data+set/*' },
    system: 'sys',
    resource: 'dataaaaset/item1',
    expected: false,
  },
  {
    label: 'Regex Escape: parentheses () are treated literally',
    pattern: { system: 'sys', resourcePattern: 'item(1)/*' },
    system: 'sys',
    resource: 'item(1)/child',
    expected: true,
  },
  {
    label: 'Regex Escape: brackets [] are treated literally',
    pattern: { system: 'sys', resourcePattern: 'matrix[0]/*' },
    system: 'sys',
    resource: 'matrix[0]/elem',
    expected: true,
  },
  {
    label: 'Regex Escape: pipe | is treated literally',
    pattern: { system: 'sys', resourcePattern: 'a|b/*' },
    system: 'sys',
    resource: 'a|b/value',
    expected: true,
  },
  {
    label: 'Regex Escape: pipe | does not act as regex alternation',
    pattern: { system: 'sys', resourcePattern: 'a|b/*' },
    system: 'sys',
    resource: 'a/value',
    expected: false,
  },
  {
    label: 'Regex Escape: anchors ^ and $ are treated literally in pattern',
    pattern: { system: 'sys', resourcePattern: '^prefix$/*' },
    system: 'sys',
    resource: '^prefix$/entry',
    expected: true,
  },
]);

describe('R-17: Governed Matcher Conformance Suite (OD-4 / U-1 / E-17)', () => {
  it('enforces identical verdicts between targetMatches and delegationTargetMatches across all corpus vectors', () => {
    for (const vector of CORPUS) {
      const v1 = targetMatches(vector.pattern, vector.system, vector.resource);
      const v2 = delegationTargetMatches(vector.pattern as DelegationTargetScope, vector.system, vector.resource);

      assert.equal(
        v1,
        vector.expected,
        `targetMatches divergence on "${vector.label}": expected ${vector.expected}, got ${v1}`,
      );
      assert.equal(
        v2,
        vector.expected,
        `delegationTargetMatches divergence on "${vector.label}": expected ${vector.expected}, got ${v2}`,
      );
      assert.equal(
        v1,
        v2,
        `Semantic divergence between targetMatches and delegationTargetMatches on "${vector.label}"`,
      );
    }
  });

  it('guarantees source-level byte-identical implementation between both matcher functions (I-6 static guard)', () => {
    // Locate the source files reliably whether running from src/ or dist/
    const packageDir = resolve(__dirname, __dirname.includes('/dist/') ? '../..' : '..');
    const manifestPath = resolve(packageDir, 'src/capability-manifests.ts');
    const delegationPath = resolve(packageDir, '../authentication/src/delegation-types.ts');

    const manifestSrc = readFileSync(manifestPath, 'utf8');
    const delegationSrc = readFileSync(delegationPath, 'utf8');

    // Extract function bodies
    const extractBody = (src: string, fnName: string): string => {
      const match = src.match(new RegExp(`export function ${fnName}\\([^)]+\\): boolean \\{([\\s\\S]*?\\n\\})`));
      if (!match) {
        throw new Error(`Could not locate function ${fnName} in source`);
      }
      return match[1].trim();
    };

    const targetMatchesBody = extractBody(manifestSrc, 'targetMatches');
    const delegationTargetMatchesBody = extractBody(delegationSrc, 'delegationTargetMatches');

    assert.equal(
      targetMatchesBody,
      delegationTargetMatchesBody,
      'I-6 INVARIANT VIOLATION: targetMatches and delegationTargetMatches function bodies are not byte-identical',
    );
  });
});
