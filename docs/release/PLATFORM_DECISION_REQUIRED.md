# Kinetra T14 platform decision required

Status: `ARCHITECTURE DECISION REQUIRED`

This document presents two realistic alternatives. It does not select a platform and is not a
deployment approval. The owner must confirm the actual platform before a platform-specific manifest
is created.

## Decision criteria

| Criterion                   | Option A - AWS                                                                                             | Option B - Google Cloud                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| API runtime                 | ECS service on Fargate behind an Application Load Balancer                                                 | Cloud Run service                                                                                                                                |
| Worker runtime/scheduler    | One-shot ECS `RunTask` tasks triggered by EventBridge Scheduler for verifier and cleanup                   | Cloud Run Jobs triggered by Cloud Scheduler for verifier and cleanup                                                                             |
| Frontend hosting            | Private S3 origin behind CloudFront with Origin Access Control                                             | Firebase Hosting for the immutable Vite static bundle                                                                                            |
| Registry                    | Amazon ECR; deploy only `repository@sha256:...`                                                            | Artifact Registry; deploy only `repository@sha256:...`                                                                                           |
| Database                    | RDS for PostgreSQL 17, private networking                                                                  | Cloud SQL for PostgreSQL 17, private connectivity                                                                                                |
| Video object storage        | Existing S3 design with explicit versioning/encryption policy                                              | Requires a deliberate decision: keep AWS S3 cross-cloud or build and review a new GCS adapter; no silent substitution                            |
| Secret manager              | AWS Secrets Manager or Parameter Store with task-role access                                               | Secret Manager with least-privilege service accounts                                                                                             |
| Health/readiness            | ALB/container liveness plus a new dependency-aware readiness contract; worker heartbeats in PostgreSQL     | Cloud Run startup/liveness plus a new dependency-aware readiness contract; worker heartbeats in PostgreSQL                                       |
| Rollback                    | Previous ECS task definition and exact backend digest; versioned frontend release in S3/CloudFront         | Previous Cloud Run revision pinned by digest; previous Firebase Hosting release                                                                  |
| SBOM/provenance/signature   | Syft/SPDX, trusted CI provenance and owner-selected Cosign/KMS policy bound to ECR digest                  | Syft/SPDX, trusted CI provenance and owner-selected Cosign/Cloud KMS policy bound to Artifact Registry digest                                    |
| Observability               | CloudWatch logs, metrics, alarms and traces; explicit worker failure alarms                                | Cloud Logging, Monitoring, Error Reporting and traces; explicit worker failure alarms                                                            |
| Operational cost/complexity | Medium to high: more infrastructure objects and IAM boundaries, but direct fit with the existing S3 design | Low to medium for API/jobs, but cross-cloud S3 or a new storage adapter can remove the simplicity advantage                                      |
| Realtime constraint         | More than one API replica requires a reviewed shared Socket.IO adapter and connection-routing policy       | WebSockets are supported, but multi-instance state still requires a shared Socket.IO adapter; request timeouts/reconnect behavior must be tested |

## Option A - AWS ECS/Fargate

Why it is realistic:

- the T14 storage contract already targets private S3 and exact object versions;
- ECS services can run the API while EventBridge Scheduler can invoke one-shot ECS tasks;
- task definitions accept container image digests, and ECS provides image version consistency;
- S3 plus CloudFront can host the static frontend with a private origin;
- existing AWS IAM, KMS and bucket controls can be kept in one cloud boundary.

Decisions still required:

- AWS account, region, VPC/subnets, ALB and DNS/TLS ownership;
- RDS PostgreSQL topology, backup/restore and migration operator;
- exact ECR repository, retention and cross-account policy;
- task CPU/memory/ephemeral storage, API replicas and termination grace;
- worker schedules, retry/dead-letter behavior and alarms;
- Secrets Manager versus Parameter Store, secret delivery method and rotation;
- CloudFront cache, CSP/headers, SPA fallback and service-worker policy;
- signing identity and verification gate.

## Option B - Google Cloud Run

Why it is realistic:

- Cloud Run services accept prebuilt container images;
- Cloud Run Jobs can run one-shot verifier and cleanup commands on a schedule;
- Firebase Hosting is suited to static and single-page applications;
- Artifact Registry provides digest-addressed container images;
- the serverless runtime reduces routine cluster operations.

Decisions still required:

- GCP organization/project, region, networking, DNS/TLS and service accounts;
- Cloud SQL PostgreSQL topology, connectors, backup/restore and migration operator;
- whether S3 remains the video store or a separately reviewed GCS adapter is funded;
- Cloud Run CPU/memory/ephemeral storage, concurrency, min/max instances and timeouts;
- WebSocket/Socket.IO reconnect and shared-state design;
- Cloud Scheduler cadence, retry policy and alerts;
- Firebase Hosting headers, SPA/service-worker routing and version retention;
- signing identity and verification gate.

## Owner decision record

The following fields must be completed by owners. Blank values mean no decision.

| Field                               | Required owner           | Decision |
| ----------------------------------- | ------------------------ | -------- |
| Selected option                     | Platform/DevOps          | PENDING  |
| Account/project and region          | Platform/Cloud           | PENDING  |
| Video object storage                | Cloud/Security + Backend | PENDING  |
| PostgreSQL topology                 | DBA/SRE                  | PENDING  |
| Frontend host                       | Frontend + Platform      | PENDING  |
| Registry and immutable retention    | Platform + Security      | PENDING  |
| Secret delivery and rotation        | Security                 | PENDING  |
| Signing/provenance policy           | Security + Release       | PENDING  |
| Runtime limits and worker schedules | Platform/SRE             | PENDING  |
| Realtime multi-replica policy       | Backend + Platform       | PENDING  |
| Rollback owner and rehearsal        | Release + SRE + DBA      | PENDING  |

## Authoritative capability references

- AWS scheduled ECS tasks:
  <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/tasks-scheduled-eventbridge-scheduler.html>
- AWS Fargate task definitions and image references:
  <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html>
- AWS ECS secret handling:
  <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html>
- AWS private S3 origin with CloudFront OAC:
  <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html>
- Cloud Run container deployment:
  <https://docs.cloud.google.com/run/docs/deploying>
- Cloud Run scheduled jobs:
  <https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule>
- Cloud Run health checks and WebSockets:
  <https://docs.cloud.google.com/run/docs/configuring/healthchecks>
  and <https://docs.cloud.google.com/run/docs/triggering/websockets>
- Artifact Registry image digests:
  <https://docs.cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling>
- Firebase Hosting:
  <https://firebase.google.com/docs/hosting>
