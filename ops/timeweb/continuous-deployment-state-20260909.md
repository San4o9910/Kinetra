# Kinetra continuous deployment evidence — 2026-09-09

This record follows the owner's `KINETRA — CONTINUOUS FIX & DEPLOYMENT: APPROVED` authorization. Earlier one-attempt and STOP requirements are superseded: a failed gate requires investigation and a justified correction before another run. Assertions must remain intact. No merge, data deletion, payments or user messages are authorized. Chat short videos remain T15.

## Application revision

Draft PR #21 remains open and unmerged. Approved source: `88199890d6f636fcf781d924137b15847a87e601`; tree `b52c6d7d11a33b010b1ba875cd37c59f4d8f4962`.

- Exact-head CI: https://github.com/San4o9910/Kinetra/actions/runs/34406930670
- Merge-ref CI: https://github.com/San4o9910/Kinetra/actions/runs/34406934645
- Verified merge checkout: `bc3d8e9811c3a592f3887baf718e285ca05707c5`, base `ea0412a20baa87b7a00c4ce466d204d12fb052cc`.

Both runs passed quality, structure and test jobs. Actual test logs report backend 226/226 and frontend 179/179, zero failed/cancelled/skipped/todo tests, PostgreSQL 17, S3 fixture, browser, production content seed and history fence markers. These are isolated CI results, not proof of deployed service readiness.

The corrected Progress controls use 48px minimum height. An isolated geometry diagnostic had measured 43.999755859375px during a translateY animation at a 428px viewport, despite an integer layout height of 44px. The browser assertion was retained unchanged.

## Existing host

Only Timeweb server `9069403`, IP `80.68.156.131`, is in scope. The pinned SSH fingerprint is `SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0`. No second VM or other project resource is needed. Hourly billing and the owner's 2,000 RUB/month total ceiling remain constraints. No billing changes were performed in this continuation.

Bootstrap attempts 34405850291 and 34406469428 failed before package, Docker or firewall configuration. The latter identified public TCP10050. Temporary keys 768735 and 768739 were removed from both server and account; local key material was removed.

Read-only inspection https://github.com/San4o9910/Kinetra/actions/runs/34407571637 identified all listener owners as `/usr/sbin/zabbix_agentd`, package `zabbix-agent-timeweb`, active `zabbix-agent.service`. The standard configuration contains Server addresses `92.53.116.12`, `92.53.116.111`, `92.53.116.119`, with no includes. This inspection did not assert the active command-line config path. The subsequent bootstrap must verify that path before allowing narrowly scoped provider monitoring traffic. Key 768749 cleanup is confirmed.

## Image qualification

Run https://github.com/San4o9910/Kinetra/actions/runs/34407452438 built both exact-source final images and passed backend tooling/UID/read-only checks and frontend nginx/static/CSP checks. Qualification failed when Trivy attempted to download a 918.52 MiB Java vulnerability database into a 256 MiB temporary filesystem. No image was published by that run. A disk-backed scanner temporary directory is the identified environment correction; no scanner scope or severity suppression is justified by this error.

## Remaining launch inputs

The inspected GitHub secret presence check did not find `YUKASSA_SHOP_ID`, `YUKASSA_SECRET_KEY`, `AUTH_TOKEN_DELIVERY_WEBHOOK_URL` or `AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET`. The current production API contract requires genuine provider settings; placeholders must not be used to claim readiness. No live payment or user-delivery test is authorized. Application startup remains blocked until the owner supplies missing inputs or approves a separately designed launch mode.

New-host staging, generated private database credentials/TLS, initial empty database migration/content seed and stopped HTTPS edge preparation can proceed after their actual prerequisites pass. Offsite backup, restore, live HTTPS/API and production-browser acceptance must be recorded from real execution before claiming production readiness. No such result is implied by CI or file preparation.
