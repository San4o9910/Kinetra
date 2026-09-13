# Kinetra: decision on replacing the unresponsive inspection

Status: OWNER_DECISION_REQUIRED. The replacement is prepared but is not published
under `.github/workflows/` and has not run.

## Verified facts — 2026-09-13

- Original read-only inspection: run `34749066794`, control
  `096393dae2c1fc977023bd0fccd17b2aa6758ace`, workflow ID `354615253`.
- Live API still reports `queued`, attempt 1, unchanged since `09:10:29Z`;
  all-attempt jobs and artifacts are both empty.
- The owner tried the normal Cancel workflow control and provided the screenshot
  `Failed to cancel workflow`. The failed UI operation's HTTP status is unknown.
- The supported force-cancel endpoint was then attempted once with exact
  run/repository/commit/workflow/age checks and two checks for zero jobs/artifacts.
  Recovery commit: `ee64da2169105c0a1d80d8c665ae7e399d541c99`.
  Recovery run: [34767192847](https://github.com/San4o9910/Kinetra/actions/runs/34767192847),
  job `103750160885`. Logs show `Actions: write`, `PRECONDITIONS_PASS`, then
  `github-http-409` at `15:58:56Z`. The force-cancel was not accepted.
- Subsequent GET still reports the old run queued with no jobs. The recovery
  workflow itself started and finished immediately; no general inability to
  start a fresh workflow was observed.
- Nine offline cancellation boundary checks passed. No host, database,
  application, SMTP, payment, package or image action ran during this recovery.

This is a GitHub workflow-state conflict. Its internal cause is not established;
no successful cancellation or completed host diagnosis is claimed.

## Concrete proposed exception

Permit exactly one replacement read-only host inspection while original run
`34749066794` still appears queued. This is a narrow exception to the existing
no-duplicate rule. It does not authorize another application activation before
the host state is known. The old run is preserved; no deletion is proposed.

Prepared file: `ops/timeweb/inspection-replacement-20260913.yml`.
Publication target: `.github/workflows/kinetra-replacement-host-inspection.yml`.
Publishing the exact prepared file triggers the replacement.

The first step rechecks the exact old run, immutable identities, unchanged queue
timestamp and absence of jobs/artifacts. It stops before host access if the old
run progresses. The host steps are the original inspection, with checkout pinned
to `096393dae2c1fc977023bd0fccd17b2aa6758ace`. The existing host-operation
concurrency group prevents overlap with new provisioning or activation runs.

Scope: server `9069403`, IP `80.68.156.131`, original SSH pin
`SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0` and frozen helper hashes.
Read only the sanitized preparation record, candidate fingerprints, container
states and Caddy status. Temporary SSH key and directory creation/removal use the
original helper; cleanup touches only this attempt's temporary objects.

Residual limitation: the unresponsive original run could start later. Both
inspections are read-only for persistent application/database state, but temporary
SSH sessions could overlap. This is why explicit permission to replace the queued
inspection is needed, rather than silently claiming it is cancelled.

After a successful replacement, inspect its actual output and confirmed temporary
cleanup, then diagnose the preparation failure before any application retry.
If the guard detects progress of the original run, use that original result.
All existing application/image/source/CPE and sequential handoff gates remain.
No new paid resource, existing-data deletion, merge, payment, user message,
package or visibility action is included.

Offline verification passed: exact equality of the complete host step to the
original, pinned checkout, read-only GitHub permissions, own trigger and existing
host concurrency group; seven guard cases covering the approved queued state,
progress/identity changes and existing jobs/artifacts. No network or host call
was made by these tests.

If this exception is not approved, the existing options are to wait for the old
run to complete or have GitHub Support repair its state. No support request has
been sent on the owner's behalf.

## Suggested owner decision

Разрешаю одну заменяющую read-only диагностику по подготовленному файлу
`ops/timeweb/inspection-replacement-20260913.yml`, пока старая проверка
`34749066794` остаётся Queued без jobs. После её успешного результата и cleanup
продолжить исправление и запуск по прежнему CONTINUOUS FIX & DEPLOYMENT.

## Reference

[GitHub force-cancel API](https://docs.github.com/en/rest/actions/workflow-runs#force-cancel-a-workflow-run)
documents this operation for cases where normal cancellation does not respond.
