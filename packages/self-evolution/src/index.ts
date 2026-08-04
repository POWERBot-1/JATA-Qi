// Public API for @jataqi/self-evolution.
export { SelfEvolutionModule } from './self-evolution-module.js';
export type { RecordObservationInput, CreateProposalInput } from './self-evolution-module.js';
export {
  EvolutionEvents, DEFAULT_CONFIDENCE_THRESHOLD, MAX_AUTONOMOUS_CYCLES,
} from './types.js';
export type {
  ObservationType, Severity, Observation, ProposalStatus, ProposalKind, Proposal,
  ExperimentMode, ExperimentStatus, Experiment, LessonLearned, ExplainabilityReport,
} from './types.js';
