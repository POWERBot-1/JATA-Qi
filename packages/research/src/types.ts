// JATA Qi Research — types (#25). Research workspaces with experiments,
// literature references, and hypothesis tracking. AI-generated hypotheses are
// always clearly labelled as such (directive #25: "clearly labeled as hypotheses").

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type ExperimentStatus = 'planned' | 'running' | 'completed' | 'failed';
export type HypothesisStatus = 'proposed' | 'testing' | 'supported' | 'refuted';

export interface ResearchProject {
  id: string;
  name: string;
  description?: string;
  field?: string;
  organizationId?: string;
  ownerId: string;
  status: ProjectStatus;
  createdAt: number;
}

export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  hypothesis?: string;
  methodology?: string;
  status: ExperimentStatus;
  results?: string;
  reproducible?: boolean;
  parameters?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface LiteratureRef {
  id: string;
  projectId: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  abstract?: string;
  tags?: string[];
  addedBy: string;
  createdAt: number;
}

export interface Hypothesis {
  id: string;
  projectId: string;
  statement: string;
  status: HypothesisStatus;
  evidence: string[];
  aiGenerated: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export const ResearchEvents = Object.freeze({
  ProjectCreated: 'research.project.created',
  ExperimentCreated: 'research.experiment.created',
  HypothesisProposed: 'research.hypothesis.proposed',
  HypothesisUpdated: 'research.hypothesis.updated',
} as const);
