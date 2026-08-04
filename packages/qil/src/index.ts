// Public API for @jataqi/qil — the Quantum Intelligence Language.
export { tokenize } from './lexer.js';
export { LexError } from './lexer.js';
export { parse, ParseError } from './parser.js';
export { validate, hasErrors } from './validator.js';
export { compile, compileSource } from './lowerer.js';
export { format, formatProgram, renderStatementLine, renderLiteral } from './formatter.js';
export { lint, lintSource } from './linter.js';
export { QiLModule } from './qil-module.js';

export {
  STRUCTURAL_KEYWORDS,
  DECLARATION_KEYWORDS,
  ACTION_KEYWORDS,
  ALL_KEYWORDS,
  QiLEvents,
} from './types.js';
export type {
  Token,
  TokenType,
  Literal,
  QiLStatement,
  QiLProgram,
  StepKind,
  PlanStep,
  ExecutionPlan,
  Diagnostic,
  DiagnosticSeverity,
  QiLCompileResult,
} from './types.js';
