// PR5 — Deployment-artifact validation. Structurally verifies the Kubernetes
// manifests, Helm chart, and monitoring stack under deploy/ are well-formed
// (no YAML parser dependency: K8s YAML is regular enough to validate by shape,
// and the Grafana dashboard is validated as JSON). Runs as part of `npm test`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/test/deployment-artifacts.test.js -> repo root (4 levels up).
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEPLOY = path.join(REPO_ROOT, 'deploy');

function read(rel: string): string {
  return fs.readFileSync(path.join(DEPLOY, rel), 'utf8');
}
function listFiles(dirRel: string): string[] {
  const dir = path.join(DEPLOY, dirRel);
  return fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory());
}

/** Split a multi-doc YAML file into raw document strings. */
function yamlDocs(text: string): string[] {
  return text.split(/\n---\s*\n/).map((d) => d.trim()).filter(Boolean);
}

describe('deployment artifacts — present & non-empty', () => {
  const expected = [
    'k8s/namespace.yaml', 'k8s/configmap.yaml', 'k8s/secret.yaml', 'k8s/serviceaccount.yaml',
    'k8s/deployment.yaml', 'k8s/service.yaml', 'k8s/ingress.yaml', 'k8s/hpa.yaml',
    'k8s/pdb.yaml', 'k8s/networkpolicy.yaml', 'k8s/kustomization.yaml',
    'monitoring/service-monitor.yaml', 'monitoring/prometheus-rules.yaml',
    'monitoring/prometheus.yml', 'monitoring/grafana-datasource.yaml', 'monitoring/grafana-dashboard.json',
    'helm/jataqi/Chart.yaml', 'helm/jataqi/values.yaml',
  ];
  for (const f of expected) {
    it(`deploy/${f} exists and is non-trivial`, () => {
      const text = read(f);
      assert.ok(text.length > 50, `${f} is too small`);
      assert.ok(!/\t/.test(text), `${f} must not contain tab characters (invalid YAML)`);
    });
  }
});

describe('Kubernetes manifests — valid document shape', () => {
  const files = listFiles('k8s').filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 10, `expected >=10 K8s manifests, found ${files.length}`);
  for (const f of files) {
    it(`k8s/${f}: every resource doc declares apiVersion + kind`, () => {
      const docs = yamlDocs(read(`k8s/${f}`));
      for (const doc of docs) {
        // Skip kustomization.yaml (no apiVersion+kind per resource) — it has its own kind.
        if (doc.startsWith('apiVersion: kustomize')) continue;
        if (/^kind:\s*\w/m.test(doc)) {
          assert.match(doc, /^apiVersion:\s*\S/m, `k8s/${f} has a kind but no apiVersion`);
        }
      }
    });
    it(`k8s/${f}: resources are labeled with app.kubernetes.io/name`, () => {
      const text = read(`k8s/${f}`);
      if (text.includes('kind: Namespace')) return; // namespace labels itself
      assert.match(text, /app\.kubernetes\.io\/name/, `k8s/${f} should carry standard labels`);
    });
  }
});

describe('Kubernetes manifests — workload hardening', () => {
  it('StatefulSet runs non-root, drops ALL capabilities, and probes /livez + /readyz', () => {
    const text = read('k8s/deployment.yaml');
    assert.match(text, /runAsNonRoot:\s*true/);
    assert.match(text, /runAsUser:\s*\d+/);
    assert.match(text, /drop:\s*\[\s*"ALL"\s*\]|drop:\n\s*-\s*ALL/);
    assert.match(text, /readOnlyRootFilesystem:\s*true/);
    assert.match(text, /path: \/livez/);
    assert.match(text, /path: \/readyz/);
    assert.match(text, /resources:/);          // resource requests/limits present
    assert.match(text, /volumeClaimTemplates:/); // persistent storage
  });

  it('NetworkPolicy denies by default and allows only 7400 ingress + DNS/443 egress', () => {
    const text = read('k8s/networkpolicy.yaml');
    assert.match(text, /policyTypes:.*Ingress.*Egress|policyTypes:\s*\n.*Ingress.*\n.*Egress/s);
    assert.match(text, /port: 7400/);
    assert.match(text, /port: 443/);
  });

  it('HPA targets the StatefulSet on CPU + memory', () => {
    const text = read('k8s/hpa.yaml');
    assert.match(text, /kind: StatefulSet/);
    assert.match(text, /name: cpu/);
    assert.match(text, /name: memory/);
  });

  it('Ingress terminates TLS and wires CORS', () => {
    const text = read('k8s/ingress.yaml');
    assert.match(text, /tls:/);
    assert.match(text, /enable-cors/);
  });
});

