# Kinetra launch state — 2026-09-14

Continuation of the approved deployment on existing Timeweb server 9069403 (80.68.156.131).
Owner approval is recorded at cd9ac715de899a312c6ab611579a8489d6f6ec96 in ops/timeweb/database-order-owner-approval-20260914.json.
Public endpoint: https://80.68.156.131/

## Completed application acceptance

Application source remains 73b665065e00a5b375e90f701373b3e0856a0386. PR 21 remains draft, open and unmerged (verified this turn).
The single newly approved application continuation succeeded:
- Control 601e86cd3b30f034f4f3e5f44ea7b3059d8e4a4e; run 34843101590; job 103972448471.
- Accepted artifact 10346942703; SHA-256 651c0ea09a7120ae06ea8c9ee0c1877a6e629b39f88fe1adde437881eb9c7bf7.
- The original PostgreSQL, backend and frontend container identities were preserved; no recreation, migrations or data deletion.
- Stable complete mount-record comparison corrected Docker Mounts array ordering without excluding mount values.
- Offline implementation qualification: 184 tests passed in run 34843020619 at 4477b9b82c9d10e9178b40d95964777f2207a678.
- Application startup attempt has been consumed successfully. Do not replay an application activation workflow.

## Completed HTTPS acceptance

HTTPS control 6797463b77314927eb9f2e3e6c323e22d513b342; run 34845206322; job 103979346057: SUCCESS.
Accepted HTTPS artifact 10347472238; SHA-256 35437e48bf0da2eb9993a8dff811cafae74293579035fb0be50de53f2899a75f.
The accepted caller verified the trusted current IP certificate, HTTP 308 redirect, static assets, healthy backend, private /ready and unauthenticated /api/v1/me boundary.
Caddy invocation: 2b236e80eec4476989b5a2daca71ae0a.
HTTPS attempt nonce: 0a0a95ba7b7942f542301c4dd5d60b03.
SSH key 773343 was removed from server and account; local key and guest temporary files were removed. Caller completed PASS_HTTPS_ONLY.
The one-use Caddy start attempt is consumed. Do not replay HTTPS activation or remove its attempt/checkpoint files.

Two further pre-start validation corrections were necessary:
- Full semantic validation of explicitly dynamic health timestamp and authentication request UUID, followed by canonical hashes. Static bodies remain byte-identical to the authenticated local handoff.
- Explicit typed D-Bus confirmation for empty structured arrays omitted by systemctl text output.
The final actual HTTPS run passed 42 guest tests and 20 caller tests before host access.
References: https-dynamic-response-policy-20260914.md and https-systemd-empty-arrays-20260914.md.

## External acceptance

Control 8ce2e5d72178d8d15684dfc2b4954f178e5a2ed3; run 34846350686; job 103983126285: SUCCESS.
Artifact 10348153766, kinetra-external-browser-34846350686-1; SHA-256 4a2b22f39247fdd05fa140ea07c49c0e068af227fa43dfe7ae9a0e9c53421c41.
Retained acceptance.json, desktop.png and mobile.png.
Actual result: PASS_ANONYMOUS_EXTERNAL_ONLY. Certificate was trusted externally and valid through Sep 21 03:48:48 2026 GMT.
Successful run: https://github.com/San4o9910/Kinetra/actions/runs/34846350686

Anonymous scope only: fresh browser profile, desktop 1440x1000, mobile 390x844, login rendered, no horizontal overflow, empty submit disabled, real JavaScript/CSS, trusted public certificate, health 200, ready 404, me 401/no-store, HTTP redirect 308.
No forms are filled or submitted. The app's own empty refresh bootstrap is permitted only without Cookie/Authorization; its approved backend returns 401 before the service/repository call. All other writes and off-origin requests are blocked.
The exact pre-existing external Google Fonts stylesheet must remain blocked by CSP, as required by the previously qualified local Assets policy; Chrome verifies that block and rejects every other network failure. No external font is fetched. The intercepted refresh response body is not assumed to remain in CDP's body cache; its actual 401 and the rendered login are checked.

## Scope remaining

This is application + HTTPS + anonymous browser acceptance, not full user-launch acceptance.
Caddy boot enablement and PostgreSQL persistent restart policy have not been changed. PostgreSQL restart policy remains no.
Backup/restore qualification, reboot acceptance, certificate renewal monitoring and user launch remain outstanding.
Authenticated account workflows, email delivery, payments and user messages were not exercised or activated.
No new paid resource was created and the existing budget/scope exclusions remain in effect.

## Recovery guidance

Use the successful immutable runs/artifacts above and inspect current state before any further operation.
The previous failed checkpoints/attempt records remain preserved. Never delete or rewrite them to rerun a one-use workflow.
The local executor was unavailable in this session; code and validation were completed through the authorized repository and GitHub Actions.
Current operational source is on ops/timeweb-hourly-preflight-20260909; the deployed application source is the separate immutable application commit above.
