#!/usr/bin/env node
// Provisioning tool: generates the signed Creator Root manifest and a private
// signing key. The manifest (public) is committed; the private key is written
// to provenance/keys/creator.key which MUST be gitignored and kept secret.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { provisionRoot } from './manifest.js';

const MANIFEST_PATH = 'provenance/root-manifest.json';
const KEY_DIR = 'provenance/keys';
const KEY_PATH = `${KEY_DIR}/creator.key`;
const force = process.argv.includes('--force');

function main(): void {
  if (existsSync(MANIFEST_PATH) && !force) {
    console.log(`provenance: ${MANIFEST_PATH} already exists (use --force to regenerate).`);
    console.log('WARNING: regenerating destroys continuity with previously signed releases.');
    return;
  }
  mkdirSync(KEY_DIR, { recursive: true });
  const { manifest, privateKeyDerB64 } = provisionRoot();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(KEY_PATH, privateKeyDerB64 + '\n', { mode: 0o600 });
  console.log(`provenance: wrote ${MANIFEST_PATH} (public, committable).`);
  console.log(`provenance: wrote ${KEY_PATH} (PRIVATE — keep secret, gitignored).`);
  console.log(`creator: ${manifest.creator.display_name} | anchor: ${manifest.identity_anchor_sha256}`);
}

main();