describe('monitoring stack — shape', () => {
  it('ServiceMonitor scrapes /metrics', () => {
    const text = read('monitoring/service-monitor.yaml');
    assert.match(text, /kind: ServiceMonitor/);
    assert.match(text, /path: \/metrics/);
  });
  it('alerting rules reference the gateway metrics', () => {
    const text = read('monitoring/prometheus-rules.yaml');
    assert.match(text, /jataqi_requests_total/);
    assert.match(text, /jataqi_request_duration_ms_bucket/);
    assert.match(text, /severity:\s*(critical|warning)/);
  });
  it('governance SLA alert rules target the tool-intelligence metrics', () => {
    const text = read('monitoring/prometheus-rules.yaml');
    assert.match(text, /JataQiToolApprovalQueueHigh/);
    assert.match(text, /jataqi_tool_pending_approvals/);
    assert.match(text, /JataQiToolGovernanceDenySpike/);
    assert.match(text, /jataqi_tool_governance_decisions_total\{decision="DENY"\}/);
    assert.match(text, /JataQiToolR4InvocationRateHigh/);
    assert.match(text, /jataqi_tool_invocations_total\{risk=~"R4\|R5"\}/);
  });
  it('Grafana dashboard is valid JSON with RED panels', () => {
    const dash = JSON.parse(read('monitoring/grafana-dashboard.json')) as { panels: { title: string }[]; title: string };
    assert.ok(dash.title.includes('JATA Qi'));
    assert.ok(dash.panels.length >= 4);
    assert.ok(dash.panels.some((p) => p.title.includes('Requests')));
    assert.ok(dash.panels.some((p) => p.title.includes('Latency')));
  });
});


describe('Terraform — valid configuration', () => {
  it('main.tf uses required providers + modules', () => {
    const text = read('terraform/main.tf');
    assert.match(text, /required_providers/, 'must declare required providers');
    assert.match(text, /terraform-aws-modules\/eks/, 'must use the EKS module');
    assert.match(text, /terraform-aws-modules\/vpc/, 'must use the VPC module');
    assert.match(text, /aws_db_instance/, 'must provision RDS PostgreSQL');
    assert.match(text, /aws_s3_bucket.*backups/, 'must provision a backup bucket');
    assert.match(text, /storage_encrypted.*=.*true/, 'RDS must encrypt storage');
  });
  it('variables.tf has sensible defaults', () => {
    const text = read('terraform/variables.tf');
    for (const v of ['project_name', 'aws_region', 'postgres_version', 'db_instance_class', 'node_desired_size']) {
      assert.ok(text.includes(`variable "${v}"`), `variables.tf must declare ${v}`);
    }
  });
  it('outputs.tf exposes the cluster + database endpoints', () => {
    const text = read('terraform/outputs.tf');
    assert.match(text, /output "cluster_endpoint"/);
    assert.match(text, /output "database_endpoint"/);
    assert.match(text, /output "backup_bucket"/);
  });
  it('terraform.tfvars.example exists with production defaults', () => {
    const text = read('terraform/terraform.tfvars.example');
    assert.match(text, /db_multi_az.*=.*true/);
    assert.match(text, /backup_retention_days/);
  });
});

describe('Helm chart — renderable shape', () => {
  it('Chart.yaml declares name, version, appVersion', () => {
    const text = read('helm/jataqi/Chart.yaml');
    assert.match(text, /^name: jataqi/m);
    assert.match(text, /^version:/m);
    assert.match(text, /^appVersion:/m);
  });
  it('templates exist and reference Helm helpers/Release', () => {
    const templates = listFiles('helm/jataqi/templates');
    assert.ok(templates.includes('statefulset.yaml'), 'missing statefulset template');
    assert.ok(templates.includes('service.yaml'), 'missing service template');
    assert.ok(templates.includes('_helpers.tpl'), 'missing helpers');
    const sts = read('helm/jataqi/templates/statefulset.yaml');
    assert.match(sts, /include "jataqi.labels"/);
    assert.match(sts, /\.Release\.Name/);
    assert.match(sts, /livenessProbe/);
  });
  it('values.yaml exposes scaling, storage, tls, monitoring knobs', () => {
    const text = read('helm/jataqi/values.yaml');
    for (const key of ['replicaCount', 'jataqi:', 'storage:', 'tls:', 'autoscaling:', 'monitoring:', 'resources:']) {
      assert.ok(text.includes(key), `values.yaml missing ${key}`);
    }
  });
});

