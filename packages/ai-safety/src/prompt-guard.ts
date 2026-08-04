// PromptGuard — heuristic detection of prompt injection, jailbreak attempts,
// PII leakage, and content safety violations. Zero deps (pure string analysis).

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface GuardResult {
  risk: RiskLevel;
  blocked: boolean;
  violations: GuardViolation[];
  sanitizedInput?: string;
}

export interface GuardViolation {
  type: ViolationType;
  severity: RiskLevel;
  message: string;
  pattern: string;
  match?: string;
}

export type ViolationType =
  | 'injection_override'    // "ignore previous instructions", "you are now..."
  | 'injection_extraction'  // "repeat your system prompt", "what are your rules"
  | 'jailbreak_roleplay'    // DAN, developer mode, simulated persona
  | 'pii_credit_card'       // credit card number patterns
  | 'pii_ssn'               // US Social Security Number
  | 'pii_email'             // email addresses (configurable)
  | 'pii_phone'             // phone numbers (configurable)
  | 'toxicity'              // slurs, threats, violence markers
  | 'data_exfil'            // "send to", "post to URL", base64 blobs
  | 'code_exec'             // shell/code injection in prompts
;

export interface GuardConfig {
  /** Block at this risk level and above (default 'high'). */
  blockAt?: RiskLevel;
  /** Enable PII detection (default true). */
  detectPII?: boolean;
  /** Enable toxicity detection (default true). */
  detectToxicity?: boolean;
  /** Max input length before truncation (default 100_000 chars). */
  maxInputLength?: number;
}

const DEFAULT_CONFIG: Required<GuardConfig> = {
  blockAt: 'high',
  detectPII: true,
  detectToxicity: true,
  maxInputLength: 100_000,
};

const RISK_ORDER: Record<RiskLevel, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

// --- Detection rules ---------------------------------------------------------

interface Rule {
  type: ViolationType;
  severity: RiskLevel;
  pattern: RegExp;
  message: string;
}

const INJECTION_RULES: Rule[] = [
  { type: 'injection_override', severity: 'critical', message: 'Instruction override attempt', pattern: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?|directives?)/i },
  { type: 'injection_override', severity: 'critical', message: 'System role hijack', pattern: /(?:you\s+are\s+now|act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a|an)\s+(?:developer|admin|root|unrestricted|jailbroken|DAN)|enter\s+(?:developer|god|root)\s+mode)/i },
  { type: 'injection_override', severity: 'high', message: 'Authority claim', pattern: /(?:I\s+am\s+(?:your|the)\s+(?:developer|admin|creator|owner|root)|as\s+(?:your|the)\s+(?:developer|admin|creator))/i },
  { type: 'injection_extraction', severity: 'high', message: 'System prompt extraction', pattern: /(?:repeat|reveal|show|print|output|display)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|directives?|initial\s+message)/i },
  { type: 'injection_extraction', severity: 'medium', message: 'Internal disclosure probe', pattern: /(?:what\s+(?:are|is)\s+your\s+(?:rules|instructions|constraints|limitations)|tell\s+me\s+(?:everything|all)\s+(?:about\s+)?yourself)/i },
  { type: 'jailbreak_roleplay', severity: 'critical', message: 'DAN jailbreak pattern', pattern: /DAN|do\s+anything\s+now|AIM\s+(?:mode|persona)/i },
  { type: 'jailbreak_roleplay', severity: 'high', message: 'Mode override', pattern: /(?:enter|enable|activate|switch\s+to)\s+(?:jailbreak|unrestricted|unfiltered|unsafe|chaos|evil)\s*(?:mode|persona|character)/i },
  { type: 'code_exec', severity: 'high', message: 'Code execution in prompt', pattern: /(?:```(?:python|bash|sh|javascript|node|ruby|php)|exec\(|eval\(|system\(|os\.system|child_process|subprocess)/i },
  { type: 'data_exfil', severity: 'high', message: 'Data exfiltration attempt', pattern: /(?:send|post|upload|transfer|exfiltrate).{0,40}?(?:data|info|results?|secrets?).{0,15}?to\s+(?:https?:\/\/|ftp:\/\/|an?\s+(?:url|endpoint|webhook|server))/i },
];

const PII_RULES: Rule[] = [
  { type: 'pii_credit_card', severity: 'high', message: 'Credit card number detected', pattern: /\b(?:\d[ -]*?){13,16}\b/ },
  { type: 'pii_ssn', severity: 'high', message: 'SSN detected', pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/ },
  { type: 'pii_email', severity: 'medium', message: 'Email address detected', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ },
  { type: 'pii_phone', severity: 'low', message: 'Phone number detected', pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
];

const TOXICITY_RULES: Rule[] = [
  { type: 'toxicity', severity: 'critical', message: 'Threat of violence', pattern: /(?:I\s+will|I'm\s+going\s+to|gonna)\s+(?:kill|hurt|attack|harm|destroy|bomb|shoot|stab)/i },
  { type: 'toxicity', severity: 'high', message: 'Self-harm reference', pattern: /(?:kill\s+myself|end\s+my\s+life|suicide|self[- ]?harm|cutting\s+myself)/i },
  { type: 'toxicity', severity: 'high', message: 'Hate speech marker', pattern: /(?:racial|ethnic|religious)\s+(?:slur|epithet)|(?:gook|kike|spic|tranny|faggot)/i },
  { type: 'toxicity', severity: 'medium', message: 'Profanity', pattern: /(?:fuck|shit|bitch|asshole|dickhead|bastard)/i },
];

function severityRank(s: RiskLevel): number { return RISK_ORDER[s]; }

/** The core guard — scans input text and returns a risk assessment. */
export class PromptGuard {
  private readonly cfg: Required<GuardConfig>;
  private readonly rules: Rule[];

  constructor(config: GuardConfig = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    const active: Rule[] = [...INJECTION_RULES];
    if (this.cfg.detectPII) active.push(...PII_RULES);
    if (this.cfg.detectToxicity) active.push(...TOXICITY_RULES);
    this.rules = active;
  }

  scan(input: string): GuardResult {
    const truncated = input.length > this.cfg.maxInputLength ? input.slice(0, this.cfg.maxInputLength) : input;
    const violations: GuardViolation[] = [];

    for (const rule of this.rules) {
      const match = truncated.match(rule.pattern);
      if (match) {
        violations.push({
          type: rule.type,
          severity: rule.severity,
          message: rule.message,
          pattern: rule.pattern.source,
          match: match[0],
        });
      }
    }

    const maxRisk: RiskLevel = violations.length === 0
      ? 'safe'
      : violations.reduce((max, v) => severityRank(v.severity) > severityRank(max) ? v.severity : max, 'safe' as RiskLevel);

    const blocked = severityRank(maxRisk) >= severityRank(this.cfg.blockAt);

    return {
      risk: maxRisk,
      blocked,
      violations,
      ...(blocked ? { sanitizedInput: this.sanitize(truncated) } : {}),
    };
  }

  /** Quick check: returns true if the input should be blocked. */
  isBlocked(input: string): boolean {
    return this.scan(input).blocked;
  }

  /** Redact detected PII from the input. */
  sanitize(input: string): string {
    return input
      .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED-CC]')
      .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '[REDACTED-SSN]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED-EMAIL]')
      .replace(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED-PHONE]');
  }
}
