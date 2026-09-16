# Coaching release — 2026-09-15

Live URL: https://80.68.156.131/

The owner explicitly authorized merging and updating the existing Kinetra site.
PR #22 is merged into `feature/onboarding-exploration-mode` at
`13437af4cf7791f767f58a27662755efdc25925b`. The deployed application revision is
`a61a42f2dc10749939a1044990bf2cf456e34b52`; its tree is identical to that merge.
Earlier PRs in the feature stack remain separate; `main` is not the deployed source.

## Accepted deployment

- Control: `d42e7d3d9a857ef621ad775edc03b1a192c6ac58`.
- Successful run: https://github.com/San4o9910/Kinetra/actions/runs/35036937433
- Result: `PASS_UPGRADED`, followed by successful external anonymous desktop/mobile acceptance.
- Existing Timeweb server: 9069403 / 80.68.156.131. No new paid resource.
- Backend: `ghcr.io/san4o9910/kinetra-backend@sha256:4926900d638e629fc7c2a275f92866be27b487dc901559ec7ff8fe301b42d6be`.
- Frontend: `ghcr.io/san4o9910/kinetra-frontend@sha256:efd7d884c7aa5500f2571c23049491d289591572100ad76f9cac1f911d41206b`.
- PostgreSQL container identity was preserved. Migration ledger contains 001–015 with exact source checksums; runtime grants were reapplied.
- Effective API settings: `AUTH_PASSWORD_MIN_LENGTH=6`, `CHAT_ENABLED=true`.
- Current production metadata: `/srv/kinetra-stage/env/production.env`.
- Release directory: `/srv/kinetra-stage/coaching-release-a61a42f2dc10-35036937433`.
- The matching private API env is in that release directory; the stable API env copy was updated too. Do not publish these files.

## Backup and recovery evidence

The release directory contains a private `database.dump` (180011 bytes), SHA-256
`3742bc9d9e76eb46667703d5afb2882224b4a4fe26104261cc9ffca6ae1e3215`.
It was restored into an owned temporary database and its migration ledger and user
table readability were verified before application replacement. The temporary
database was then removed. The backup remains on the existing host; this is not an
off-host disaster recovery guarantee.

Two earlier attempts remain preserved. Run 35036305821 stopped before migration
because the public SQL mount inherited a private umask. Run 35036521425 applied
014/015, then restored the previous app after an HTTP connection reset during
nginx startup. Read-only run 35036784808 confirmed the restored app and complete
15-entry ledger before the final continuation. No checkpoint was deleted or
rewritten. The corrected readiness wait has regression tests for transient resets
and rejects an incorrect authentication boundary.

The final accepted deployment is one-use. Do not rerun an activation workflow.
For a later change, inspect current container identities and prepare a new release.
All ephemeral provider/guest SSH keys and local key files were removed successfully.

## Verification

Merged-source CI: https://github.com/San4o9910/Kinetra/actions/runs/35035115157
(265 backend + 204 frontend tests, PostgreSQL/S3/browser gates, build/type/lint/manifest).

Image qualification: https://github.com/San4o9910/Kinetra/actions/runs/35035640061
The unchanged previous runtime was reused by digest after source recipe/lockfile
identity checks. Both new images passed runtime/media/static checks and fresh
image scans. The unchanged source-built media SBOM was checked under its existing,
expiring two-CPE disposition; that exception scope was not expanded.

Final artifacts:
- Upgrade: 10423627248, SHA-256 `e211ac33e351c93095c110c7b0fcdd05483ef0bad2ec15696895947222ff769c`.
- Browser: 10423458165, SHA-256 `64407a579632991baa58a0b4329e2e183adae3f0ef3a8b89aff92222627bb3f0`.

External checks: trusted IP certificate, HTTP 308, health 200, private ready 404,
anonymous me 401/no-store, real JS/CSS, login at 1440×1000 and 390×844, no horizontal
overflow or uncaught browser exceptions. Screenshots are retained in the browser
artifact. No account forms were submitted and no user messages were sent.

## Remaining configuration

- The reviewer-only admin panel is deployed at `/admin/trainer-applications`.
  The owner-selected existing account received reviewer access on 2026-09-16 through
  the deployed audited reviewer CLI. Run 35100872079 passed unique account matching,
  persistence and the application access check (`can_review: true`). The private
  host audit is under `/srv/kinetra-stage/owner-reviewer-audit/35100872079`.
  No account email/UUID was published; all temporary SSH keys were removed.
- AI stays unavailable until a dedicated server key and model are configured.
- Private photo/video uploads stay disabled until private S3 is configured.
- Payments remain disabled. Email delivery and authenticated production workflows
  were not exercised by this release's anonymous acceptance.
- Existing PostgreSQL restart policy and Caddy boot policy were preserved.