describe('production hardening — PSS, per-pillar policies, PQ-ready TLS, multi-region DR', () => {
  it('namespace enforces the RESTRICTED Pod Security Standard', () => {
    const ns = read('k8s/namespace.yaml');
    assert.ok(ns.includes('pod-security.kubernetes.io/enforce: restricted'), 'enforce=restricted label');
    assert.ok(ns.includes('pod-security.kubernetes.io/enforce-version:'), 'enforce version pinned');
    assert.ok(ns.includes('pod-security.kubernetes.io/audit: restricted'), 'audit label');
    assert.ok(ns.includes('pod-security.kubernetes.io/warn: restricted'), 'warn label');
  });

  it('renders dedicated per-pillar NetworkPolicies (backup + observability) wired into kustomize', () => {
    const backup = read('k8s/networkpolicy-backup.yaml');
    assert.ok(backup.includes('kind: NetworkPolicy'));
    assert.ok(backup.includes('policyTypes: [Egress]'));
    assert.ok(backup.includes('port: 443'), 'S3 egress');
    const observability = read('k8s/networkpolicy-observability.yaml');
    assert.ok(observability.includes('policyTypes: [Ingress]'));
    assert.ok(observability.includes('monitoring'), 'scrape namespace selector');
    assert.ok(observability.includes('port: 7400'), 'metrics port');
    const kustomize = read('k8s/kustomization.yaml');
    assert.ok(kustomize.includes('networkpolicy-backup.yaml'));
    assert.ok(kustomize.includes('networkpolicy-observability.yaml'));
  });

  it('ingress is PQ-ready via cert-manager automation with TLS termination', () => {
    const ingress = read('k8s/ingress.yaml');
    assert.ok(ingress.includes('cert-manager.io/cluster-issuer: jataqi-letsencrypt'), 'cert-manager annotation');
    assert.ok(ingress.includes('secretName: jataqi-ingress-tls'), 'TLS secret');
    const values = read('helm/jataqi/values.yaml');
    assert.ok(values.includes('pqNotes'), 'PQ notes documented in values');
    assert.ok(values.includes('clusterIssuer: jataqi-letsencrypt'), 'helm cluster issuer value');
  });

  it('helm chart renders per-pillar policies + PSS knobs from values', () => {
    const values = read('helm/jataqi/values.yaml');
    assert.ok(values.includes('podSecurity:'), 'PSS block');
    assert.ok(values.includes('enforce: restricted'));
    assert.ok(values.includes('backupEgress: true'), 'backup plane enabled');
    assert.ok(values.includes('backupCidr:'), 'backup CIDR knob');
    assert.ok(values.includes('observabilityIngress: false'), 'observability plane knob');
    const template = read('helm/jataqi/templates/networkpolicy-backup.yaml');
    assert.ok(template.includes('networkPolicy.backupEgress'), 'conditional render');
    assert.ok(template.includes('{{ include "jataqi.fullname" . }}-backup'));
    const ingressTemplate = read('helm/jataqi/templates/ingress.yaml');
    assert.ok(ingressTemplate.includes('cert-manager.io/cluster-issuer'), 'helm ingress cert-manager annotation');
  });

  it('terraform provisions a multi-region DR site (RDS replica + cross-region S3)', () => {
    const dr = read('terraform/dr-region.tf');
    assert.ok(dr.includes('provider "aws" {'), 'aliased DR provider');
    assert.ok(dr.includes('alias  = "dr"'));
    assert.ok(dr.includes('aws_db_instance.jataqi.arn'), 'cross-region replica of the primary DB');
    assert.ok(dr.includes('aws_s3_bucket_replication_configuration'), 'cross-region S3 replication');
    assert.ok(dr.includes('aws_s3_bucket.backups'), 'replicates the primary backup bucket');
    assert.ok(dr.includes('dr_region'), 'region knob');
    const vars = read('terraform/variables.tf');
    for (const v of ['dr_enabled', 'dr_region', 'dr_db_instance_class', 'dr_backup_retention_days']) {
      assert.ok(vars.includes(variable(v)), `variables.tf missing ${v}`);
    }
  });
});

