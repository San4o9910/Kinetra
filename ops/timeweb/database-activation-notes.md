# Dormant database activation workflow

`database-activation.yml` is an inactive review copy under `ops/timeweb`. It has not been placed in `.github/workflows`, run against Timeweb, or used to initialize any database. The first step fails unless root fills the reviewed inputs and changes `ACTIVATE_DATABASE_INITIALIZATION` to `APPROVED`.

Activation target is only existing server 9069403 / 80.68.156.131. The workflow uses the same host-maintenance concurrency group as bootstrap and Caddy preparation. Its ordered mutations are the existing reviewed staging command followed by the existing reviewed first-initialization command. The registry token is supplied only to staging; initialization explicitly rejects a retained registry token. Each host step receives its own step-local Timeweb token. Both helpers remove credentials from child environments and verify temporary-key cleanup. No provider secrets, API/frontend startup, ACME request, payment, message, purchase, existing-data deletion or merge is included.

## Inputs root must fill from completed evidence

- Exact application, base and merge commits, with successful first-attempt exact-head and merge-ref CI run IDs.
- Successful first-attempt image-qualification run ID and its control commit. Pin the SHA-256 of that commit's actual `.github/workflows/kinetra-image-validation.yml` blob after reviewing its full qualification policy.
- That run's immutable, unexpired `kinetra-image-evidence-RUN-1` artifact ID and API-reported SHA-256. The downloaded ZIP must have the same digest. Artifact size is bounded at 64 MiB and selected JSON/text members at 4 MiB; no archive is extracted or executed.
- Exact `NODE_IMAGE` and `NGINX_IMAGE` values from `registry-inputs.tsv`, and the digest-only private project `BACKEND_IMAGE` / `FRONTEND_IMAGE` references from `published-images.env`.
- A separately reviewed official PostgreSQL 17 bookworm digest in `POSTGRES_IMAGE`. The application image qualification evidence does not scan PostgreSQL. Existing source CI supplies PostgreSQL 17 integration coverage; staging probes the supplied actual image and initialization verifies its major version and TLS behavior. Do not describe that as a PostgreSQL image security scan.
- Recompute the six inline control-script/test hash pins if root accepts further changes. Their current values bind the reviewed staging/initialization implementation and imported helper chain.

The verifier trusts the pinned image-workflow implementation's existing parsing of actual checkout logs, then checks its pinned source-gates artifact against the current open Draft PR #21 and the live successful CI job identities and step conclusions. All expected jobs and steps must be successful; a rerun attempt, skipped step, stale PR identity, changed artifact, unresolved input or expired evidence fails before any Timeweb secret is supplied.

Image identity is checked through the pinned artifact ZIP, exact published references, SHA-256 of original registry manifest bytes, registry manifest config digests, built image IDs and application revision labels. Current package metadata must still say private and identify this repository. The staging helper performs the actual Docker pulls using those digest-pinned references. There is no additional runner registry login. Docker Buildx's upstream `util/imagetools/printers.go` writes raw manifests without adding a newline specifically to preserve their digest; the verifier neither trims nor canonicalizes JSON.

The C4 evidence contract requires exactly four registry input rows: Node, nginx, Trivy and Grype. Both final-image runtime markers must pass: actual application bcrypt/photo normalization and MP4/H264/AAC. `media-source-verification.json` must carry its PASS marker, both package inventories and exactly the source components scanned in `source-components.cdx.json`.

The additional mandatory `upstream-media/summary.json` must identify Grype 0.118.0 by the resolved registry digest, the exact source SBOM SHA-256 and both media versions. Its database hash/status must be valid, schema 6, sourced from Anchore and built no more than 120 hours before activation. Positive-control and production phases must both pass offline against that same database hash with complete component coverage. The positive control must actually find the specified FFmpeg/ImageMagick CVEs and exit 2; production must exit 0 with zero HIGH/CRITICAL findings. The original production report and its CycloneDX output independently retain the same database, identities and CPE coverage. A missing upstream step, stale database, missing runtime marker or unmatched component prevents host access.

## Before publishing the active copy

Local review on 2026-09-10 passed YAML parsing, `bash -n` on all five shell blocks, Python parsing on both embedded programs, 27 staging tests and 23 initialization tests. After adding C4 evidence checks, an isolated mocked run of the actual inline provenance verifier accepted one valid fixture and rejected 24 changed PR/run/image/artifact/scan/runtime identities and skipped-step cases. It made no network or host calls. Recheck hashes and run the two existing suites with `APP_CHECKOUT` set to the final exact application checkout before activation. These checks do not constitute live database acceptance.

Then root may copy the filled reviewed workflow to `.github/workflows/timeweb-database-initialization.yml` and publish within the existing authorization. Its path-specific push trigger starts a new first attempt. The inactive copy itself never triggers Actions.

A failure after staging or initialization creates a preserved partial state. This workflow is for the first initialization only; diagnose that state and prepare a bounded correction/resume rather than rerunning it or removing evidence/data. A successful outcome remains `DATABASE_INITIALIZED_ONLY`, with the API, frontend, workers and Caddy inactive and real provider inputs still outstanding.

Primary source for exact Buildx raw-output semantics, inspected 2026-09-10: https://github.com/docker/buildx/blob/master/util/imagetools/printers.go
