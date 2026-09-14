## Launch checkpoint — 2026-09-14: exact asset correction and stopped-container continuation approved

Owner replied «Да» to the exact proposal at a6a7eb6a1616c05632a7cc75676451642de6bd0d.
See local-asset-approval-20260914.json. This supersedes the decision-required hold
immediately below. Do not ask for this permission again. Implement the exact patch,
reconcile fresh actual host state, authenticate real prior run/artifact/inspection,
and execute one separately guarded continuation of the two preserved stopped
containers. All other restrictions, failed records and successful handoffs remain.
HTTPS requires actual local PASS and complete cleanup. No new acceptance claimed yet.

## Launch checkpoint — 2026-09-13 20:15 UTC: Health fixed; local asset gate needs a narrow decision

Owner approval c124b95ba62ff4a72491622dc92601dab4f89b6d was implemented in
9fb986087d6a5e018512fddab4ff701b8b6516a0. The approved continuation actually ran:
34779526000/job103783858959, control1940f0b72edfdc8dbc286789086cec00163a2d3b,
attempt1, workflow SHA256a5d8308c30ba7cffd40849ec0738c6f84ee31ffaac3616eaf268fa0bfd8de5b4.
Offline tests and all source/image/database/API/previous-failure/inspection gates PASS.

Both app containers started. Backend healthy/readiness and frontend runtime/nginx,
local shell HTTP/security headers/core CSP gates passed. LOCAL_ACCEPTANCE then
failed with UNREVIEWED_ASSET_ORIGIN. Later asset/API/final gates did not complete.
The actual run remains FAILURE. Full temporary cleanup succeeded (key772577).
Artifact10324610731, kinetra-local-attempt-34779526000-1,
SHA2563a482c172c4f54ec82667e4c541f51c94db8e0b21e9cabd4a597099492b590bc.
There is no accepted local handoff and HTTPS is unstarted.

Original ownership-bound rollback confirmed STOPPED for exact backend
460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a and frontend
c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206.
PostgreSQL remains running. Original failed records/archive are byte-identical.
Nonce9128e22668c33a1552f912415c800939; continuation-result SHA256
72ee16fdc09a163e0d311401c56f43c1e766b4e6e57442ddd7f68e98ada9be5b.
Both containers have now started, so NEVER rerun the never-started continuation.

Read-only reconciliation34779750372 and corrected built-file inspection34780143497
(job103785543396, control5f836991c0d0c73c593b81b63b7740503c624c25) SUCCESS with
complete cleanup. Inspection34779895771 had a regex escaping error and complete
cleanup; the correction changed only diagnostic parsers. Exact built HTML contains
the pre-existing blocked Google Fonts stylesheet and same-origin /theme-init.js,
which the frozen /assets/-only parser rejects. nginx CSP already blocks external
styles/fonts. Theme and nginx bytes match the exact approved source.

Prepared dormant asset-check patch and 16 passing offline boundary tests, including
HTTPS correspondence. No frozen asset acceptance code has been changed yet.
Actual identities and cleanup are in local-asset-inspection-20260913.json.
Concrete next decision:
[local-asset-continuation-decision-20260913.md](local-asset-continuation-decision-20260913.md).

**OWNER_DECISION_REQUIRED:** authorize only the exact qualified-shell/theme/CSP
parser correction and one explicit continuation of these two stopped containers,
preserving all old records, other assertions and successful prior handoffs.
Previous Health approval is completed and must not be requested again. Its scope
preserved frozen final assertions and forbade retry after a partial continuation.
Prepare/test the new state-specific helper after this narrow decision; do not
clear attempts, delete containers, rerun preparation, initialize/migrate or start
HTTPS from failed evidence. Existing automation is already disabled.

Source/app/image/public-package/SBOM/CPE/host/SSH/secret/cost/no-message restrictions
remain unchanged. No public availability or user readiness is claimed.
The sections below are historical checkpoints; this top section supersedes them.

## Launch checkpoint — 2026-09-13: owner-approved exact continuation implemented

