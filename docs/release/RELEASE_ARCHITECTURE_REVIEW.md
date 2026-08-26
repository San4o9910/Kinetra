RELEASE ARCHITECTURE REVIEW: CONDITIONAL

# 1. Executive decision

Release foundation можно передать на отдельное рассмотрение Platform/DevOps и Cloud/Security
owners. Статическая архитектура выстроена fail-closed: она не меняет application logic, не создаёт
deployable production manifest и не разрешает публикацию, deployment, migration или feature flag.

Переход к публикации artifact пока не разрешён. Обязательные причины:

- deployment platform и владельцы инфраструктуры не выбраны;
- Containerfile не собран на clean builder;
- новый release workflow не запускался на опубликованном exact head;
- SBOM, provenance и container digest не получены в этом review environment;
- signing policy и key/workload identity отсутствуют, статус остаётся `NOT_SIGNED_DRY_RUN`;
- frontend artifact не включён в digest/provenance chain;
- timing-sensitive concurrent backend gate нуждается в детерминизации или повторяемом remote CI
  evidence;
- readiness, resource limits, worker schedules, ImageMagick policy и rollback rehearsal не закрыты.

Итоговый статус - `CONDITIONAL`, а не `READY FOR OWNER REVIEW`, потому что owners пока могут
рассматривать варианты и список входов, но не могут безопасно разрешить artifact publication.

# 2. Scope and source identity

| Field                            | Expected                                                           | Actual                                     | Status |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------ |
| Repository                       | `San4o9910/Kinetra`                                                | `San4o9910/Kinetra`                        | PASS   |
| Local branch                     | `chore/t14-release-architecture`                                   | `chore/t14-release-architecture`           | PASS   |
| Source merge commit              | `c5645a3aa84bbc81e688c97731e48d978a2aeb92`                         | `c5645a3aa84bbc81e688c97731e48d978a2aeb92` | PASS   |
| Source tree                      | `4ee94cb5d334e54e5996d42caed35e0b3c776a23`                         | `4ee94cb5d334e54e5996d42caed35e0b3c776a23` | PASS   |
| Original 26-file foundation tree | `2e7a637e60a635c91c7d9354c2b7de349f1d0af8`                         | reproduced before this approval package    | PASS   |
| Migration 012 SHA-256            | `c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4` | unchanged                                  | PASS   |
| Application paths                | no `apps/` or `packages/` changes                                  | 0 changed paths                            | PASS   |
| Git index                        | no staged changes                                                  | clean                                      | PASS   |

The original foundation patch was applied cleanly and had SHA-256
`611e8c0cea01db936d406f9aa5e693fab57626a37a4b58f532cefd02b9fcfd3d`.

Scope review found no deleted application file, generated secret, private key, registry credential,
hardcoded production endpoint or unexpected binary. All 26 foundation files are text or JSON. The
manual credential-pattern scan produced no finding. A full Gitleaks scan remains unavailable in the
current environment and is required at the next remote gate.

# 3. Changed files and risk

The following inventory is the exact original 26-file foundation. The five approval documents in
this review are additional documentation-only files recorded separately in `MANIFEST.sha256`.

| Category                     | Files | Application impact                                                              | Status                         |
| ---------------------------- | ----: | ------------------------------------------------------------------------------- | ------------------------------ |
| Containerfile                |     2 | `Containerfile`, `.dockerignore`; packaging only                                | PASS SCOPE / BUILD BLOCKED     |
| Workflow                     |     2 | `.github/workflows/release-foundation.yml`, `.github/workflows/ci.yml`; CI only | PASS STATIC / NOT RUN REMOTELY |
| Schemas/templates            |     7 | three schemas and four `NON_DEPLOYABLE` templates                               | PASS STATIC                    |
| Validators/tests             |     7 | six release scripts plus `scripts/verify-project.mjs`                           | PASS LOCAL                     |
| ADR/documentation            |     4 | two release documents, `README.md`, `VALIDATION.md`                             | PASS                           |
| Manifest/package integration |     4 | `MANIFEST.sha256`, `.gitignore`, `package.json`, `package-lock.json`            | PASS LOCAL                     |

Exact file list:

1. `.dockerignore`
2. `.github/workflows/ci.yml`
3. `.github/workflows/release-foundation.yml`
4. `.gitignore`
5. `Containerfile`
6. `MANIFEST.sha256`
7. `README.md`
8. `VALIDATION.md`
9. `docs/release/ADR-001_PLATFORM_NEUTRAL_OCI_RUNTIME.md`
10. `docs/release/RELEASE_ARCHITECTURE.md`
11. `package-lock.json`
12. `package.json`
13. `release/contracts/artifact-identity.schema.json`
14. `release/contracts/rollback.schema.json`
15. `release/contracts/runtime-unit.schema.json`
16. `release/templates/api.runtime.template.json`
17. `release/templates/rollback.runtime.template.json`
18. `release/templates/video-cleanup.runtime.template.json`
19. `release/templates/video-verifier.runtime.template.json`
20. `scripts/release/contracts.mjs`
21. `scripts/release/generate-artifact-metadata.mjs`
22. `scripts/release/release-architecture.test.mjs`
23. `scripts/release/report-environment.mjs`
24. `scripts/release/validate-container-runtime.mjs`
25. `scripts/release/validate-release-architecture.mjs`
26. `scripts/verify-project.mjs`

# 4. Containerfile review

| Finding              | Evidence                                                                                | Status                       | Required next step                                                             |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Base image           | Node `22.16.0-bookworm-slim` pinned by SHA-256 digest in both non-scratch stages        | PASS STATIC                  | Verify digest on clean builder                                                 |
| OS packages          | Debian snapshot `20250611T000000Z`; exact ffmpeg, ImageMagick and tini package versions | PASS STATIC                  | Build and verify resolved transitive packages                                  |
| Multi-stage boundary | build, export-only `frontend-files`, and `backend-runtime` stages are separate          | PASS                         |
| Frontend target      | `scratch` contains only Vite `dist`; no server or default command                       | PASS AS EXPORT TEMPLATE      | Choose frontend host and create a separately digested frontend artifact        |
| Runtime identity     | `USER node`, non-root checks and runtime `runAsNonRoot` contract                        | PASS STATIC                  | Confirm numeric UID/GID on built image and platform                            |
| Signals              | exec-form `/usr/bin/tini --` plus Node command                                          | PASS FOUNDATION              | Define grace period, hard deadline and termination test                        |
| Runtime contents     | explicit application copies, production dependency prune, apt cache removal             | PASS STATIC                  | Inspect the actual filesystem on clean builder                                 |
| Shell/package tools  | Debian slim still contains shell and package-management/debug-capable utilities         | FOLLOW-UP REQUIRED           | Security owner must justify them or require a hardened/minimal runtime variant |
| Media tools          | ffmpeg/ffprobe and ImageMagick versions are asserted                                    | PASS STATIC                  | Run adversarial media tests in the built image                                 |
| ImageMagick policy   | no Kinetra-specific production policy has been approved                                 | OPEN / RELEASE-BLOCKING      | Approve policy or remove ImageMagick from roles that do not require it         |
| Secrets              | no credential-bearing ARG/ENV; Vite build args are documented as public                 | PASS STATIC                  | Inspect image history and config on clean builder                              |
| Health/readiness     | no misleading Docker `HEALTHCHECK`; `/health` is liveness-only                          | PASS SAFETY / READINESS OPEN | Define dependency-aware readiness and worker heartbeat probes                  |
| Resources            | read-only-root-compatible `/tmp` contract exists; no CPU, memory or tmp limits selected | OPEN / RELEASE-BLOCKING      | Set per-role limits and verify a maximum-size upload workload                  |
| Actual build         | Docker/BuildKit unavailable in this environment                                         | BLOCKED BY ENVIRONMENT       | Build `linux/amd64` on an approved clean builder                               |

The Containerfile is a credible foundation, not deployability evidence. No production runtime image
exists from this review.

# 5. Release workflow review

Detailed findings are in `RELEASE_WORKFLOW_SECURITY_REVIEW.md`. Summary:

- trigger is manual `workflow_dispatch` only;
- permissions are `contents: read` and `actions: read`;
- `publish`, `deploy`, `migrate`, and `enable_feature_flag` are required booleans with default
  `false`, and every non-false value fails before checkout;
