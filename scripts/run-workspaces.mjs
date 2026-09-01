#!/usr/bin/env node
/**
 * Execute a package script in internal dependency order.
 *
 * npm's workspace iteration order is not a build graph. This runner derives the
 * graph from local @jataqi/* dependencies so TypeScript declarations exist before
 * dependent packages compile or test.
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

try {
  const order = dependencyOrder(discoverWorkspaces());
  console.log(`Workspace ${script} order: ${order.map((workspace) => workspace.manifest.name).join(' -> ')}`);

  for (const workspace of order) {
    if (!workspace.manifest.scripts?.[script]) {
      console.log(`Skipping ${workspace.manifest.name}: no ${script} script.`);
      continue;
    }
    console.log(`\n=== ${script} ${workspace.manifest.name} ===`);
    const result = spawnSync(npm, ['run', script, `--workspace=${workspace.manifest.name}`], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} catch (error) {
  console.error(`Workspace ${script} orchestration failed: ${error.message}`);
  process.exit(1);
}
