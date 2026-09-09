# Single-server deployment candidate

This is a reviewable alternative to the external-database topology in [PRODUCTION_DELIVERY.md](PRODUCTION_DELIVERY.md). It does not establish a deployed service, successful infrastructure gates, backups, encryption or production readiness.

The bounded target is **one Timeweb hourly-billed VPS: 2 vCPU, 4 GB RAM, 50 GB disk, Ubuntu 24.04**, hosting the existing application and PostgreSQL **17**. Private S3 remains external. The authorized total ceiling is **2,000 RUB per month across the VPS and every paid dependency/add-on**. Before any charge, use the current quote and compute hourly charges using 744 hours (31 days), then include IPv4, S3 capacity/requests/egress, backups, snapshots and any other metered services. A low headline VPS quote does not establish the total ceiling. Set enforceable storage/usage limits where available and reserve room for metered charges; do not provision a second database server or add paid services beyond this total. This repository performs no billing or cloud actions and supplies no fabricated price.

## Files and topology

Merge `deploy/compose.single-server.yml` **after** `deploy/compose.production.yml`. Do not combine either with the root development `docker-compose.yml`.

- Frontend retains the loopback-only `127.0.0.1:8080` listener and requires the reviewed HTTPS edge and real-IP policy.
- API and jobs connect to `postgres:5432` on a separate Docker network marked `internal: true`. Only clients also join the existing network with outbound access to private S3 and authorized providers.
- PostgreSQL joins only the internal database network and publishes **no host port**. The frontend cannot join that network. Docker/root access remains privileged administration.
- A named Docker volume binds the explicit persistent host directory `KINETRA_POSTGRES_DATA_DIR`. The directory must already exist, be UID999-owned and mode0700. Never use `docker compose down -v`, a development volume, or a temporary directory as part of routine deployment.
- The official PostgreSQL image must be reviewed, use Debian bookworm, run its PostgreSQL account as UID/GID999, and be pinned by immutable digest. `POSTGRES_IMAGE` has no default. Both local validation and the startup wrapper reject a mutable or non-17 image reference; runtime startup also checks the actual server major and data version. Registry provenance/scanning still require separate evidence.

The PostgreSQL service intentionally has `restart: 'no'` during initial acceptance. A failed bootstrap preserves the data for inspection. Existing data without the bootstrap-complete marker is refused; do not delete the marker/data, reuse a partial cluster, or retry initialization to bypass a failure. The marker indicates role bootstrap only, never schema or launch readiness. Reboot/service recovery policy must be explicitly resolved after acceptance; the application alone cannot recover an intentionally stopped database.

## Host staging and resource budget

`ops/prepare-single-server.sh` defaults to dry run. Its opt-in form creates only a **new** private staging tree beneath an existing, canonical, operator-owned directory that denies group/world writes:

```sh
sh ops/prepare-single-server.sh
sh ops/prepare-single-server.sh --stage-approved /srv/kinetra-stage
```

The second command must target the specifically authorized host/path; it refuses existing destinations. It installs nothing, changes no host service/firewall, starts no container, generates no credential and runs no gate. The empty directories are not evidence of encrypted storage. Host package installation, Docker/Compose installation, ownership changes, TLS-edge setup, firewall policy and actual launch remain separately bounded operations. Use Docker Compose 2.30 or later for the base raw-format environment files.

| Process            | RAM ceiling | CPU ceiling | Other bounds                                                                             |
| ------------------ | ----------: | ----------: | ---------------------------------------------------------------------------------------- |
| PostgreSQL         |   1,152 MiB |    0.75 CPU | 32 connections, 256 MiB shared buffers, 64 MiB temporary SQL files per process, 128 PIDs |
| API                |     768 MiB |    0.75 CPU | 256 MiB Node heap, existing 256 MiB tmpfs, 128 PIDs                                      |
| Frontend           |     128 MiB |    0.10 CPU | Existing 64 MiB tmpfs, 32 PIDs                                                           |
| One ordinary job   |     512 MiB |    0.40 CPU | 128 MiB Node heap, existing 256 MiB tmpfs, 96 PIDs                                       |
| One video verifier |     768 MiB |    0.40 CPU | Separate encrypted scratch, 128 PIDs                                                     |

