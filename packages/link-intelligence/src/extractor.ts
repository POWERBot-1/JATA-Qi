// Intelligence Extractor (Phase 2) — transforms classified content into
// structured intelligence objects (architectures, APIs, patterns, security
// models, etc.). Uses heuristic pattern matching over the content to produce
// normalized semantic objects without requiring an LLM (deterministic + offline).

import type { IntelligenceExtract, Language } from './types.js';

/** Extract structured intelligence from classified content. */
export function extract(content: string): IntelligenceExtract {
  return {
    architectures: extractMatches(content, ARCH_PATTERNS),
    designPatterns: extractMatches(content, PATTERN_PATTERNS),
    algorithms: extractMatches(content, ALGO_PATTERNS),
    dataModels: extractMatches(content, DATA_MODEL_PATTERNS),
    apis: extractApis(content),
    services: extractMatches(content, SERVICE_PATTERNS),
    securityModels: extractMatches(content, SECURITY_PATTERNS),
    authMechanisms: extractMatches(content, AUTH_PATTERNS),
    aiWorkflows: extractMatches(content, AI_PATTERNS),
    uiSystems: extractMatches(content, UI_PATTERNS),
    deploymentModels: extractMatches(content, DEPLOY_PATTERNS),
    devOpsPractices: extractMatches(content, DEVOPS_PATTERNS),
    performanceOptimizations: extractMatches(content, PERF_PATTERNS),
    testingMethodologies: extractMatches(content, TESTING_PATTERNS),
    domainConcepts: extractDomainConcepts(content),
    businessCapabilities: extractMatches(content, BUSINESS_PATTERNS),
    infrastructurePatterns: extractMatches(content, INFRA_PATTERNS),
    snippets: extractSnippets(content),
    confidence: Math.min(1, content.length / 5000),
    extractedAt: Date.now(),
  };
}

function extractMatches(content: string, patterns: Array<{ re: RegExp; label: string }>): string[] {
  const found = new Set<string>();
  for (const { re, label } of patterns) if (re.test(content)) found.add(label);
  return [...found];
}

