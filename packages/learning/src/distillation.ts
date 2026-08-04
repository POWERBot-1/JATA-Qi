// DistillationEngine (CLP Phase 5) — turns what JATA Qi learns into durable
// knowledge. High-confidence insights and deployed recommendations become:
//   1. knowledge-service documents (searchable/retrievable via RAG),
//   2. knowledge-graph entities + triples (queryable structure), and
//   3. operational playbooks (grouped actionable procedures).
//
// This is the "apply" half of the continuous learning loop: memory → insight →
// recommendation → deployment → distilled knowledge. Distillation is
// idempotent (each source is distilled at most once) and optional-dependency
// friendly (works with knowledge, graph, both, or neither).

import { randomUUID } from 'node:crypto';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import type {
  DistilledLesson, DistilledSourceType, DistillStats, LearningInsight, Playbook, Recommendation,
} from './types.js';

/** Insights below this confidence are considered too weak to persist. */
const DEFAULT_MIN_CONFIDENCE = 0.6;

export interface DistillInput {
  insights: LearningInsight[];
  /** Deployed recommendations (status 'deployed') become lessons + playbooks. */
  recommendations: Recommendation[];
  orgId?: string;
  knowledge?: KnowledgeService;
  graph?: KnowledgeGraphModule;
  /** Minimum insight confidence to distill (default 0.6). */
  minConfidence?: number;
}

export interface DistillRun {
  stats: DistillStats;
  lessons: DistilledLesson[];
  playbooks: Playbook[];
}

export class DistillationEngine {
  private lessons = new Map<string, DistilledLesson>();
  private playbooks: Playbook[] = [];
  /** Idempotency guard: `sourceType:sourceId` already distilled. */
  private distilled = new Set<string>();

  private counters = { documentsIngested: 0, graphEntities: 0, graphTriples: 0 };
  private lastDistilledAt?: number;

  /** Distill the learning stream into durable knowledge. Idempotent per source. */
  async distill(input: DistillInput): Promise<DistillRun> {
    const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const produced: DistilledLesson[] = [];
    const producedPlaybooks: Playbook[] = [];

    for (const insight of input.insights) {
      if (insight.confidence < minConfidence) continue;
      const key = `insight:${insight.id}`;
      if (this.distilled.has(key)) continue;
      const lesson = await this.distillSource({
        sourceType: 'insight',
        sourceId: insight.id,
        title: insight.title,
        body: `${insight.detail}\n\nEvidence: ${JSON.stringify(insight.evidence)}`,
        category: insight.kind,
        confidence: insight.confidence,
        orgId: insight.orgId ?? input.orgId,
        knowledge: input.knowledge,
        graph: input.graph,
      });
      this.distilled.add(key);
      produced.push(lesson);
    }

    // Deployed recommendations: distill as lessons AND assemble playbooks.
    const deployed = input.recommendations.filter((r) => r.status === 'deployed');
    for (const rec of deployed) {
      const key = `recommendation:${rec.id}`;
      if (this.distilled.has(key)) continue;
      const lesson = await this.distillSource({
        sourceType: 'recommendation',
        sourceId: rec.id,
        title: rec.title,
        body: `${rec.rationale}\n\nSteps:\n${rec.actions.map((a) => `- ${a}`).join('\n')}`,
        category: rec.category,
        confidence: rec.priority / 100,
        orgId: rec.orgId ?? input.orgId,
        knowledge: input.knowledge,
        graph: input.graph,
      });
      this.distilled.add(key);
      produced.push(lesson);

      const playbook = this.upsertPlaybook(rec, lesson, input.orgId);
      if (playbook) producedPlaybooks.push(playbook);
    }

    if (produced.length > 0) this.lastDistilledAt = Date.now();
    return { stats: this.stats(), lessons: produced, playbooks: producedPlaybooks };
  }

  lessonsList(): DistilledLesson[] {
    return [...this.lessons.values()];
  }

  playbooksList(): Playbook[] {
    return [...this.playbooks];
  }

