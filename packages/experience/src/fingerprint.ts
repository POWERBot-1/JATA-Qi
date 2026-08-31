// Experience Fingerprint manager and evolution engine.

import type { ExperienceFingerprint, ExperienceStage, PersonalityDimension } from './types.js';

export class FingerprintManager {
  private readonly fingerprints = new Map<string, ExperienceFingerprint>();

  getOrCreate(userId: string): ExperienceFingerprint {
    let fp = this.fingerprints.get(userId);
    if (!fp) {
      fp = {
        userId,
        stage: 'DISCOVERY',
        personality: 'executive',
        preferredWorkflows: [],
        frequentlyUsedTools: [],
        interfacePreferences: {},
        dismissedRecommendations: [],
        accessibility: { fontSize: 'medium' },
        interactionCount: 0,
        lastUpdated: new Date().toISOString(),
      };
      this.fingerprints.set(userId, fp);
    }
    return fp;
  }

  recordInteraction(userId: string, workflow: string, toolUsed?: string): ExperienceFingerprint {
    const fp = this.getOrCreate(userId);
    fp.interactionCount++;
    if (workflow && !fp.preferredWorkflows.includes(workflow)) {
      fp.preferredWorkflows.unshift(workflow);
      if (fp.preferredWorkflows.length > 10) fp.preferredWorkflows.pop();
    }
    if (toolUsed && !fp.frequentlyUsedTools.includes(toolUsed)) {
      fp.frequentlyUsedTools.unshift(toolUsed);
      if (fp.frequentlyUsedTools.length > 10) fp.frequentlyUsedTools.pop();
    }

    // Evolve stage based on interaction count
    if (fp.interactionCount > 100) fp.stage = 'MASTERY';
    else if (fp.interactionCount > 50) fp.stage = 'ANTICIPATION';
    else if (fp.interactionCount > 20) fp.stage = 'ADAPTATION';
    else if (fp.interactionCount > 5) fp.stage = 'LEARNING';

    fp.lastUpdated = new Date().toISOString();
    return fp;
  }

  setPersonality(userId: string, personality: PersonalityDimension): ExperienceFingerprint {
    const fp = this.getOrCreate(userId);
    fp.personality = personality;
    fp.lastUpdated = new Date().toISOString();
    return fp;
  }
}
