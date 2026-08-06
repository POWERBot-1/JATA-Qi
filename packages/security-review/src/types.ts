// Independent Security Review — types.

export type ReviewKind =
  | 'architecture'   // security architecture assessment + design review
  | 'code'           // secure code review
  | 'infrastructure' // infrastructure review
  | 'ai_safety'      // AI safety review
  | 'compliance'     // compliance assessment (ISO 27001 / SOC 2)
  | 'independent_audit'; // periodic independent audit

export type ReviewStatus = 'planned' | 'in_progress' | 'completed' | 'needs_remediation' | 'signed_off';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'in_progress' | 'remediated' | 'accepted' | 'waived';

export interface SecurityReview {
  id: string;
  kind: ReviewKind;
  /** Component / system under review. */
  target: string;
  status: ReviewStatus;
  reviewer: string;
  /** Independent = reviewer is not the target's owner (separation of duties). */
  independent: boolean;
  /** Pre-production gate or periodic audit. */
  phase: 'pre_production' | 'periodic' | 'incident_driven';
  scheduledAt: number;
  startedAt?: number;
  completedAt?: number;
  signedOffBy?: string;
  summary?: string;
}

export interface ReviewFinding {
  id: string;
  reviewId: string;
  severity: FindingSeverity;
  title: string;
  description?: string;
  /** e.g. OWASP ASVS / NIST control mapping. */
  controlRef?: string;
  /** Recommended remediation. */
  recommendation?: string;
  status: FindingStatus;
  createdBy: string;
  createdAt: number;
  resolvedAt?: number;
}

/** Static-analysis / secure-code-check policy: patterns that must not appear. */
export interface CodeCheckRule {
  id: string;
  /** Regex pattern (tested against source lines). */
  pattern: string;
  severity: FindingSeverity;
  title: string;
  /** Languages / file extensions the rule applies to. */
  appliesTo?: string[];
}

export const DEFAULT_CODE_CHECK_RULES: CodeCheckRule[] = [
  { id: 'code.hardcoded_secret', pattern: '(api[_-]?[kK]ey|secret|password|passwd|token)\\s*[:=]\\s*[\'\"][A-Za-z0-9_\\-]{12,}', severity: 'critical', title: 'Hardcoded secret detected', appliesTo: ['.ts', '.js', '.py', '.env'] },
  { id: 'code.eval', pattern: '\\beval\\(', severity: 'high', title: 'eval() usage', appliesTo: ['.js', '.ts'] },
  { id: 'code.exec', pattern: '(child_process|execSync|shelljs)', severity: 'high', title: 'Direct process execution', appliesTo: ['.js', '.ts'] },
  { id: 'code.sql_concat', pattern: '(SELECT|INSERT|UPDATE|DELETE)\\b[^;]{0,60}"\\s*\\+', severity: 'high', title: 'Potential SQL injection (string concatenation)', appliesTo: ['.js', '.ts', '.py'] },
  { id: 'code.insecure_crypto', pattern: '(md5|sha1)\\(', severity: 'medium', title: 'Weak cryptographic hash', appliesTo: ['.js', '.ts', '.py'] },
  { id: 'code.debug', pattern: '(console\\.log|print)\\(.*(password|secret|token)', severity: 'medium', title: 'Sensitive data logged', appliesTo: ['.js', '.ts', '.py'] },
];

export interface CodeCheckResult {
  file: string;
  line: number;
  ruleId: string;
  severity: FindingSeverity;
  title: string;
  snippet: string;
}

export interface ReviewStats {
  total: number;
  completed: number;
  signedOff: number;
  needsRemediation: number;
  openFindings: number;
  criticalFindings: number;
  highFindings: number;
  remediatedFindings: number;
  acceptedFindings: number;
  complianceScore: number; // 0..100
}
