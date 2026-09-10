# Production delivery candidate

Status: repository foundation, not a deployed or production-qualified system. No cloud resources, credentials, schedules, DNS, payments or user messages were changed. Local configuration validation is not an infrastructure gate. See the final change report for actual test evidence.

## Architecture and boundaries

TLS edge → loopback-only Nginx `127.0.0.1:8080` → API on private Docker network → external PostgreSQL **17**, private S3, authorized delivery/payment/push providers. The network permits outbound traffic because these dependencies are external; an approved firewall must restrict egress. Database and object storage are not created by this Compose file.

The frontend is static. Its API and private media origins are fixed during the image build; changing runtime environment variables cannot update those origins. Publish a fresh frontend image if origins change. Both images carry the reviewed full commit label.

`/health` means the process is alive. Internal `/ready` means the process is accepting traffic and a bounded database connectivity probe succeeded. It does **not** check schema compatibility, provider delivery, S3, worker freshness or correctness of migrations. Verify the full migration ledger and immutable SQL checksums against the candidate **before admitting traffic**. Nginx does not expose `/ready` publicly.

## Images and build contract

Use the reviewed official Node 22 Alpine 3.24 image as the base for both application build and backend runtime, replace its Node executable with the authenticated shared-OpenSSL build described below, and `nginxinc/nginx-unprivileged:1.30.4-alpine-slim` (Alpine 3.24, UID/GID 101). Matching the Node build/runtime musl ABI preserves native modules such as bcrypt. The frontend needs only nginx core modules; the slim image omits unused image-filter, XSLT, GeoIP and njs dependencies. Resolve their immutable digests from the chosen registry and record provenance. `NODE_IMAGE` and `NGINX_IMAGE` must contain `@sha256:` plus 64 hex digits; templates intentionally have invalid placeholders. No digest or current vulnerability status is invented here.

The backend final image removes npm, npx, Corepack and Yarn programs and their vendored dependencies. They remain available in the build stage; production API and job entrypoints run Node directly. This removes unused runtime software, not scanner metadata. Preserve OS and language package inventory, HIGH/CRITICAL vulnerability and secret scanning, and all image smoke assertions. The 2026-09-09 Debian image scan found additional OS/media vulnerabilities; package-manager removal alone does not qualify the backend for deployment.

