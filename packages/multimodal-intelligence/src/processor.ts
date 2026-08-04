// Multimodal Processor (Phase 1-2) — normalizes raw input from any modality
// into SemanticKnowledge. Uses modality-specific extraction heuristics (no LLM
// required — deterministic and offline). Each modality has its own extraction
// pipeline; the processor dispatches based on the modality type.

import { randomUUID } from 'node:crypto';
import type { Modality, SemanticKnowledge } from './types.js';

/**
 * Process raw content from a specific modality into structured semantic knowledge.
 * Pure function — no side effects, no network calls.
 */
export function process(modality: Modality, content: string, sourceId: string, sourceRef: string): SemanticKnowledge {
  const base: SemanticKnowledge = {
    id: randomUUID(), sourceId, modality, sourceRef,
    concepts: [], relationships: [], facts: [], procedures: [],
    dataModels: [], apis: [], securityPatterns: [], optimizations: [],
    workflows: [], snippets: [], confidence: 0,
    extractedAt: Date.now(),
  };

  switch (modality) {
    case 'text': return extractText(content, base);
    case 'document': return extractDocument(content, base);
    case 'image': return extractImage(content, base);
    case 'audio': return extractAudio(content, base);
    case 'video': return extractVideo(content, base);
    case 'code': return extractCode(content, base);
    case 'web': return extractWeb(content, base);
    case 'device': return extractDevice(content, base);
    case 'enterprise': return extractEnterprise(content, base);
    case 'api': return extractApi(content, base);
    case 'link': return extractText(content, base); // delegate to text extraction
    default: return extractText(content, base);
  }
}

// ---- modality-specific extractors ----------------------------------------

function extractText(content: string, base: SemanticKnowledge): SemanticKnowledge {
  return {
    ...base,
    concepts: extractConcepts(content),
    facts: extractFacts(content),
    procedures: extractProcedures(content),
    dataModels: extractDataModels(content),
    apis: extractApiEndpoints(content),
    securityPatterns: extractSecurityPatterns(content),
    optimizations: extractOptimizations(content),
    workflows: extractWorkflows(content),
    snippets: extractCodeSnippets(content),
    confidence: Math.min(1, content.length / 3000),
  };
}

function extractDocument(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // Documents are typically text-like (PDF text, DOCX extracted text, CSV rows).
  const result = extractText(content, base);
  // CSV detection: extract data model from header row.
  const firstLine = content.split('\n')[0] ?? '';
  if (firstLine.includes(',')) {
    const headers = firstLine.split(',').map((h) => h.trim().toLowerCase());
    result.dataModels.push(`CSV schema: ${headers.join(', ')}`);
    result.facts.push({ subject: 'document', predicate: 'has_columns', object: headers.length.toString(), confidence: 0.9 });
  }
  return result;
}

function extractImage(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // For images, content is typically OCR-extracted text or alt-text/descriptions.
  return {
    ...base,
    concepts: extractConcepts(content),
    facts: [{ subject: 'image', predicate: 'contains_text', object: content.slice(0, 200), confidence: 0.6 }],
    confidence: content.length > 50 ? 0.5 : 0.2,
  };
}

function extractAudio(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // For audio, content is typically a transcript.
  return {
    ...base,
    concepts: extractConcepts(content),
    procedures: extractProcedures(content),
    facts: extractFacts(content),
    confidence: content.length > 200 ? 0.6 : 0.3,
  };
}

function extractVideo(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // For video, content is typically a transcript or description.
  return extractAudio(content, base);
}

function extractCode(content: string, base: SemanticKnowledge): SemanticKnowledge {
  const result = extractText(content, base);
  result.snippets = extractCodeSnippets(content).length > 0
    ? extractCodeSnippets(content)
    : [{ language: 'unknown', content: content.slice(0, 500) }];
  // Detect API patterns in code.
  result.apis = extractApiEndpoints(content);
  result.confidence = Math.min(1, content.length / 2000);
  return result;
}