Run **at most one scheduled job at a time**, including backups/migrations as maintenance work. No scheduler or global job lock is installed here. With the largest job, container ceilings total 2,816 MiB, leaving approximately 1.25 GiB of a 4 GiB host for Ubuntu, Docker, the HTTPS edge and headroom. If the advertised memory is decimal GB, actual headroom is smaller. No container may use additional swap (`memswap_limit` equals `mem_limit`). Validate memory and latency with the real candidate and approved load before changing capacity or enabling traffic. Do image builds and heavy scans off this small server, within separately authorized infrastructure and budget.

Each container retains at most three nominal 10 MiB Docker local log segments; one-shot jobs must be removed after their reviewed run. PostgreSQL disables SQL/parameter/connection logging. Its WAL target is 1 GiB, replication slots are disabled, temporary query files are limited to 64 MiB per process, and working memory is bounded. **`max_wal_size` is a soft target; a Compose local volume has no hard data-size quota.** Database tables, images, retained stopped containers and host logs can fill the disk. These files do not claim a 50 GB disk quota exists.

An initial operational allocation within the included disk is up to 20 GiB for PostgreSQL, 10 GiB for OS/images, at least 3 GiB for one encrypted media scratch worker, with the remaining space reserved for WAL variation/maintenance/headroom. Confirm actual free bytes; provider GB and GiB differ. Before admitting traffic, configure host filesystem quotas or equivalent admission controls, image/log retention, free-space alerts and a documented write-stop response that preserves data before exhaustion. Do not place an unbounded database dump beside the live database. No quota, monitoring agent, prune job or filesystem encryption is created by this overlay.

## TLS and distinct credentials

All API/job database URLs must use the matching role and exactly the host/database/query below, with that role's real password supplied through its existing private environment file:

`postgresql://<dedicated_role>:<percent_encoded_secret>@postgres:5432/kinetra?sslmode=verify-full`

The angle-bracket fields are explanatory syntax and are not deployable values. Do not add `sslrootcert` to this URL: existing runtime/production validators deliberately allow only their reviewed parameters. The overlay instead mounts the **public CA certificate only** at `/run/kinetra/postgres-ca.crt` and supplies `NODE_EXTRA_CA_CERTS` before Node starts. No app/job receives the CA private key or PostgreSQL server key. The installed `pg-connection-string` code retains Node's certificate and hostname verification for `verify-full`; no `NODE_TLS_REJECT_UNAUTHORIZED=0`, insecure mode, hostname override or trust bypass is introduced. The extra private CA becomes trusted by that Node process, so protect its signing key independently and use it exclusively for this database.

Use a real CA-signed server certificate with the explicit SAN `DNS:postgres`, EKU `serverAuth`, a matching server private key, and a valid rotation window. To create a new private CA and leaf locally on an already authorized machine with OpenSSL installed:

```sh
sh deploy/postgres/issue-server-certificate.sh
sh deploy/postgres/issue-server-certificate.sh --issue-approved-certificate /srv/kinetra-stage/tls/issued
```

The helper only creates new files in that new private directory and preserves partial output on failure. It verifies the local signature and hostname; this is not a live database TLS gate. Public certificates become mode0644. Keep `ca-private/ca.key` outside all container mounts and protect its recovery/rotation copy independently. Install only the leaf key as UID999 mode0600 at the exact path in `KINETRA_POSTGRES_KEY_FILE`; install the public CA/leaf certificates at their public metadata paths. Only narrowly scoped ownership changes on these exact approved files and the PostgreSQL data directory are needed. Do not recursively chown the repository or environment-secret tree. Record fingerprints and renewal dates; no renewal scheduler is installed.

