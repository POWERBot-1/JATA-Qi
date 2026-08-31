// Living Command Surface Composer (FXL™ UI Composition Engine).

import type { ExperienceFingerprint, UserContext, CommandSurfaceLayout } from './types.js';

export class FXLComposer {
  compose(fingerprint: ExperienceFingerprint, context: UserContext): CommandSurfaceLayout {
    const intent = context.currentIntent.toLowerCase();
    let primaryCards: string[] = ['Overview', 'Recent Activity', 'Quick Actions'];
    let visibleTools: string[] = fingerprint.frequentlyUsedTools.slice(0, 5);
    let suggestedActions: string[] = ['Ask JATA Qi', 'Search Knowledge'];

    if (intent.includes('sale') || intent.includes('business') || intent.includes('revenue')) {
      primaryCards = ['Orders & Revenue', 'Customer Feed', 'Payments Ledger', 'Campaign Status'];
      suggestedActions = ['Review Orders', 'Analyze Revenue', 'Send Campaign'];
    } else if (intent.includes('learn') || intent.includes('study') || intent.includes('research')) {
      primaryCards = ['Knowledge RAG', 'Recent Notes', 'Active Topic', 'Progress'];
      suggestedActions = ['Search Notes', 'Ask Tutor', 'Summarize Document'];
    } else if (intent.includes('code') || intent.includes('engineering') || intent.includes('build')) {
      primaryCards = ['Repository Status', 'Agent Workspace', 'Test Results', 'Active Tools'];
      suggestedActions = ['Run Tests', 'Build Workspace', 'Deploy Agent'];
    }

    const density = context.deviceType === 'mobile' ? 'compact' : (fingerprint.personality === 'spacious' ? 'spacious' : 'comfortable');

    return {
      layoutId: `layout-${fingerprint.userId}-${Date.now()}`,
      title: `Living Surface: ${context.currentIntent || 'General Command'}`,
      primaryCards,
      visibleTools: visibleTools.length > 0 ? visibleTools : ['knowledge.search', 'agent.run'],
      suggestedActions,
      density,
      personality: fingerprint.personality,
    };
  }
}