function extractWeb(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // Strip HTML tags for concept extraction.
  const text = content.replace(/<[^>]+>/g, ' ');
  return {
    ...extractText(text, base),
    facts: [...base.facts, ...extractMetaTags(content)],
    confidence: Math.min(1, text.length / 3000),
  };
}

function extractDevice(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // Device telemetry is typically JSON.
  let telemetry: Record<string, unknown> = {};
  try { telemetry = JSON.parse(content); } catch { /* not JSON */ }
  const keys = Object.keys(telemetry);
  return {
    ...base,
    concepts: keys.slice(0, 20),
    facts: keys.slice(0, 10).map((k) => ({ subject: 'device', predicate: k, object: String(telemetry[k] ?? ''), confidence: 0.8 })),
    dataModels: keys.length > 0 ? [`Device schema: ${keys.join(', ')}`] : [],
    confidence: keys.length > 0 ? 0.8 : 0.3,
  };
}

function extractEnterprise(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // Enterprise knowledge (wiki, tickets, CRM) is typically structured text.
  return {
    ...extractText(content, base),
    workflows: extractWorkflows(content),
    confidence: Math.min(1, content.length / 2500),
  };
}

function extractApi(content: string, base: SemanticKnowledge): SemanticKnowledge {
  // API specifications (OpenAPI, GraphQL schema, gRPC proto).
  return {
    ...base,
    apis: extractApiEndpoints(content),
    dataModels: extractDataModels(content),
    concepts: extractConcepts(content),
    confidence: 0.9,
  };
}

// ---- shared extraction helpers -------------------------------------------

function extractConcepts(content: string): string[] {
  const concepts = new Set<string>();
  // Capitalized terms.
  const caps = content.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g);
  for (const m of caps) concepts.add(m[1]!.toLowerCase());
  // Technical terms.
  const tech = content.matchAll(/\b(api|rest|graphql|grpc|webhook|oauth|jwt|redis|kubernetes|docker|microservice|database|schema|endpoint|middleware|pipeline|workflow|authentication|authorization|encryption|cache|queue|stream|batch|concurrent|async|webhook)\b/gi);
  for (const m of tech) concepts.add(m[0]!.toLowerCase());
  return [...concepts].slice(0, 50);
}

function extractFacts(content: string): Array<{ subject: string; predicate: string; object: string; confidence: number }> {
  const facts: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
  // "X is Y" / "X uses Y" / "X supports Y" patterns.
  const patterns = content.matchAll(/(\w+(?:\s\w+){0,2})\s+(?:is|are|uses?|supports?|requires?|provides?|implements?|contains?)\s+([^.\n]+)/gi);
  for (const m of patterns) {
    facts.push({ subject: m[1]!.trim().toLowerCase(), predicate: 'relates_to', object: m[2]!.trim().toLowerCase().slice(0, 100), confidence: 0.6 });
  }
  return facts.slice(0, 30);
}

