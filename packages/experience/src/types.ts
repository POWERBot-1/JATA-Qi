// Types for Fingerprint Experience Layer (FXL™)

export type ExperienceStage = 'DISCOVERY' | 'LEARNING' | 'ADAPTATION' | 'ANTICIPATION' | 'MASTERY' | 'REINVENTION';

export type PersonalityDimension =
  | 'calm'
  | 'energetic'
  | 'minimalist'
  | 'executive'
  | 'visual'
  | 'analytical'
  | 'conversational'
  | 'compact'
  | 'spacious'
  | 'guided'
  | 'advanced';

export interface ExperienceFingerprint {
  userId: string;
  stage: ExperienceStage;
  personality: PersonalityDimension;
  preferredWorkflows: string[];
  frequentlyUsedTools: string[];
  interfacePreferences: Record<string, unknown>;
  dismissedRecommendations: string[];
  accessibility: {
    highContrast?: boolean;
    screenReader?: boolean;
    fontSize?: 'small' | 'medium' | 'large';
  };
  interactionCount: number;
  lastUpdated: string;
}

export interface UserContext {
  userId: string;
  currentIntent: string;
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'embedded';
  timeOfDay: string;
  activeRole: string;
}

export interface CommandSurfaceLayout {
  layoutId: string;
  title: string;
  primaryCards: string[];
  visibleTools: string[];
  suggestedActions: string[];
  density: 'compact' | 'comfortable' | 'spacious';
  personality: PersonalityDimension;
}
