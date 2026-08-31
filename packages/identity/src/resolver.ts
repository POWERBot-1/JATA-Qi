// Identity Resolver (JQ-IDENTITY-RESOLVER) and Identity Graph (JQ-IDENTITY-GRAPH)

import type { IdentityGraphNode, IdentityGraphEdge, ResolutionState } from './types.js';

export class IdentityResolver {
  resolve(reference: string): { canonicalId: string; state: ResolutionState } {
    const clean = reference.trim().toUpperCase();
    if (['JATA QI', 'JATA-QI', 'JATA QI AI', 'JQ'].includes(clean) || clean.includes('JATA-QI')) {
      return { canonicalId: 'JATA-QI', state: 'CANONICAL' };
    }
    if (clean.includes('JATA QI RELEASE') || clean.startsWith('V0.1')) {
      return { canonicalId: 'JATA-QI', state: 'VERSION' };
    }
    if (clean.includes('CORE-KERNEL') || clean.includes('MODEL-FABRIC')) {
      return { canonicalId: 'JATA-QI', state: 'MODULE' };
    }
    if (clean.length === 0) {
      return { canonicalId: '', state: 'AMBIGUOUS' };
    }
    return { canonicalId: '', state: 'UNRELATED' };
  }
}

export class IdentityGraph {
  private readonly nodes = new Map<string, IdentityGraphNode>();
  private readonly edges: IdentityGraphEdge[] = [];

  addNode(node: IdentityGraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(source: string, target: string, relation: string): void {
    this.edges.push({ source, target, relation });
  }

  getGraph(): { nodes: IdentityGraphNode[]; edges: IdentityGraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }
}
