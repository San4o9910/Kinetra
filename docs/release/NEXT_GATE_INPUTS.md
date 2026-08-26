# Kinetra T14 next gate inputs

Status: `INCOMPLETE - OWNER INPUT REQUIRED`

The next gate is branch publication and remote non-publishing validation. It is not artifact
publication or deployment.

## 1. Repository and release identity

| Required input                     | Expected form             | Owner                    | Value                                      |
| ---------------------------------- | ------------------------- | ------------------------ | ------------------------------------------ |
| Approved base                      | full 40-character SHA     | Repository owner         | `c5645a3aa84bbc81e688c97731e48d978a2aeb92` |
| Approved branch                    | exact branch name         | Repository owner         | `chore/t14-release-architecture`           |
| Permission to commit/push/draft PR | explicit yes/no and scope | Repository owner         | PENDING                                    |
| Draft PR base                      | exact branch              | Repository owner         | PENDING                                    |
| Required checks                    | exact GitHub check names  | Repository/Release owner | PENDING                                    |
| Remote workflow permission         | exact workflow and ref    | Platform/Release owner   | PENDING                                    |

## 2. Platform decision

| Required input                                 | Owner                    | Value   |
| ---------------------------------------------- | ------------------------ | ------- |
| Selected platform or approved alternative      | Platform/DevOps          | PENDING |
| Cloud account/project and region               | Platform/Cloud           | PENDING |
| API runtime and replica range                  | Platform/SRE             | PENDING |
| Network, ingress, TLS and DNS                  | Platform/Security        | PENDING |
| PostgreSQL 17 topology and connection method   | DBA/SRE                  | PENDING |
| Video storage decision: S3 or reviewed adapter | Cloud/Security + Backend | PENDING |
| Frontend hosting and CDN                       | Frontend + Platform      | PENDING |
| OCI registry/repository                        | Platform                 | PENDING |
| Immutable retention and deletion protection    | Platform + Security      | PENDING |

## 3. Runtime and operations

| Required input          | Minimum detail                                                      | Owner              | Value   |
| ----------------------- | ------------------------------------------------------------------- | ------------------ | ------- |
| API CPU/memory          | request and limit                                                   | Platform/SRE       | PENDING |
| Verifier CPU/memory/tmp | includes maximum video and concurrent jobs                          | Platform/SRE       | PENDING |
| Cleanup CPU/memory/tmp  | request and limit                                                   | Platform/SRE       | PENDING |
| Read-only filesystem    | writable paths and size limits                                      | Security/SRE       | PENDING |
| Graceful shutdown       | signal, grace period, hard deadline and test                        | Backend + SRE      | PENDING |
| API readiness           | PostgreSQL/S3/media dependencies and timeout semantics              | Backend + SRE      | PENDING |
| Worker schedule         | verifier and cleanup cadence                                        | Product + SRE      | PENDING |
| Worker concurrency      | per-role maximum and overlap policy                                 | Backend + SRE      | PENDING |
| Retry/dead-letter       | limits, quarantine and operator path                                | Backend + SRE      | PENDING |
| Observability           | logs, metrics, traces, dashboards and retention                     | SRE/Security       | PENDING |
| Alerts                  | stale heartbeat, degraded run, retry/quarantine and cleanup backlog | SRE                | PENDING |
| Realtime scaling        | single replica or shared Socket.IO adapter                          | Backend + Platform | PENDING |

## 4. Security and supply chain

| Required input                                        | Owner               | Value   |
| ----------------------------------------------------- | ------------------- | ------- |
| Secret manager and delivery method                    | Security            | PENDING |
| Workload identities and least-privilege roles         | Security/Platform   | PENDING |
| S3 IAM, KMS, CORS, versioning and lifecycle policy    | Cloud/Security      | PENDING |
| ImageMagick production policy                         | Security/Backend    | PENDING |
| Vulnerability scanner and severity threshold          | Security            | PENDING |
| Secret scanner and exception process                  | Security            | PENDING |
| SBOM format and retention                             | Security/Release    | PENDING |
| Provenance/attestation standard                       | Security/Release    | PENDING |
| Signer, key/workload identity and verification policy | Security/Release    | PENDING |
| Transparency/log policy                               | Security            | PENDING |
| Evidence retention and access policy                  | Security/Compliance | PENDING |

## 5. Validation evidence

The next approval request must attach all applicable evidence:

- exact clean-builder backend image digest and config digest;
- independently repeated build comparison;
- built-image filesystem/history and non-root runtime validation;
- ffmpeg/ffprobe, ImageMagick and native bcrypt probes inside the image;
- immutable frontend bundle digest and deployable static-host package;
- backend and frontend SBOMs;
- vulnerability and secret scan results;
- trusted provenance/attestation and signature verification;
- exact-head and PR merge-ref CI with PostgreSQL 17, versioned/unversioned MinIO/S3 and Chrome;
- deterministic replacement for the timing-sensitive 200 ms test or repeated remote evidence plus
  an approved residual-risk decision;
- platform-specific readiness, resource and worker-schedule validation;
- previous production backend/frontend digests;
- rollback rehearsal and data-compatibility result;
- PostgreSQL backup/restore evidence and migration 012 runbook.

## 6. Required owner names

Before artifact publication, name one accountable person or team for each role:

- Repository owner;
- Platform/DevOps owner;
- Cloud/Security owner;
- Release owner;
- Frontend hosting owner;
- Backend/runtime owner;
- DBA/SRE owner;
- Incident/rollback owner;
- Product owner for feature flag activation.

## 7. Safety boundary

Supplying these inputs does not itself authorize a mutation. Each later action still requires the
separate approval listed in `OPEN_APPROVALS.md`.