function extractApis(content: string): Array<{ name: string; method?: string; path?: string; description?: string }> {
  const apis: Array<{ name: string; method?: string; path?: string; description?: string }> = [];
  // REST endpoints: GET /path, POST /path, etc.
  const restMatches = content.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s<"'`]+)/g);
  for (const m of restMatches) {
    apis.push({ name: `${m[1]} ${m[2]}`, method: m[1], path: m[2] });
  }
  // Express-style: app.get('/path'), router.post('/path'), etc.
  const expressMatches = content.matchAll(/\.(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`)]+)/gi);
  for (const m of expressMatches) {
    const method = m[1]!.toUpperCase();
    const path = m[2]!;
    apis.push({ name: `${method} ${path}`, method, path });
  }
  // OpenAPI path definitions.
  const openApiMatches = content.matchAll(/["']([A-Z]+)["']\s*:\s*\{[^}]*["']?path["']?\s*:\s*["'](\/[^"']+)["']/g);
  for (const m of openApiMatches) {
    apis.push({ name: `${m[1]} ${m[2]}`, method: m[1], path: m[2] });
  }
  // Function exports: export function foo, def foo, pub fn foo.
  const fnMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g);
  for (const m of fnMatches) {
    const name = m[1] ?? m[2];
    if (name && name.length > 2) apis.push({ name });
  }
  // Deduplicate.
  const seen = new Set<string>();
  return apis.filter((a) => { const k = a.name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50);
}

function extractDomainConcepts(content: string): string[] {
  const concepts = new Set<string>();
  // Capitalized multi-word terms (potential domain concepts).
  const matches = content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g);
  const stopWords = new Set(['The', 'This', 'That', 'These', 'Those', 'Some', 'More', 'Less', 'Very', 'Just', 'Also', 'Only', 'When', 'Where', 'What', 'Which', 'How', 'Why', 'Who', 'Use', 'Using', 'Used', 'Make', 'Makes', 'Made', 'Get', 'Set', 'Put', 'Run', 'Runs', 'Running', 'Add', 'Adds', 'Added', 'New', 'Old', 'All', 'Each', 'Every', 'First', 'Last', 'Next', 'Previous', 'GitHub', 'GitLab', 'API', 'HTTP', 'JSON', 'XML', 'URL', 'SQL', 'HTML', 'CSS']);
  for (const m of matches) {
    const concept = m[1]!;
    if (concept.length > 3 && !stopWords.has(concept) && !stopWords.has(concept.split(' ')[0]!)) {
      concepts.add(concept);
    }
  }
  return [...concepts].slice(0, 30);
}

function extractSnippets(content: string): Array<{ language: Language; content: string; description: string }> {
  const snippets: Array<{ language: Language; content: string; description: string }> = [];
  // Markdown code blocks.
  const blocks = content.matchAll(/```(\w+)?\n([\s\S]*?)```/g);
  for (const m of blocks) {
    const lang = (m[1] ?? 'unknown') as Language;
    const code = m[2]!.trim();
    if (code.length > 10 && code.length < 2000) {
      snippets.push({ language: lang, content: code, description: `Code snippet (${lang})` });
    }
  }
  return snippets.slice(0, 10);
}

// ---- pattern libraries ----------------------------------------------------

const ARCH_PATTERNS = [
  { re: /microservice|micro-service/i, label: 'Microservices' },
  { re: /monolith|monolithic/i, label: 'Monolithic' },
  { re: /event[\s-]?driven|event\s+sourcing/i, label: 'Event-Driven' },
  { re: /serverless|lambda|function\s+as\s+a\s+service/i, label: 'Serverless' },
  { re: /cqrs|command\s+query\s+responsibility/i, label: 'CQRS' },
  { re: /hexagonal|clean\s+architecture|ports\s+and\s+adapters/i, label: 'Hexagonal/Clean Architecture' },
  { re: /domain[\s-]?driven|ddd\b/i, label: 'Domain-Driven Design' },
  { re: /service[\s-]?oriented|soa\b/i, label: 'SOA' },
];

const PATTERN_PATTERNS = [
  { re: /singleton|factory|builder|observer|strategy|adapter|decorator|facade/i, label: 'GoF Design Patterns' },
  { re: /repository\s+pattern/i, label: 'Repository Pattern' },
  { re: /unit[\s-]?of[\s-]?work/i, label: 'Unit of Work' },
  { re: /dependency\s+injection|inversion\s+of\s+control/i, label: 'Dependency Injection' },
  { re: /middleware/i, label: 'Middleware' },
  { re: /plugin|extension/i, label: 'Plugin/Extension' },
  { re: /pub\s*sub|publish\s+subscribe/i, label: 'Pub/Sub' },
];

const ALGO_PATTERNS = [
  { re: /consensus|raft|paxos/i, label: 'Consensus Algorithm' },
  { re: /map[\s-]?reduce/i, label: 'MapReduce' },
  { re: /merkle\s+tree|hash\s+tree/i, label: 'Merkle Tree' },
  { re: /bloom\s+filter/i, label: 'Bloom Filter' },
  { re: /consistent\s+hashing/i, label: 'Consistent Hashing' },
  { re: /rate\s+limit|throttl/i, label: 'Rate Limiting' },
  { re: /backpressure/i, label: 'Backpressure' },
  { re: /circuit\s+breaker/i, label: 'Circuit Breaker' },
  { re: /exponential\s+backoff|retry/i, label: 'Retry with Backoff' },
];

const DATA_MODEL_PATTERNS = [
  { re: /relational|sql|rdbms|postgres|mysql/i, label: 'Relational (SQL)' },
  { re: /document|mongodb|couchdb|nosql/i, label: 'Document (NoSQL)' },
  { re: /graph\s+database|neo4j|sparql/i, label: 'Graph Database' },
  { re: /time[\s-]?series|influx|prometheus/i, label: 'Time-Series' },
  { re: /key[\s-]?value|redis|dynamodb/i, label: 'Key-Value Store' },
  { re: /column[\s-]?family|cassandra|hbase/i, label: 'Column-Family' },
  { re: /vector\s+(database|index|search)/i, label: 'Vector Database' },
];

const SERVICE_PATTERNS = [
  { re: /api\s+gateway/i, label: 'API Gateway' },
  { re: /service\s+mesh|istio|linkerd/i, label: 'Service Mesh' },
  { re: /load\s+balancer|nginx|haproxy/i, label: 'Load Balancer' },
  { re: /message\s+queue|kafka|rabbitmq|nats/i, label: 'Message Queue' },
  { re: /cache|redis|memcached/i, label: 'Cache' },
  { re: /cdn|cloudfront|cloudflare/i, label: 'CDN' },
  { re: /search\s+engine|elasticsearch|solr/i, label: 'Search Engine' },
];

const SECURITY_PATTERNS = [
  { re: /zero[\s-]?trust/i, label: 'Zero Trust' },
  { re: /rbac|role[\s-]?based\s+access/i, label: 'RBAC' },
  { re: /abac|attribute[\s-]?based\s+access/i, label: 'ABAC' },
  { re: /oauth|openid|oidc|saml/i, label: 'Federation/SSO' },
  { re: /mfa|multi[\s-]?factor|totp|webauthn|passkey/i, label: 'MFA' },
  { re: /encryption[\s-]?at[\s-]?rest|aes|gcm/i, label: 'Encryption at Rest' },
  { re: /encryption[\s-]?in[\s-]?transit|tls|ssl/i, label: 'TLS/Encryption in Transit' },
  { re: /audit\s+log|audit\s+trail/i, label: 'Audit Logging' },
];

const AUTH_PATTERNS = [
  { re: /jwt|json\s+web\s+token/i, label: 'JWT' },
  { re: /api\s+key|bearer\s+token/i, label: 'API Key/Bearer' },
  { re: /basic\s+auth/i, label: 'Basic Auth' },
  { re: /oauth/i, label: 'OAuth' },
  { re: /oidc|openid/i, label: 'OIDC' },
  { re: /saml/i, label: 'SAML' },
  { re: /session\s+cookie/i, label: 'Session Cookie' },
  { re: /mTLS|mutual\s+TLS/i, label: 'mTLS' },
];

const AI_PATTERNS = [
  { re: /large\s+language\s+model|llm|gpt|claude|gemini/i, label: 'LLM Integration' },
  { re: /retrieval[\s-]?augmented|rag\b/i, label: 'RAG' },
  { re: /fine[\s-]?tun|embedding\s+model/i, label: 'Model Fine-Tuning/Embeddings' },
  { re: /agent|autonomous|tool[\s-]?use/i, label: 'AI Agents' },
  { re: /prompt\s+engineer|prompt\s+template/i, label: 'Prompt Engineering' },
  { re: /vector\s+embed|semantic\s+search/i, label: 'Vector/Semantic Search' },
];

const UI_PATTERNS = [
  { re: /react|vue|angular|svelte|solid/i, label: 'SPA Framework' },
  { re: /responsive|mobile[\s-]?first/i, label: 'Responsive Design' },
  { re: /design\s+system|design\s+token/i, label: 'Design System' },
  { re: /accessibility|wcag|aria/i, label: 'Accessibility' },
  { re: /dark\s+mode|theme/i, label: 'Theming' },
];

const DEPLOY_PATTERNS = [
  { re: /docker|container/i, label: 'Containers' },
  { re: /kubernetes|k8s|helm/i, label: 'Kubernetes' },
  { re: /serverless|lambda|cloud\s+function/i, label: 'Serverless' },
  { re: /blue[\s-]?green|canary/i, label: 'Blue-Green/Canary Deployment' },
  { re: /terraform|pulumi|cloudformation/i, label: 'Infrastructure as Code' },
  { re: /ci\/cd|github\s+actions|gitlab\s+ci|jenkins/i, label: 'CI/CD Pipeline' },
];

const DEVOPS_PATTERNS = [
  { re: /observability|opentelemetry|otel/i, label: 'Observability' },
  { re: /prometheus|grafana|datadog/i, label: 'Monitoring' },
  { re: /distributed\s+tracing|jaeger|zipkin/i, label: 'Distributed Tracing' },
  { re: /log\s+aggregat|elk\s+stack|fluentd/i, label: 'Log Aggregation' },
  { re: /chaos\s+engineering|fault\s+injection/i, label: 'Chaos Engineering' },
];

const PERF_PATTERNS = [
  { re: /connection\s+pool/i, label: 'Connection Pooling' },
  { re: /lazy\s+load|code\s+split/i, label: 'Lazy Loading' },
  { re: /index|optimize\s+query/i, label: 'Database Indexing' },
  { re: /batch|bulk\s+operat/i, label: 'Batching' },
  { re: /cache\s+strategy|lru|lfu/i, label: 'Caching Strategy' },
];

const TESTING_PATTERNS = [
  { re: /unit\s+test|jest|vitest|mocha|pytest/i, label: 'Unit Testing' },
  { re: /integration\s+test|e2e|cypress|playwright/i, label: 'Integration/E2E Testing' },
  { re: /property[\s-]?based\s+test|quickcheck|fast[\s-]?check/i, label: 'Property-Based Testing' },
  { re: /benchmark|perf\s+test|load\s+test|stress\s+test/i, label: 'Performance/Load Testing' },
  { re: /fuzz\s+test|mutation\s+test/i, label: 'Fuzz/Mutation Testing' },
  { re: /contract\s+test|pact/i, label: 'Contract Testing' },
  { re: /security\s+test|penetrat|sast|dast/i, label: 'Security Testing' },
];

const BUSINESS_PATTERNS = [
  { re: /subscri|saas|paywall/i, label: 'Subscription/SaaS' },
  { re: /marketplace|seller|buyer/i, label: 'Marketplace' },
  { re: /payment|billing|invoice|stripe|paypal/i, label: 'Payments/Billing' },
  { re: /analytics|dashboard|report/i, label: 'Analytics/Reporting' },
  { re: /workflow|approval|business\s+rule/i, label: 'Workflow Engine' },
  { re: /notification|alert|email|sms/i, label: 'Notifications' },
  { re: /multi[\s-]?tenant|organization|tenant/i, label: 'Multi-Tenancy' },
];

const INFRA_PATTERNS = [
  { re: /load\s+balanc|reverse\s+proxy/i, label: 'Load Balancing' },
  { re: /auto[\s-]?scal|horizontal\s+scal/i, label: 'Auto-Scaling' },
  { re: /disaster\s+recovery|backup|snapshot/i, label: 'Disaster Recovery' },
  { re: /multi[\s-]?region|geo[\s-]?redundan|anycast/i, label: 'Multi-Region' },
  { re: /edge\s+comput|cdn|fog\s+comput/i, label: 'Edge Computing' },
];