The owner replied «да» to proposal3fe71151ff3d590c0cb03c367693a87ef0f2d4a6.
Approval is recorded in c124b95ba62ff4a72491622dc92601dab4f89b6d and supersedes
the decision-required hold immediately below. Do not request this approval again.

Fresh inspection34778863835/job103782050733 (control99511c096a6842dc8902794211157718d7e5d59f)
PASS: same never-started backend and failed checkpoint, PostgreSQL running, all cleanup
complete. The exact Health correction and separate bounded continuation are implemented;
see [preserved-backend-continuation-20260913.md](preserved-backend-continuation-20260913.md).
17 continuation boundary tests and all related caller/Health tests PASS.

Next: publish the reviewed resume caller once, authenticate real source/image/database,
successful API phase and exact failed-start/inspection evidence, then run the explicit
continuation. Preserve original failures and credentials. No container/data deletion.
Require actual complete local PASS and cleanup before HTTPS. On any partial failure,
inspect actual continuation records and live identities; never rerun blindly.
No successful new local handoff, HTTPS or user readiness is claimed yet.

## Launch checkpoint — 2026-09-13 19:26 UTC: exact Health query failure; decision prepared

Local run `34777104737` / job `103777116383`,
control `5da9479b63dd7884d6e5484fe33b8dd1f9fff3dc`, FAILED after all source/image/database
and preserved-API authentication gates passed. All temporary SSH and guest-directory
cleanup completed. No successful local handoff exists; HTTPS remains unstarted.

Read-only runs `34777288124`, `34777544360`, `34777637820` succeeded and reconciled
the actual partial state: PostgreSQL running; exact backend
`460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a`
created and never started; frontend absent. Startup nonce
`9128e22668c33a1552f912415c800939`; failed checkpoint SHA256
`ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a`.
The original rollback uncertainty is retained as historical failure, not acceptance.

The frozen Docker inspection query actually fails on absent optional Health before
backend's first start. The one-expression correction was verified read-only on the
exact backend and healthy PostgreSQL; eight offline regression checks pass.
Frozen executable helpers have not been changed or bypassed.
The original start-attempt/result now exist, so original startup must not be rerun.

**OWNER_DECISION_REQUIRED:** see
[local-start-health-decision-20260913.md](local-start-health-decision-20260913.md)
for the exact dormant patch and bounded continuation of this existing backend,
preserving the failed evidence and every acceptance check. This is a new decision
on frozen startup code and the existing-attempt guard, not a repeat of image-publicity
or replacement-inspection approval. No container/data deletion is proposed.

Until resolved, preserve backend and PostgreSQL as observed; do not publish another
activation, clear records, retry preparation/startup or claim local/HTTPS acceptance.
The launch automation was checked and is already disabled. The old orphan inspection
`34749066794` remains queued with zero jobs/artifacts; its exact guard passed again.
All existing image/source/SBOM/CPE/public-package/host/secret constraints remain.

## Launch checkpoint — 2026-09-13: recovered API retained; local import failure reconciled

Run `34776089449` FAILED in the later local wrapper; its API recovery phase and
subsequent provenance recheck PASSED with full cleanup. Accepted API outer is in
artifact `10324010735`, SHA256
`42316ff964771c0aa766a2c2b9ddbdf5490d8268ba4c8355d61e4b0564275eb0`.
Do not repeat API recovery or treat the overall run as local acceptance.

Read-only run `34776287669`, job `103774897052`,
control `82109af279cc9ebdbdabb3bc255b0620f678331b` proved at19:00:12 UTC
that only PostgreSQL is running, API recovery is durable, directory mode0700 is
restored, and no application startup attempt/result exists. Complete cleanup PASS.

The precise transferred helper set reproduced missing `inspect-host-monitoring.py`.
Add only this frozen dependency and propagate verified wrapper hash pins, including
the stale HTTPS dependency literal. All executable HTTPS checks and frozen local
startup checks remain identical. See `local-start-recovery-20260913.md`.

Next: authenticate the exact successful API phase artifact and independent no-start
inspection, then resume only local startup through the updated dormant application
caller. Fresh source/image/database gates and full successful local handoff/cleanup
are still required before HTTPS. No additional provider secrets are needed.

