# Exact-artifact input inventory

**Class:** OWNER/BUILDER PREPARATION — target inventory, not independent verification
**Target:** `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`
**Tree:** `5f2152ce0cd702b649b93bc23c165d36cb9b9dba`

The files below are the declared specification, workflow, dependency, runner, and P2-S8 assertion inputs available in the exact target object. Blob IDs are Git object records, not execution results. The complete 725-path inventory is in `artifact-tree-manifest.json`.

| Role | Exact path | Git blob |
|---|---|---|
| target input | `.github/workflows/ci.yml` | `cf8a5d00443b4cccbb5b2bd9dbe2e332edab078f` |
| target input | `package.json` | `3a916d03a5fd5b5ee4ae89c5ef08b5482239e851` |
| target input | `package-lock.json` | `cca8dd872820bf6a0138129d562cd3e5eaf0d18b` |
| target input | `docs/P2_PRODUCTION_IDENTITY_PRIVILEGED_PLANE_SPECIFICATION.md` | `56152f80c7d7bb222407a81c2c9d93ce9f7f78bf` |
| target input | `docs/rubric/JATA-P0-95-v1.1.md` | `fc9ce9c87f827a6324df4f9560a2cd6b1827423c` |
| target input | `docs/rubric/P0R-95_SCORECARD.md` | `1fa82f0716ed97a99c8943b40016ee31428e7afd` |
| target input | `docs/verification/P2_S8_IMPLEMENTATION_REPORT.md` | `1fdea8571ccce400aedb0bbe849cdb4b55929cd4` |
| target input | `docs/verification/P2_S8_COMPLETION_REPORT.md` | `d0f3fc4e7f3e9e05f503a16bdb7274c72bbfe711` |
| target input | `docs/verification/P2_S8_OPERATOR_RUNBOOK.md` | `87052707f263224b213f6f925e7c4f40e9fb5705` |
| target input | `docs/verification/P2_S8_WHOLE_TREE_VERIFICATION_PASS.md` | `0e4689e0e5cbf1b8e6da51ddc61ff3d50087451a` |
| target input | `docs/verification/P2_POST_MILESTONE_V11_REASSESSMENT.md` | `837983cdc27377d311eaea104a9afe271f83e036` |
| target input | `scripts/check-workspace-lockfile.mjs` | `4125cd1523d323fce45d49b1f78332762d2f74cf` |
| target input | `scripts/run-workspaces.mjs` | `3851323ac1db1e3aa921f2b06f9f23073d11673e` |
| target input | `packages/authentication/package.json` | `bbc8dde666d87928cb02feffaee158e11c754bc2` |
| target input | `packages/authorization-boundary/package.json` | `cf8adb0e932637b500ccb50993133e91324c8cc7` |
| target input | `packages/authentication/test/p2-s8-restart-recovery.test.ts` | `010ee76dd2a17880d489bd5ec76e32f8d93f4ff8` |
| target input | `packages/authentication/test/p2-s8-fanout-contention.test.ts` | `d1058558420852ae8867358e83d0eebd417435d2` |
| target input | `packages/authentication/test/p2-s8-outage-matrix.test.ts` | `7b550d03a016fd5cfe2be7ef8492c0cbcc4a9f54` |
| target input | `packages/authentication/test/p2-s8-failover.test.ts` | `639b12c94c2d144aa1c8a61aa65829f7edbb7790` |
| target input | `packages/authentication/test/p2-s8-skew-matrix.test.ts` | `3bc5c129e06ea333fdcb17acce387711bcd74e4f` |
| target input | `packages/authentication/test/p2-s8-tamper-duplicates.test.ts` | `ff75bf0f523dfa401a4bf98eb2a72cb04ea15b5e` |
| target input | `packages/authentication/test/p2-s8-mutation-hygiene.test.ts` | `57c4a1897d2bf8a846b95b98b34c4e471115282e` |
| target input | `packages/authentication/test/p2-s7-mutation.test.ts` | `d9820178e3f188c7c2a279b3efa52c9b6d98f763` |
| target input | `packages/authentication/test/p2-s8-worker.ts` | `36e9da5bc02b2e9e54f80b61a352dfbce23d1ff2` |
| target input | `packages/authorization-boundary/test/p2-s8-decision-outage.test.ts` | `818307d7cbdd1334c0a1370c2483ebc7de397802` |

## Owner-side contextual files not in the target artifact

These later-tree files are available to the owner for governance context but must not be copied into or substituted for the exact artifact during verification:

| `docs/verification/P2_ASSURANCE_CAP_DISPOSITION.md` | current HEAD: available; target SHA: not present |
| `docs/verification/P2_S8_POSTMERGE_VERIFICATION.md` | current HEAD: available; target SHA: not present |
| `docs/verification/P0_V11_ASSESSMENT_AT_08ADBD9.md` | current HEAD: available; target SHA: not present |
| `docs/verification/P3_B_PR39_INDEPENDENT_VERIFICATION.md` | current HEAD: available; target SHA: not present |
| `docs/verification/P3_B_PRE_IMPLEMENTATION_SECURITY_ASSESSMENT.md` | current HEAD: absent; target SHA: not present |
