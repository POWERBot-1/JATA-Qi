#!/usr/bin/env node
/**
 * Execute a package script in internal dependency order.
 *
 * npm's workspace iteration order is not a build graph. This runner derives the
 * graph from local @jataqi/* dependencies so TypeScript declarations exist before
 * dependent packages compile or test.
 *
 * Failure semantics differ per mode:
 *
 * - `build` is fail-fast: a downstream compilation may depend on artifacts from
 *   an upstream workspace, so continuing after an upstream build failure can
 *   produce misleading compilation results.
 *
 * - `test` aggregates: every eligible suite runs to completion even if earlier
 *   suites fail, each suite outcome is reported, and the runner exits non-zero
 *   at the end if one or more suites failed. A failing suite must never mask
 *   the results of downstream suites in the same run (audit finding F-02).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.argv[2];
if (!script || !['build', 'test'].includes(script)) {
  console.error('Usage: node scripts/run-workspaces.mjs <build|test>');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function discoverWorkspaces() {
  if (!existsSync(packagesDir)) throw new Error('packages directory does not exist.');
  const workspaces = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error(`Workspace packages/${entry.name} has no valid package name.`);
    }
    workspaces.push({ directory: entry.name, manifest });
  }
  return workspaces.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function internalDependencies(manifest, names) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
  const dependencies = new Set();
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (names.has(name)) dependencies.add(name);
      else if (name.startsWith('@jataqi/')) {
        throw new Error(`${manifest.name} declares unknown internal workspace dependency "${name}".`);
      }
    }
  }
  return [...dependencies].sort();
}

function dependencyOrder(workspaces) {
  const byName = new Map();
  for (const workspace of workspaces) {
    if (byName.has(workspace.manifest.name)) {
      throw new Error(`Duplicate workspace package name "${workspace.manifest.name}".`);
    }
    byName.set(workspace.manifest.name, workspace);
  }

  const names = new Set(byName.keys());
  const visiting = new Set();
  const visited = new Set();
  const order = [];

  function visit(name, ancestry = []) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular workspace dependency: ${[...ancestry, name].join(' -> ')}.`);
    }
    const workspace = byName.get(name);
    if (!workspace) throw new Error(`Unknown workspace package "${name}".`);
    visiting.add(name);
    for (const dependency of internalDependencies(workspace.manifest, names)) {
      visit(dependency, [...ancestry, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(workspace);
  }

  for (const name of [...names].sort()) visit(name);
  return order;
}

// test = aggregate (never mask downstream suites); build = fail-fast.
const aggregateFailures = script === 'test';
const results = [];

try {
  const order = dependencyOrder(discoverWorkspaces());
  console.log(`Workspace ${script} order: ${order.map((workspace) => workspace.manifest.name).join(' -> ')}`);

  for (const workspace of order) {
    if (!workspace.manifest.scripts?.[script]) {
      console.log(`Skipping ${workspace.manifest.name}: no ${script} script.`);
      results.push({ name: workspace.manifest.name, outcome: 'SKIPPED' });
      continue;
    }
    console.log(`\n=== ${script} ${workspace.manifest.name} ===`);
    const result = spawnSync(npm, ['run', script, `--workspace=${workspace.manifest.name}`], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) {
      if (aggregateFailures) {
        results.push({ name: workspace.manifest.name, outcome: 'ERROR', detail: result.error.message });
        continue;
      }
      throw result.error;
    }
    if (result.status !== 0) {
      if (aggregateFailures) {
        results.push({ name: workspace.manifest.name, outcome: 'FAILED', detail: `exit ${result.status}` });
        continue;
      }
      process.exit(result.status ?? 1);
    }
    results.push({ name: workspace.manifest.name, outcome: 'PASSED' });
  }

  if (aggregateFailures) {
    const failed = results.filter((entry) => entry.outcome === 'FAILED' || entry.outcome === 'ERROR');
    const passed = results.filter((entry) => entry.outcome === 'PASSED').length;
    const skipped = results.filter((entry) => entry.outcome === 'SKIPPED').length;
    console.log(`\n=== Workspace ${script} summary ===`);
    for (const entry of results) {
      console.log(`${entry.outcome}\t${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
    }
    console.log(`Total: ${results.length} · Passed: ${passed} · Failed: ${failed.length} · Skipped: ${skipped}`);
    if (failed.length > 0) {
      console.error(`Workspace ${script} run completed with ${failed.length} failing workspace(s).`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`Workspace ${script} orchestration failed: ${error.message}`);
  process.exit(1);
}