function extractProcedures(content: string): Array<{ name: string; steps: string[] }> {
  const procedures: Array<{ name: string; steps: string[] }> = [];
  // Numbered/bulleted lists.
  const sections = content.split(/\n(?=#{1,3}\s)/);
  for (const section of sections) {
    const titleMatch = section.match(/^#{1,3}\s+(.+)/);
    if (!titleMatch) continue;
    const steps: string[] = [];
    const stepMatches = section.matchAll(/^\s*[-*]\s+(.+)/gm);
    for (const m of stepMatches) steps.push(m[1]!.trim());
    const numberedMatches = section.matchAll(/^\s*\d+\.\s+(.+)/gm);
    for (const m of numberedMatches) steps.push(m[1]!.trim());
    if (steps.length >= 2) procedures.push({ name: titleMatch[1]!.trim(), steps: steps.slice(0, 20) });
  }
  return procedures.slice(0, 10);
}

function extractDataModels(content: string): string[] {
  const models: string[] = [];
  // interface/type definitions.
  const ts = content.matchAll(/(?:interface|type)\s+(\w+)/g);
  for (const m of ts) models.push(m[1]!);
  // class definitions.
  const cls = content.matchAll(/class\s+(\w+)/g);
  for (const m of cls) models.push(m[1]!);
  // SQL CREATE TABLE.
  const sql = content.matchAll(/CREATE\s+TABLE\s+(\w+)/gi);
  for (const m of sql) models.push(m[1]!);
  // JSON schema "type": "object" with "properties".
  if (/"properties"\s*:/.test(content)) models.push('JSON Schema');
  return [...new Set(models)].slice(0, 30);
}

function extractApiEndpoints(content: string): Array<{ name: string; method?: string; path?: string }> {
  const apis: Array<{ name: string; method?: string; path?: string }> = [];
  const rest = content.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s<"'`]+)/g);
  for (const m of apis.length < 50 ? [...rest] : []) apis.push({ name: `${m[1]} ${m[2]}`, method: m[1], path: m[2] });
  const express = content.matchAll(/\.(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`)]+)/gi);
  for (const m of [...express].slice(0, 50)) {
    const method = m[1]!.toUpperCase();
    apis.push({ name: `${method} ${m[2]}`, method, path: m[2] });
  }
  return [...new Set(apis.map((a) => a.name))].map((name) => apis.find((a) => a.name === name)!).slice(0, 50);
}

function extractSecurityPatterns(content: string): string[] {
  const patterns = [
    { re: /oauth|oidc|openid/i, label: 'OAuth/OIDC' },
    { re: /jwt|json\s+web\s+token/i, label: 'JWT' },
    { re: /rbac|role[\s-]?based/i, label: 'RBAC' },
    { re: /abac/i, label: 'ABAC' },
    { re: /tls|ssl|https/i, label: 'TLS' },
    { re: /encryption[\s-]?at[\s-]?rest|aes/i, label: 'Encryption at Rest' },
    { re: /audit\s+log/i, label: 'Audit Logging' },
    { re: /mfa|multi[\s-]?factor/i, label: 'MFA' },
  ];
  return patterns.filter((p) => p.re.test(content)).map((p) => p.label);
}

function extractOptimizations(content: string): string[] {
  const patterns = [
    { re: /cache|caching/i, label: 'Caching' },
    { re: /connection\s+pool/i, label: 'Connection Pooling' },
    { re: /lazy\s+load/i, label: 'Lazy Loading' },
    { re: /batch|bulk/i, label: 'Batching' },
    { re: /index|optimize\s+query/i, label: 'Database Indexing' },
    { re: /cdn|edge/i, label: 'CDN/Edge' },
    { re: /compress|gzip|brotli/i, label: 'Compression' },
  ];
  return patterns.filter((p) => p.re.test(content)).map((p) => p.label);
}

function extractWorkflows(content: string): string[] {
  const patterns = [
    { re: /approval\s+workflow/i, label: 'Approval Workflow' },
    { re: /ci\/cd|pipeline/i, label: 'CI/CD Pipeline' },
    { re: /notification\s+flow/i, label: 'Notification Flow' },
    { re: /onboard/i, label: 'Onboarding Workflow' },
    { re: /escalat/i, label: 'Escalation Workflow' },
    { re: /deploy/i, label: 'Deployment Workflow' },
  ];
  return patterns.filter((p) => p.re.test(content)).map((p) => p.label);
}

function extractCodeSnippets(content: string): Array<{ language: string; content: string }> {
  const snippets: Array<{ language: string; content: string }> = [];
  const blocks = content.matchAll(/```(\w+)?\n([\s\S]*?)```/g);
  for (const m of blocks) {
    const lang = m[1] ?? 'unknown';
    const code = m[2]!.trim();
    if (code.length > 10 && code.length < 2000) snippets.push({ language: lang, content: code });
  }
  return snippets.slice(0, 10);
}

function extractMetaTags(content: string): Array<{ subject: string; predicate: string; object: string; confidence: number }> {
  const facts: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
  const title = content.match(/<title>(.+?)<\/title>/i);
  if (title) facts.push({ subject: 'page', predicate: 'title', object: title[1]!.trim(), confidence: 0.9 });
  const desc = content.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i);
  if (desc) facts.push({ subject: 'page', predicate: 'description', object: desc[1]!, confidence: 0.8 });
  return facts;
}
