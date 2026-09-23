# Production monitoring candidate

Status: proposed checks and runbooks. No monitoring vendor, dashboard, exporter, alerts, subscriptions, on-call route or external recipient has been configured. Names below are operational roles, not assigned people. Owner confirmation is required before activation.

## What to observe

| Component                  | Evidence needed                                                                             | Proposed response                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Public app and TLS         | Independent HTTPS probes from two regions; cert lifetime; expected app shell                | Sustained failure: launch lead/on-call investigates routing and last release                   |
| API availability           | Internal readiness plus public synthetic login/read/save using dedicated nonproduction data | Repeated verified user-flow failure: halt rollout and inspect API/DB                           |
| API latency/errors         | Request count, 5xx ratio, duration histogram by stable route, no IDs or query strings       | Establish baseline before setting thresholds; compare with approved SLO                        |
| Frontend                   | JS errors and measured LCP/INP/CLS with consent/redaction                                   | Notify on regression; reproduce with tested release                                            |
| Database                   | Connectivity, pool saturation, storage, replication/PITR health, migration ledger           | DB operator checks capacity or failed migration; no automatic destructive repair               |
| Workers                    | Last successful completion, duration, exit code, backlog and lease age per purpose          | Investigate stale cleanup/verification before enabling dependent media features                |
| Private S3                 | Signed access correctness, denied public reads, version-aware delete results                | Investigate authorization/encryption/provider errors; retain safe failure behavior             |
| Auth delivery/payment/push | Sanitized success/error rates and latency; sandbox recipients only for synthetics           | Disable rollout and investigate provider config; never retry real financial operations blindly |
| Backups                    | Last successful encrypted offsite copy, archive integrity, restore drill timestamp          | Escalate missing recoverability; a local archive alone is insufficient                         |
| Monitoring itself          | External heartbeat, route delivery test to confirmed recipient                              | Detect missing telemetry, not merely absent alerts                                             |

Readiness is a connectivity/draining signal, not schema readiness or business-flow success. A green HTTP health response cannot replace any row above.

## Proposed objectives; owner must ratify

Use three initial user-facing objectives: successful authenticated reads/writes, timely API responses and successful accepted-workout persistence. Record the denominator, eligible routes, synthetic exclusions and rolling window for each. Choose percentages and latency limits **after** staging and traffic measurements. No 99.9% uptime, recovery time or notification-delivery promise is made by this candidate.

Page only for verified, sustained user impact with a usable runbook. Send noncritical regressions during agreed support hours; keep transient low-impact events in dashboards. Confirm the named primary, deputy, escalation delay, available hours, contact route and privacy policy before enabling any notification. Draft rules in `ops/monitoring/alerts.example.yml` are not valid evidence of monitoring coverage and must not be loaded as production rules.

## Dashboard and response outline

Operations dashboard: release digest, app/API availability, 5xx ratio, latency, DB pool, worker freshness, backup age. Reliability dashboard: objective compliance and budget trend. Preserve stable service/route labels; never label with email, user ID, tokens, signed media URLs, chat content or payment payloads.

When critical flow fails: capture timestamp and release digest → assess scope → pause further rollout → inspect sanitized API/DB/provider signals → have authorized launch lead choose mitigation. Restoring data, changing flags, retrying payments, paging a user or rolling back production still needs the respective authority. Use [launch runbook](PRODUCTION_LAUNCH_RUNBOOK.md) and [DR plan](DISASTER_RECOVERY.md).

Before launch, prove alert delivery with an approved synthetic incident, missing-exporter detection and recovery notification. Record actual timing and false positives; after launch review noisy/unused alerts and objective definitions regularly. Logs retention and personal-data collection need a documented owner decision rather than indefinite storage.
