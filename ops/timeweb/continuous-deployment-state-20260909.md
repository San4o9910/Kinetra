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

The staging runner now accepts Docker's canonical tagless RepoDigests while still limiting repositories, optional tags and exact SHA256 syntax. Existing C3 logs proved Node/nginx references were tagless. Database major17/UID999 and image provenance checks remain mandatory; 30 staging and 23 initializer offline tests passed after the correction. Provider-secret presence is being refreshed without reading values or contacting providers.

The official Docker Library repo-info remote/17-bookworm.md identifies candidate amd64 PostgreSQL17.11 as postgres@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6 (config sha256:a2ea0e68c465e0acf4c3672471b22b6b62972bb341e6f31544c855d85ba43745). This is an upstream candidate reference, pending actual host pull/version/UID/TLS checks; no PostgreSQL image security-scan result is claimed.

## C5 image evidence and C6 source verification

Image qualification https://github.com/San4o9910/Kinetra/actions/runs/34439133755 built both images and passed all actual bcrypt/media, inventory, UID/read-only, nginx/static/CSP checks. Trivy reported only two remaining backend HIGH package entries: CVE-2026-14456 in libcrypto3 and libssl3 3.5.7-r0, fixed in 3.5.8-r0; frontend and secret findings were zero. Grype downloaded its database but failed to hydrate it with SQLITE_IOERR_WRITE (778). Nothing was published. Read-only artifact inspection https://github.com/San4o9910/Kinetra/actions/runs/34440481954 verified the exact artifact/run/control identity and retained the public failure diagnostic.

C6 source 7f071d35645014f0461dd5194cb4a08b61ab4b6f (tree f8c3275a3aa5a7bab2d4a00643614e83770f330a) requires actual Alpine libcrypto3/libssl3 >=3.5.8-r0. Exact-head 34440515837 and merge-ref 34440519629 passed every quality/structure/test job; actual tests remain backend226/frontend179, no failures or skips, and all PG17/S3/browser markers. Merge checkout 90777e653b1731dadb4d1add425b35109796d079 uses unchanged base ea0412a20baa87b7a00c4ce466d204d12fb052cc. PR21 remains draft and unmerged.

The Grype environment correction routes Go and SQLite temporary files to a bounded disk-backed cache, raises the per-file limit from 2 to 4 GiB and total accounting to 8 GiB with 2 GiB free reserve, and preserves per-phase peak/final database/cache/temp/free-byte evidence before cleanup. Twenty offline tests pass. EFBIG from the old file limit is a working hypothesis for IOERR_WRITE, not a proven measurement; scanner scope, severity, positive controls and no-ignore requirements remain unchanged. Actual corrected scanning is pending.

Independent source review identified that Node22.23.2 also vendors OpenSSL3.5.7. Updating APK libraries does not patch this embedded copy. The OpenSSL advisory concerns QUIC server incoming queues; Node/Kinetra exploitability is not established, and compiled-out QUIC cannot be claimed. A separately verified runtime correction is being investigated before publishing or deploying an image.

Read-only provider refresh 34439772760 confirms all four required settings remain absent (presence booleans only). Host state remains prepared but no app/database initialized. No new billing, provider traffic, real payments, user messages or merges occurred.

## C7 shared-OpenSSL correction

C7 source 1d7f827b301072faa86d4955f0d94ec1b027d353 (tree 10b0bc83343ea23ef59823eabb4f08b0d3031206) replaces the original Node executable in both application build and runtime with the same Node22.23.2/ABI127 built using supported shared-OpenSSL configuration against patched Alpine libraries. Root independently verified the official source SHA256 and signed checksums with the pinned official release key; five authentication/runtime negative tests and independent integration/source reviews pass. Final-image checks require actual loaded library version, dynamic linkage and matching executable hash. No QUIC function was removed and no vulnerability exception was added.

Local typecheck, lint, format, structural checks, source authentication tests and app build with the real origin passed. Exact-head34441915544 and merge-ref34441917975 passed all three jobs and every step for the new source; actual logs retain backend226/frontend179, zero skipped/failed/cancelled/todo and all PostgreSQL17/S3/browser/content-seed gates. Verified merge checkout072b29862ec25a3739fafb030cb3d6382ed4d4f7. Source compilation and complete final-image qualification have not yet run for C7. The image workflow allows120minutes for bounded Node make-j2 (60minute compile limit), the existing media builds and complete scanners. The dormant database verifier now requires actual Node runtime evidence as well as all previous markers; its valid fixture and32negativeprovenance cases passed.

## C7 compile timeout and bounded resource correction

Image run34442249626/job102759549118 failed at06:44:45UTC with `spawnSync make ETIMEDOUT`, arguments `-j2`, signalSIGTERM, at3612seconds in the Node build stage. The last work was V8 heap compilation. No final image/runtime/security qualification or publication completed; artifact10139871656 contains only pre-build evidence. This is an observed compile deadline failure, not a vulnerability-scan result.

