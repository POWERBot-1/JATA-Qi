# JATA Qi — Production Operations Runbook (SOC + Incident Response)

Companion to the SOC module (`@jataqi/soc`), the incident command framework,
and the operations module (`@jataqi/operations`). This is the human playbook;
the platform automates the mechanical parts.

## 1. On-call rotations

```
jataqi ops rotation alice,bob,carol        # create the primary rotation
jataqi ops oncall                          # who is on call now
jataqi ops chain primary sev1              # escalation chain for sev1
jataqi ops sla sev1 15 1                   # SLA: escalate to level 1 after 15m
```

- Rotations are deterministic (wall-clock shift index). Shift length defaults
  to 7 days; configure `shiftMs` for faster rotations.
- Escalation chains page on-call + N successors for the severity.
- The current on-call engineer is included in every operational health report.

## 2. Incident severity + SLA matrix

| Severity | Definition | First response | Escalation |
| -------- | ---------- | -------------- | ---------- |
| SEV1 | Platform down / data loss / security breach | 15 min | SOC lead → CISO |
| SEV2 | Major feature degraded / high-severity finding | 60 min | SOC lead |
| SEV3 | Minor degradation / medium finding | 8 hours | On-call |
| SEV4 | Cosmetic / low | 24 hours | On-call (next business day) |

The SOC incident command framework enforces these: `sweepEscalations()`
auto-escalates incidents stuck past their SLA, and the security-automation
correlation engine opens incidents automatically from pillar events.

## 3. Incident response procedure (IR)

1. **Detect** — SOC lake alerts, correlation engine auto-incidents, hunts.
2. **Triage** — classify severity, assign commander + responders
   (`jataqi soc incident` / gateway `/soc/incidents`).
3. **Contain** — approval-gated actions for destructive/irreversible steps:
   `jataqi defense contain revoke_sessions <user> ...` then approve via
   `jataqi defense approve <actionId>`.
4. **Eradicate** — rotate secrets, block IOCs, quarantine workloads.
5. **Recover** — `jataqi defense recover <target>` (restore → validate →
   verify → comms → health → resumed).
6. **Close** — transition to `closed`, preserving evidence with
   chain-of-custody hashes (`/soc/incidents/evidence`).
7. **Review** — RCA + lessons learned bumps the playbook version; the
   security-review module tracks independent re-audits.

## 4. Backup verification + DR drills

```
jataqi ops verify-backup <backupId> <namespace> <contentHash>   # automated
jataqi ops drill "Q3 DR drill"                                   # start
jataqi ops advance <drillId> simulate|restore|validate|failover|recover|completed
```

- **Backup verification** runs automatically in the ops module: read-back +
  hash comparison produces an auditable `BackupVerification` record; failures
  emit `ops.backup.verification_failed`.
- **DR drills** walk the full lifecycle; every drill is recorded with its
  result (passed/failed). Drill failures block the operational health report
  from being `healthy`.
- Recovery plans measure **RPO from real snapshot age** (disaster-recovery →
  resilience-engineering provider wiring). `jataqi resilience execute <planId>`
  validates RTO compliance.

## 5. Operational health reporting

```
jataqi ops health
```

Generates the report from: component checks (gateway, DB, storage...),
uptime percentage, open incidents, backups verified, drills passed, and the
current on-call engineer. Overall status is degraded if any check is
degraded, down if any is down.

## 6. Scheduled maintenance checklist

- [ ] Rotate on-call at shift boundary (automatic by rotation config)
- [ ] Verify backups (`ops verify-backup`) — automated, review failures
- [ ] Run one DR drill per quarter; file the result in the drill log
- [ ] Review open SEV2+ incidents weekly (RCA + lessons → playbook bump)
- [ ] Re-run `node examples/self-audit.mjs` after any release
- [ ] Re-run `node examples/scalability-validation.mjs` after capacity changes
- [ ] Check PQ migration phase (`jataqi pqc migration`) and advance per policy
