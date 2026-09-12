# Kinetra verified checkpoint — 2026-09-12

The owner added the two Yandex SMTP repository secrets and requested continued
work on Kinetra. This checkpoint supersedes the unchecked SMTP state in the
September 10 notes. It is **not application launch acceptance**.

**Subsequent owner decision, 2026-09-12:** the owner explicitly accepted the
linked two-CPE proposal. `upstream-disposition.py` implements that limited
approval, with the September 26 expiration, exact application/source/SBOM
identity, unchanged raw reports and zero unresolved HIGH/CRITICAL findings.
Both scanner qualification and downstream provenance recompute the decision
using the same SHA-pinned helper. Local verification passed 51 tests across
the scanner, disposition boundaries and application caller; this is not yet a
successful fresh full-image build or live deployment. The proposal JSON and
historical investigation below are retained unchanged as the approval record.

## Verified mail prerequisites

| Check | Actual result | Evidence |
| --- | --- | --- |
| Both SMTP secrets present | PASS; booleans only | [34718481115](https://github.com/San4o9910/Kinetra/actions/runs/34718481115) |
| Existing server to smtp.yandex.ru:465 | PASS; verified TLS, EHLO, AUTH advertised | [34718730726](https://github.com/San4o9910/Kinetra/actions/runs/34718730726) |
| Yandex accepts username and app password | PASS; SMTP login from GitHub runner | [34718872036](https://github.com/San4o9910/Kinetra/actions/runs/34718872036) |

The server network test did not authenticate. The separate credential test did
authenticate but did not send mail. These establish network and credential
prerequisites, not end-to-end application delivery. Secret values were not read
back or included in logs/artifacts. The network inspection removed its temporary
SSH key from the guest, provider account and local runner.

SMTP settings are prepared in the dormant application caller; they have **not**
been installed in a running API. The chosen settings remain `smtp`, `yandex`,
`https://80.68.156.131`, `AUTH_TOKEN_DELIVERY_SMTP_USERNAME` and
`AUTH_TOKEN_DELIVERY_SMTP_PASSWORD`.

## Source and deployment identity

- Application: `73b665065e00a5b375e90f701373b3e0856a0386`, branch
  `feature/onboarding-exploration-mode`, draft PR #21 unmerged.
- Base: `ea0412a20baa87b7a00c4ce466d204d12fb052cc`.
- Reviewed merge: `2f5d388dea92ed4994131d0b5e77734189de026c`.
- Previously verified complete source CI: head [34535162371](https://github.com/San4o9910/Kinetra/actions/runs/34535162371),
  merge [34535166746](https://github.com/San4o9910/Kinetra/actions/runs/34535166746).
  Each passed all six jobs, 258 backend and 203 frontend tests, with zero skips
  and the required PostgreSQL 17, S3 and browser evidence. No app source changed
  in this work segment.
- Control fixes through `6002dcd0e01bb39ac7d05100647614dcc5b047b8`, branch
  `ops/timeweb-hourly-preflight-20260909`.
- Only authorized deployment target: Timeweb 9069403 / 80.68.156.131, hourly
  billing, hosting at most 2,000 RUB/month; SSH fingerprint
  `SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0`.

No database initialization, application startup, image publication or HTTPS
activation was performed in this work segment. Direct public `/healthz` and
`/readyz` probes returned HTTP 502. The app is not accepted as live. Existing
continuous fix/deployment authority remains valid after mandatory gates pass;
merge, existing-data deletion, payments and real user messages remain excluded.
Free beta for the first 15 eligible trainees remains the approved product mode.

## Scanner implementation corrections

The prior full-image build [34536263175](https://github.com/San4o9910/Kinetra/actions/runs/34536263175)
built both images and passed runtime/media/static smoke checks and Trivy
HIGH/CRITICAL and secret checks, then failed the upstream scanner parser. It did
not publish qualified images. Its source-built Node runtime took about 113 minutes
for the overall job; no unchanged full rebuild was started merely to rediscover
the scanner issue.

Three corrections now match the actual pinned Grype 0.118.0 source and output:

1. Accept the schema serialization `v6.1.9` while still validating schema 6,
   source, age, validity and exact database identity.
2. Set `match-upstream-kernel-headers: true` to prevent four implicit kernel
   ignore rules; require this setting and retain the zero-ignore policy.
3. Read database validity from `descriptor.db.status`, not the containing
   metadata object; update downstream provenance to the same documented shape.

Scanner regression tests: **24 passed**. Application caller/provenance tests:
**14 passed**. The preserved-body test normalizes only the two verified Grype
serialization changes before checking the original provenance body hash; all
unrelated acceptance assertions remain intact.

The fast diagnostic [34719050096](https://github.com/San4o9910/Kinetra/actions/runs/34719050096)
authenticated the exact previous image SBOM and ran the pinned scanner with a
fresh database. Version, database update and status passed; positive controls
passed and detected the required 2026 FFmpeg/ImageMagick vulnerabilities. The
production scan then correctly failed on two actual unbounded CPE matches.

Artifact: `10305503336`, `kinetra-upstream-scan-34719050096-1`, archive SHA-256
`dfebfc0cd9ddeefff2f28d309660c06a532346df49083e6cb769d5ab42db26a1`.
Its contents were inspected by successful read-only run
[34719192073](https://github.com/San4o9910/Kinetra/actions/runs/34719192073).
This diagnostic is not a replacement for full-image qualification.

## Remaining findings and reviewable proposal

| Finding | Raw severity | Component | Match evidence |
| --- | --- | --- | --- |
| CVE-2014-9826 | Critical | ImageMagick 7.1.2-30 | nvd:cpe, stock-matcher, versionConstraint `none (unknown)` |
| CVE-2017-5506 | High | ImageMagick 7.1.2-30 | nvd:cpe, stock-matcher, versionConstraint `none (unknown)` |

Both NVD matches use an unrestricted ImageMagick CPE and offer no fixed version.
The [pinned Wolfi supplier advisory](https://github.com/wolfi-dev/advisories/blob/39f06f99bf82ad5af70979464169fb6b1d63d07f/imagemagick.advisories.yaml)
records both as false positives because the vulnerable code was fixed upstream
before Wolfi packaging. Debian records fixes for
[CVE-2014-9826](https://security-tracker.debian.org/tracker/CVE-2014-9826) since
`8:6.8.9.9-4` and
[CVE-2017-5506](https://security-tracker.debian.org/tracker/CVE-2017-5506) since
`8:6.9.7.4+dfsg-1`.

For CVE-2017-5506, the [upstream fix](https://github.com/ImageMagick/ImageMagick/commit/9a069e0f2e027ec5138f998023cf9cb62c04889f)
is a verified ancestor of the pinned source commit. The exact current
`MagickCore/profile.c` retains the negative-offset and overflow guards. For
CVE-2014-9826, supplier evidence supports a probable false positive, but the
original Debian patch-to-current-source mapping has not been independently
completed. Kinetra builds upstream sources, so distro package status alone is
not proof of identical source. No malformed-image exploit test was run.

[The proposed disposition](upstream-cpe-review-proposal-20260912.json) is concrete
and **inactive**: only these two IDs, only the exact source/SBOM/version, expiring
September 26. It would retain raw reports/severities and require zero unresolved
HIGH/CRITICAL findings. Every additional finding, changed identity or range,
expired record or missing evidence would fail closed. Positive controls and
full image/secret scanning would remain mandatory. No workflow currently reads
this proposal, no CVE has been ignored, and the failed scan is still failed.

The authority record `continuous-deployment-state-20260909.md` requires assertions
to remain intact. Currently both `scan-upstream-media.py` and
`verify-launch-provenance.py` require zero **raw** HIGH/CRITICAL findings. Changing
this to accept reviewed fixed-upstream dispositions changes that release rule;
it is not another parser fix. A focused owner decision on the attached proposal
is needed before making that policy change. No new blanket deployment approval
is needed.

## Resuming from this checkpoint

Do not start another full image build with the same known failing policy. Resolve
the proposed classification or supply a remediated candidate first. If the owner
accepts the disposition proposal, implement it in both qualification and launch
provenance, preserve raw evidence and negatively test unknown IDs, wrong hashes,
expiration, changed ranges and all positive controls before any release.

The full image workflow intentionally has not been retriggered. Before its next
authorized execution, update its scanner helper hashes from the old pins to:

```
46c32b0e6c1e6005904fd30b2d73eee674f0c4d6a3961fea1f1f8036eeda8ddd  ops/timeweb/scan-upstream-media.py
c4a35c5b13730316bc92c8f1b1ccf1d1b54c1cbaa15718790cb5603a07aec4a8  ops/timeweb/test-scan-upstream-media.py
```

Recompute those pins again if policy implementation changes either file. Fill
dormant database/application templates only from actual successful new image
evidence and each preceding stage; retain existing host state. Then complete
staged database/API/web/HTTPS activation, external browser acceptance and the
remaining backup/restore and operations acceptance work. SMTP prerequisites are
now verified and do not require asking the owner to add these secrets again.