## Launch checkpoint — 2026-09-13: exact candidate recovery accepted, local startup running

Read-only validator diagnostic `34775387238` / job `103772445526`
identified the actual rejection: data directory must be UID999 mode0700.
Read-only metadata run `34775554137` / job `103772903044` proved that
the existing outer volume directory was UID999/GID999 mode1777
(device2049/inode524370); nested PGDATA was UID999/GID0 mode0700.
Both inspections had complete owned-object cleanup and no production mutations.

Reviewed correction `11513602f47ede10ec146735179fd8cf05254181`
adds separate recovery entry points; frozen helpers, validators and all original
source/image/database gates remain unchanged. It restores only the proven outer
directory to0700, preserves the candidate and all credentials, requires exact
old/candidate hashes and refuses repeated recovery or startup evidence.
See `api-candidate-recovery-20260913.md`.

First publication `f7d94c3bf8c8c13890a295bb547477acad68a60a`,
run `34776031376`, stopped in offline tests before source authentication,
Timeweb or any host action: the CI runner was not root but the guest fixtures
require root ownership. Only the offline invocation was corrected to
`sudo env -i`; the ten test assertions and production code were unchanged.

Current control `f0d2e6daa8395426bcfa7a6e461464f6b3316dfc`,
run `34776089449`, job `103774343436` passed all offline tests,
source/image/database authentication, exact candidate recovery and the following
live provenance recheck. Local backend/frontend startup is now in progress.
Do not duplicate or rerun. No complete successful local handoff exists yet;
wait for the real run result, artifact and all cleanup before HTTPS.

## Launch checkpoint — 2026-09-13 18:32 UTC: approved replacement inspected preserved candidate

The owner's explicit “Да” authorized the one replacement proposed in
`inspection-recovery-decision-20260913.md`. Publication commit
`b9f5b85043d5e04bbed0167c69c6447e9d09ea95`, run `34774887728`,
job `103771077391` completed SUCCESS. The guard verified exact original
`34749066794` still queued with zero jobs/artifacts. Original was not retried
or cancelled. Approval is recorded in `9b820bc82ea63a28413d062593bde0f53861d3eb`.
This supersedes the owner-decision hold immediately below.

Actual pinned host inspection returned PASS, server on, PostgreSQL running,
Caddy inactive/disabled, no application record and no backend/frontend
containers. Guest/account temporary SSH keys were API_DELETE_CONFIRMED;
local key was REMOVED.

Preserved candidate: `api-preparation-08115658b05bc897f6bdb8f7a7874938`.
Attempt matches exact app and all five qualified image identities.
Active api.env SHA-256:
`491d26791ac0c3d2074c51eb561c2a38885f0e4d5a160e4e7e80f879c9991f5e`.
Candidate api.env SHA-256:
`f83605434b89354008382d5b87f02aab48b6729e86b56bec419c0affd94c2688`.
Candidate production.env SHA-256:
`4094b16bdb78990c7e011a4672df1e74f9da84c535bd498efa325cffff4afba4`.
No previous-api.env exists. Evidence shows candidate files were created,
but does not yet identify which validation stopped preparation.

Next: diagnose the exact preserved candidate using read-only, network-isolated
validators with sanitized result categories and owned temporary-container cleanup.
Do not rerun preparation, overwrite candidate credentials, initialize the database,
or start the app until the partial state is reconciled and every required gate passes.
All image/source/SBOM/public-package/host/secret restrictions remain unchanged.

## Launch checkpoint — 2026-09-13: cancellation conflict requires a narrow decision

The owner attempted normal cancellation of inspection run `34749066794`;
the supplied screenshot reports `Failed to cancel workflow`. A single supported
force-cancel attempt was prepared with exact repository/run/workflow/commit/age
bindings and repeated zero-job/zero-artifact checks. Nine offline boundary tests
passed before publication.

Recovery control `ee64da2169105c0a1d80d8c665ae7e399d541c99`,
run `34767192847`, job `103750160885` started immediately. Logs at
`15:58:56Z` show `PRECONDITIONS_PASS`, then `github-http-409` from
the force-cancel endpoint. This is not successful cancellation. A subsequent
live GET still shows original run `34749066794` queued at
`096393dae2c1fc977023bd0fccd17b2aa6758ace`, attempt 1, zero jobs.
No host operation or application retry was performed.

