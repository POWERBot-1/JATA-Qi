// Link Classifier (Phase 1) — detects the source type, language, framework,
// domain, version, license, and dependencies from a URL or content payload.
// Uses pattern matching (no network calls — the caller fetches the content).

import type { Classification, Language, SourceType } from './types.js';

/** URL patterns for source-type detection. */
const URL_PATTERNS: Array<{ re: RegExp; type: SourceType }> = [
  { re: /github\.com/i, type: 'github' },
  { re: /gitlab\.com/i, type: 'gitlab' },
  { re: /bitbucket\.org/i, type: 'bitbucket' },
  { re: /npmjs\.com|npmjs\.org/i, type: 'npm' },
  { re: /pypi\.org/i, type: 'pypi' },
  { re: /crates\.io/i, type: 'crates' },
  { re: /swagger\.io|openapi|redoc/i, type: 'openapi' },
  { re: /graphql/i, type: 'graphql' },
  { re: /youtube\.com|youtu\.be/i, type: 'youtube' },
  { re: /\.pdf$/i, type: 'pdf' },
  { re: /\.md$|README|CHANGELOG/i, type: 'markdown' },
  { re: /rss|atom\.xml/i, type: 'rss' },
  { re: /doi\.org|arxiv|scholar/i, type: 'paper' },
  { re: /rfc-editor|ietf\.org|tools\.ietf/i, type: 'rfc' },
  { re: /docs?\.|documentation|guide|tutorial/i, type: 'documentation' },
];

/** Language detection from file extensions, code patterns, and package files. */
const LANG_MAP: Record<string, Language> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c', '.h': 'c',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html', '.htm': 'html',
  '.css': 'css',
  '.sql': 'sql',
};

const FRAMEWORK_PATTERNS: Array<{ re: RegExp; framework: string }> = [
  { re: /react|next\.js|nextjs/i, framework: 'React/Next.js' },
  { re: /vue|nuxt/i, framework: 'Vue/Nuxt' },
  { re: /angular/i, framework: 'Angular' },
  { re: /express|fastify|koa|nestjs/i, framework: 'Node.js' },
  { re: /django|flask|fastapi/i, framework: 'Python Web' },
  { re: /spring|quarkus/i, framework: 'Java/Spring' },
  { re: /docker|containerd|podman/i, framework: 'Containers' },
  { re: /kubernetes|k8s|helm/i, framework: 'Kubernetes' },
  { re: /terraform|opentofu/i, framework: 'IaC' },
  { re: /tensorflow|pytorch|onnx/i, framework: 'ML/AI' },
];

const LICENSE_PATTERNS: Array<{ re: RegExp; license: string }> = [
  { re: /MIT License/i, license: 'MIT' },
  { re: /Apache License.*2\.0/i, license: 'Apache-2.0' },
  { re: /BSD .*Clause/i, license: 'BSD' },
  { re: /GNU GENERAL PUBLIC LICENSE/i, license: 'GPL' },
  { re: /Mozilla Public License/i, license: 'MPL-2.0' },
  { re: /ISC License/i, license: 'ISC' },
  { re: /Unlicense/i, license: 'Unlicense' },
];

/**
 * Classify a link from its URL and (optionally) fetched content.
 * Pure function — no network calls.
 */
