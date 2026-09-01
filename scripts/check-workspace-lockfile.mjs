#!/usr/bin/env node
/**
 * Verify that every package workspace has the corresponding npm lockfile records.
 *
 * npm workspaces require both a packages/<directory> record and a linked
 * node_modules/<package-name> record in a v3 package-lock. Keeping this check
 * at the root prevents a new workspace from making `npm ci` unusable.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const packageLockPath = join(root, 'package-lock.json');
const rootPackagePath = join(root, 'package.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${relative(root, path) || path}: ${error.message}`);
  }
}

function discoverWorkspaces() {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = entry.name;
      const manifestPath = join(packagesDir, dir, 'package.json');
      if (!existsSync(manifestPath)) return undefined;
      const manifest = readJson(manifestPath);
      return {
        dir,
        path: `packages/${dir}`,
        manifest,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

const rootManifest = readJson(rootPackagePath);
const lockfile = readJson(packageLockPath);
const workspaces = discoverWorkspaces();
const errors = [];

if (!lockfile.packages || typeof lockfile.packages !== 'object') {
  errors.push('package-lock.json is missing its lockfileVersion 2/3 "packages" map.');
}

const lockedRoot = lockfile.packages?.[''];
if (!lockedRoot) {
  errors.push('package-lock.json is missing its root package record.');
} else if (JSON.stringify(lockedRoot.workspaces) !== JSON.stringify(rootManifest.workspaces)) {
  errors.push('package-lock.json root workspaces declaration does not match package.json.');
}

const workspaceNames = new Map();
for (const workspace of workspaces) {
  const { manifest, path } = workspace;
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push(`${path}/package.json is missing a valid package name.`);
    continue;
  }
  const prior = workspaceNames.get(manifest.name);
  if (prior) errors.push(`Duplicate workspace package name "${manifest.name}" in ${prior} and ${path}.`);
  workspaceNames.set(manifest.name, path);

  const lockedWorkspace = lockfile.packages?.[path];
  if (!lockedWorkspace) {
    errors.push(`package-lock.json is missing workspace record "${path}".`);
  } else {
    if (lockedWorkspace.name !== manifest.name) {
      errors.push(`Lockfile workspace "${path}" has name "${lockedWorkspace.name ?? '<missing>'}", expected "${manifest.name}".`);
    }
    if (lockedWorkspace.version !== manifest.version) {
      errors.push(`Lockfile workspace "${path}" has version "${lockedWorkspace.version ?? '<missing>'}", expected "${manifest.version ?? '<missing>'}".`);
    }
  }

  const linkPath = `node_modules/${manifest.name}`;
  const lockedLink = lockfile.packages?.[linkPath];
  if (!lockedLink) {
    errors.push(`package-lock.json is missing workspace link "${linkPath}".`);
  } else {
    if (lockedLink.link !== true) errors.push(`Lockfile record "${linkPath}" is not marked as a workspace link.`);
    if (lockedLink.resolved !== path) {
      errors.push(`Lockfile link "${linkPath}" resolves to "${lockedLink.resolved ?? '<missing>'}", expected "${path}".`);
    }
  }
}

for (const lockPath of Object.keys(lockfile.packages ?? {}).filter((path) => /^packages\/[^/]+$/.test(path))) {
  if (!workspaces.some((workspace) => workspace.path === lockPath)) {
    errors.push(`package-lock.json contains stale workspace record "${lockPath}".`);
  }
}

if (errors.length > 0) {
  console.error('Workspace/lockfile consistency check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Workspace/lockfile consistency check passed (${workspaces.length} workspaces).`);
}