Create eight independently random **base64url** passwords, each containing at least 32 random bytes (43–128 encoded characters). The files below contain the password alone, optionally one final newline, and must be UID999 mode0600 in `KINETRA_POSTGRES_SECRETS_DIR`. Use a secret manager or a bounded local generator whose output is written directly to restricted files; never pass plaintext passwords in shell arguments, logs or chat.

| Password filename        | Database identity       | Credential consumer                                    |
| ------------------------ | ----------------------- | ------------------------------------------------------ |
| `bootstrap_password`     | `kinetra_bootstrap`     | PostgreSQL initialization only; network login denied   |
| `migrate_password`       | `kinetra_migrate`       | Migration environment only; database/schema owner      |
| `api_password`           | `kinetra_api`           | API environment only; runtime DML, no schema ownership |
| `notifications_password` | `kinetra_notifications` | Notification job environment only                      |
| `renewals_password`      | `kinetra_renewals`      | Renewal job environment only                           |
| `chat_cleanup_password`  | `kinetra_chat_cleanup`  | Chat cleanup job environment only                      |
| `video_cleanup_password` | `kinetra_video_cleanup` | Video cleanup job environment only                     |
| `video_verify_password`  | `kinetra_video_verify`  | Video verifier job environment only                    |

Compose file-backed secret mounts retain host UID/mode; Compose's secret `uid`/`mode` declarations would not repair incorrectly owned files. The entrypoint runs role creation locally as the OS PostgreSQL user through an explicit peer map. Remote database connections require TLS plus SCRAM, only the named roles and database are allowed, and the bootstrap superuser has no matching network rule. PostgreSQL administrators/root can still see mounted database secrets and process environments.

Role creation is transactional and initializes no application tables. Run the existing migration runner with the dedicated migration identity. After verifying the complete immutable migration ledger, explicitly apply `deploy/postgres/runtime-grants.sql` as the migration owner and verify actual privileges. This post-migration script must not be moved into `initdb`: the tables do not exist at bootstrap. It grants API table DML/sequence usage and explicitly removes access to the migration ledger. Worker grants are restricted to current required tables and trigger side effects; they receive no schema-create, superuser, role-management or sequence privileges. Review and update these grants with future migrations; there are no automatic default DML grants. Reviewer CLI authority and production administration remain separately scoped operations.

## Local validation and execution boundary

Populate an external `single-server.env` from `deploy/postgres/single-server.env.example`. Its six public keys are separate from the existing `production.env`, because the existing production validator rejects extra keys. Keep API/job secret environment files mode0600 and independently scoped as before. Do not put the single-server metadata into service `env_file` or add CA-related keys to the strict API/job environment templates.

```sh
node deploy/postgres/validate-single-server.mjs /srv/kinetra-stage/env/single-server.env /srv/kinetra-stage/env/production.env
node deploy/postgres/validate-single-server.mjs /srv/kinetra-stage/env/single-server.env /srv/kinetra-stage/env/production.env migrate /srv/kinetra-stage/env/jobs/migrate.env
```

The validator runs locally without connecting to any service. It composes existing production validation with the image/ownership/secret-separation/URL contract, certificate lifetime, CA signature, exact SAN/EKU and key match. It does not prove entropy, registry provenance, TLS negotiation, network isolation, schema readiness, quota, encryption, backups or provider correctness. Run it from a privileged approved operator context able to read the UID999 files; do not loosen permissions to satisfy validation. Generic failure messages intentionally suppress credentials.

Actual Compose operations must explicitly pass **both** metadata files and **both** Compose files, in this order:

```sh
docker compose --env-file /srv/kinetra-stage/env/production.env \
  --env-file /srv/kinetra-stage/env/single-server.env \
  -f deploy/compose.production.yml -f deploy/compose.single-server.yml config --quiet
```