The repository is public (verified via GitHub API). GitHub's official standard-runner reference assigns public ubuntu-latest4CPU/16GB; authenticated Node22.23.2 BUILDING.md requires at least8GB for4parallel jobs. The correction uses4jobs with explicit CPU/effective-memory preconditions,90minute make deadline and150minute whole image workflow. Actual host/container resources are retained before compiling. Source signatures, exact versions, shared OpenSSL, runtime assertions and both full scanners remain unchanged. GitHub documents standard public-repository CI and current GHCR container storage/bandwidth as free; no Timeweb resizing or tariff change is involved. Corrected execution is pending.

## C8 source qualification and launch handoff

C8 source fc55ef42169d2729f31a897d6b499d936004c756 (tree41b130009648089022389cc9a54698d7c8ad381f) implements the diagnosed four-job resource correction. Exact-head34447345842 and merge-ref34447349464 passed all three jobs and every step. Actual test logs retain backend226/frontend179, zero failures/cancellations/skips/todo and PostgreSQL17/S3/browser/content-seed/history checks. Verified merge checkout36ec682d203fc5335d00f4816f4dbb8a0fd7f9cf uses unchanged baseea0412a20baa87b7a00c4ce466d204d12fb052cc. PR21 remains draft/unmerged. Five source authentication/runtime tests, formatting, structural/manifest and workflow syntax checks passed locally. Image qualification with the corrected build is pending actual execution.

The reviewed application-activation-notes.md records the database-to-application handoff, exact private environment inputs, staged validators, preserved data rollback and anonymous HTTPS/browser checks. The PostgreSQL candidate must be passed as postgres:17-bookworm@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6 to satisfy the existing single-server validator. Independent read-only review found no C8 contract mismatch. This is a dormant runbook, not proof of activation. Missing provider inputs, offsite backup/restore and actual application/HTTPS acceptance remain unresolved.

## Dormant API environment preparation helper

While C8 image run34447780806 is compiling, a guest-only API environment preparation phase was implemented and root-reviewed. activate-application-host.py SHA256c4aa6e204d8a17aa686ad6179caf1dd5a1f397867aa534d3c574c103e3c65a21 and test-activate-application-host.py SHAc9894e1e5a0071e0f0d3f460b692f3622636848ec1b2b46c76348a9afe3a3d16 passed17 offline tests twice (agent and root), syntax and diff checks. Root review corrected durable preservation before atomic replace, truthful installed state after replace, early webhook-port validation and current PG health checks. Keygen/validator containers disable Docker logs. No active preparation workflow, host execution, provider request or service startup occurred. Detailed handoff and limitations are in application-activation-notes.md.

## 2026-09-10 dormant API wrapper and local startup preparation

`prepare-api-host.py` is now implemented and frozen at SHA256 `d07e96d93636bdc90b78f22c990df8e6e8fbb707efc5f0c77aeec28a9206dc5f`; its test file is `ee88bda833cd2479a5605ce2d4b0f6484eae50b42ae5a130f7a7ed7ec62b8899`. Agent and root each passed 13 offline tests. The wrapper validates providers before Timeweb/key generation, binds committed sources and five images, uses pinned SSH and stdin-only private input, and reports actual guest result plus guest-temp/guest-key/account-key/local-key cleanup. Wrong returned key identity never grants deletion authority; a lost response remains `UNKNOWN_RECONCILE`.

`start-application-host.py` is frozen at SHA256 `498715ff4f8cedd8b5230ed662b9c079f5ab33ce67ce06d5e054f5ef76c00f6c`; its test file is `d52e7d61eeb203ac9bbae1a3aef4ae2b56fae9609c16896ff7a65356f54caea6`. Root passed 18 offline tests. This guest-only phase creates backend/frontend with Compose `up --no-start`, verifies invocation ownership/full ID, then starts by that ID. It preserves PostgreSQL and Caddy state, stops only owned services on failure and records persistent `CHECKPOINT_ONLY` evidence. Continuing requires matching successful outer stdout/key cleanup and fresh live-ID inspection; the checkpoint alone is not an activation handoff.

These tests model Timeweb/SSH/Docker/SQL/HTTP and do not establish live readiness. Exact contracts and CLI are in `application-activation-notes.md`. The current-evidence provenance integration and active API/start workflows remain incomplete; the startup outer wrapper is pending separate implementation. Root's static C8 startup review found no renewal/dispatch worker execution or payment/delivery requests, not live-provider acceptance. At this entry C8 image qualification [34447780806](https://github.com/San4o9910/Kinetra/actions/runs/34447780806) is still building; no final qualified image or new server mutation is claimed. Provider settings, public HTTPS/browser acceptance, persistent runtime policy and actual backup/restore remain launch dependencies. No merge, billing change, provider request, payment or user message occurred in this preparation.