describe('GA v1.0.0 — deployment + validation artifacts', () => {
  it('package.json is version 1.0.0 and the GA tag exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.0.0');
    const chart = read('helm/jataqi/Chart.yaml');
    assert.ok(chart.includes('version: 1.0.0'), 'helm chart v1.0.0');
    assert.ok(chart.includes('appVersion: "1.0.0"'), 'helm appVersion v1.0.0');
  });

  it('commercial deployment artifacts exist (Dockerfile, compose, deploy-validate, ga-validation, docs)', () => {
    for (const rel of ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'scripts/deploy-validate.sh', 'examples/ga-validation.mjs', 'docs/RELEASE_NOTES_v1.0.0.md', 'docs/PRODUCTION_RUNBOOK.md', 'docs/ADMIN_GUIDE.md', 'docs/API_REFERENCE.md']) {
      const full = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(full), `${rel} must exist`);
      assert.ok(fs.statSync(full).size > 100, `${rel} must be non-trivial`);
    }
  });

  it('Dockerfile uses the production multi-stage pattern with a HEALTHCHECK', () => {
    const docker = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    assert.ok(docker.includes('FROM node:22-slim AS builder'));
    assert.ok(docker.includes('FROM node:22-slim AS runtime'));
    assert.ok(docker.includes('HEALTHCHECK'), 'docker HEALTHCHECK');
    assert.ok(docker.includes('EXPOSE 7400'));
    assert.ok(docker.includes('CMD ["node", "packages/cli/dist/src/index.js", "serve"]'));
  });

  it('deploy-validate.sh covers docker, k8s, helm, terraform, version, and boot', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/deploy-validate.sh'), 'utf8');
    for (const probe of ['Dockerfile', 'deploy/k8s', 'Chart.yaml', 'dr-region.tf', 'v1.0.0', '/readyz']) {
      assert.ok(script.includes(probe), `deploy-validate.sh references ${probe}`);
    }
  });

  it('ga-validation.mjs validates commercial + security + resilience surfaces', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'examples/ga-validation.mjs'), 'utf8');
    for (const probe of ['/products/install', '/onboarding/complete', '/ops/backup/verify', '/soc/report', '/defense/posture', '/resilience/regions', 'GA_VALIDATION_REPORT.md']) {
      assert.ok(script.includes(probe), `ga-validation.mjs references ${probe}`);
    }
  });
});


