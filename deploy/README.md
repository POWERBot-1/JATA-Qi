# Deploying JATA Qi

JATA Qi ships as a single zero-dependency Node.js process behind an HTTP(S)
gateway. This directory contains production-grade deployment artifacts:

```
deploy/
├── k8s/            # Plain Kubernetes manifests (+ Kustomize base)
├── helm/jataqi/    # Parameterized Helm chart
└── monitoring/     # Prometheus ServiceMonitor, alert rules, Grafana dashboard
```

## Quick start — Docker Compose (local / single-node)

```bash
cp .env.example .env          # edit secrets/providers
docker compose up --build
curl http://localhost:7400/health
```

Compose uses the SQLite driver with a named volume at `/data` so data,
sessions, and audit logs survive container restarts.

## Kubernetes (Kustomize)

```bash
# Edit deploy/k8s/secret.yaml with real credentials first (or use kubectl create secret).
kubectl apply -k deploy/k8s
kubectl rollout status statefulset/jataqi -n jataqi
kubectl -n jataqi port-forward svc/jataqi-cluster 7400:80
curl http://127.0.0.1:7400/readyz   # dependency-checked readiness
```

## Kubernetes (Helm)

```bash
helm install jataqi deploy/helm/jataqi \
  --namespace jataqi --create-namespace \
  --set jataqi.security.bootstrapAdmin.password="$(openssl rand -base64 24)" \
  --set jataqi.tls.enabled=true \
  --set monitoring.enabled=true
```

Key values (see `deploy/helm/jataqi/values.yaml`):

| Value | Purpose |
|---|---|
| `replicaCount` | Pod count (raise only with a shared/networked store) |
| `jataqi.storage.driver` | `sqlite` (default) / `filesystem` / `memory` |
| `jataqi.tls.enabled` | Terminate TLS in-pod (mount certs via Secret) |
| `jataqi.cors.enabled` | Enable configurable CORS |
| `jataqi.backups.*` | Scheduled-backup automation |
| `autoscaling.enabled` | HorizontalPodAutoscaler |
| `monitoring.enabled` | Prometheus ServiceMonitor |

## Probes

| Probe | Path | Meaning |
|---|---|---|
| Liveness | `/livez` | Process is alive & serving (cheap, no dependency checks) |
| Readiness | `/readyz` | Storage + security dependencies reachable (gates traffic) |
| Startup | `/livez` | Slow-boot protection (up to 2 min) |

## Horizontal scaling

The gateway is **stateless**: authentication sessions, users, API keys, and
tenant data all live in the shared storage layer, so any replica can validate
any request (proven by the `horizontal-scaling.test.ts` suite — two instances
sharing a SQLite database authenticate each other's sessions and honor
cross-instance revocation immediately).

Scale-out beyond a single writer requires one of:

1. **ReadWriteMany volume** on a POSIX-locking-capable shared filesystem
   (CephFS/EFS) with SQLite WAL — set `jataqi.storage.accessMode: ReadWriteMany`
   and raise `replicaCount`.
2. **Networked DB driver** (Postgres, planned) — the recommended path for
   multi-writer horizontal scale.

Until then, keep `replicaCount: 1` for SQLite (vertically scalable) and scale
the edge (Ingress/LB) for connection fan-out.

## Monitoring

Scrape `GET /metrics` (Prometheus text exposition). RED metrics:

- `jataqi_requests_total{method,path,status}` — request counter
- `jataqi_request_duration_ms` — latency histogram (buckets + `_sum` + `_count`)
- `jataqi_requests_in_flight` — concurrent requests gauge

With `kube-prometheus-stack`, enable the ServiceMonitor:

```yaml
monitoring:
  enabled: true
  release: prometheus   # your operator release
```

Import `deploy/monitoring/grafana-dashboard.json` for a ready RED dashboard, and
wire the alert rules from `deploy/monitoring/prometheus-rules.yaml` (error rate,
p95 latency, pod-not-ready, readiness failures).

## TLS

Provide a certificate (inline or file path). With Helm:

```bash
kubectl create secret tls jataqi-tls -n jataqi --cert=cert.pem --key=key.pem
helm upgrade jataqi deploy/helm/jataqi --set jataqi.tls.enabled=true
```

The gateway then serves HTTPS with HSTS (`max-age=31536000; includeSubDomains`)
and `minVersion: TLSv1.2`.
