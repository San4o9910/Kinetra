# Production launch runbook candidate

**Decision: NO-GO for application traffic until the evidence below is complete.** On 2026-09-09 the owner granted CONTINUOUS FIX & DEPLOYMENT approval: diagnose failures, fix their causes and repeat PostgreSQL 17, S3 and browser gates without another approval; preserve every mandatory check. Necessary follow-up commits/pushes to Draft PR #21 are authorized. After all mandatory checks are green, deployment and initial setup of a new empty database are authorized only on existing Timeweb server 9069403 (80.68.156.131), with hourly billing and a 2,000 RUB monthly hosting budget. Merge, deletion of existing data, real payments and messages remain prohibited. Chat short videos remain separate task T15. Missing credentials or an owner decision must be requested after completing available work. There is no confirmed launch date or named on-call person.

## Record before launch

Record the exact reviewed commit, immutable backend/frontend image digests, build provenance/SBOM/scan results, environment/account/region, public API/app/media origins, database identity and current schema ledger, storage versioning/encryption policy, launch window and signed owner decision. Keep secrets outside this record.

| Role                 | Responsibility                                                  | Assignment |
| -------------------- | --------------------------------------------------------------- | ---------- |
| Owner / launch lead  | Approves GO, scope, pause and rollback decisions                | To confirm |
| Deploy operator      | Reviewed images, edge, environment, rollback procedure          | To assign  |
| Database operator    | Backup/PITR evidence, schema compatibility, migration execution | To assign  |
| QA lead              | Required gates and critical journeys on exact candidate         | To assign  |
| On-call / deputy     | First-day response and escalation                               | To assign  |
| Communications owner | Approved audience and factual updates                           | To assign  |

## Required evidence

- Ordinary checks pass on the exact candidate: unit, typecheck, lint, format, structural assertions, build and dependency review. Existing strict browser/history assertions remain intact.
- PostgreSQL **17**, private S3 where applicable and browser gates are green with **zero skips**; record exact head/ref identity and logs. Diagnose failures/skips and repeat after a justified fix; never bypass assertions or perform blind retries. Require new exact-head and PR merge-ref CI after the authorized commit/push; no stale run substitutes for this evidence.
- Production images are built, scanned, identified by digest and smoke-tested with their actual OS/media binaries. Static Containerfile review is not an image-build PASS.
- Schema ledger includes every required migration with exact immutable checksum. Connectivity-only `/ready` is insufficient. Document backwards compatibility with the rollback image and test migration failure behavior on isolated staging.
- TLS edge restricts ingress; actual client IP reaches application through reviewed trust/CIDRs; public readiness is inaccessible. Auth cookie, CORS, CSP, cache and signed media headers work together on the actual app origin.
- Separate secret files/roles for API and every worker pass validation and IAM review; production webhook provider has a tested sandbox integration and redaction. Real payment/email/push effects remain disabled until separately approved.
- Scheduler, heartbeat/backlog checks, monitoring and confirmed on-call routing are working. Draft monitoring rules do not satisfy this requirement.
- Encrypted off-account backup and PostgreSQL/media restore drill pass; actual RPO/RTO fit owner-approved targets and key recovery is possible.
- Accessibility review includes keyboard, focus, reduced motion, contrast, mobile viewport and readable charts. Existing trainer content with meaningful audio needs an approved accessible alternative/caption workflow before that content can launch; no fake caption readiness.
- Chat video attachments remain outside this change and need the separate T15 plan/gates.

## Cutover sequence within the existing deployment approval

| Step | Operator action                                                 | Verification and pause point                                                                     |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1    | Confirm launch window, exact release and available roles        | Existing conditional deployment approval recorded; required evidence current                     |
| 2    | Restrict traffic and capture approved recovery point            | Integrity verified; no competing migrator/jobs                                                   |
| 3    | Execute only approved migration job, with dedicated credentials | Complete immutable ledger/schema check; stop on first failure                                    |
| 4    | Start reviewed API and frontend images in approved environment  | Correct digest, healthy process, private readiness, no accidental public upstream                |
| 5    | Verify edge/routing and sandbox-only critical journeys          | Login, profile, today/plan, workout save including Back fence, progress, trainer/chat if enabled |
| 6    | Admit traffic after all required checks pass                    | Correct client-IP trust, stable error/latency baseline and monitoring delivery                   |
| 7    | Separately authorize each scheduler/feature/provider activation | Correct purpose credentials, fresh heartbeats, no duplicate actions                              |
| 8    | Observe first hour/day                                          | Record known regressions and owner decision; only then approve announcements                     |

The existing continuous approval already covers deployment and first initialization of the empty database on the named host after green mandatory gates. These steps do not require another blanket approval. Missing external credentials or an unapproved resource/cost decision still require the owner. Payment activation and real messages remain excluded.

Timeweb server 9069403 is the selected target. Follow the reviewed single-server and IP HTTPS deployment instructions; record image digests and actual provider configuration before GO. Do not improvise provider commands during an incident.

## Pause and rollback

Withhold deployment while required gates are failed or skipped, and continue authorized diagnosis and fixes. Withhold traffic on wrong release/ref/image identity, missing schema migration, cross-user access issue, data integrity discrepancy, leaking secrets, broken workout persistence, payment duplication, missing recovery path or unusable on-call monitoring. Owner sets quantitative error/latency limits from measurements before launch; no arbitrary thresholds are claimed as proven.

The authorized launch lead chooses rollback. For a compatible application change, the operator uses the last verified image digests, then repeats the approved smoke checks and records the outcome. Do not roll back SQL automatically. If schema/data compatibility is uncertain, hold traffic and escalate to the database/incident lead using [the DR plan](DISASTER_RECOVERY.md). A threshold or this runbook does not authorize production rollback by an assistant.

During the first hour, watch the critical paths, DB pool, worker freshness, provider errors and user-visible performance. During the first day, review sanitized error trends and backup success. During the first week, resolve agreed nonblocking issues and update the runbook from evidence. Assign the coverage and update cadence before GO.

Communication draft: “Release [commit/digest] is [paused / under verification / verified]. Confirmed impact: [facts]. Current action: [action]. Next update: [time].” Do not send until audience, channel, sender and text are approved.

Related: [delivery contract](PRODUCTION_DELIVERY.md), [monitoring](PRODUCTION_MONITORING.md), [backup and recovery](DISASTER_RECOVERY.md).
