# Kinetra release architecture foundation

Status: implementation foundation only; not an authorization to release or deploy.

## Immutable application source

This foundation packages the application state merged by T14. The application identity is:

- Git commit: `c5645a3aa84bbc81e688c97731e48d978a2aeb92`
- Git tree: `4ee94cb5d334e54e5996d42caed35e0b3c776a23`
- Migration: `apps/backend/migrations/012_video_uploads.sql`
- Migration SHA-256: `c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4`

The release-foundation files added after that merge are packaging metadata, not a claim that a
production artifact already exists. A release process must record both the release-foundation
revision and the immutable application identity above.

## OCI build contract

The root `Containerfile` deliberately exposes two targets:

| Target            | Purpose                                                                                     | Default process                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `backend-runtime` | One common image for the API, T14 verification/cleanup workers, and explicit migration jobs | `node apps/backend/dist/server.js` |
| `frontend-files`  | Export-only `scratch` filesystem containing `apps/frontend/dist`                            | None                               |

The backend target is the final/default target. Worker and migration executions override `CMD`
without changing `ENTRYPOINT`:

```text
node apps/backend/dist/video-admin/run-upload-worker.js
node apps/backend/dist/video-admin/run-media-cleanup.js
node apps/backend/dist/video-admin/upload-recovery-cli.js retry
node apps/backend/scripts/migrate.mjs
```

The migration command is an explicit, one-shot release operation. It must never be coupled to API
startup. The existing runner uses a PostgreSQL advisory lock, per-file checksums, and transactions,
but production still has to supply an explicit `DATABASE_URL`; its localhost fallback is unsuitable
for a release.

Example local build shapes (these commands do not publish anything):

```text
docker build --file Containerfile --target backend-runtime --build-arg RELEASE_DEFINITION_COMMIT=<exact-release-commit> --build-arg RELEASE_DEFINITION_TREE=<exact-release-tree> --tag kinetra:local .
docker build --file Containerfile --target frontend-files --output type=local,dest=./frontend-export .
```

`RELEASE_DEFINITION_COMMIT` and `RELEASE_DEFINITION_TREE` are mandatory 40-character lowercase Git
object IDs for the reviewed revision that contains this release definition. They are recorded in
the runtime image alongside the distinct, fixed T14 application source identity. A workflow must
derive them from its clean checkout; a caller must not provide claimed values without verifying the
checkout.

`DEBIAN_SNAPSHOT` is an internal build assertion fixed to `20250611T000000Z`; overriding it with
another value fails the build rather than selecting a mutable package source.

The following optional build arguments are public values compiled into the browser bundle:

```text
VITE_API_URL
VITE_PRIVATE_MEDIA_ORIGIN
VITE_APP_VERSION
VITE_PRIVACY_URL
VITE_SUPPORT_EMAIL
```

No secret may be passed as a build argument. Production frontend origins must be selected only
after the serving topology is approved. The blank defaults are useful for a structural build but
are not an approval of any production routing topology.

## Reproducible runtime inputs

- Node image: `node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34`
- Node: `v22.16.0`
- npm: `10.9.2`
- npm lockfile: root lockfile v3, installed with `npm ci`
- Debian snapshot: `20250611T000000Z`
- ffmpeg package: `7:5.1.6-0+deb12u1` (also provides `ffprobe`)
- ImageMagick package: `8:6.9.11.60+dfsg-1.6+deb12u3`
- tini package: `0.19.0-1`

The build and runtime stages use the same pinned Debian/Node base so the native `bcrypt` module is
not copied across incompatible libc or architecture boundaries. The build deliberately does not
use `npm ci --ignore-scripts`; native install scripts remain enabled and a bcrypt ABI smoke check
runs in both stages. Direct media/init packages are exact-version constrained, their versions are
checked with `dpkg-query`, and transitive Debian packages are resolved only from the immutable
snapshot. `ca-certificates` is inherited from the digest-pinned Node base, is asserted present, and
is deliberately not reinstalled from apt. The final image's SBOM must capture every resolved
transitive and inherited version, including `ca-certificates`.

## Runtime security contract

- The final process runs as the image's unprivileged `node` user.
- `/usr/bin/tini --` is the exec-form entrypoint and forwards signals to the selected Node process.
- `TRAINER_VIDEO_UPLOADS_ENABLED=false` is the image default. Enabling T14 is a separate deployment
  decision and requires its database, private S3, worker, ffprobe, and cleanup prerequisites.