The backend runtime explicitly requires `libcrypto3>=3.5.8-r0` and `libssl3>=3.5.8-r0` from Alpine 3.24. The image qualification run [34439133755](https://github.com/san4o9910/Kinetra/actions/runs/34439133755) found CVE-2026-14456 in the pinned base's older `3.5.7-r0` libraries; adding unrelated APK packages retained those installed versions. Alpine's [security database](https://secdb.alpinelinux.org/v3.24/main.json) and [OpenSSL package recipe](https://github.com/alpinelinux/aports/blob/3.24-stable/main/openssl/APKBUILD) identify `3.5.8-r0` as the fixed release. These minimum constraints update the actual libraries and fail the build if no satisfying package is available. The resulting image still requires the full inventory, runtime and vulnerability gates before deployment.

Node **22.23.2** embeds OpenSSL **3.5.7**, so updating Alpine libraries alone does not replace the copy in the original Node executable. The [official OpenSSL advisory](https://openssl-library.org/news/secadv/20260813.txt) describes a QUIC server queue issue; application exploitability has not been demonstrated, and no exception or suppression is used. The separate `node-build` stage compiles the same authenticated official Node release with its supported `--shared-openssl` option against Alpine `openssl-dev>=3.5.8-r0`. Application build and backend runtime receive that same executable; Node major version, musl ABI and UID remain unchanged. Runtime package managers are still removed.

`deploy/node` pins the official source archive, signed release checksums and public release key. The final image retains its public source/signature/build evidence under `/usr/share/kinetra-node`. Actual final-image checks require Node22.23.2, `node_shared_openssl=true`, OpenSSL3.5.x with patch>=8, matching executable SHA256 and resolved dynamic links to both `libssl.so.3` and `libcrypto.so.3`. These assertions prevent a clean APK scan from hiding the old bundled OpenSSL copy. Building and qualifying this executable remain required execution gates; the recipe alone is not deployment evidence.

The separate media build stage compiles FFmpeg **9.0.1** and ImageMagick **7.1.2-30** from the official signed release archives. `deploy/media/sources.json` pins each exact HTTPS URL, archive SHA256, public-key SHA256 and primary signing fingerprint. Both hash and detached-signature verification are mandatory on each build. ImageMagick's Git tag is unsigned, and its GitHub release asset differs from the official download archive; neither substitutes for the pinned archive/signature pair. Public release keys in the build context are public verification material, not credentials.

FFmpeg retains its internal demuxers/decoders, `ffmpeg`, `ffprobe`, lavfi and libx264 encoding; network protocols and unused autodetected external libraries are excluded. ImageMagick retains JPEG, PNG and WebP delegates and its `identify`/`convert` interfaces; unused XML, X11, Perl and additional external delegates are excluded. Their actual binaries and shared libraries are installed as locally signed APKv3 packages with file checksums, ownership, source origin and measured SONAME dependencies. The temporary APK private signing key stays in the build stage and is removed after packaging. This local package signature authenticates build output; it is distinct from upstream release signatures and release provenance.

The final image retains `/usr/share/kinetra-media/source-builds.json`, `source-components.cdx.json`, signature statuses, build flags, source hashes, measured executable hashes, public keys, licenses, the real APK database and separate builder/runtime APK inventories. The source CycloneDX inventory identifies both upstream applications by version, generic PURL and CPE. It **supplements** the full image SBOM: scan these upstream identities with a compatible vulnerability matcher and retain that report in addition to the unchanged OS/language/secret image scans. A clean Alpine vendor-feed result alone cannot establish coverage for locally built upstream software. Missing source components, unmatched coverage, scanner errors or HIGH/CRITICAL findings leave the candidate unqualified. No finding suppression or `ignore-unfixed` is permitted.

The release must exercise real JPEG/PNG/WebP normalization and malformed/animated rejection, MP4 H264/AAC verification, bcrypt, shared imports and the existing libx264/color/identify/convert image smokes under UID 1000 with read-only filesystem, dropped capabilities and no-new-privileges. Source fix review is supporting evidence; it does not replace these checks or the PostgreSQL 17/browser gates. FFmpeg with libx264 is GPL-2.0-or-later; retain upstream license notices and provide the corresponding source and exact build recipe with any redistribution of the image.

Use Docker BuildKit with `-f deploy/Containerfile` and the repository root as context. Its matching `deploy/Containerfile.dockerignore` allows only application source, manifests, the Node/media build recipes and public release keys, and Nginx configuration. Do not replace this with a generic `COPY . .`. Runtime secrets never belong in build arguments, source files, build logs or the frontend.

Authorized release operators build the `backend` and `frontend` targets with public build arguments `NODE_IMAGE`, `NGINX_IMAGE`, `VCS_REF`, `VITE_API_URL`, `VITE_PRIVATE_MEDIA_ORIGIN`. Then scan the actual final images, produce an SBOM and provenance, test runtime libraries and record **final image** digests. The two upstream media sources are pinned separately. Alpine repository packages installed during a build are recorded but are not individually pinned by this candidate; that build must be reviewed/scanned and subsequent deploys use its immutable final digest. Base pinning alone does not make rebuilt APK dependencies reproducible.

Backend runtime is UID 1000 and includes CA roots, `ffmpeg`, `ffprobe`, ImageMagick `identify`/`convert` and `tini`. It contains compiled server/shared code and the migration runner/SQL. Frontend runtime is UID 101. Both use read-only filesystems, dropped capabilities and no-new-privileges. Containers have bounded writable temporary storage. Existing trainer video verification needs a separate dedicated encrypted disk mount, described below.

## Configuration

Require Docker Compose **2.30 or later**, including raw-format service environment files. Copy these examples to approved **absolute paths outside Git**, mode 0600 for files with secrets:

| File                                    | Purpose                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `deploy/production.env.example`         | Public image digests, commit, public origins, absolute file/mount paths |
| `deploy/api.env.example`                | API database/JWT/provider credentials and flags                         |
| `deploy/jobs/migrate.env.example`       | Migration database credentials only                                     |
| `deploy/jobs/notifications.env.example` | Notification database role and VAPID only                               |
| `deploy/jobs/renewals.env.example`      | Renewal database role and YooKassa only                                 |
| `deploy/jobs/chat-cleanup.env.example`  | Chat cleanup database role and private S3 only                          |
| `deploy/jobs/video-cleanup.env.example` | Video cleanup database role and private S3 only                         |
| `deploy/jobs/video-verify.env.example`  | Verification database role, private S3 and verifier settings only       |

Use raw `KEY=VALUE` lines, no shell interpolation, quotes, inline comments or multiline values. Percent-encode reserved characters in database URL credentials. Supply credentials through an approved secret manager materializing restricted files; do not paste them into shell commands. Environment variables are visible to privileged Docker administrators; this is not a secret-manager implementation.

Read-only local validation (no network calls):

```sh
node ops/validate-production-env.mjs /absolute/approved/production.env
node ops/validate-production-env.mjs /absolute/approved/production.env notifications /absolute/approved/notifications.env
```

Validation rejects placeholders, unexpected worker credentials, insecure database/provider URLs and incompatible shutdown bounds. Runtime parsers provide further checks. The validator cannot establish that a host, bucket, IAM role or TLS certificate is correct, that key material belongs together, or that permissions are minimal. Those remain deployment checks.

API `SHUTDOWN_TIMEOUT_MS` must be at most 30000 for Compose's 35-second grace; `SHUTDOWN_DRAIN_MS` must be lower. New readiness probes fail when draining begins. Existing requests have a bounded opportunity to finish; hard deadlines still terminate hung work. Exercise this with real load on isolated staging before launch.

Keep all production feature flags false until separately approved. Do not start `renewals`, `notifications` or the delivery webhook with real recipient/payment credentials during verification. Photos require private S3 and the chat cleanup worker. Any configured private media requires the exact matching `VITE_PRIVATE_MEDIA_ORIGIN`; use no wildcard/public bucket. Chat video attachments are excluded and require separate T15.

## Edge and privacy requirements

Nginx overwrites `X-Forwarded-For` with the immediate peer and declares HTTPS because it is reachable only through the TLS edge. API trusts exactly one Nginx proxy. **Before launch, configure a reviewed real-IP policy with exact edge CIDRs or equivalent authenticated edge behavior.** Without it, many users share the edge IP for rate limits and payment source-IP checks. Never solve this by trusting arbitrary forwarded headers or exposing the upstream port publicly. Also verify origin routing, certificate renewal, HSTS at the actual HTTPS edge and WebSocket upgrades.

HTTP access logs contain only method, status, byte count and duration. No URL/query, IP, cookie, referrer or user-agent is logged. Nginx error logging is restricted to critical events; platform logging and application errors still require a redaction audit. Static HTML/service worker revalidate, hashed assets cache for one year; unknown asset paths return 404 rather than HTML. The HTTP CSP limits active content, while the build-generated CSP restricts exact private image/media origins. Validate the **combined** headers and CSP on the deployed build.

## Jobs and video scratch

The job wrapper defaults to dry run and accepts only the six fixed job names. A future explicitly authorized operator supplies `--execute-approved-job`, public metadata, job name and the specific worker environment file. It does not echo secrets and does not start dependency services. Migration, notification, renewal and cleanup execution is an external action and is not implied by reading this runbook.

Do not give workers API JWT, auth delivery or unrelated provider secrets. The DB role and S3 policy must be restricted for each purpose; the examples do not provision grants. Use one approved scheduler with no overlapping instances and external duration/success alerts. None is installed here. Observe existing worker lease/heartbeat contracts before enabling dependent flags.

`video-verify` processes existing T14 trainer uploads, not chat video. It downloads an entire upload for verification (default maximum 2 GiB). Provision at least **3 GiB free per sequential worker**, plus capacity based on measured concurrency, on a dedicated encrypted filesystem mounted to `/video-scratch`; `TMPDIR` points there. Pre-create the host directory UID 1000, mode 0700; Compose refuses to create a missing host path. Encryption and capacity require operator evidence: file permissions cannot prove them. Mount with appropriate `nodev,nosuid,noexec` controls at the host. Do not use the API's 256 MiB tmpfs for video downloads. Configure orphan scratch cleanup after crashes only with a separate bounded maintenance procedure that protects active jobs. The example limits verifier deadline to 900 seconds and uses 950 seconds stop grace.

## Unfinished launch evidence

Cloud/provider choice, regional privacy requirements, IAM, TLS trust chain, edge real-IP contract, image build/scans/signing, running migrations ledger, secrets rotation, jobs schedule/alerts, email/SMS delivery, S3 versioning/encryption/private access, backup offsite retention, restore drill, measured RPO/RTO and on-call ownership all require evidence. This document does not declare them complete.

Primary references checked during preparation: [Docker build context and Dockerfile-specific ignore files](https://docs.docker.com/build/concepts/context/), [Compose env_file raw format](https://docs.docker.com/reference/compose-file/services/#env_file), [Nginx proxy request buffering and forwarded headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
