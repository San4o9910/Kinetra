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

## Subsequent verified host and scanner results

Host bootstrap https://github.com/San4o9910/Kinetra/actions/runs/34408679429 passed: Docker 29.1.3, Compose 2.40.3+ds1-0ubuntu1~24.04.1, bounded local Docker logs, active incoming-deny UFW with SSH/HTTP/HTTPS and three exact provider source addresses for TCP10050. The installed Zabbix binary confirmed its default configuration path. Fresh SSH reconnect passed; temporary key 768761 was removed from guest/account/local state. No application or database started.

Image run https://github.com/San4o9910/Kinetra/actions/runs/34408679490 completed the corrected scanner without storage or cleanup errors, but found 278 backend and 68 frontend HIGH/CRITICAL package/CVE entries (including duplicate CVEs across related packages), zero secrets. These counts are findings, not distinct exploitable application vulnerabilities. Publication remained blocked. Sanitized entries are in image-findings-34408679490.json. Remediation is investigating patched runtime packages and removal of unused build tools/modules, preserving complete image scanning.

## Current C3 source and stopped edge

C3 app commit `2e20e6d20ea202bccca44488a2f897e4b6b9552d` (tree `de7e164ac1e064e978d99100645729032f2c7071`) removes runtime package managers and selects minimal nginx Alpine3.24. Exact-head CI 34409666852 and merge-ref CI 34409670669 both passed all three jobs; backend226/frontend179 and zero skips remain. Verified merge checkout is `a27c8a280ea9918123352e4cf29137bdb464c3a6`; the PR remains draft/unmerged. Local typecheck/lint/structure/format and build with the actual API origin also passed.

Caddy preparation https://github.com/San4o9910/Kinetra/actions/runs/34409119237 passed. Caddy2.11.4 was installed, isolated config validation and freshSSH reconnect succeeded. Service is disabled/inactive; no ACME or app startup occurred. Temporary key768767 was removed from guest/account/local state.

## 2026-09-10 source-media correction and CI

C3 image qualification https://github.com/San4o9910/Kinetra/actions/runs/34410155012 completed successfully as an execution but failed the security gate: frontend HIGH/CRITICAL findings fell to zero; backend retained 267 package/CVE entries (84 distinct CVE IDs), zero secrets. Tooling/static checks passed; nothing was published. This result motivates the source-media build, not an unchanged retry.

C4 `41000ddbd23d18baf90a4b6be970f866963f6bb5` builds FFmpeg9.0.1 and ImageMagick7.1.2-30 from pinned signed sources on the same Node22/Alpine3.24 ABI used by the application build. It installs real signed APK packages and retains full source/binary/package evidence. A review corrected unsupported scanelf syntax before publication. Local source-inventory tests, application media/password smoke, typecheck, lint, format, structure and build passed.

C4 source CI found that eight new MANIFEST paths lacked the required `./` prefix. C5 `644878e4cf4c917fb87b07a5ff8a0cdcf4e74a48` (tree `a29b12dc6b56cd77e8a12f4b270f3534bf4a2962`) corrects only those canonical path entries; exact tracked-file membership and hashes were checked locally. No gate was changed. Exact-head CI https://github.com/San4o9910/Kinetra/actions/runs/34438646842 and merge-ref CI https://github.com/San4o9910/Kinetra/actions/runs/34438648896 now passed all three jobs. Actual logs show backend226/frontend179, zero fail/cancel/skip/todo, PG17/S3/browser markers. Merge checkout is `ddf2bd3d1047cf3e794878bf54360c4a579a23f4`; base remains unchanged.

The new image qualification preserves Trivy OS/language/secret coverage and adds independent Grype0.118.0 upstream CPE matching, validated against vulnerable positive controls using the same database. A vendor-only Alpine scan cannot establish coverage of custom source builds. Runtime checks exercise actual bcrypt, JPEG/PNG/WebP normalization, resize, metadata stripping, malformed/animated rejection and H264/AAC MP4. Qualification remains pending actual execution.

Database staging/initialization helpers passed 27 and 23 local offline tests plus independent review. The activation workflow under ops/timeweb remains dormant and contains explicit missing evidence placeholders. Host database initialization and application startup have not run; Caddy remains prepared but inactive. Missing provider inputs and offsite backup/restore proof remain real launch dependencies.