- No `.env`, credential file, VCS state, test fixture, or arbitrary repository directory is copied.
- Runtime files are selected by explicit `COPY` instructions; the frontend output is not present in
  `backend-runtime`.
- Runtime secrets are injected by the eventual platform. At minimum these include database, JWT,
  private S3, YooKassa, and VAPID secrets. The current S3 implementation requires explicit access
  and secret keys; workload-identity support is not claimed.
- The API can run with a read-only root filesystem, but `/tmp` must be writable and externally
  bounded. Each active verifier may download an entire accepted video, currently up to 2 GiB, to a
  temporary file. Capacity and concurrency limits are platform responsibilities.
- The image intentionally has no Dockerfile `HEALTHCHECK`. `/health` is liveness-only and does not
  test PostgreSQL, S3, ffprobe, ImageMagick, or worker freshness, so treating it as readiness would
  be unsafe.
- The API has SIGINT/SIGTERM cleanup. One-shot workers and migrations rely on the external runtime's
  termination and retry policy; a hard shutdown deadline is not currently implemented.

ImageMagick is installed because the existing chat-photo path invokes `identify` and `convert`.
The Debian default policy is not represented here as a reviewed Kinetra policy. A production owner
must review and test delegate, codec, memory, disk, pixel, and timeout restrictions before approving
the image for production media processing.

The repository API does not serve `apps/frontend/dist`. `vite preview` is a development preview,
not a production web server. The frontend target therefore exports files only and makes no claim
about TLS, caching, CSP/header delivery, service-worker routing, or source-map exposure.

## Open decisions and release gates

These items are intentionally unresolved; this document does not infer a runtime architecture that
the repository does not define.

| Decision / gate               | Current status     | Required evidence before production                                                                                                         |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform and topology         | **OPEN**           | Named owner; API, worker, database, object storage, network, tmpfs, scaling, and termination design                                         |
| OCI registry/repository       | **OPEN**           | Approved registry, immutable digest retention, access policy, and pull path                                                                 |
| Frontend serving              | **OPEN**           | Approved static host/CDN, TLS, security headers, SPA/service-worker routing, cache invalidation, public build values, and source-map policy |
| SBOM, provenance, and signing | **OPEN**           | Selected formats/tools, trusted identity, verifier policy, transparency/log policy, and evidence linked to the final image digest           |
| Worker scheduler              | **OPEN**           | Cadence, singleton/concurrency rules, timeout, retry/dead-letter, alerts, and ownership for verifier, cleanup, and recovery jobs            |
| Readiness                     | **OPEN**           | A dependency-aware readiness contract and platform probe; `/health` may be used only for liveness                                           |
| Rollback                      | **OPEN**           | Known-good previous image/frontend digests, database compatibility analysis, traffic procedure, and operator rehearsal                      |
| Migration 012 production run  | **NOT AUTHORIZED** | Database backup/restore evidence, exact checksum verification, approved maintenance/runbook, and explicit operator approval                 |
| ImageMagick policy            | **OPEN**           | Reviewed least-privilege policy plus adversarial chat-photo tests                                                                           |
| Horizontal API scaling        | **OPEN**           | Socket.IO/event distribution design; the current in-memory realtime path does not establish multi-replica safety                            |

The platform-neutral `release/templates/*.template.json` files are explicitly `NON_DEPLOYABLE`
contracts. They do not select a platform or constitute deployable manifests. Until the open gates
are closed, there is no approved platform, registry artifact, platform-specific production
deployment manifest, previous rollback artifact, signing identity, scheduler, readiness probe, or
frontend publication path.

## Explicit non-actions

The checked-in release-foundation source set and its guarded manual workflow do **not** authorize
or perform any persistent artifact publication or production mutation. The workflow may build and
inspect an image inside one CI runner, but its image archive and metadata files remain runner-local
and are removed before the job ends. Only ordinary GitHub job logs and the step summary remain
subject to the repository's CI retention policy.

In particular, this foundation does **not**:

- push, sign, attest, upload, or publish an image, frontend bundle, SBOM, or metadata artifact;
- create a registry, release, deployment, environment, scheduler, or secret;
- enable `TRAINER_VIDEO_UPLOADS_ENABLED`;
- run migration 012 against any database;
- perform a production deployment, traffic change, or rollback;
- claim that a production image passed platform-specific security or acceptance testing.

The manual workflow validates and packages these targets only in ephemeral runner storage.
Publication and deployment remain separately authorized, auditable actions bound to exact artifact
digests.
