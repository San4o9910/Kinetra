#!/bin/sh
set -eu
umask 077
# No database connection unless the explicit execution flag is supplied.
if [ "$#" -ne 2 ] || [ "$1" != '--execute-approved-backup' ]; then
  echo 'Dry run: no backup performed. Usage: backup-postgres.sh --execute-approved-backup /absolute/approved/encrypted/directory'
  exit 0
fi
backup_dir=$2
case "$backup_dir" in /*) ;; *) echo 'Absolute backup directory required.' >&2; exit 1 ;; esac
if [ ! -d "$backup_dir" ] || [ -L "$backup_dir" ] || [ "$(stat -c %a "$backup_dir")" != 700 ] || [ "$(stat -c %u "$backup_dir")" != "$(id -u)" ]; then
  echo 'Pre-create a private mode0700 backup directory owned by the operator.' >&2; exit 1
fi
if [ "${KINETRA_BACKUP_APPROVED:-}" != yes ] || [ ! -f "$backup_dir/.kinetra-encrypted-backup-approved" ]; then
  echo 'Missing backup approval or encrypted-storage attestation marker.' >&2; exit 1
fi
case "${PGSERVICE:-}" in ''|*[!a-zA-Z0-9_-]*) echo 'Set the approved PGSERVICE name.' >&2; exit 1 ;; esac
case "${PGSERVICEFILE:-}" in /*) ;; *) echo 'Set absolute PGSERVICEFILE.' >&2; exit 1 ;; esac
if [ ! -f "$PGSERVICEFILE" ] || [ -L "$PGSERVICEFILE" ] || [ "$(stat -c %a "$PGSERVICEFILE")" != 600 ]; then
  echo 'PGSERVICEFILE must be a private mode0600 regular file.' >&2; exit 1
fi
if [ -n "${PGPASSFILE:-}" ] && { [ ! -f "$PGPASSFILE" ] || [ -L "$PGPASSFILE" ] || [ "$(stat -c %a "$PGPASSFILE")" != 600 ]; }; then
  echo 'PGPASSFILE must be a private mode0600 regular file.' >&2; exit 1
fi
case "$(pg_dump --version)" in 'pg_dump (PostgreSQL) 17.'*) ;; *) echo 'PostgreSQL 17 pg_dump is required.' >&2; exit 1 ;; esac
case "$(psql --version)" in 'psql (PostgreSQL) 17.'*) ;; *) echo 'PostgreSQL 17 psql is required.' >&2; exit 1 ;; esac
export PGCONNECT_TIMEOUT=10
source_version=$(psql --no-password --dbname="service=$PGSERVICE sslmode=verify-full" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command='SHOW server_version_num')
case "$source_version" in 17[0-9][0-9][0-9][0-9]) ;; *) echo 'Source server must be PostgreSQL 17.' >&2; exit 1 ;; esac
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || { echo 'A backup is already running.' >&2; exit 1; }
staging_dir=$(mktemp -d "$backup_dir/.backup.XXXXXX")
cleanup() { rm -rf -- "$staging_dir"; }
trap cleanup EXIT HUP INT TERM
# Credentials remain in the approved libpq service/pass file, never command arguments.
timeout --signal=TERM --kill-after=30s 2h pg_dump --no-password --dbname="service=$PGSERVICE sslmode=verify-full" --format=custom --lock-wait-timeout=30000 --file="$staging_dir/database.dump"
(cd "$staging_dir" && sha256sum database.dump > database.dump.sha256)
printf 'created_utc=%s\nformat=postgresql17-custom\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$staging_dir/metadata.txt"
archive_name="$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$staging_dir" | cut -c 9-)"
# Publish the dump, checksum and metadata atomically as one directory on this volume.
mv -- "$staging_dir" "$backup_dir/$archive_name"
trap - EXIT HUP INT TERM
echo 'KINETRA_POSTGRES_BACKUP=CREATED_LOCAL (offsite copy and restore verification still required)'
