import fs from 'node:fs';
import path from 'node:path';

function oldMatcher(pattern, system, resource) {
  if (!pattern) return false;
  if (pattern.system !== system) return false;
  if (pattern.resourcePattern === undefined) return resource === undefined;
  if (resource === undefined) return false;
  if (!pattern.resourcePattern.includes('*')) return pattern.resourcePattern === resource;
  const regex = new RegExp(
    `^${pattern.resourcePattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );
  return regex.test(resource);
}

function newMatcher(pattern, system, resource) {
  if (!pattern) return false;
  if (pattern.system !== system) return false;
  if (pattern.resourcePattern === undefined) return resource === undefined;
  if (resource === undefined) return false;
  if (!pattern.resourcePattern.includes('*')) return pattern.resourcePattern === resource;
  const regex = new RegExp(
    `^${pattern.resourcePattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/.]*')}$`
  );
  return regex.test(resource);
}

const files = [];
function scanDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanDir(full);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
}
scanDir('.');

const patternRegex = /resourcePattern\s*[:=]\s*["'`]?([^"'`,\s{}]+)["'`]?/g;
const occurrences = [];
const uniquePatterns = new Set();

for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = patternRegex.exec(content)) !== null) {
    const pat = m[1];
    if (pat && !pat.startsWith('$') && !pat.startsWith('/') && pat !== 'string' && pat !== 'undefined') {
      uniquePatterns.add(pat);
      occurrences.push({ file: f, pattern: pat });
    }
  }
}

console.log('Total unique resource patterns found in repository:', uniquePatterns.size);
for (const p of Array.from(uniquePatterns).sort()) {
  console.log('  Pattern:', p);
}

const targetRegex = /resource\s*:\s*["'`]?([^"'`,\s{}]+)["'`]?/g;
const uniqueResources = new Set();
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = targetRegex.exec(content)) !== null) {
    const res = m[1];
    if (res && !res.startsWith('$') && res !== 'string' && res !== 'undefined') {
      uniqueResources.add(res);
    }
  }
}
console.log('\nTotal unique test/code resources found:', uniqueResources.size);
for (const r of Array.from(uniqueResources).sort()) {
  console.log('  Resource:', r);
}

console.log('\n--- RE-EVALUATION MATRIX ACROSS ALL COMBINATIONS ---');
let changedCount = 0;
const changedItems = [];

for (const pat of uniquePatterns) {
  for (const res of uniqueResources) {
    const pObj = { system: 'test', resourcePattern: pat };
    const oldRes = oldMatcher(pObj, 'test', res);
    const newRes = newMatcher(pObj, 'test', res);
    if (oldRes !== newRes) {
      changedCount++;
      changedItems.push({ pattern: pat, resource: res, oldRes, newRes });
      console.log(`CHANGED: pattern "${pat}" vs resource "${res}": OLD=${oldRes} -> NEW=${newRes}`);
    }
  }
}

console.log(`\nTotal re-evaluation verdict changes across cross-product: ${changedCount}`);