export function classify(url: string, content?: string): Classification {
  const sourceType = detectSourceType(url, content);
  const language = detectLanguage(url, content);
  const framework = detectFramework(content);
  const domain = extractDomain(url);
  const version = extractVersion(url, content);
  const license = detectLicense(content);
  const title = extractTitle(content);
  const description = extractDescription(content);
  const dependencies = extractDependencies(content);
  const confidence = computeConfidence(sourceType, language, content);

  return {
    sourceType, language,
    ...(framework ? { framework } : {}),
    ...(domain ? { domain } : {}),
    ...(version ? { version } : {}),
    ...(license ? { license } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    dependencies,
    confidence,
    detectedAt: Date.now(),
  };
}

function detectSourceType(url: string, content?: string): SourceType {
  for (const { re, type } of URL_PATTERNS) if (re.test(url)) return type;
  if (content) {
    if (/"""openapi"""|swagger:\s*"?\d/i.test(content)) return 'openapi';
    if (/^#\s/m.test(content) && /```/.test(content)) return 'markdown';
    if (/<html|<!DOCTYPE/i.test(content)) return 'html';
    if (/^\s*[{[]/.test(content.trim())) return 'json';
    if (/<\?xml/.test(content)) return 'xml';
  }
  return 'unknown';
}

function detectLanguage(url: string, content?: string): Language {
  // Check file extension in URL.
  for (const [ext, lang] of Object.entries(LANG_MAP)) {
    if (url.toLowerCase().endsWith(ext)) return lang;
  }
  // Check content patterns.
  if (content) {
    if (/import\s+.*\s+from\s+['"].*\.js['"];|export\s+(type|interface|class|function)/.test(content)) return 'typescript';
    if (/require\(|module\.exports|function\s+\w+\s*\(/.test(content)) return 'javascript';
    if (/def\s+\w+\(|import\s+\w+\s+from|print\(/.test(content)) return 'python';
    if (/fn\s+\w+|use\s+std::|pub\s+(fn|struct|enum)/.test(content)) return 'rust';
    if (/func\s+\w+|package\s+main/.test(content)) return 'go';
    if (/public\s+(class|static|void)|System\.out/.test(content)) return 'java';
  }
  return 'unknown';
}

function detectFramework(content?: string): string | undefined {
  if (!content) return undefined;
  for (const { re, framework } of FRAMEWORK_PATTERNS) if (re.test(content)) return framework;
  return undefined;
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch { return undefined; }
}

function extractVersion(url: string, content?: string): string | undefined {
  const urlMatch = url.match(/\/v?(\d+\.\d+(?:\.\d+)?)/);
  if (urlMatch) return urlMatch[1];
  if (content) {
    const pkgMatch = content.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
    if (pkgMatch) return pkgMatch[1];
  }
  return undefined;
}

function detectLicense(content?: string): string | undefined {
  if (!content) return undefined;
  for (const { re, license } of LICENSE_PATTERNS) if (re.test(content)) return license;
  return undefined;
}

function extractTitle(content?: string): string | undefined {
  if (!content) return undefined;
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  const htmlTitle = content.match(/<title>(.+?)<\/title>/i);
  if (htmlTitle) return htmlTitle[1]!.trim();
  const pkgName = content.match(/"name"\s*:\s*"([^"]+)"/);
  if (pkgName) return pkgName[1];
  return undefined;
}

function extractDescription(content?: string): string | undefined {
  if (!content) return undefined;
  const pkgDesc = content.match(/"description"\s*:\s*"([^"]+)"/);
  if (pkgDesc) return pkgDesc[1];
  const firstPara = content.match(/^>\s*(.+)$/m); // blockquote
  if (firstPara) return firstPara[1]!.trim();
  return undefined;
}

function extractDependencies(content?: string): string[] {
  if (!content) return [];
  const deps: string[] = [];
  // package.json dependencies.
  const pkgMatch = content.match(/"dependencies"\s*:\s*\{([^}]+)\}/);
  if (pkgMatch) {
    const names = pkgMatch[1]!.matchAll(/"(@?[^"]+)"\s*:/g);
    for (const m of names) deps.push(m[1]!);
  }
  // requirements.txt / pyproject.toml.
  const pyMatch = content.matchAll(/^([a-zA-Z0-9_-]+)\s*[>=~]/gm);
  for (const m of pyMatch) if (!deps.includes(m[1]!)) deps.push(m[1]!);
  // Cargo.toml.
  const cargoMatch = content.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*["\d]/gm);
  for (const m of cargoMatch) if (!deps.includes(m[1]!)) deps.push(m[1]!);
  // Markdown dependency list (comma or newline separated under a Dependencies heading).
  const mdDepSection = content.match(/##\s*Dependenc(?:y|ies)\s*\n([\s\S]*?)(?:\n#|\n##|$)/i);
  if (mdDepSection) {
    const items = mdDepSection[1]!.matchAll(/([a-zA-Z0-9_-]+)/g);
    for (const m of items) {
      const name = m[1]!.toLowerCase();
      if (name.length > 1 && !['and', 'the', 'for', 'with', 'using'].includes(name) && !deps.includes(name)) deps.push(name);
    }
  }
  return deps;
}

function computeConfidence(sourceType: SourceType, language: Language, content?: string): number {
  let conf = 0.3;
  if (sourceType !== 'unknown') conf += 0.3;
  if (language !== 'unknown') conf += 0.2;
  if (content && content.length > 100) conf += 0.1;
  if (content && content.length > 1000) conf += 0.1;
  return Math.min(1, conf);
}
