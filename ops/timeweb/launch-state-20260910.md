# Kinetra launch checkpoint — 2026-09-10

**Superseded by:** [2026-09-12 checkpoint](launch-state-20260912.md), including
the newer SMTP application commit, verified credentials and current image gate.

This is an evidence checkpoint, not a launch acceptance record. The existing
continuous approval permits corrected checks and deployment on Timeweb 9069403
(80.68.156.131), hourly billing, at most 2,000 RUB/month. Payments and real user
messages remain excluded. No merge is authorized.

## Application candidate

- Branch: `feature/onboarding-exploration-mode`; Draft PR #21 remains unmerged.
- Application commit: `5798289a21af4bc63a3dffbb0aaf76a9b2bac88b`.
- Base commit: `ea0412a20baa87b7a00c4ce466d204d12fb052cc`.
- Reviewed merge commit: `0ade90585ecd33b39852a4a38eeb296cce63e893`.
- Exact-head CI: [34530850712](https://github.com/San4o9910/Kinetra/actions/runs/34530850712).
- Merge-ref CI: [34530854556](https://github.com/San4o9910/Kinetra/actions/runs/34530854556).

Both runs and all six jobs/steps completed successfully. Actual job logs were
reviewed for checkout identity, 241 backend and 203 frontend tests with zero
failures/skips, PostgreSQL 17 free-beta, S3 multipart, existing player tab/history,
free-beta browser, password recovery and email verification browser PASS markers.
The same-document auth-link correction retains the existing history assertions.

## Image qualification in progress at this checkpoint

[Run 34531345462](https://github.com/San4o9910/Kinetra/actions/runs/34531345462),
job `103052536245`, uses control commit
`6f4e575083d7eacb9af69f22ce82ba31f81fb1d6`. The authenticated Node source build
started at 21:17:47 UTC. Image qualification, image publication and image digests
are **not yet accepted**. Read the current run and complete evidence before
filling any activation workflow inputs.

The corrected build runs the Node cache target before the final application
targets, avoiding simultaneous Node/media compilation on the four-CPU runner.
The Node compilation bound is 180 minutes and the job bound is 300 minutes;
neither bound is a promised completion time. Source signatures/checksums,
runtime assertions and both vulnerability scanners remain required.

## Deployment state and missing inputs

No database initialization, application startup or HTTPS activation was executed
by this work segment. The previously prepared host is the only authorized target.
Do not interpret local helper tests or dormant workflow copies as live success.

Read-only secret-presence run `34527626364` reported both
`AUTH_TOKEN_DELIVERY_WEBHOOK_URL` and `AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET` absent.
A real compatible auth delivery provider is still required by API startup.
These are webhook integration values, not interchangeable SMTP credentials.
No real email was sent. Payment configuration remains deferred and is not a
required input for the approved free beta.

Dormant database and application callers must receive actual immutable source,
image and prior-step evidence before activation. HTTPS additionally needs a
complete successful local application handoff and reviewed outer invocation.
The dormant application caller passed 13 offline tests and the HTTPS guest
passed 33 offline tests, including independent review and root verification.
The extracted source/image provenance gate is byte-identical to its prior
workflow body (SHA-256 `338cbbb5e3068f4f3e2ca917ef4dc57166be0e7438d7635304b0ad78ac748f7c`).
External browser acceptance, persistent PostgreSQL restart policy, boot
enablement, certificate renewal monitoring, backup/restore and user launch
remain unfinished. Preserve all existing host state when diagnosing a failure;
do not repeat a first-initialization attempt blindly.
