// Experience Diversity Index and Advanced FXL Enhancements

import type { ExperienceFingerprint, CommandSurfaceLayout } from './types.js';

export class ExperienceDiversityEngine {
  calculateDiversityIndex(layouts: CommandSurfaceLayout[]): number {
    if (layouts.length <= 1) return 1.0;
    const uniqueCardSets = new Set(layouts.map((l) => l.primaryCards.join(',')));
    const uniquePersonalities = new Set(layouts.map((l) => l.personality));
    const diversityRatio = (uniqueCardSets.size / layouts.length) * 0.7 + (uniquePersonalities.size / 11) * 0.3;
    return Number(Math.min(1.0, Math.max(0.1, diversityRatio)).toFixed(3));
  }
}

export class FingerprintMemoryManager {
  private readonly profiles = new Map<string, ExperienceFingerprint>();

  exportProfile(userId: string): string {
    const fp = this.profiles.get(userId);
    if (!fp) throw new Error(`Fingerprint not found for user: ${userId}`);
    return JSON.stringify(fp, null, 2);
  }

  importProfile(jsonString: string): ExperienceFingerprint {
    const fp = JSON.parse(jsonString) as ExperienceFingerprint;
    this.profiles.set(fp.userId, fp);
    return fp;
  }

  deleteProfile(userId: string): boolean {
    return this.profiles.delete(userId);
  }
}
