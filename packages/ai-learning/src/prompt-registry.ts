// Prompt Registry — versioned prompt templates with approval workflows and
// variable rendering. Templates progress: draft → reviewed → active →
// deprecated. Only one version is active per template. Variables are extracted
// from {{mustache}} placeholders and resolved on render.

import { randomUUID } from 'node:crypto';
import type { PromptTemplate, PromptVersion, PromptVersionStatus } from './types.js';

export class PromptRegistry {
  private templates = new Map<string, PromptTemplate>();

  /** Create a new prompt template with an initial draft version. */
  create(input: { name: string; content: string; category: string; description?: string }): PromptTemplate {
    const templateId = randomUUID();
    const variables = extractVariables(input.content);
    const v1: PromptVersion = {
      id: randomUUID(), templateId, version: 1, content: input.content, variables,
      status: 'draft', createdAt: Date.now(),
    };
    const template: PromptTemplate = {
      id: templateId, name: input.name, category: input.category,
      ...(input.description ? { description: input.description } : {}),
      versions: [v1], createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.templates.set(templateId, template);
    return template;
  }

  /** Create a new draft version of an existing template. */
  newVersion(templateId: string, content: string, notes?: string): PromptVersion {
    const t = this.require(templateId);
    const version = t.versions.length + 1;
    const v: PromptVersion = {
      id: randomUUID(), templateId, version, content, variables: extractVariables(content),
      status: 'draft', createdAt: Date.now(), ...(notes ? { notes } : {}),
    };
    t.versions.push(v);
    t.updatedAt = Date.now();
    return v;
  }

  /** Approve a draft version (draft → reviewed). */
  approve(templateId: string, versionId: string, approver: string): PromptVersion {
    const v = this.requireVersion(templateId, versionId);
    if (v.status !== 'draft') throw new Error(`version ${versionId} is not draft (status: ${v.status})`);
    v.status = 'reviewed';
    v.approvedBy = approver;
    return v;
  }

  /** Activate a reviewed version (deprecates the previous active). */
  activate(templateId: string, versionId: string): PromptVersion {
    const t = this.require(templateId);
    const v = this.requireVersion(templateId, versionId);
    if (v.status !== 'reviewed') throw new Error(`version ${versionId} must be reviewed before activation`);
    // Deprecate the currently active version.
    if (t.activeVersionId) {
      const prev = t.versions.find((x) => x.id === t.activeVersionId);
      if (prev) prev.status = 'deprecated';
    }
    v.status = 'active';
    t.activeVersionId = versionId;
    t.updatedAt = Date.now();
    return v;
  }

  /** Deprecate a version. */
  deprecate(templateId: string, versionId: string): PromptVersion {
    const v = this.requireVersion(templateId, versionId);
    v.status = 'deprecated';
    return v;
  }

  get(templateId: string): PromptTemplate | undefined { return this.templates.get(templateId); }
  list(category?: string): PromptTemplate[] {
    const all = [...this.templates.values()];
    return category ? all.filter((t) => t.category === category) : all;
  }

  /** Get the active version of a template. */
  getActive(templateId: string): PromptVersion | undefined {
    const t = this.templates.get(templateId);
    return t?.activeVersionId ? t.versions.find((v) => v.id === t.activeVersionId) : undefined;
  }

  /** Render the active version with variables resolved. */
  render(templateId: string, vars: Record<string, string>): string {
    const v = this.getActive(templateId);
    if (!v) throw new Error(`no active version for template ${templateId}`);
    let out = v.content;
    for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, value);
    return out;
  }

  get size(): number { return this.templates.size; }

  private require(templateId: string): PromptTemplate {
    const t = this.templates.get(templateId);
    if (!t) throw new Error(`template ${templateId} not found`);
    return t;
  }
  private requireVersion(templateId: string, versionId: string): PromptVersion {
    const t = this.require(templateId);
    const v = t.versions.find((x) => x.id === versionId);
    if (!v) throw new Error(`version ${versionId} not found in template ${templateId}`);
    return v;
  }
}

/** Extract {{variable}} names from a prompt template string (sorted). */
export function extractVariables(content: string): string[] {
  const matches = content.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]!))].sort();
}
