# Personal trainer workspace — 2026-09-18

## Product behavior

PR 25 adds the trainer-owned workspace at `/trainer/students`, a private lesson
library at `/trainer/lessons`, and personal assignments at `/my-training`.
The trainer adds students by name, shares an expiring one-use invitation,
authors and publishes individual programs, and uploads their own video lessons.
Students explicitly accept the invitation, complete assigned workouts, and leave
difficulty, wellbeing and notes. The trainer sees each student's own progress
and history, including in chat. Completed workouts cannot be rewritten.
The general introductory course is a labelled fallback for unassigned users.
No program is automatically generated or copied into a trainer's assignment.

Manual trainer verification, existing reviewer grants, optional application links,
six-character minimum passwords, the orange/navy palette and brand animation
remain in place. No trainer or owner account was silently approved or impersonated.
No invitation email is automatically sent.

## Qualification

Final source `5f9fbea3ab2ed75f5da79d3fb542be4525b00aa3` passed exact-head
run **35336628747** and PR merge-ref run **35336633945**. The tested merge-ref
was `81800b1eb40454be1d5dd3334c535b03f4eddf9f`. PR 25 merged as
`9d6dced30e194a418016c9e45e5d353e50786cb1`; merged-source push run
**35336978393** also passed all three required jobs.

There were 270 backend and 204 frontend passing tests. PostgreSQL 17 coverage
exercised invitation lifecycle, draft/publish, isolation across trainers/students,
actual MP4 H.264 upload and ffmpeg validation, signed/ranged HTTP playback,
completion idempotency, revision conflicts and revocation. Browser coverage
exercised trainer invitation, program authorship, upload UI, student acceptance,
completion and trainer feedback at mobile and desktop widths. The actual upload
codec was validated in PostgreSQL tests; browser fixtures verified transmitted
bytes rather than substituting local browser storage for uploaded files.

Image qualification **35337332290**, control
`fe5da967d86fd9f0cf2d1e62cdefb4f6c73646ac`, reuses the unchanged qualified
runtime and rescans both final images and source components. Evidence is limited
to those exact images, source identities and dated vulnerability databases.

Evidence artifact **10543731012**, SHA-256
`7c6ac0c8e2e118424d85470f3a4e712ca643f41e78115fab871a02af57f3a3a9`.
Both final images passed HIGH/CRITICAL vulnerability and secret checks, independent
source CPE checks and immutable runtime smoke tests.

- Backend: `ghcr.io/san4o9910/kinetra-backend@sha256:34c468073228ff8a88e99d2cabbe6e1ba830b95afc2d2fc955a72d20eb0a02cb`
- Frontend: `ghcr.io/san4o9910/kinetra-frontend@sha256:3857f2a9d620bd3e742c34023bef8cded15f57e6dfe8ad21fc8c4a3e1018e4a2`

Fresh host inspection **35335012967** verified the preceding release, healthy
services, boot policies, 15 migrations and approximately 43.5 GiB of free disk.
The installer additionally checks exact current container identities before mutation.

## Installation and storage

Accepted install **35337689894**, job **105576242654**, control
`4ee2520c1a50f84a033e05407cac8c11e2388409`: `PASS_UPGRADED`.
External desktop (1440×1000) and mobile (390×844) acceptance also passed.
No rollback was needed. All ephemeral guest/provider/local SSH keys were removed.

Verified pre-release backup:

- Path: `/srv/kinetra-stage/trainer-workspace-release-5f9fbea3ab2e-35337689894/database.dump`
- Bytes: `181506`
- SHA-256: `7fa7f559fb93a224a7296775cd8fde63f62436f7f13c67bb12077eedc426eb55`

Final container identities:

- backend: `030a6cfc33a99eefff400f0742665bb013db9f3aa053ac680e57e468982453e3`
- frontend: `77f4e2f5cb9f4d919d4f7391b2d6ee33de9ce975f0f46074e92872fe11a89176`
- postgres: `a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1`

Acceptance artifacts:

- kinetra-trainer-workspace-browser-35337689894: **10544225484**, SHA-256 `3869e0bbb0899f0276f9a5743ac73739026cc8ff5f0edf5024dfb962d42f3fa7`
- kinetra-trainer-workspace-upgrade-35337689894: **10544110702**, SHA-256 `29fd90424f610e7209eb340bf1a51b0aa9e62e3d66487363d3d8dd3985260c9d`

Migration 016 is additive; all 15 earlier migration checksums are preserved.
Existing explicit chat assignments are imported into the trainer roster. Runtime
grants were applied after the new tables. The existing PostgreSQL container,
Caddy boot policy and reviewer count were preserved.

Lessons use private persistent storage on the existing host:
`/srv/kinetra-stage/media/training-lessons` (UID/GID 1000, mode 0700), mounted
at `/training-media`. There is no public directory route. Authorization is checked
for every signed playback request. Format: MP4 H.264/yuv420p, optional AAC;
256 MiB per file, at most two hours, 1 GiB per trainer, 5 GiB total initial quota.
No new cloud server or paid storage resource was created. S3/chat media, AI and
payments remain unconfigured/disabled as before.

The pre-release database backup was restored into a disposable database and
verified before replacing the application. It remains on the same host. Future
backups must include both PostgreSQL and the private lesson directory; a database
backup alone is not a backup of uploaded lessons. This release does not claim
off-host disaster recovery.

External production acceptance verifies trusted HTTPS, public shell, protected
training endpoints and anonymous login/registration on desktop and mobile.
Authenticated trainer/student workflows were exercised in isolated CI fixtures;
production acceptance did not create users, programs, invitations or videos.
