# Backup and disaster recovery candidate

No backup, restore, failover, retention policy, encryption key or offsite copy was executed or configured by this change. Scripts default to dry run. A valid archive and checksum do not prove that Kinetra can recover; a verified isolated restore with application/media checks is required.

## Recoverable state and decisions

| State                                                                               | Criticality                     | Proposed protection                                                               | Evidence still required                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| PostgreSQL: users, workout completion, roles, payments, chat/media metadata, leases | Must recover                    | Provider PITR plus encrypted independent exports                                  | Provider, retention, source privilege, off-account access, actual restore      |
| Private S3 photos and existing trainer video object versions                        | Must recover with DB references | Private versioned encrypted storage and separately approved replication/retention | VersionId continuity, tombstone/deletion policy, KMS access, regional recovery |
| Secrets and keys                                                                    | Must recover securely           | Approved secret-manager recovery and break-glass process                          | Recovery holder, IAM/KMS separation, rotation and access drill                 |
| Code, image digests and schema checksums                                            | Must recover                    | Git history plus approved registry provenance and immutable image retention       | Off-provider recovery path, signed build artifacts                             |
| Monitoring/scheduler/configuration                                                  | Should recover                  | Versioned configuration and separately protected provider settings                | Actual exporters, schedule, routing and ownership                              |
| Temporary verification files                                                        | Rebuildable                     | Re-fetch original version from private S3                                         | Safe crash cleanup; original object must remain recoverable                    |

Owner must choose acceptable data loss (RPO), downtime (RTO), cost, regions and retention for the first three rows. These values are **not established**. A daily dump can lose up to a day of writes and cannot replace a shorter approved RPO; PITR and independently protected copies may be necessary. Retention must also account for deletion/privacy obligations, rather than preserving personal data indefinitely.

Consider host failure, regional/provider loss, bad migration, accidental deletion, compromised account, corrupt data and lost KMS access. A backup in the same account or on the same disk does not cover these scenarios. Versioning alone is not a second backup, and a database snapshot cannot restore missing S3 versions.

## PostgreSQL export helper

`ops/backup-postgres.sh` is a Linux operator helper requiring PostgreSQL 17 `pg_dump` and `psql`, coreutils (`stat`, `timeout`, `sha256sum`, `mktemp`) and util-linux `flock`. Without the named execution arguments it prints a dry-run message and opens no database connection.

A separately authorized operator must:

1. Approve the exact source/account, source read privileges, backup destination, time window and data handling. Use a dedicated `PGSERVICE` entry in an absolute mode0600 `PGSERVICEFILE`, with an approved TLS trust chain; use an absolute mode0600 `PGPASSFILE` if needed. Do not put credentials in shell arguments or this repository.
2. Provision an encrypted destination directory, owned by the operator and mode0700. After verifying actual encryption/key recovery, record the `.kinetra-encrypted-backup-approved` marker and set `KINETRA_BACKUP_APPROVED=yes`. The marker is an attestation; the script **cannot prove encryption**.
3. Run the approved source export with `--execute-approved-backup` and the approved absolute directory. The helper forces `sslmode=verify-full`, checks server/client major 17, disables password prompting, locks the export and bounds it to two hours. It writes a custom-format dump, checksum and timestamp to a temporary private directory, then publishes that directory atomically on the same volume. Partial temporary output is removed after failure.
4. Copy the successful archive to the approved encrypted independent storage. This helper performs no upload, schedule, retention deletion or key management. Verify the offsite copy and record its integrity and access controls.

The export contains sensitive data. Restrict operator/log access; do not share it in chat. A custom-format dump does not include cluster roles and global grants: recover those from separately approved infrastructure configuration. Do not assume it contains provider settings, secrets or S3 media.

## Isolated restore drill

`ops/restore-drill-postgres.sh` takes an approved archive directory and an **existing, empty** target database named `kinetra_restore_*`. It never creates/drops a database or uses `--clean`. It requires exact `KINETRA_RESTORE_APPROVED=<target name>` and `KINETRA_RESTORE_TARGET_CLASS=isolated-nonproduction`. These labels and naming checks cannot prove isolation. Before running it, the operator must verify a separate nonproduction account/host, firewall and credentials **unable to access production**, plus sufficient encrypted storage.

Use a dedicated nonproduction `PGSERVICE`/`PGSERVICEFILE`; the helper overrides the database name and TLS mode. It verifies the exact checksum filename, archive catalog, client/server major 17 and absence of user tables/functions/types/collations/custom schemas/foreign servers/extensions/publications/event triggers/large objects. It takes a local archive/target lock. This lock does not coordinate separate archives or hosts: the operator must provide exclusive target ownership and a nonoverlapping scheduler. The restore is a single transaction, stops on error and has a six-hour process limit. No application, workers or external integration may point at the target during the drill.

Only restore archives from the approved trusted source. PostgreSQL restores can execute SQL from that source; checksum integrity does not make an untrusted archive safe. Restored personal data needs production-grade access restrictions and an approved deletion plan even in the isolated environment.

After the helper reports restoration, the drill is **not yet PASS**. Verify all migration names/checksums, row-count/integrity samples, login/session behavior, role restrictions, accepted-workout history, payment idempotency state and chat ownership. Check private S3 VersionId references and deletion records against the matching recovery point. Keep real payments, messages, notifications and production feature flags disabled. Run only separately authorized test gates; a red or skipped required PostgreSQL 17/S3/browser gate means STOP without retry under the current project mandate.

Record backup timestamp, last recoverable write, restore start/end, service validation end, actual data loss and downtime, failures and corrective actions. No measured RPO/RTO is available yet. Cleanup of the restored database and archive is a separate approved action; scripts do not perform it.

## Actual disaster sequence

The designated incident/launch lead validates impact and freezes further risky changes, chooses a trusted recovery point and authorizes exact source, destination, account, region, expected loss, downtime and rollback boundaries. A database operator restores to an isolated replacement; an S3 operator verifies corresponding object versions and keys; QA checks integrity with outbound effects disabled. The lead reviews evidence **before** authorizing traffic movement and before restarting workers. Never overwrite the only surviving source as an initial recovery step.

Rollback of an application image is distinct from data recovery. Do not automatically reverse SQL, restore old payment state or rerun provider requests. Escalate irreversible data changes for a reviewed repair plan. Communication owner drafts a factual status update with known impact, action underway and next update time; sending needs an approved audience/channel.

## Drill register

| Drill                                           | Status        | Owner     | Measured RPO/RTO |
| ----------------------------------------------- | ------------- | --------- | ---------------- |
| Candidate tabletop                              | Not performed | To assign | None             |
| PostgreSQL isolated restore plus matching media | Not performed | To assign | None             |
| Off-account/key recovery                        | Not performed | To assign | None             |

Propose an isolated drill before first launch and after material schema/storage changes; choose a recurring cadence once owner and support capacity are confirmed. No calendar invitations or production operations are authorized by this proposal.

Primary references checked: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