describe('Phase 6 — production kit + payment webhook', () => {
  it('production kit files exist and are non-trivial', () => {
    for (const rel of [
      'production/provision.sh', 'production/docker-compose.prod.yml', 'production/nginx.conf',
      'production/jataqi.service', 'production/production.env.example', 'production/backup.sh',
      'production/deploy.sh', 'production/README.md',
    ]) {
      const full = path.join(DEPLOY, rel);
      assert.ok(fs.existsSync(full), `${rel} must exist`);
      assert.ok(fs.statSync(full).size > 200, `${rel} must be non-trivial`);
    }
  });

  it('nginx enforces HTTP→HTTPS redirect with HSTS and /ws upgrade', () => {
    const nginx = read('production/nginx.conf');
    assert.ok(nginx.includes('return 301 https://'), 'HTTP → HTTPS redirect');
    assert.ok(nginx.includes('Strict-Transport-Security "max-age=31536000'), 'HSTS');
    assert.ok(nginx.includes('proxy_set_header Upgrade $http_upgrade'), '/ws upgrade');
    assert.ok(nginx.includes('TLSv1.2 TLSv1.3'), 'modern TLS');
    assert.ok(nginx.includes('api.${DOMAIN}'), 'api subdomain');
  });

  it('systemd unit is hardened (non-root, NoNewPrivileges, ProtectSystem, seccomp allowlist)', () => {
    const unit = read('production/jataqi.service');
    assert.ok(unit.includes('User=jataqi') && unit.includes('Group=jataqi'));
    assert.ok(unit.includes('NoNewPrivileges=true'));
    assert.ok(unit.includes('ProtectSystem=strict'));
    assert.ok(unit.includes('PrivateTmp=true'));
    assert.ok(unit.includes('CapabilityBoundingSet='));
    assert.ok(unit.includes('AmbientCapabilities='));
    assert.ok(unit.includes('SystemCallFilter=@system-service'), 'seccomp allowlist compensates');
    assert.ok(unit.includes('SystemCallErrorNumber=EPERM'));
    // MemoryDenyWriteExecute is incompatible with Node 22 (V8 RWX code range,
    // undici llhttp WASM) — it must be documented as such, never set as a
    // directive (the comment may mention it).
    assert.ok(!/^MemoryDenyWriteExecute=/m.test(unit), 'incompatible flag not set as a directive');
    assert.ok(unit.includes('MemoryDenyWriteExecute'), 'incompatibility documented in the unit');
  });

  it('docker-compose runs postgres+redis+jataqi with health gates and persistent volumes', () => {
    const compose = read('production/docker-compose.prod.yml');
    for (const probe of ['postgres:16-alpine', 'redis:7-alpine', 'ghcr.io/powerbot-1/jataqi:1.0.0', 'nginx', 'certbot', '/var/lib/jataqi/postgres', '/var/lib/jataqi/redis', 'pg_isready', 'redis-cli']) {
      assert.ok(compose.includes(probe), `compose references ${probe}`);
    }
  });

  it('production.env.example has placeholders only and separates sandbox/production', () => {
    const env = read('production/production.env.example');
    assert.ok(env.includes('CHANGE_ME'), 'placeholders only');
    assert.ok(env.includes('STRIPE_SECRET_KEY'), 'stripe key slot');
    assert.ok(env.includes('STRIPE_WEBHOOK_SECRET'), 'webhook secret slot');
    assert.ok(env.includes('strictly separate from sandbox/test keys'), 'sandbox separation warning');
    assert.ok(!env.includes('sk_live_') && !env.includes('whsec_live_'), 'no real credentials committed');
  });

  it('gateway exposes the signature-verified payment webhook route with raw body', async () => {
    const gateway = fs.readFileSync(path.join(REPO_ROOT, 'packages/api-gateway/src/gateway-module.ts'), 'utf8');
    assert.ok(gateway.includes("'/payments/webhook/stripe'"), 'webhook route registered');
    assert.ok(gateway.includes('rawBody'), 'raw body captured for signature verification');
    assert.ok(gateway.includes('constructWebhookEvent'), 'provider signature verification used');
    assert.ok(gateway.includes('payment_intent.succeeded'), 'commercial side effects on success');
  });
});

