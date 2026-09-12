// P2-S7 — MUTATION SUITE. Proves the S7 tests actually kill the mutations that
// would defeat the seam.
//
// This is not a stand-in test. Each mutant edits the REAL TypeScript source,
// compiles the real package to a scratch outDir (the shipped `dist/` is never
// touched), runs the REAL target suite against it, and asserts the suite FAILS.
// A mutant that survives is a real gap in the security tests, and fails here.
//
// The four mutation classes the S7 mandate calls out are all covered:
//   * production falls back to / accepts dev-inmemory  → M1, M9, M10
//   * authorization is bypassed                        → M7 (and M4 at the seam)
//   * tenant binding is removed                        → M6
//   * secrets enter audit output                       → M8
// plus the key-lifecycle controls: M2 (retirement), M3 (revocation),
// M4 (context/AAD binding), M5 (purpose separation).
//
// HYGIENE: every mutant is reverted in a `finally`, the restore is verified
// byte-for-byte, and the scratch outDir is removed. A final test re-reads both
// source files and asserts they match the bytes captured before the suite ran,
// so a crash mid-suite cannot leave the tree silently modified.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bounded retries for an INCONCLUSIVE child run (infrastructure flake). */
const MAX_CHILD_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/**
 * A sanitized environment for the spawned mutant runs.
 *
 * THIS IS LOAD-BEARING. This suite is itself executed by `node --test`, which
 * exports `NODE_TEST_CONTEXT=child-v8` to its children. A nested
 * `node --test` that inherits it does NOT run in standalone mode: it reports
 * over IPC to the parent and exits 0 even when tests fail, which made every
 * mutant look like it survived. Stripping it forces a real standalone run with
 * a real exit code and a real TAP summary.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

const KEY_SEAM = 'src/key-management.ts';
const SECRETS = 'src/secret-material.ts';
const MFA = 'src/mfa.ts';
const PRIVILEGE = 'src/privilege-store.ts';
const AUTH_MODULE = 'src/authentication-module.ts';
const BREAK_GLASS = 'src/break-glass.ts';

interface Edit {
  readonly find: string;
  readonly replace: string;
}

interface Mutant {
  readonly id: string;
  readonly control: string;
  readonly file: string;
  readonly edits: readonly Edit[];
  /** Compiled target suite that MUST fail when the control is removed. */
  readonly target: string;
}