  stats(): DistillStats {
    return {
      lessons: this.lessons.size,
      playbooks: this.playbooks.length,
      documentsIngested: this.counters.documentsIngested,
      graphEntities: this.counters.graphEntities,
      graphTriples: this.counters.graphTriples,
      ...(this.lastDistilledAt !== undefined ? { lastDistilledAt: this.lastDistilledAt } : {}),
    };
  }

  // ---- internals ---------------------------------------------------------

  private async distillSource(input: {
    sourceType: DistilledSourceType;
    sourceId: string;
    title: string;
    body: string;
    category: string;
    confidence: number;
    orgId?: string;
    knowledge?: KnowledgeService;
    graph?: KnowledgeGraphModule;
  }): Promise<DistilledLesson> {
    const lesson: DistilledLesson = {
      id: randomUUID(),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      title: input.title,
      body: input.body,
      category: input.category,
      confidence: input.confidence,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      distilledAt: Date.now(),
    };

    // 1. Knowledge service document (retrievable via RAG).
    if (input.knowledge) {
      try {
        const doc = await input.knowledge.ingestText(`# ${input.title}\n\n${input.body}`, {
          title: `Lesson: ${input.title}`,
          contentType: 'text/markdown',
          metadata: {
            source: 'learning',
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            category: input.category,
            confidence: input.confidence,
            ...(input.orgId ? { orgId: input.orgId } : {}),
          },
        });
        lesson.documentId = doc.id;
        this.counters.documentsIngested += 1;
      } catch { /* knowledge write failed — keep in-memory lesson */ }
    }

    // 2. Knowledge graph entity + triples (structured query surface).
    if (input.graph) {
      try {
        const entityId = `ent:lesson:${lesson.id}`;
        const entity = input.graph.addOrGetEntity({
          id: entityId,
          type: 'Lesson',
          name: input.title,
          properties: {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            category: input.category,
            confidence: input.confidence,
            ...(input.orgId ? { orgId: input.orgId } : {}),
          },
        });
        lesson.entityId = entity.id;
        this.counters.graphEntities += 1;
        // Anchor nodes must exist before triples reference them.
        input.graph.addOrGetEntity({ id: `cat:${input.category}`, type: 'Category', name: input.category });
        this.counters.graphEntities += 1;
        // lesson --derived_from--> source category anchor (+ org anchor).
        input.graph.addTriple({ subject: entityId, predicate: 'derived_from', object: `cat:${input.category}`, confidence: input.confidence });
        this.counters.graphTriples += 1;
        if (input.orgId) {
          input.graph.addOrGetEntity({ id: `org:${input.orgId}`, type: 'Organization', name: input.orgId });
          this.counters.graphEntities += 1;
          input.graph.addTriple({ subject: entityId, predicate: 'belongs_to', object: `org:${input.orgId}`, confidence: 1 });
          this.counters.graphTriples += 1;
        }
      } catch { /* graph write failed — keep in-memory lesson */ }
    }

    this.lessons.set(lesson.id, lesson);
    return lesson;
  }

  /** Group deployed recommendations into playbooks (one per category per org). */
  private upsertPlaybook(rec: Recommendation, lesson: DistilledLesson, orgId?: string): Playbook | undefined {
    let playbook = this.playbooks.find((p) => p.category === rec.category && p.orgId === orgId && p.status === 'active');
    if (!playbook) {
      playbook = {
        id: randomUUID(),
        name: playbookName(rec.category),
        category: rec.category,
        summary: `Operational playbook for ${rec.category.replace(/-/g, ' ')} improvements.`,
        steps: [],
        lessonIds: [],
        ...(orgId ? { orgId } : {}),
        status: 'active',
        createdAt: Date.now(),
      };
      this.playbooks.push(playbook);
    }
    for (const step of rec.actions) {
      if (!playbook.steps.includes(step)) playbook.steps.push(step);
    }
    if (!playbook.lessonIds.includes(lesson.id)) playbook.lessonIds.push(lesson.id);
    return playbook;
  }
}

/** Human-readable playbook name from a recommendation category. */
function playbookName(category: string): string {
  const words = category.split(/[-_]/).filter(Boolean);
  return `Playbook: ${words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`;
}
