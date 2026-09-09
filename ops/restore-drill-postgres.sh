#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 3 ] || [ "$1" != '--execute-approved-drill' ]; then
  echo 'Dry run: no restore performed. Usage: restore-drill-postgres.sh --execute-approved-drill /absolute/backup-directory kinetra_restore_unique_name'
  exit 0
fi
archive_dir=$2
target_db=$3
case "$archive_dir" in /*) ;; *) echo 'Absolute backup directory required.' >&2; exit 1 ;; esac
case "$target_db" in kinetra_restore_?*) ;; *) echo 'An explicit kinetra_restore_* database name is required.' >&2; exit 1 ;; esac
case "$target_db" in *[!a-zA-Z0-9_]*) echo 'Unsafe target database name.' >&2; exit 1 ;; esac
if [ "${KINETRA_RESTORE_APPROVED:-}" != "$target_db" ] || [ "${KINETRA_RESTORE_TARGET_CLASS:-}" != isolated-nonproduction ]; then
  echo 'Explicit target approval and isolated-nonproduction attestation required.' >&2; exit 1
fi
case "${PGSERVICE:-}" in ''|*[!a-zA-Z0-9_-]*) echo 'Set the dedicated nonproduction PGSERVICE name.' >&2; exit 1 ;; esac
case "${PGSERVICEFILE:-}" in /*) ;; *) echo 'Set absolute PGSERVICEFILE.' >&2; exit 1 ;; esac
if [ ! -f "$PGSERVICEFILE" ] || [ -L "$PGSERVICEFILE" ] || [ "$(stat -c %a "$PGSERVICEFILE")" != 600 ]; then
  echo 'PGSERVICEFILE must be a private mode0600 regular file.' >&2; exit 1
fi
if [ -n "${PGPASSFILE:-}" ] && { [ ! -f "$PGPASSFILE" ] || [ -L "$PGPASSFILE" ] || [ "$(stat -c %a "$PGPASSFILE")" != 600 ]; }; then
  echo 'PGPASSFILE must be a private mode0600 regular file.' >&2; exit 1
fi
if [ ! -d "$archive_dir" ] || [ "$(stat -c %a "$archive_dir")" != 700 ] || [ "$(stat -c %u "$archive_dir")" != "$(id -u)" ] || [ -L "$archive_dir" ] || [ ! -f "$archive_dir/database.dump" ] || [ -L "$archive_dir/database.dump" ] || [ ! -f "$archive_dir/database.dump.sha256" ] || [ -L "$archive_dir/database.dump.sha256" ]; then
  echo 'Expected a local trusted archive directory.' >&2; exit 1
fi
# Never let an edited checksum file select arbitrary filesystem paths.
if ! LC_ALL=C sed -n '1p' "$archive_dir/database.dump.sha256" | LC_ALL=C grep -Eq '^[0-9a-f]{64}  database\.dump$' || [ "$(wc -l < "$archive_dir/database.dump.sha256")" -ne 1 ]; then
  echo 'Invalid archive checksum manifest.' >&2; exit 1
fi
(cd "$archive_dir" && sha256sum --check --status database.dump.sha256)
case "$(pg_restore --version)" in 'pg_restore (PostgreSQL) 17.'*) ;; *) echo 'PostgreSQL 17 pg_restore is required.' >&2; exit 1 ;; esac
case "$(psql --version)" in 'psql (PostgreSQL) 17.'*) ;; *) echo 'PostgreSQL 17 psql is required.' >&2; exit 1 ;; esac
pg_restore --list "$archive_dir/database.dump" >/dev/null
export PGCONNECT_TIMEOUT=10
# Service credentials must be unable to reach production. The name/attestation alone
# cannot prove isolation. Operator must verify account, host, firewall and IAM first.
connection="service=$PGSERVICE dbname=$target_db sslmode=verify-full"
exec 9>"$archive_dir/.restore-$PGSERVICE-$target_db.lock"
flock -n 9 || { echo 'A restore is already running for this archive and target.' >&2; exit 1; }
server_version=$(psql --no-password --dbname="$connection" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command='SHOW server_version_num')
case "$server_version" in 17[0-9][0-9][0-9][0-9]) ;; *) echo 'Target server must be PostgreSQL 17.' >&2; exit 1 ;; esac
object_count=$(psql --no-password --dbname="$connection" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_foreign_server) + (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') + (SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_event_trigger) + (SELECT count(*) FROM pg_largeobject_metadata)")
if [ "$object_count" != 0 ]; then echo 'Target database is not empty; refusing restore.' >&2; exit 1; fi
# No --clean/--create: never drop an existing database. A failed restore rolls back.
timeout --signal=TERM --kill-after=30s 6h pg_restore --no-password --dbname="$connection" --exit-on-error --single-transaction --no-owner --no-privileges "$archive_dir/database.dump"
echo 'KINETRA_POSTGRES_RESTORE_DRILL=RESTORED (application/media integrity and measured RPO/RTO still required)'
