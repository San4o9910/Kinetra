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
