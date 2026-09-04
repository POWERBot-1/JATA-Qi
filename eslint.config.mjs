// R-01: a real repository linter, replacing the previously vacuous root
// `lint` script (no workspace defined one, so `--if-present` always succeeded).
//
// Deliberately conservative: this milestone activates linting as a genuine
// merge gate, it does not undertake a repo-wide style rewrite. Rules are the
// recommended correctness sets plus a small number of governance-relevant
// checks. Broadening the rule set is future work and explicitly NOT R-01 scope.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],

      // --- Pre-existing-finding categories -------------------------------
      // Activating a linter on a 48-workspace codebase that never had one
      // surfaces 55 pre-existing violations. R-01's scope is to make the gate
      // REAL, not to perform a repo-wide rewrite (which would touch W22/W23/
      // O-01/P-01 files this milestone must not change). These categories are
      // therefore reported as warnings so they are visible and counted, while
      // the gate still fails the build on anything outside them.
      //
      // Two are genuine correctness findings, recorded for a future milestone:
      //   - no-unsafe-finally: packages/external-connectors/src/registry.ts:136
      //   - no-useless-catch:  packages/storage-postgres/src/postgres-collection.ts:52
      // Neither is introduced by R-01 and neither is fixed here.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'prefer-const': 'warn',
      'no-unsafe-finally': 'warn',
      'no-useless-catch': 'warn',
    },
  },
  {
    // Test files may use looser typing for fixtures and fakes.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Plain ESM scripts and test workers run under Node and use Node globals.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
);