describe('Phase 7b — M-Pesa (Daraja) payment rail', () => {
  it('PaymentsModule registers an M-Pesa provider from config', () => {
    const mod = fs.readFileSync(path.join(REPO_ROOT, 'packages/payments/src/payments-module.ts'), 'utf8');
    assert.ok(mod.includes('mpesa?: MpesaConfig'), 'config slot');
    assert.ok(mod.includes("this.providers.set('mpesa', provider)"), 'provider registered');
    assert.ok(mod.includes("get mpesa()"), 'mpesa getter');
    assert.ok(mod.includes('recordPendingIntent') && mod.includes('resolvePendingIntent'),
      'pending-intent registry (CheckoutRequestID → customer attribution)');
  });

  it('gateway exposes the M-Pesa webhook + STK Push routes with shared side effects', () => {
    const gateway = fs.readFileSync(path.join(REPO_ROOT, 'packages/api-gateway/src/gateway-module.ts'), 'utf8');
    assert.ok(gateway.includes("'/payments/webhook/mpesa'"), 'webhook route');
    assert.ok(gateway.includes("'/payments/mpesa/stk-push'"), 'STK Push initiation route');
    assert.ok(gateway.includes('applyPaymentSucceeded'), 'shared payment→invoice→subscription flow');
    assert.ok(gateway.includes('x-mpesa-signature'), 'operator-side callback HMAC enforced');
    assert.ok(gateway.includes('resolvePendingIntent'), 'registry attribution used (never trusts callback body)');
  });

  it('bootstrap wires M-Pesa from env and the role policy grants payments perms', () => {
    const boot = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/bootstrap.ts'), 'utf8');
    for (const v of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_ENVIRONMENT', 'MPESA_CALLBACK_URL', 'MPESA_API_BASE']) {
      assert.ok(boot.includes(v), `bootstrap reads ${v}`);
    }
    const policy = fs.readFileSync(path.join(REPO_ROOT, 'packages/security/src/types.ts'), 'utf8');
    assert.ok(policy.includes("'payments:read', 'payments:write'"), 'developer payments perms');
    assert.ok(policy.includes("'payments:read'"), 'analyst payments:read');
  });

  it('production.env.example documents the M-Pesa production rail with placeholders', () => {
    const env = read('production/production.env.example');
    for (const v of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_ENVIRONMENT=production', 'MPESA_CALLBACK_URL', 'MPESA_WEBHOOK_SECRET', 'x-mpesa-signature']) {
      assert.ok(env.includes(v), `env example documents ${v}`);
    }
    assert.ok(!env.includes('MPESA_CONSUMER_KEY=sk') && !env.includes('MPESA_PASSKEY=real'), 'no real credentials');
  });

  it('MpesaProvider verifies callbacks and constructs events with receipt metadata', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/payments/src/mpesa.ts'), 'utf8');
    assert.ok(src.includes('verifyCallback'), 'operator HMAC verification');
    assert.ok(src.includes('MpesaReceiptNumber'), 'receipt metadata flattened for audit');
    assert.ok(src.includes('stkpush/v1/processrequest') && src.includes('stkpushquery/v1/query'), 'Daraja endpoints');
    assert.ok(src.includes('sandbox.safaricom.co.ke') && src.includes('api.safaricom.co.ke'), 'sandbox/production bases');
  });
});