- checkout and setup actions are commit-SHA pinned; checkout credentials are not persisted;
- application commit/tree and release-definition commit/tree are independently verified;
- the Docker context is recreated from `git archive` of the exact application commit;
- workflow has no registry login/push, artifact upload, deployment, migration, flag activation,
  environment target or repository secret consumption;
- image, SBOM and metadata remain runner-local and are removed in an `always()` cleanup step;
- missing Docker, SBOM or runtime evidence cannot become `COMPLETE_LOCAL_UNSIGNED_EVIDENCE`;
- unsigned provenance and `NOT_SIGNED_DRY_RUN` are represented explicitly, not as signed PASS.

Open workflow gates are remote execution, clean-builder evidence, scanner policy, trusted
attestation/signature, durable evidence retention for a future publishing workflow, frontend
artifact handling and runner/toolchain reproducibility.

# 6. Supply-chain validation

| Link                           | Evidence                                                               | Status                        | Required next step                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Exact source SHA/tree          | Git and workflow guards match `c5645a3...` / `4ee94c...`               | PASS                          |
| Reproducible build input       | pinned base, Debian snapshot, lockfile, sanitized exact-source context | PASS STATIC                   | Build twice on independent clean builders and compare OCI manifest/config digests                      |
| Backend image digest           | no Docker in review environment                                        | BLOCKED BY ENVIRONMENT        | Produce OCI manifest digest on approved builder                                                        |
| Frontend digest                | export-only target exists but workflow produces no frontend digest     | MISSING / RELEASE-BLOCKING    | Package and digest immutable frontend output                                                           |
| SBOM                           | pinned Syft design exists; Syft unavailable locally                    | BLOCKED BY ENVIRONMENT        | Generate SPDX JSON and bind its SHA-256 to exact backend digest; do the same for frontend dependencies |
| Vulnerability/secret scan      | Trivy and Gitleaks unavailable; no scanner step in foundation workflow | MISSING / RELEASE-BLOCKING    | Approve scanners, severity policy and fail-closed behavior                                             |
| Provenance                     | BuildKit metadata design plus local unsigned provenance contract       | CONDITIONAL                   | Generate trusted CI attestation bound to published digest                                              |
| Signature                      | `NOT_SIGNED_DRY_RUN`                                                   | NOT SIGNED / RELEASE-BLOCKING | Select signer, key/workload identity, verification policy and transparency requirements                |
| Digest-pinned runtime manifest | validators reject tag-only and mutable references                      | PASS STATIC                   | Render and validate the chosen platform adapter against the actual digest                              |
| Rollback reference             | placeholders require an immutable predecessor                          | OPEN / RELEASE-BLOCKING       | Supply previous production backend and frontend digests and rehearse rollback                          |

# 7. Architecture decisions required

No infrastructure owner has confirmed a production platform. The result is:

`ARCHITECTURE DECISION REQUIRED`

Two realistic, non-selected alternatives are documented in `PLATFORM_DECISION_REQUIRED.md`:

- Option A: AWS ECS/Fargate + EventBridge Scheduler + ECR + private S3/CloudFront;
- Option B: Google Cloud Run services/jobs + Cloud Scheduler + Artifact Registry + Firebase Hosting.

Neither option is approved by this review. Platform/DevOps, Cloud/Security, Frontend and SRE owners
must jointly select or reject them and provide the platform-specific values listed in
`NEXT_GATE_INPUTS.md`.

# 8. Test and risk analysis

## Local validation

| Check                                                    | Result                                            |
| -------------------------------------------------------- | ------------------------------------------------- |
| Clean `npm ci` with isolated writable cache              | PASS, 361 packages                                |
| Release regression                                       | PASS, 23/23                                       |
| Static release validator                                 | PASS                                              |
| Structural verifier                                      | PASS, 2946/2946                                   |
| TypeScript and ESLint                                    | PASS                                              |
| Production frontend build                                | PASS, 131 modules                                 |
| Frontend tests                                           | PASS, 160/160                                     |
| Backend default-concurrent runs in this review           | PASS 3/3, each 163 pass / 18 infrastructure skips |
| Exact timing-sensitive test in this review               | PASS 10/10 isolated                               |
| Browser harness                                          | build/mock/cleanup PASS; Chrome execution BLOCKED |
| Manifest before approval docs                            | PASS, 339/339                                     |
| Docker, PostgreSQL client, Syft, Cosign, Trivy, Gitleaks | BLOCKED BY ENVIRONMENT                            |

