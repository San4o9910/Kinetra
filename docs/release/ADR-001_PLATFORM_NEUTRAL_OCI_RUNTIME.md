# ADR-001: Platform-neutral OCI runtime foundation

- Status: Proposed
- Decision scope: build and runtime artifact shape only
- Application commit: `c5645a3aa84bbc81e688c97731e48d978a2aeb92`
- Application tree: `4ee94cb5d334e54e5996d42caed35e0b3c776a23`
- Migration 012 SHA-256: `c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4`

## Context

Kinetra is an npm-workspace monorepo with shared, backend, and Vite frontend packages. The backend
produces several compatible Node entrypoints: a long-running API and one-shot verification,
cleanup, recovery, and migration processes. The backend does not serve the frontend build. The
repository does not select a production platform, registry, static host, scheduler, signing system,
readiness contract, or rollback artifact.

T14 adds private-S3 video upload and verification behavior. The feature is fail-closed and defaults
off. Its verifier needs `ffprobe` and writes a bounded-by-policy but potentially 2 GiB temporary
download. Existing chat-photo processing also needs ImageMagick `identify` and `convert`. The
backend depends on native `bcrypt`, so build/runtime ABI consistency matters.

## Decision

Adopt one platform-neutral, multi-stage root `Containerfile` with these artifact boundaries:

1. A builder installs the locked npm workspaces, compiles shared/backend/frontend outputs, prunes
   development dependencies, and performs JavaScript and native bcrypt checks.
2. A `frontend-files` target exports only `apps/frontend/dist` from `scratch`. It is content, not a
   web server or deployment design.
3. A common `backend-runtime` target contains the backend, production workspace dependencies,
   migrations, ffmpeg/ffprobe, ImageMagick, and tini. The API is its default command; workers and
   the migration runner use explicit command overrides from the same immutable image.

Both Linux stages use the digest-pinned Node 22.16.0 Bookworm slim base. Runtime Debian packages are
resolved from snapshot `20250611T000000Z`; ffmpeg `7:5.1.6-0+deb12u1`, ImageMagick
`8:6.9.11.60+dfsg-1.6+deb12u3`, and tini `0.19.0-1` are exact-version constrained and verified.
Repository inputs are selected with explicit `COPY` operations, and secret-like/context-only files
are excluded before the build context is sent.

The backend runs as `node` with exec-form `tini` and Node commands. The image default is
`TRAINER_VIDEO_UPLOADS_ENABLED=false`. It contains no secret and has no embedded health check.
Platform configuration must provide secrets at runtime, a writable/capacity-limited `/tmp`, and an
appropriate termination window. Migration execution remains a separate, explicitly authorized
one-shot operation.

The immutable application link is commit `c5645a3aa84bbc81e688c97731e48d978a2aeb92`, tree
`4ee94cb5d334e54e5996d42caed35e0b3c776a23`, and migration 012 checksum
`c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4`. Mandatory
`RELEASE_DEFINITION_COMMIT` and `RELEASE_DEFINITION_TREE` build arguments separately bind the
runtime image to the reviewed release definition. The release identity must come from a clean
checkout, and the application identity must not be silently rewritten.

## Rationale

- A common backend image prevents drift between API, verifier, cleanup, recovery, and migration
  code while keeping execution roles independently schedulable.
- A separate frontend filesystem avoids introducing an unreviewed web server or coupling static
  delivery to the API.
- Digest, snapshot, and exact direct-package constraints reduce mutable upstream inputs. A generated
  SBOM is still required because they do not by themselves enumerate every transitive component.
- Matching build and runtime bases plus native smoke tests reduce bcrypt ABI risk.
- Non-root execution, explicit copies, no embedded secrets, and a feature-off default make the
  artifact a safer foundation without pretending that platform controls already exist.
- Omitting `HEALTHCHECK` avoids falsely promoting the current liveness-only `/health` response to a
  dependency-aware readiness guarantee.

## Consequences

Positive consequences:

- The same digest can be selected for API and one-shot backend roles.
- PID 1 behavior and signal forwarding are explicit.
- ffprobe and ImageMagick package versions are verifiable from the built image.
- The frontend can be extracted without a runtime layer.
- The feature flag remains disabled unless a deployment explicitly enables it.

Costs and constraints:

- The backend image includes both ffmpeg and ImageMagick even when a particular role does not invoke
  both, increasing its package surface.
- Native modules require per-platform builds and tests; this ADR does not approve cross-architecture
  emulation or a multi-architecture manifest.
- The verifier's temporary-file model requires explicit disk and concurrency capacity.
- The Debian ImageMagick default policy is not a reviewed application policy and remains a release
  blocker for production media processing.
- The current API signal handling has no hard deadline, and one-shot processes rely on external
  timeout/retry behavior.
- Frontend source maps are produced by the existing Vite configuration. Whether they may be
  published is a frontend-hosting decision, not settled here.

## Deliberate non-decisions

The following remain **OPEN** and require named owners and independently reviewable evidence:

- production platform, network/topology, replica count, storage, and resource limits;
- OCI registry and immutable retention/pull policy;
- frontend host/CDN, TLS, headers, routing, caching, build-time origins, and source-map handling;
- SBOM format, provenance generator, signer identity, signature policy, and verification gate;
- verifier/cleanup/recovery scheduler cadence, concurrency, retry, timeout, alerting, and ownership;
- dependency-aware readiness endpoint and probe semantics;
- previous known-good artifacts and rollback/data-compatibility procedure;
- ImageMagick delegate/resource policy and adversarial validation;
- distributed Socket.IO/realtime state if more than one API replica is proposed;
- workload identity or another replacement for the currently required static S3 credentials.

No platform-specific deployable manifest is defined because selecting those fields without an
approved platform would invent architecture. Platform-neutral `release/templates/*.template.json`
contracts exist, but their `NON_DEPLOYABLE` status is a hard boundary rather than a deployment
claim. No previous artifact is named because no immutable predecessor was evidenced.

## Validation required before acceptance

A future acceptance record must, at minimum:

1. Build both targets from the reviewed release-foundation revision and the exact application
   identity above.
2. Verify the image digest, OCI labels, user, entrypoint, default command, feature-off default,
   package versions, ffmpeg/ffprobe, ImageMagick, and native bcrypt operation.
3. Generate and bind SBOM/provenance/signature evidence to that digest, then verify it with the
   approved policy.
4. Run Kinetra's complete test suite and platform-specific PostgreSQL 17, private S3/MinIO, Chrome,
   ffmpeg/ffprobe, ImageMagick, worker, migration, and graceful-termination acceptance checks.
5. Approve readiness, scheduler, frontend, secrets, capacity, migration, observability, and rollback
   runbooks before any production change.

This ADR and its `Containerfile` authorize no build publication, feature enablement, production
migration, deployment, traffic change, or rollback.
