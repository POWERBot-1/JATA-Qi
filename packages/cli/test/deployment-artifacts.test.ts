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
