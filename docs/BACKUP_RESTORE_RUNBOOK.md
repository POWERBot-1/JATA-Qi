# Backup / Restore Runbook

## Backup

- **Scheduled snapshots** (`@jataqi/disaster-recovery`): interval + retention
  + notifications via the DR scheduler; `POST /backup/schedule`.
- **Manual**: `POST /backup { namespaces }` → snapshot per namespace.
- **Storage**: memory / filesystem / sqlite / postgres drivers; S3 bucket
  with lifecycle + versioning (Terraform); cross-region S3 replication
  (`deploy/terraform/dr-region.tf`).

## Backup verification (automated)

```
POST /ops/backup/verify { backupId, namespace, entries, recordedHash, actualHash }
```

Read-back + content-hash matching produces an auditable `BackupVerification`
record. Failures emit `ops.backup.verification_failed` and degrade the
operational health report. Verification is part of the operations module —
no manual restore needed for confidence.

## Restore

```
POST /dr/restore  (disaster-recovery module)
```

Restore is integrity-verified against the snapshot content hash, and the
resilience-engineering recovery plans measure **RPO from the newest real
snapshot age** (`DrSnapshotProvider` wired in the bootstrap).

## DR drills (quarterly)

```
jataqi ops drill "Q3 DR drill"
jataqi ops advance <drillId> simulate
jataqi ops advance <drillId> restore
jataqi ops advance <drillId> validate
jataqi ops advance <drillId> failover
jataqi ops advance <drillId> recover
jataqi ops advance <drillId> completed     # result: passed
```

Drill failures are recorded and reflected in the ops health report.

## Recovery objectives

- RPO: minutes (snapshot age measured from real backups).
- RTO: plan-defined (`rtoMs`); executions flagged `violated` when exceeded.
- Multi-region: primary → DR region failover (RDS cross-region replica +
  replicated S3); active DR cluster option for RTO < 5 min.