const MUTANTS: readonly Mutant[] = [
  {
    id: 'M1',
    control: 'production accepts a dev-inmemory key seam',
    file: KEY_SEAM,
    edits: [
      {
        find: `  if (seam.kind !== 'external') {
    throw new KeyManagementError('KEY_DEV_PROVIDER_IN_PRODUCTION');
  }
}`,
        replace: `  // MUTANT M1: production accepts a development seam.
  return;
}`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M2',
    control: 'a RETIRED key can still sign (rotation is not enforced)',
    file: KEY_SEAM,
    edits: [
      {
        find: `    // A RETIRED key must never produce a NEW signature.
    if (entry.status !== 'ACTIVE') {`,
        replace: `    // MUTANT M2: retired keys may produce new signatures.
    if (false) {`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M3',
    control: 'revocation is terminal',
    file: KEY_SEAM,
    edits: [
      {
        find: `  #assertNotRevoked(entry: DevKeyEntry): void {
    if (entry.status === 'REVOKED') {
      throw new KeyManagementError('KEY_REVOKED', { keyId: entry.keyId, version: entry.version, purpose: entry.purpose });
    }
  }`,
        replace: `  #assertNotRevoked(_entry: DevKeyEntry): void {
    // MUTANT M3: revocation is no longer enforced.
  }`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M4',
    control: 'ciphertext is bound to its sealing context (AAD authorization)',
    file: KEY_SEAM,
    edits: [
      {
        find: `        if (sealed.context !== context) {
          // Context mismatch is an authorization-class failure, not a crypto
          // error: the caller is asking to open someone else's blob.
          throw new KeyManagementError('KEY_UNAUTHORIZED', { keyId, version, purpose: 'encryption' });
        }`,
        replace: `        if (false) {
          // MUTANT M4: context binding is not checked.
          throw new KeyManagementError('KEY_UNAUTHORIZED', { keyId, version, purpose: 'encryption' });
        }`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M5',
    control: 'purpose separation (a signing key cannot wrap secrets)',
    file: KEY_SEAM,
    edits: [
      {
        find: `  #assertPurpose(entry: DevKeyEntry, purpose: KeyPurpose): void {
    if (entry.purpose !== purpose) {
      throw new KeyManagementError('KEY_PURPOSE_MISMATCH', {
        keyId: entry.keyId,
        version: entry.version,
        purpose: entry.purpose,
      });
    }
  }`,
        replace: `  #assertPurpose(_entry: DevKeyEntry, _purpose: KeyPurpose): void {
    // MUTANT M5: purpose separation is no longer enforced.
  }`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M10',
    control: 'isDevelopmentKeySeam classifies a dev seam as development',
    file: KEY_SEAM,
    edits: [
      {
        find: `export function isDevelopmentKeySeam(seam: KeyManagementSeam | undefined): boolean {
  if (!seam || typeof seam !== 'object') return true;
  return seam.kind !== 'external';
}`,
        replace: `export function isDevelopmentKeySeam(_seam: KeyManagementSeam | undefined): boolean {
  // MUTANT M10: every seam is claimed to be production-grade.
  return false;
}`,
      },
    ],
    target: 'p2-s7-key-seam.test.js',
  },
  {
    id: 'M9',
    control: 'production accepts a dev-inmemory secret seam',
    file: SECRETS,
    edits: [
      {
        find: `  if (seam.kind !== 'external') throw new SecretMaterialError('SECRET_DEV_PROVIDER_IN_PRODUCTION');`,
        replace: `  // MUTANT M9: production accepts a development secret seam.
  return;`,
      },
    ],
    target: 'p2-s7-secret-material.test.js',
  },
  {
    id: 'M6',
    control: 'the store scopes every read/write to the caller tenant (RLS)',
    file: SECRETS,
    edits: [
      {
        find: `      return fn(scope);
    }, { tenantId });`,
        replace: `      return fn(scope);
      // MUTANT M6: the tenant scope is dropped, so RLS no longer applies.
    });`,
      },
    ],
    target: 'p2-s7-secret-material.test.js',
  },
  {
    id: 'M7',
    control: 'open() enforces the principal/purpose binding and the stored AAD',
    file: SECRETS,
    edits: [
      {
        find: `      if (!doc || doc.principalId !== input.principalId || doc.purpose !== input.purpose) return { kind: 'unknown' };`,
        replace: `      // MUTANT M7a: the principal/purpose binding is no longer checked.
      if (!doc) return { kind: 'unknown' };`,
      },
      {
        find: `      if (doc.sealed.context !== deriveSecretContext(input)) {
        // Defence in depth: even if a row were somehow re-pointed, the AAD
        // binding must still match exactly.
        return { kind: 'unknown' };
      }`,
        replace: `      // MUTANT M7b: the stored AAD is no longer compared.`,
      },
      {
        find: `      material = await decryptor.decrypt(doc.sealed, deriveSecretContext(input));`,
        replace: `      // MUTANT M7c: decrypt under the blob's OWN context, not the caller's.
      material = await decryptor.decrypt(doc.sealed, doc.sealed.context);`,
      },
    ],
    target: 'p2-s7-secret-material.test.js',
  },
  {
    id: 'M8',
    control: 'audit records never carry secret material',
    file: SECRETS,
    edits: [
      {
        find: `      await this.#audit(scope, this.#entry(input, 'seal', 'SUCCESS', correlationId, ref));`,
        replace: `      await this.#audit(scope, {
        ...this.#entry(input, 'seal', 'SUCCESS', correlationId, ref),
        // MUTANT M8: the plaintext is written into the audit record.
        material: Buffer.from(input.material).toString('base64'),
      } as unknown as Omit<SecretAccessRecord, 'id'>);`,
      },
    ],
    target: 'p2-s7-secret-material.test.js',
  },
  // ---------------------------------------------------------------------
  // P2-S5 §8 / §5.3 — enforcement of step-up assurance at the privilege
  // elevation boundary. Both mutants must be killed by
  // p2-s5-stepup-integration.test.js.
  // ---------------------------------------------------------------------
  {
    id: 'M-S3-1',
    control: 'grantElevation actually invokes step-up verification',
    file: PRIVILEGE,
    edits: [
      {
        find: `    await this.#verifyStepUpEvidence(input, now);`,
        replace: `    // MUTANT M-S3-1: step-up evidence is accepted on assertion, never verified.
    // This is exactly the pre-S5 behaviour the integration closed.`,
      },
    ],
    target: 'p2-s5-stepup-integration.test.js',
  },
  {
    id: 'M-S3-2',
    control: 'a revoked/replaced factor invalidates its prior assurance (§5.3)',
    file: MFA,
    edits: [
      {
        find: `    if (resolved.factorStatus !== 'ACTIVE') {`,
        replace: `    // MUTANT M-S3-2: the authoritative factor state is ignored, so a factor
    // revoked as compromised keeps authorizing with its old assurance.
    if (false) {`,
      },
    ],
    target: 'p2-s5-stepup-integration.test.js',
  },
  {
    id: 'M-S3-3',
    control: 'the production composition wires the assurance provider and fails closed without one',
    file: AUTH_MODULE,
    edits: [
      {
        find: `      this.#privilegeStore = await PrivilegeStore.open(storage, {
        ...(this.#mfa ? { stepUpVerifier: this.#mfa } : {}),
        strictStepUp: true,
      });`,
        replace: `      // MUTANT M-S3-3: the production plane is built with no assurance
      // provider and no strict mode — the pre-fix vacuity.
      this.#privilegeStore = await PrivilegeStore.open(storage);`,
      },
    ],
    target: 'p2-s5-stepup-integration.test.js',
  },
  {
    id: 'M-S6-1',
    control: 'break-glass activation actually invokes S5 step-up verification',
    file: BREAK_GLASS,
    edits: [
      {
        find: `      await this.stepUp.verifyStepUpEvidence({`,
        replace: `      // MUTANT M-S6-1: step-up evidence is accepted on assertion.
      if (false) await this.stepUp.verifyStepUpEvidence({`,
      },
    ],
    target: 'p2-s6-break-glass.test.js',
  },
  {
    id: 'M-S6-2',
    control: 'blank reason is refused at activation (A-12d)',
    file: BREAK_GLASS,
    edits: [
      {
        find: `    if (!isNonBlank(input.reason) || input.reason.trim().length === 0) {
      throw new BreakGlassError('BG_REASON_REQUIRED', 'activation reason is mandatory and non-blank (A-12d; fail-closed).');
    }`,
        replace: `    // MUTANT M-S6-2: reason is no longer mandatory.`,
      },
    ],
    target: 'p2-s6-break-glass.test.js',
  },
];

/** Bytes of every file this suite mutates, captured before any mutation. */
const PRISTINE = new Map<string, string>();

async function readSource(file: string): Promise<string> {
  return fs.readFile(path.join(PKG, file), 'utf8');
}

async function restoreAll(): Promise<void> {
  for (const [file, bytes] of PRISTINE) {
    await fs.writeFile(path.join(PKG, file), bytes, 'utf8');
  }
}

/**
 * Apply a mutant, compile, run the real target suite, and require it to FAIL.
 */
async function assertMutantKilled(mutant: Mutant): Promise<void> {
  const srcPath = path.join(PKG, mutant.file);
  const pristine = PRISTINE.get(mutant.file);
  assert.ok(pristine !== undefined, `no pristine bytes captured for ${mutant.file}`);

  let source = pristine as string;
  for (const edit of mutant.edits) {
    const occurrences = source.split(edit.find).length - 1;
    assert.equal(
      occurrences,
      1,
      `${mutant.id}: mutation anchor must match exactly once in ${mutant.file}, found ${occurrences}. ` +
        'The source has drifted — update the mutant rather than weakening it.',
    );
    source = source.replace(edit.find, edit.replace);
  }

  const outDir = path.join(PKG, 'dist', '.mutation', mutant.id.toLowerCase());
  try {
    await fs.writeFile(srcPath, source, 'utf8');
    await fs.rm(outDir, { recursive: true, force: true });

    // The mutant must still COMPILE — otherwise it proves nothing.
    const build = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.test.json', '--outDir', outDir], {
      cwd: PKG,
      encoding: 'utf8',
      env: childEnv(),
    });
    assert.equal(
      build.status,
      0,
      `${mutant.id}: the mutant did not compile, so it proves nothing.\n${build.stdout}\n${build.stderr}`,
    );

    // Run the target suite, retrying ONLY an inconclusive run.
    //
    // A run is DECISIVE when it executed and neither cancelled nor skipped
    // anything. Anything else is an infrastructure failure — in practice
    // embedded PostgreSQL failing to boot under load, which cancels every
    // subtest via the failed `before` hook. The first revision of this harness
    // treated that as "the mutant survived", which is a false accusation
    // against the security suite; it is now reported as INCONCLUSIVE and
    // retried, and only a decisive run can ever be judged.
    let exitCode: number | null = null;
    let cancelled = -1;
    let skipped = -1;
    let failed = -1;
    let tests = -1;
    let lastSummary = '';
    for (let attempt = 1; attempt <= MAX_CHILD_ATTEMPTS; attempt += 1) {
      const run = spawnSync(process.execPath, ['--test', path.join(outDir, 'test', mutant.target)], {
        cwd: PKG,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: childEnv(),
      });
      exitCode = run.status;
      lastSummary = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      const count = (label: string): number => {
        const match = lastSummary.match(new RegExp(`^# ${label} (\\d+)`, 'm'));
        return match ? Number(match[1]) : -1;
      };
      tests = count('tests');
      failed = count('fail');
      cancelled = count('cancelled');
      skipped = count('skipped');
      if (tests > 0 && cancelled === 0 && skipped === 0) break; // decisive
      if (attempt < MAX_CHILD_ATTEMPTS) await sleep(1500 * attempt);
    }

    assert.ok(
      tests > 0,
      `${mutant.id}: INCONCLUSIVE — the target suite never executed (no TAP summary), so the mutation proves nothing`,
    );
    assert.equal(
      cancelled,
      0,
      `${mutant.id}: INCONCLUSIVE — ${cancelled} subtests were cancelled, which means the suite's before() hook failed ` +
        '(embedded PostgreSQL did not come up). That is an infrastructure failure, NOT a mutation result. ' +
        `Last summary tail:\n${lastSummary.slice(-1200)}`,
    );
    assert.equal(skipped, 0, `${mutant.id}: INCONCLUSIVE — ${skipped} subtests were skipped; a skipped suite proves nothing`);
    assert.ok(
      (failed ?? 0) >= 1,
      `${mutant.id} SURVIVED: removing the control "${mutant.control}" still passed ${mutant.target}. ` +
        'The security test suite has a real gap.',
    );
    assert.notEqual(
      exitCode,
      0,
      `${mutant.id}: the mutated suite reported failures but exited 0; the runner is not propagating results`,
    );
  } finally {
    await fs.writeFile(srcPath, pristine as string, 'utf8');
    assert.equal(await readSource(mutant.file), pristine, `${mutant.id}: source must be restored byte-for-byte`);
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

describe('P2-S7 mutation suite (the security tests kill the mutations)', () => {
  it('captures pristine sources', async () => {
    // Every file any mutant touches must be snapshotted here, or the harness
    // refuses to run that mutant (it cannot guarantee byte-for-byte restore).
    for (const file of [KEY_SEAM, SECRETS, MFA, PRIVILEGE, AUTH_MODULE, BREAK_GLASS]) {
      PRISTINE.set(file, await readSource(file));
    }
    assert.equal(PRISTINE.size, 6);
  });

  // Registered synchronously so node:test collects every case up front.
  for (const mutant of MUTANTS) {
    it(`${mutant.id} kills: ${mutant.control}`, () => assertMutantKilled(mutant));
  }

  it('every mutated source file is restored byte-for-byte after the suite', async () => {
    for (const [file, bytes] of PRISTINE) {
      assert.equal(await readSource(file), bytes, `${file} was left modified by the mutation suite`);
    }
  });
});

after(async () => {
  // Belt and braces: even if a case threw mid-mutation, the tracked sources are
  // put back before the process exits.
  await restoreAll();
  await fs.rm(path.join(PKG, 'dist', '.mutation'), { recursive: true, force: true });
});