`config --quiet` validates Compose rendering and must not be described as a service gate. Environment values take precedence over `--env-file`; the job wrapper clears inherited base/overlay metadata, the selected job-file override and Compose project/file/profile/environment/compatibility/orphan settings. Apply the same controls to any separate deployment command. Avoid printing `docker compose config` output because resolved service environments contain secrets.

`ops/run-production-job.sh` accepts an optional **fifth argument** containing the absolute `single-server.env` path. Its original four-argument form retains external PostgreSQL behavior and the existing strict production/job validation. The fifth argument selects the single-server validator, which also runs existing production/job validation, then supplies both metadata files and both Compose files in the required order. Validation failure exits before Docker is invoked; the wrapper does not infer topology from inherited environment variables.

```sh
sh ops/run-production-job.sh
sh ops/run-production-job.sh --execute-approved-job \
  /srv/kinetra-stage/env/production.env migrate \
  /srv/kinetra-stage/env/jobs/migrate.env \
  /srv/kinetra-stage/env/single-server.env
```

The second command executes a real authorized migration job; it is not a dry run or local check. Replace `migrate` and its environment-file path only with the specific approved job and matching private environment. The wrapper sets `KINETRA_JOB_ENV_FILE` from that explicit argument and always uses `--profile jobs run --rm --no-deps`, so it neither starts PostgreSQL nor other dependency services. An approved scheduler/operator must still enforce one job globally and the external execution deadline; this wrapper installs neither. Do not start all job services with `up`; do not use migration credentials in the API or give a worker the API environment.

The bounded launch sequence is: validate staged files and actual budget → bring up only PostgreSQL once → verify the approved PostgreSQL 17/TLS evidence → run reviewed migrations once → verify ledger/checksums and apply/verify runtime grants → satisfy required S3 and browser gates for the exact candidate → admit traffic through the reviewed HTTPS edge. The bootstrap healthcheck only detects the final TCP server accepting connections; it is not the PostgreSQL integration gate. No automatic retry is authorized by this sequence. Real notifications, renewals, auth deliveries and payment effects require their existing explicit scope.

## Backup, media and remaining launch requirements

This low-cost topology has **one application/database failure domain**. A local volume is not a backup and provides no managed PITR. [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) still applies, but managed-database PITR is not silently supplied by this overlay. Choose an affordable approved RPO/RTO, encrypted off-host exports, retention and independent recovery-key access, then prove an isolated restore. Existing backup helpers require PostgreSQL17 clients and `sslmode=verify-full`; the host has no published PostgreSQL port. Supply a reviewed backup execution path within the private network plus its own read-only database role/credentials and libpq CA service configuration before using those helpers. No backup identity, network tunnel, automated export, WAL archive, retention deletion or restore is configured here. Do not expose port5432 or reuse the bootstrap/migration identity merely to make a backup command connect.

External private S3 still requires the real approved region/bucket, least-privilege identities, encryption, versioning/VersionId continuity and measured usage within budget. The overlay creates no object-storage emulator or substitute. Existing T14 trainer verification still requires a **dedicated encrypted filesystem**, UID1000/mode0700, appropriate mount controls and at least **3 GiB free per sequential worker**. The inherited verifier bind remains fail-closed when the path is missing; merely creating the staging directory cannot satisfy encryption evidence. Keep affected feature flags false until actual dependencies, worker freshness and scratch evidence are accepted. **T15 chat video attachments remain excluded.**

A red or skipped required PostgreSQL17, S3 or browser gate means **STOP, without retry** under the current project mandate. Do not relabel a local parser, healthcheck, TLS-file inspection or empty staging tree as one of those gates. Live gates, deployment, DNS/TLS edge, scheduler, monitoring, encrypted scratch, off-host backups/restore evidence and final readiness remain unproven until their real results are recorded.
