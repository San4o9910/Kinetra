# Training experience release — 18 September 2026

Accepted on the existing server 9069403 at https://80.68.156.131/.

The owner authorized the complete trainer/student workflow improvements in the active session. This release preserves the orange/night palette, simplified applications, manual trainer review, owner reviewer identity and six-character password minimum. No paid resources or payment activation.

## Application and evidence

- PR 26: source `5be7df36f85b65c8248c221509ea3a7fec1919db`, merged as `cd6bd3c853caaea4a262e7821776461cb691f504`.
- Exact-head CI: 35360977695; merge-ref CI: 35360982984, tested merge `7a4412cfc74e51743a78a274cb40e6e141270768`. All three jobs and every step passed in both runs.
- Merged push CI: 35361452226, passed. Backend: 271 tests; frontend: 205 tests; all mandatory browser scenarios passed.
- Native browser stability: three consecutive unchanged workspace scenarios passed in run 35361045841, job 105652100315, control `6f0ab3b5b7a925a18df2c392ed3935ea356b298f`. Previously reproduced native input failures did not recur after changing the test-only six-character fixture password, across three focused and two complete acceptance runs; production password rules are unchanged.
- Image qualification: 35361504599, control `62914709020a9143ffb141d63d116514f617aa17`. Real HEVC-to-H.264 conversion and private photo normalization passed inside the immutable non-root runtime. Trivy HIGH/CRITICAL/secrets and independently checked upstream CPE evidence passed under the unchanged, bounded disposition.
- Image evidence artifact 10555595692, `sha256:32b3eb2e62567d1ccf11f13a07039aaf89e9a986073e2d98982cd80272f832d3`.
- Upgrade: 35362046745, control `5bccb07cda8d4e7fdd068840885bcccba3ff2139`, result PASS_UPGRADED.
- Backend: `ghcr.io/san4o9910/kinetra-backend@sha256:96c21c21afeee176937afcff0996b38f4dc8c8d21d24ab7fdca1330644fc5a6d`.
- Frontend: `ghcr.io/san4o9910/kinetra-frontend@sha256:b394b4e58702ea7543640f8bd828a61a9aba26470ba52097dc221a532596884d`.

## Delivered workflow

Trainers author structured exercises, save templates and assign independent copies, duplicate workouts/weeks, upload phone videos with resumable chunks and server conversion, organize their own video library, review each student's actual sets and reports, and handle reschedule requests from the attention feed.

Students have Today, Schedule and Progress, a workout mode with actual set records and rest timer, exercise-context questions for the trainer, account-scoped draft recovery and optional measurements/photos. Photos are private until explicitly shared with the current trainer; revocation blocks future signed-link access. Complaints and trainer verification have owner-visible history. Reminders require opt-in and browser notification permission, use the selected local time and only fire on scheduled unfinished training days.

Offline support preserves marks in an opened workout; uncached pages and videos are not promised offline. Invitations are copied manually, never sent automatically. Revocation cannot retract a copy already saved by its recipient. Video sources are limited to 256 MiB, with 1 GiB per-trainer and 5 GiB total lesson capacity; pending conversions reserve capacity. No external storage service was added.

## Installation and acceptance

Migration 017 is additive; prior migration checksums were preserved. Final ledger: 17 migrations. Existing private media files/configuration and reviewer membership were preserved. PostgreSQL container `a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1` and Caddy were not restarted. Application containers: backend `0f9966a4966072897ac9fbf29416ecaa5d94c40daa9d2b42b5748356e6083a0a`, frontend `312ec2bf90f182939e37f5fd1a57fbcebbda9e33cf1cc725851415c7e8b8bc9e`.

Backup: `/srv/kinetra-stage/training-experience-release-5be7df36f85b-35362046745/database.dump`, 197572 bytes, SHA-256 `fa300776b498a97f024a1c18b7a1c674bd3df189c910a2cc8c6f54defd6df3c4`. Restoration was proved before applying migration 017. Rollback was not needed. Personal training reminders are enabled using the existing VAPID configuration; only opted-in subscribers are eligible. Temporary SSH key 778351 was removed from the guest and cloud account, and its local files were removed.

Anonymous external acceptance passed at desktop 1440×1000 and mobile 390×844: trusted HTTPS, login and simplified registration render, no horizontal overflow, real JavaScript/CSS load, and no uncaught exceptions. Protected trainer routes remain unauthorized without a session. Functional authenticated scenarios use isolated fixtures; acceptance did not impersonate real users, create accounts or send test notifications.

Certificate fingerprint `FC:62:55:15:E5:4F:6F:91:C7:24:20:8C:D7:D4:6D:3C:21:08:46:FD:D8:2A:96:E8:1F:B0:87:52:09:53:8E:F5`, valid until Sep 24 13:43:48 2026 GMT.

## Retained artifacts

- kinetra-training-experience-upgrade-35362046745: ID 10554660978, `sha256:c4c068df7518daab2532debb1f51f7daa1c0e1315ee4e65fd01afef7eba36c6c`.
- kinetra-training-experience-browser-35362046745: ID 10554541109, `sha256:43038a9b781c89a572ad46f855dd9ce9dbb3b176d55c7dea92ed7cd65536f8ba`.
