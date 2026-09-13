# Kinetra checkpoint — 2026-09-13

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
the host CPU. Exact rebuild reproduction is still required; the observed flag
difference alone does not prove binary equivalence.

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
qualification remains pending actual execution.

Detailed evidence: [source-rebuild-analysis-20260913.json](source-rebuild-analysis-20260913.json).
Application remains `73b665065e00a5b375e90f701373b3e0856a0386`, Draft PR21 unmerged.
Prepared database/application/HTTPS callers remain dormant until actual fresh
qualification succeeds. Do not blindly repeat first host initialization/start.
