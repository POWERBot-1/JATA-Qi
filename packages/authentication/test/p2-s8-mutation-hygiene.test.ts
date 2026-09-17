// P2-S8 — mutation-harness hygiene gate.
//
// The mutation suite (p2-s7-mutation.test.ts) executes mutants against a
// DISPOSABLE package copy under os.tmpdir() — never against the tracked
// working tree. This gate pins that invariant structurally: it asserts the
// harness source contains no write path into the tracked tree and that no
// mutation scratch directory exists inside it.
//
// Rationale: the pre-S8 harness edited tracked `src/*.ts` in place and
// restored in a `finally`. A SIGKILL/crash between write and restore — or a
// concurrent run — could contaminate the working tree with mutant code and
// silently change what the rest of the suite verifies. S8 removes the write
// path entirely; this test fails if it ever comes back.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const HARNESS = path.join(PKG, 'test', 'p2-s7-mutation.test.ts');

describe('P2-S8 mutation-harness hygiene (tracked tree is never mutated)', () => {
  it('the harness stages mutants in os.tmpdir(), not in the tracked tree', async () => {
    const source = await fs.readFile(HARNESS, 'utf8');
    assert.ok(source.includes('os.tmpdir()'), 'mutant staging root is os.tmpdir()');
    assert.ok(source.includes('mkdtemp'), 'each mutant gets a fresh disposable directory');
    assert.ok(!source.includes('dist/.mutation'), 'no scratch outDir inside the tracked dist/');
  });

  it('the harness has no write path into tracked sources (no restore needed)', async () => {
    const source = await fs.readFile(HARNESS, 'utf8');
    // The harness may READ tracked sources (pristine capture) but must never
    // WRITE them: no writeFile/copyFile/rename targeting PKG paths, and no
    // restore helper (nothing is ever modified, so nothing is restored).
    assert.ok(!source.includes('restoreAll'), 'no restore helper exists (nothing is modified)');
    assert.ok(!source.includes('writeFile(srcPath'), 'no write path into tracked sources');
    assert.ok(!source.includes('writeFile(path.join(PKG'), 'no write path into PKG-rooted paths');
  });

  it('no mutation scratch directory exists inside the tracked tree', async () => {
    const scratch = path.join(PKG, 'dist', '.mutation');
    await assert.rejects(fs.stat(scratch), /ENOENT/, 'tracked dist/.mutation/ must not exist');
  });

  it('no MUTANT marker exists in any tracked source file', async () => {
    const srcDir = path.join(PKG, 'src');
    const entries = await fs.readdir(srcDir);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const bytes = await fs.readFile(path.join(srcDir, entry), 'utf8');
      assert.ok(!bytes.includes('MUTANT M'), `tracked src/${entry} carries no mutant marker`);
    }
  });
});
