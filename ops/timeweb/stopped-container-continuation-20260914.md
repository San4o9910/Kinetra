# Approved stopped-container continuation — 2026-09-14

Owner approval: 1be0c7f18c7a9ee2d3835ce22cf7deefbd98e969 for the exact proposal
a6a7eb6a1616c05632a7cc75676451642de6bd0d. No further permission is needed within it.

Fresh read-only reconciliation34815492692/job103885177890,
control865ab9f2a3f64b9e8938f8333d9e2cd3a8f6181e SUCCESS. Same exact stopped
container IDs, StartedAt, nonce, prior record hashes, qualified shell/theme/CSP;
PostgreSQL running. Temporary key772837 fully removed; no application mutation.
Actual sanitized result: stopped-containers-inspection-20260914.json.

Applied the exact approved patch to start-application-host.py and activate-https-host.py.
Updated actual dependency pins. Tests discovered the same /assets/-only restriction
in the outer local/HTTPS result schema. Those two schemas now admit only the exact
/theme-init.js path with its qualified SHA256; bundled JS is still required.
This is propagation of the approved asset contract, not an additional source or
security-policy exception. Every other response validation is retained.

New resume-stopped-application-host.py:
- exact same reviewed acceptance, runtime, rollback, readiness and database helpers;
- both preserved exited/nonrunning IDs, images/project/service/nonce and StartedAt;
- actual configured port bindings checked before start, original live bindings
  rechecked after start, plus original runtime sandbox/mount/network/image checks;
- original result/attempt/archives and prior failed continuation hashes required;
- current source/config/credentials/database handoffs checked under the original lock;
- separate exclusive application-assets-attempt and result with original nonce;
- no app create/recreate, no initialization/migration, no credentials regeneration;
- old records retained byte-for-byte; original failed checkpoint archive required
  before atomic installation of a new success checkpoint;
- success checkpoint alone remains insufficient: complete matching outer PASS and
  temporary cleanup mandatory before HTTPS; any new partial failure requires review.

authenticate-stopped-containers.py independently authenticates the original successful
API phase, current source/image/database gates, exact failed run34779526000 /
control1940f0b72edfdc8dbc286789086cec00163a2d3b / workflow SHA
a5d8308c30ba7cffd40849ec0738c6f84ee31ffaac3616eaf268fa0bfd8de5b4 /
artifact10324610731 SHA3a482c172c4f54ec82667e4c541f51c94db8e0b21e9cabd4a597099492b590bc,
and fresh successful inspection with exact cleanup. Failed run remains failed.
Receipt binds current control/run, both IDs and API outer digest.
resume-stopped-caller.py requires that receipt; separate GitHub-only and
Timeweb-only steps retain original secret boundaries. SMTP is not invoked.

Verified locally: 15 new stopped-continuation tests; 16 asset-boundary tests;
8 optional-Health regression tests; 18 local guest, 19 local outer, 33 HTTPS guest,
17 HTTPS caller, 15 application caller and 8 preserved API authentication tests.
All PASS. Existing fixture documents were updated to the exact approved reference
types with explicitly synthetic HTML hash bindings; production constants are
checked separately against actual host evidence. No production browser/form/mail
activity occurred during these tests.

Dormant publication copy: stopped-application-activation.yml.
SHA256 e41770be283ea5adec77d8702ce56d67339da773cccae6113082e3eaa44a5c49.
Publish once to .github/workflows/timeweb-application-activation.yml after code
commit; no workflow_dispatch rerun. HTTPS template has current pins and remains
unfilled until the actual full local run/artifact/cleanup succeed.
All previous source/app/image/CPE/SBOM/public-package/host/cost/no-message limits remain.

## Actual execution and final state — 2026-09-14

Executed run34816449431/job103888017101 from369891effdfce1077c2d4740782fef6b354159e1
with actual workflow SHA256b25f542342bf463b3bd3f5c3846c0e7272f11329ee67ca7c1b90220b93d27ff7.
This supersedes the provisional dormant workflow hash above. Initial CI34816357110
never reached the host; its root-only offline fixtures now use a root-owned isolated
TemporaryDirectory, without altering actual runtime ownership/assertions.

All actual provenance/offline/runtime/local assets/API gates passed. Original final
DATABASE_ISOLATION_CHANGED stopped the continuation; both owned containers were
confirmed STOPPED by rollback and independently reconciled. Complete cleanup772851.
No accepted handoff and no HTTPS. The one-use attempt is consumed. Read
stopped-container-result-20260914.json and database-order-continuation-decision-20260914.md.
Dormant stopped-application-activation.yml mirrors the exact executed workflow for
review; DO NOT publish or rerun it. The new database-order patch is dormant.