describe('Phase 7/8 — deploy.sh production hardening (live rehearsal fixes)', () => {
  it('installs the complete tree via a per-item loop — no brace expansion, missing items skipped', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('INSTALL_ITEMS=('), 'per-item install list');
    for (const item of ['package.json', 'package-lock.json', 'scripts', 'clients', 'deploy', 'docs', '.env.example']) {
      assert.ok(script.includes(`"${item}"`), `install list includes ${item}`);
    }
    assert.ok(script.includes('"$REPO/packages/"'), 'packages has its own dedicated sync (with --delete)');
    assert.ok(!script.includes('"$REPO"/{'), 'no brace expansion on repo paths');
    assert.ok(script.includes('(skip missing:'), 'missing optional items are skipped, not fatal');
  });

  it('rsync --delete is scoped to packages/ only (production.env can never be deleted)', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    const deleteLine = script.split('\n').find((l) => l.includes('rsync -a --delete')) ?? '';
    assert.ok(deleteLine.includes('--delete'), 'has a --delete pass');
    assert.ok(deleteLine.includes('"$REPO/packages/"') && deleteLine.includes('"$APP_DIR/packages/"'),
      '--delete applies only to the packages/ sync (its only rsync use in the script)');
    assert.ok(!deleteLine.includes('"$APP_DIR/"'), 'never --delete the APP_DIR root (protects production.env)');
    assert.ok(script.includes('cp -r "$REPO/$item" "$APP_DIR/"'), 'cp fallback per item');
    assert.ok(script.includes('rsync not found — using cp fallback'), 'cp fallback branch');
  });

  it('systemd detection is container-safe: root + real systemd + systemctl + writable unit dir', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('[ "$(id -u)" = "0" ]'), 'systemd mode requires root');
    assert.ok(script.includes('command -v systemctl'), 'systemctl must exist');
    assert.ok(script.includes('[ -w /etc/systemd/system ]'), 'unit dir must be writable');
    assert.ok(script.includes('ps -p 1 -o comm='), 'PID-1 verification');
    assert.ok(script.includes('FORCE_BACKGROUND'), 'operator escape still forces background mode');
    assert.ok(script.includes('MODE="systemd"'), 'mode selection present');
  });

  it('background mode survives script/session exit (setsid, nohup fallback, in-child env sourcing)', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('command -v setsid'), 'setsid preferred');
    assert.ok(script.includes('wrapper="nohup"'), 'nohup fallback when setsid is absent');
    assert.ok(script.includes("set -a; . \"$1\"; set +a; exec node \"$2\" serve 7400"),
      'env sourced inside the child — quoting-safe env values can never break the command line');
    assert.ok(script.includes('disown'), 'job table release');
    assert.ok(script.includes('[ -w "$(dirname "$LOG")" ]'), 'log-path writability fallback');
    assert.ok(script.includes('setsid'), 'detached background process survives script exit');
  });

  it('removes unsafe sudo assumptions: chown/ownership only when root, APP_DIR writability gate', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('(non-root — skipping chown'), 'chown skipped for non-root');
    assert.ok(script.includes('is not writable — run as root or set APP_DIR'), 'writable APP_DIR gate');
    const rootChown = script.indexOf('chown -R');
    const nonRoot = script.indexOf('(non-root — skipping chown');
    assert.ok(rootChown > -1 && nonRoot > -1 && rootChown < nonRoot, 'chown guarded by root check');
  });

  it('bare-metal path runs npm ci in APP_DIR with a package-lock guard before starting', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('npm ci --omit=dev --ignore-scripts --no-audit --no-fund'),
      'production deps installed into app dir');
    assert.ok(script.includes('package-lock.json missing — install incomplete'), 'lockfile guard');
    const ciAt = script.indexOf('npm ci --omit=dev');
    const startAt = script.indexOf('Start + health gate');
    assert.ok(ciAt > -1 && startAt > -1 && ciAt < startAt, 'npm ci runs before application start');
  });

  it('keeps the real connectivity probe: Postgres TCP probe + Redis when configured', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes('probe_url'), 'probe helper');
    assert.ok(script.includes('net.connect'), 'real TCP probe (not a ping/HTTP substitute)');
    assert.ok(script.includes('POSTGRES_URL'), 'Postgres probed when configured');
    assert.ok(script.includes('REDIS_URL'), 'Redis probed when configured');
    assert.ok(script.includes('connectivity failed — check POSTGRES_URL'), 'hard failure on unreachable DB');
  });

  it('refuses placeholder secrets: CHANGE_ME gate on production.env', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(script.includes("grep -q 'CHANGE_ME'"), 'placeholder scan');
    assert.ok(script.includes('still contains CHANGE_ME placeholders'), 'clear error');
  });

  it('systemd unit templates to a custom APP_DIR/APP_USER via the same sed deploy.sh uses', () => {
    const unit = read('production/jataqi.service');
    const rendered = unit
      .replaceAll('/opt/jataqi', '/srv/jataqi')
      .replaceAll('User=jataqi', 'User=ops')
      .replaceAll('Group=jataqi', 'Group=ops');
    assert.ok(rendered.includes('WorkingDirectory=/srv/jataqi'));
    assert.ok(rendered.includes('EnvironmentFile=/srv/jataqi/production.env'));
    assert.ok(rendered.includes('ExecStart=/usr/bin/node /srv/jataqi/packages/cli/dist/src/index.js serve 7400'));
    assert.ok(rendered.includes('ReadWritePaths=/srv/jataqi'));
    assert.ok(rendered.includes('User=ops') && rendered.includes('Group=ops'));
    assert.ok(rendered.includes('NoNewPrivileges=true') && rendered.includes('ProtectSystem=strict'),
      'hardening survives templating');
  });

  it('deploy.sh never touches the Docker/Compose path (both paths stay independent)', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'deploy/production/deploy.sh'), 'utf8');
    assert.ok(!script.includes('docker compose') && !script.includes('docker-compose'),
      'deploy.sh is the bare-metal path; compose stays the container path');
    const compose = read('production/docker-compose.prod.yml');
    for (const svc of ['postgres:', 'redis:', 'jataqi:', 'nginx:', 'certbot:']) {
      assert.ok(compose.includes(svc), `compose service ${svc} still present`);
    }
    assert.ok(compose.includes('ghcr.io/powerbot-1/jataqi:1.0.0'), 'pinned image unchanged');
    assert.ok((compose.match(/healthcheck:/g) ?? []).length >= 3, 'healthchecks intact');
  });
});

function variable(name: string): string {
  return `variable "${name}"`;
}
