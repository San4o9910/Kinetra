# Availability recovery and simpler trainer registration — 2026-09-17

## Confirmed outage and recovery

The external HTTPS listener refused connections. The fixed-host inventory at
run **35282750779** found Caddy inactive/disabled and the existing PostgreSQL
container stopped with restart policy `no`. Frontend and backend had restarted;
the backend was unhealthy because PostgreSQL was unavailable. The public
`/health` endpoint is a liveness check and returned 200 locally during this outage.

Recovery run **35283286808**, control
`2560d83fcfa4c12dfb72794b0aa011dcfd17efb5`, restored the existing database and
HTTPS service. PostgreSQL now uses `unless-stopped`, persisted both in Docker
and the staged single-server Compose source. Caddy is enabled and active.
The application source also records the PostgreSQL boot policy.

No replacement server, database initialization, account mutation, email or
migration was involved in recovery. The 15 installed migrations and the existing
reviewer grant were verified. External HTTPS `/` and `/health` returned 200;
unauthenticated `/api/v1/me` returned 401. The pinned host identity and all
three application container identities were preserved. Ephemeral SSH keys were
removed from both server and provider account.

The first recovery run **35283120658** failed during Caddy configuration
validation before any mutation. The successful replacement used the service's
existing `PUBLIC_IPV4` and XDG configuration under the Caddy service user.
Private recovery receipt and previous Compose source are retained on the host
under `/srv/kinetra-stage/availability-repair-20260917`.

## Product change

PR **23** removes mandatory external verification materials. Candidates submit
name, specialization, years of experience (including zero), city, and a short
education/experience description. Timezone is inferred, with an optional edit.
Links are optional, and multiline descriptions are accepted. The admin queue
explicitly explains when no links were supplied; reviewers may request details.

Signup requires role, email and one password of at least six characters, with
show/hide control. Phone and password repetition are removed from this form.
The owner-review entry is available on the trainer application screen, and
opening the admin URL before login preserves the intended destination.

Existing server-side reviewer authorization, verified-email approval requirement,
self-review prohibition, append-only decision history and pending trainer
restrictions remain enforced. No automatic trainer approval was introduced.

## Qualification

Source and merge-ref runs for PR 23 passed 266 backend and 204 frontend tests,
real PostgreSQL 17 and private S3 fixtures, plus browser coverage for the complete
simplified registration → link-free application → owner approval path.
The first repeated merged-source run exposed a test-browser startup race before
navigation: the new test accessed `documentElement` in the initial document before its root element was available. PR **24** fixes initial navigation through CDP, keeping the rendered
login wait and all application assertions. The failed run is retained as evidence.

The release uses the unchanged qualified media runtime, with fresh image and
source scans. This claim is limited to the dated scanner databases and exact
image/source identities; it is not a claim that software has no vulnerabilities.

Final source `c4f63e798b3bb98b97ea9eb7de73ba5c167a54c5` passed exact-source
run **35284329501** and merge-ref run **35284334188**. PR 24 merged as
`5b208925884cdf1038a9a586edfa5bbe28fd1c0e`; merged-source run **35284673554**
also passed all three required jobs.

Image qualification **35284713355**, control
`b542532f71bdb18a7a7b40e5ed7f99e9e9bcd5fd`, passed the final image and source
checks. Evidence artifact **10523629322**, SHA-256
`737d4ca401a4afa577e44edf8040da9ca92043d8c70d6fca9e6ec4bea1ca62b8`.

- Backend: `ghcr.io/san4o9910/kinetra-backend@sha256:b45a3bf54ec9ff4a7c2988147ae87554e95659cfa2b485ba0e45535887302e02`
- Frontend: `ghcr.io/san4o9910/kinetra-frontend@sha256:252be3a21c0f89e93a7400b530d6c86f46be8305aee6e770c1f5c271054047c5`

## Deployment receipt

Accepted installation run **35285117508**, job **105415618619**, control
`77f3de12b7b74598459380c203114e8dde8a4439`: `PASS_UPGRADED`.
The same run completed external anonymous desktop (1440×1000) and mobile
(390×844) checks for HTTPS, login and the simplified registration form, without
submitting a production registration or sending email. Both viewports rendered
correctly without horizontal overflow or uncaught browser exceptions.

The compiled server schema was also checked inside the actual deployed backend:
an application with no materials and a multiline description is accepted;
an unsafe optional URL is rejected. The existing reviewer grant count was
preserved, PostgreSQL container identity stayed unchanged, and all 15 migration
checksums matched. No schema or grants were changed by the application update.

Backup, restored into a disposable database and verified before replacement:

- Path: `/srv/kinetra-stage/trainer-signup-release-c4f63e798b3b-35285117508/database.dump`
- Bytes: `180326`
- SHA-256: `90576c32f35fe61f1bc43925ac70f75ab2f40c7c88357d778c37beecad81b579`

The backup remains on the existing host; this is not an off-host disaster recovery
claim. Backend/frontend replacement required no rollback. All ephemeral provider,
guest and local SSH key material was cleaned up.

Final container IDs:

- Backend: `fa83f342eca9a9934b8e3a2345d8239a71957ce339ac2e525f9ab8cc16d3ffb2`
- Frontend: `20d864e33c14c7e08c9b6e2368d128589bc994d6268c2880cdf2b8abf72640d9`
- PostgreSQL: `a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1`

Owner review URL: `https://80.68.156.131/admin/trainer-applications`.
Authenticated submission, clarification and approval were exercised in isolated
HTTP/PostgreSQL/browser fixtures; production checks did not impersonate the owner
or modify user applications. Existing optional AI, private media and payment
configuration was preserved.

Acceptance artifacts:

- Upgrade **10523468296**, SHA-256 `d9abb85d9374dcd1626af3bb2b91d7b61b3d3a190e8ab0bd492c4f1e2eae0703`
- Browser **10524109064**, SHA-256 `4cdb037d1baed9708e3ea0156d49ee259554ba866fab5ebbf319bc456e9a72d9`
