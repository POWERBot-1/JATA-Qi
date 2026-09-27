# Verifier delivery and evidence retention

## Required authorship and delivery sequence

The preferred route is:

`separate verifier → own fork/identity → PR → owner review → explicit merge authorization → merge → post-merge verification`

The future verifier must:

1. use their own GitHub identity and credentials;
2. run against `08adbd9adf569d0dd18ad1d96289e1fea9f9d6fe`, not a later `main`
   SHA;
3. author `docs/verification/P2_S8_INDEPENDENT_VERIFICATION.md` themselves;
4. include identity basis, independence declaration, environment, roles,
   provider configuration, exact SHA, commands, results, assertion-level
   findings, findings register, remediation record if applicable, final
   PASS/FAIL determination, and evidence provenance;
5. commit the report from their own fork/identity and open the PR;
6. leave the report's technical conclusion unchanged when the owner reviews
   its governance completeness;
7. stop before merge authorization unless the owner separately authorizes
   merge after the complete gate is satisfied.

The owner may check whether the report satisfies the durability requirements.
The owner may not rewrite a FAIL, remove findings, or turn a findings report
into a PASS report.

## Retention requirements

Retain, with the report and PR:

- exact commit and tree IDs;
- `git show -s --format=fuller` output;
- clean-checkout status output before and after execution;
- Node/npm/OS and dependency installation details;
- commands exactly as executed, including working directories;
- complete stdout/stderr and exit codes;
- test runner summaries and PostgreSQL readiness/skip diagnostics;
- assertion-level result records and raw failure evidence;
- SHA-256 or equivalent hashes for raw logs, manifests, and report inputs;
- verifier identity/credential basis, roles, and independence declaration;
- disclosed AI/tool identities and provenance when applicable;
- remediation records that preserve the original finding and observed
  before/after evidence;
- fork, branch, commit, PR, and merge/post-merge identifiers when available.

Do not retain secrets, provider credentials, tokens, or raw secret material in
logs. Redaction must be disclosed and must not erase evidence needed to
reproduce the result.

## Merge and score boundary

A PR, review, CI check, or owner approval does not itself satisfy E4. The
report must be durable and authored by the eligible separate verifier. A
future PASS still does not authorize score recalculation; score reassessment
requires separate authorization. This kit grants neither merge authorization
nor production authorization.
