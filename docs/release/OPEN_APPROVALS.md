# Kinetra T14 open approvals

Current authorization: `OWNER REVIEW ONLY`.

No approval below is implied by the existence of the release foundation or this review package.
Approvals must be explicit and limited to one gate.

## Approval sequence

| Gate | Action                                       | Required approver                                     | Required evidence before approval                                                         | Current status |
| ---- | -------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| A0   | Accept this review package                   | Repository/product owner                              | five review documents and valid manifest                                                  | OPEN           |
| A1   | Create commit, push branch and open draft PR | Repository owner                                      | A0 accepted; exact final patch/tree identity; no unrelated changes                        | NOT AUTHORIZED |
| A2   | Run exact-head and PR merge-ref CI           | Repository + Release owner                            | published branch/PR identity; no skips in required T14 gates                              | NOT AUTHORIZED |
| A3   | Run non-publishing release workflow          | Platform/Release owner                                | A2 head identity; approved runner permissions; no production secrets                      | NOT AUTHORIZED |
| A4   | Approve platform design                      | Platform/DevOps + Cloud/Security + Frontend + DBA/SRE | completed `NEXT_GATE_INPUTS.md`, platform adapter and threat review                       | NOT AUTHORIZED |
| A5   | Publish immutable backend/frontend artifacts | Platform + Security + Release                         | clean builds, scans, SBOM, trusted provenance, signature verification and digest manifest | NOT AUTHORIZED |
| A6   | Deploy to staging                            | Release + Platform + DBA/SRE                          | A5 evidence, staging manifests, rollback target and smoke plan                            | NOT AUTHORIZED |
| A7   | Apply migration 012 in production            | DBA/SRE + Release owner                               | backup/restore evidence, rehearsal, checksum and maintenance runbook                      | NOT AUTHORIZED |
| A8   | Enable `TRAINER_VIDEO_UPLOADS_ENABLED`       | Product/Release + Security/SRE                        | successful staging soak, healthy workers, alerting and rollback readiness                 | NOT AUTHORIZED |

## Explicitly prohibited without a later gate

- commit, push, PR state change or merge;
- remote workflow dispatch;
- registry login or upload;
- SBOM/provenance/signature publication;
- GitHub Release or tag;
- staging or production deployment;
- migration execution;
- feature flag activation;
- secrets, IAM, KMS, CORS, bucket policy, lifecycle or scheduler changes;
- production object cleanup or rollback.

## Gate A0 owner decision

The owner should choose exactly one outcome:

- `ACCEPT REVIEW PACKAGE` - allows preparation of a separate A1 publication mandate only;
- `REQUEST CORRECTION` - names the exact document/finding to change;
- `REJECT FOUNDATION` - stops T14 release architecture work.

Accepting A0 does not grant A1 or any later approval.