**OWNER_DECISION_REQUIRED:** the exact queued inspection cannot currently be
cancelled through either attempted path. The existing no-duplicate condition
still forbids silently publishing a replacement. Do not repeat cancellation,
trigger another diagnostic, or retry application activation automatically.

Concrete proposal and evidence:
[inspection-recovery-decision-20260913.md](inspection-recovery-decision-20260913.md).
Prepared dormant replacement:
[inspection-replacement-20260913.yml](inspection-replacement-20260913.yml).
It is not present at its active workflow path and has not run. The complete
host inspection step is unchanged, checkout is pinned to the original control,
and seven offline guard cases passed. If approved, recheck live runs and publish
this exact replacement once; inspect actual output and temporary-object cleanup
before investigating and retrying application preparation.

Automatic continuation is to be paused until the owner resolves this narrow
exception or GitHub completes/cancels the original run. The original qualification,
database handoff, source/app identities, public-image approval, CPE/SBOM policy,
SSH pin, SMTP handling and all prior deployment limits remain in force.
The application and HTTPS are still unstarted.

## Launch checkpoint — 09:23 UTC

Fresh image qualification run `34742116241` (job `103683458868`) is
SUCCESS. Exact source inventory, public-package identity, AMD media
reproduction, runtime, Trivy and Grype gates passed. Qualified evidence artifact
`10313848590`, SHA-256
`45f567dd7b0085168a90fbb7f30bccbf312e7d4f4584ec254f4e9181323e7b4b`.

Read-only image-input run `34747263665` authenticated the artifact and emitted
the four exact digest references. Database activation run `34747344318`
completed SUCCESS and retained handoff artifact `10314313956`, SHA-256
`e789ea40587c5537003348d862b511df80843767144a824952cc06b13ab4f8a2`.
The approved PostgreSQL container is running; application and Caddy were not
started by that phase.

Application preparation runs `34747520462` and `34747801755` failed before
startup with complete temporary-key and guest-directory cleanup. Read-only
diagnostics isolated the exact cause: `bootstrap-server.py` imports
`inspect-host-monitoring.py`, but `prepare-api-host.py` did not include that
already frozen helper in its transferred pinned set. Commit
`1beeeb124167cff2247a26cfdf9741e51beec31a` added only the missing exact pin and
propagated the resulting caller hashes. Validation run `34748797786` passed
all 17 prepare, 19 local-activation, application-caller and HTTPS-caller tests.

The corrected application activation run `34748921875` again stopped in API
preparation before local startup. It preserved no accepted application handoff;
temporary key and guest-directory cleanup are confirmed complete. Its sanitized
attempt artifact is `10315336650`, SHA-256
`1aacc165460f8e134ee99cdba94c0575d50768057218b7a95c8c7bc2fa36bf2b`;
read-only artifact inspection run `34748975277` passed. No database
reinitialization, application startup, HTTPS activation, email, payment, package
visibility change, deletion or paid-resource action occurred.

Read-only host-state inspection run `34749066794`, control
`096393dae2c1fc977023bd0fccd17b2aa6758ace`, is queued. Do not cancel,
duplicate or start another application attempt until this exact inspection
completes and its logs are reviewed. The queue delay is treated as transient.

# Kinetra checkpoint — 2026-09-13

## Latest owner decision — public images approved

The first new run `34742043591` (control `e587a7bbaab8d1a1693b71bb2d3dd58df8e290e0`)
passed the live approved-public-package check, then stopped before compilation:
GitHub allocated `GenuineIntel`, while exact approved media reproduction requires
`AuthenticAMD`. Actual job `103683269996` logs confirm this category. No build,
push or host operation occurred in that attempt. A new first-attempt allocation
is triggered by a comment-only workflow change; every executable check is identical.

The owner answered “Да” to the explicit public-image proposal linked at
`c2f0f67e61ceb2c02b1418ef886a1e13223a4171`. This supersedes the PRIVATE-only
publication blocker below, for only the two existing packages and exact app
listed in `public-image-approval-20260913.json`. No other approval is widened.