The browser harness was correctly classified as blocked after producing
`KINETRA_BROWSER_MOCK_API=PASS` and cleanup markers; it did not emit a browser PASS marker.

## Timing-sensitive failure

- Exact test: `T14 verification deadline expiring during final renewal prevents publication`.
- Scenario: a 200 ms verification deadline competes with a mocked 250 ms final lease renewal.
- Historical evidence: one prior full default-concurrent run failed because the deadline elapsed
  before the final renewal began; serial and isolated T14 runs passed.
- Current evidence: 3/3 full default-concurrent runs passed and 10/10 exact isolated runs passed.
- Combined recorded full-run sample: one failure among four known default-concurrent runs. This is
  not a statistical reliability claim, but it proves the failure is not safely dismissible.
- Classification: test-harness/environment timing sensitivity. The observed failure does not show
  that stale publication occurred; the implementation continued to fence publication. However,
  the wall-clock test can fail for machine-load reasons and therefore cannot be a trustworthy
  release gate as written.
- Required change: replace narrow real-time races with deterministic synchronization/fake timing,
  or prove an equivalently strict deterministic fence through a non-flaky test. Do not simply
  increase the timeout without preserving the boundary being tested.
- Release impact: release-blocking for artifact publication and staging, but not a reason to reject
  the platform-neutral documentation foundation.

Remote CI evidence for the immutable application source remains GitHub Actions run `32842822401`
(run 124, attempt 1): all three jobs passed, including PostgreSQL 17, private MinIO/S3 and browser
steps. That run covers the application source only; it does not validate this release-definition
head or its future PR merge ref.

# 9. Approval package inventory

| Document                              | Purpose                                     | Checksum evidence |
| ------------------------------------- | ------------------------------------------- | ----------------- |
| `RELEASE_ARCHITECTURE_REVIEW.md`      | independent decision and evidence           | `MANIFEST.sha256` |
| `PLATFORM_DECISION_REQUIRED.md`       | two realistic platform alternatives         | `MANIFEST.sha256` |
| `RELEASE_WORKFLOW_SECURITY_REVIEW.md` | workflow threat/security review             | `MANIFEST.sha256` |
| `OPEN_APPROVALS.md`                   | approval sequence and current authorization | `MANIFEST.sha256` |
| `NEXT_GATE_INPUTS.md`                 | required owner-supplied inputs              | `MANIFEST.sha256` |

The existing T14 evidence history was not replaced. `MANIFEST.sha256` adds these five documents and
retains all existing entries.

Missing evidence remains: clean container build, image filesystem/history inspection, SBOM,
scanner results, trusted provenance, signature verification, frontend artifact digest, remote
release workflow execution, exact-head/merge-ref CI, platform adapter, readiness/resource limits,
previous production digests and rollback rehearsal.

# 10. Explicit approvals for next step

| Action                  | Required approver              | Why needed                                    | Allowed now? |
| ----------------------- | ------------------------------ | --------------------------------------------- | ------------ |
| Commit/push/draft PR    | Repository owner               | publishes the release-definition branch       | NO           |
| Remote workflow run     | Platform/Release owner         | validates workflow on exact remote head       | NO           |
| Artifact publish        | Platform + Security            | mutates registry and creates release evidence | NO           |
| Staging deployment      | Release + Platform + DBA/SRE   | mutates an environment                        | NO           |
| Migration 012           | DBA/SRE + Release owner        | irreversible production data change           | NO           |
| Feature flag activation | Product/Release + Security/SRE | exposes T14 behavior to users                 | NO           |

The current authorized next action is owner review of this package only.

# 11. Final safety statement

No artifact was published. No registry, GitHub Release, tag or persistent Actions artifact was
created. Staging and production were not changed. Migration 012 was not executed. The
`TRAINER_VIDEO_UPLOADS_ENABLED` flag was not enabled. Secrets, IAM, KMS, CORS, bucket policy,
lifecycle, scheduler and production configuration were not changed. No commit, push or PR was
created.
