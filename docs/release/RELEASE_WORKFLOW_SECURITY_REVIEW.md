# Kinetra T14 release workflow security review

Status: `CONDITIONAL - STATIC PASS, REMOTE EXECUTION NOT RUN`

Reviewed workflow: `.github/workflows/release-foundation.yml`.

## Threat boundary

The workflow is allowed to create temporary local evidence on a GitHub-hosted runner. It is not
allowed to publish, deploy, migrate, enable a feature, write repository contents, consume production
secrets or retain an image/SBOM as an Actions artifact.

## Trigger and permissions

| Control                | Finding                                                          | Status      |
| ---------------------- | ---------------------------------------------------------------- | ----------- |
| Trigger                | `workflow_dispatch` only                                         | PASS        |
| Repository permissions | `contents: read`, `actions: read`                                | PASS        |
| Environment target     | none                                                             | PASS        |
| Checkout credentials   | `persist-credentials: false`                                     | PASS        |
| Action references      | checkout, setup-node and setup-buildx pinned to full commit SHAs | PASS STATIC |
| Concurrency            | ref-scoped group, no cancellation of an in-progress evidence run | PASS        |
| Job timeout            | 60 minutes                                                       | PASS        |

The `ubuntu-24.04` runner label and the Buildx version selection are not bit-for-bit builder pins.
The workflow records runner image metadata and pins the BuildKit driver image digest, but a future
publication gate must preserve full builder identity and demonstrate repeatability on clean
builders.

## Dangerous inputs and bypass resistance

| Input                 | Type/default               | Guard                                       | Status |
| --------------------- | -------------------------- | ------------------------------------------- | ------ |
| `publish`             | required boolean / `false` | any non-`false` value exits before checkout | PASS   |
| `deploy`              | required boolean / `false` | any non-`false` value exits before checkout | PASS   |
| `migrate`             | required boolean / `false` | any non-`false` value exits before checkout | PASS   |
| `enable_feature_flag` | required boolean / `false` | any non-`false` value exits before checkout | PASS   |

The guard reads typed GitHub inputs through step-local environment variables. Repository or runner
environment variables do not replace these expressions. No later step implements the prohibited
operations, so bypassing the first guard alone would still not create a publisher or deployer.

## Source and build identity

- Canonical repository is fixed to `San4o9910/Kinetra`.
- Application source is fixed to commit `c5645a3aa84bbc81e688c97731e48d978a2aeb92` and tree
  `4ee94cb5d334e54e5996d42caed35e0b3c776a23`.
- Release-definition commit/tree are recorded independently from application source.
- Both checkouts must be clean regular files.
- Docker context is recreated using `git archive` of the exact application commit; `.git`, symlinks
  and workspace debris are excluded.
- Container build receives only release-definition identity arguments. No credential-bearing build
  arguments exist.

Status: `PASS STATIC`; actual BuildKit execution remains blocked until the workflow runs remotely.

## Publication and mutation review

Static review found none of the following:

- `docker push`, `buildx --push`, Podman push or registry login;
- `actions/upload-artifact`, GitHub Release or tag creation;
- Kubernetes, Helm or environment deployment commands;
- database migration commands;
- feature flag activation;
- repository write permissions;
- GitHub `secrets.*` consumption;
- production endpoint, IAM, KMS, CORS, bucket, lifecycle or scheduler mutation.

Status: `PASS STATIC`.

## SBOM, provenance and signature behavior

| Component         | Behavior                                                                  | Status                             |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| Image digest      | BuildKit metadata must contain a SHA-256 manifest digest                  | DESIGNED / NOT RUN                 |
| SBOM              | Syft `1.51.0` archive is size- and SHA-256-checked before SPDX generation | DESIGNED / NOT RUN                 |
| Provenance        | BuildKit metadata is extracted as local unsigned provenance               | DESIGNED / NOT TRUSTED ATTESTATION |
| Signature         | explicit `NOT_SIGNED_DRY_RUN`, `signed=false`, no transparency entry      | PASS HONESTY / NOT SIGNED          |
| Scanner           | no vulnerability scanner step                                             | MISSING / RELEASE-BLOCKING         |
| Secret scanner    | no Gitleaks step                                                          | MISSING / RELEASE-BLOCKING         |
| Frontend artifact | not packaged, digested or covered by SBOM/provenance                      | MISSING / RELEASE-BLOCKING         |

If Docker, runtime validation, Syft, metadata generation or any required evidence step fails, the
required evidence list remains incomplete. The finalizer writes an `INCOMPLETE_OR_FAILED` summary;
it cannot write the complete status. Because earlier failed steps retain their job failure state,
the `always()` finalizer does not turn a failed job into a workflow PASS.

## Logs, retention and cleanup

- shell blocks use `set -Eeuo pipefail` and do not use `set -x`;
- GitHub token is used only for silent read-only API requests and is not written to evidence;
- evidence files are mode 0600/0700 and symlinks are rejected;
- image archives are prohibited inside the evidence directory;
- no persistent Actions artifact is uploaded;
- image, archive, source context, tool download and evidence directory are removed in `always()`
  cleanup.

This is suitable for a non-publishing dry run. It is not sufficient for a publishing pipeline,
which will need an approved immutable retention policy for image, SBOM, provenance, signature and
verification records.

## Exact CI dependency

The workflow verifies existing application run `32842822401` (run 124, attempt 1) using the
read-only Actions API. The run is bound to the exact T14 merge commit and all three expected jobs
passed. This evidence does not cover the release-definition branch, exact head or future PR merge
ref.

## Required changes before artifact publication

1. Publish the branch only after repository-owner approval and run both exact-head and PR merge-ref
   CI.
2. Run this manual workflow on the exact approved release-definition commit.
3. Build backend and frontend immutable artifacts; record both digests.
4. Add approved fail-closed vulnerability and secret scanners with a documented exception process.
5. Replace local unsigned provenance with a trusted attestation bound to the registry digest.
6. Apply and verify the approved signature policy.
7. Retain immutable evidence under an approved access/retention policy.
8. Prove two-clean-builder repeatability or document accepted non-reproducible fields.
9. Ensure the timing-sensitive concurrent backend gate is deterministic before treating CI as a
   reliable release gate.

Final workflow verdict: `CONDITIONAL`.