The publication and live provenance gates now require PUBLIC visibility plus
exact package IDs, owner, names and repository identity. A new read-only check
runs before media/Node compilation; publication rechecks before and after push.
All original build/runtime/scan/source gates remain, as does the exact CPE policy.
The frozen host helpers are unchanged. Only dependency hash pins changed in the
application/HTTPS callers and dormant activation workflows.

Local verification passed: 15 application-caller tests (including public package
scope mutations and the preserved original gate digest), 17 HTTPS-caller tests,
and 14 CPE-disposition tests. Fresh full qualification must succeed before any
host stage. The earlier failed run is not accepted for deployment. The dormant
qualified-input reader must be filled with the actual new run/control identity.

New image run [34742116241](https://github.com/San4o9910/Kinetra/actions/runs/34742116241),
job `103683458868`, control `074db3062f601a4ad12896219cc041d71b6b355f`, is in progress.
The live public-package and AMD CPU checks have both passed; actual media
reproduction is in progress. Workflow SHA-256 is
`971b921d5f309b4cc20c6ca552e4df6084d454b749dd11a70fc5676bddd7ad49`.
The independent scanner run `34742043642` completed successfully under control
`e587a7bbaab8d1a1693b71bb2d3dd58df8e290e0`. No final image qualification/publication
success is claimed yet. Do not cancel or duplicate the running build.

The dormant qualified-input reader is now bound to this new run/control/workflow.
It still requires full actual success before publication at its active path.
Automatic continuation is being resumed with the new PUBLIC approval; the old
PRIVATE-only prompt is superseded. Database, application and HTTPS remain unstarted.

## Current blocker — 05:36 UTC

Run `34733519897` completed with failure at 04:31 UTC, **only in the final
publication privacy assertion**. Source/CPU/media reproduction, Node build,
both final images, all runtime smoke checks, Trivy package/secret checks and
the independent upstream scanner passed. Raw upstream HIGH/CRITICAL remains 2,
both exactly dispositioned under the existing approval, unresolved 0; source
inventory is the original `ebb69ea87b5ec9aa929c590bf6ceab0bc6239c38bfb3040e198e6a7bfa925dd7`.

Both pushes succeeded, but the package API reports PUBLIC rather than the
required PRIVATE visibility. Read-only inspection run `34740682638`, job
`103679745148`, control `21c333376a18192fd985e8a0a04a777e579cc34a`, authenticated
the exact archive and confirmed both packages belong to this repository and
are public. The workflow did not change visibility; why the observed creation
differs from GitHub's documented private default is not established.

Artifact: `10311681518`, SHA-256
`4783d6fd51bec6c8a9d3c4bfe63d6b2e6c2f0915ecd472323d47b8dd60c05bd7`.
No full successful image qualification, private publication or host activation
is accepted. Database/application/HTTPS templates remain dormant. Do not copy
the qualified-input reader for this failed run and do not rerun the full build
until the publication policy issue is resolved.

The narrow decision proposal is
[publication-visibility-decision-20260913.md](publication-visibility-decision-20260913.md).
No package deletion, visibility mutation, new package, weakened gate or host
write was performed during diagnosis. Automatic continuation is to be paused
because the next step needs an owner decision, not another build attempt.
Earlier progress entries below are historical and superseded by this section.

The owner requested continued work. Continuous fix/deployment authority and all
existing exclusions remain: fixed Timeweb server 9069403 / 80.68.156.131, no
merge, paid resources/billing changes, existing-data deletion, real user mail or
payment activation. SMTP prerequisites were already verified on September 12.

## Actual full-image result

[34723385107](https://github.com/San4o9910/Kinetra/actions/runs/34723385107)
completed at 00:11 UTC with a failure in upstream source qualification. Both
images built; actual Node/shared OpenSSL, bcrypt, photo/video, nginx/static checks
passed. Trivy reported zero HIGH/CRITICAL package findings and zero secrets in
both images. Positive upstream controls passed. No image was published and no
database, application or HTTPS activation was performed.

The exception helper rejected the new source inventory fingerprint. The generic
scanner error hid its precise fixed category, `disposition-source-sbom-mismatch`.
The owner-approved source inventory remains
`ebb69ea87b5ec9aa929c590bf6ceab0bc6239c38bfb3040e198e6a7bfa925dd7`;
the rejected rebuild produced
`28de11e2eeee8ea03aa27798e5a210abf0b785d0e44503e942e1ec01c74bcab5`.

## Verified comparison and correction

Read-only comparison
[34733203425](https://github.com/San4o9910/Kinetra/actions/runs/34733203425)
authenticated both exact artifact archives and passed. Only the three aliases'
ImageMagick executable hashes differ in the source inventories. Application
source, media source archives, recipe, declared versions, registry inputs,
runtime package inventory and the build-package versions in both logs match.
Both HIGH/CRITICAL records remain exactly the two approved unbounded CPE matches;
the additional two records are Medium. Raw reports remain unchanged.

Actual ImageMagick configure output selected `-mtune=amdfam10` in the approved
build and `-mtune=core2` in the rejected build. The authenticated upstream
`m4/ax_gcc_archflag.m4` automatically selects this portable optimization from
the host CPU. The observed flag difference alone did not prove binary equivalence;
the actual corrected rebuild result is recorded below.

The workflow correction requires the reviewed AMD build environment, then builds
the unchanged media stage and checks its actual source inventory against the
original approved hash **before** the expensive Node build. Final images reuse
that same-run media cache. Every existing source, runtime, image/secret, positive
control, upstream and publication assertion is preserved. The exception policy,
application commit and source inventory are not rewritten or expanded.

The scanner now reports fixed policy failure categories precisely while still
rejecting them. Fourteen exception-boundary tests and 24 scanner tests passed.
The comparison of old/new workflow steps verified that all previous gates remain
unchanged apart from helper pins and a cache-order comment. Full corrected
qualification remains pending completion of the running job.

Detailed evidence: [source-rebuild-analysis-20260913.json](source-rebuild-analysis-20260913.json).
Application remains `73b665065e00a5b375e90f701373b3e0856a0386`, Draft PR21 unmerged.
Prepared database/application/HTTPS callers remain dormant until actual fresh
qualification succeeds. Do not blindly repeat first host initialization/start.

## Corrected execution

Correction control: `cbeb9be9dc94ce7966ae208472224b7904381e6b`.
Real scanner [34733519894](https://github.com/San4o9910/Kinetra/actions/runs/34733519894),
job `103660661920`, completed successfully. Actual logs confirm all 38 tests,
unchanged approved source inventory, raw HIGH/CRITICAL 2, dispositioned 2,
unresolved 0, and successful unsuppressed positive controls. The original
production and positive-control exit codes remain 2.

Fresh full qualification
[34733519897](https://github.com/San4o9910/Kinetra/actions/runs/34733519897),
job `103660662186`, is running. Current source gates, registry resolution and the
reviewed AMD CPU precondition passed. As of 03:02 UTC, the actual media rebuild
and exact prior-SBOM precheck have both completed successfully. This confirms
reproduction of the original approved source inventory without changing the
application or exception scope. The authenticated Node cache build is now in
progress. Do not start another image run or change its workflow while it runs.
No corrected full-image PASS, publication or host activation is claimed.

## Next action after qualification

`qualified-image-inputs.yml` is a dormant, read-only reader pinned to this exact
image run, control commit and workflow hash. After full qualification succeeds,
copy it to `.github/workflows/kinetra-qualified-image-inputs.yml` and publish.
It authenticates the matching artifact archive, discovers only the four public
image references, then calls the unchanged complete launch-provenance verifier
before printing `KINETRA_VERIFIED_IMAGE_INPUTS`. No host or SMTP secret is used.
Use that verified JSON to fill the database activation template; the separately
reviewed PostgreSQL candidate remains
`postgres:17-bookworm@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6`.
Actual PostgreSQL host checks remain required. Follow database, local application
and HTTPS handoffs in order. The existing automatic continuation remains enabled;
it must consult this checkpoint and live runs to avoid duplicate host actions.
