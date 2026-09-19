#!/bin/sh
set -eu
umask 077
fail() { echo "PostgreSQL startup refused: $1" >&2; exit 1; }
image=${KINETRA_POSTGRES_IMAGE:-}
if ! printf '%s\n' "$image" | LC_ALL=C grep -Eq '^(docker.io/library/)?postgres:17(\.[0-9]+)?-bookworm@sha256:[a-f0-9]{64}$'; then
  fail 'an immutable official PostgreSQL 17 bookworm image is required.'
fi
case "$(postgres --version)" in 'postgres (PostgreSQL) 17.'*) ;; *) fail 'server major must be 17.' ;; esac
[ "$(id -u postgres)" = 999 ] && [ "$(id -g postgres)" = 999 ] || fail 'reviewed image must use postgres UID/GID 999.'
[ "${PGDATA:-}" = /var/lib/postgresql/data/pgdata ] || fail 'unexpected data directory.'
if [ -f "$PGDATA/PG_VERSION" ]; then
  [ "$(cat "$PGDATA/PG_VERSION")" = 17 ] || fail 'existing data major must be 17.'
  [ -f "$PGDATA/.kinetra-bootstrap-complete" ] || fail 'partial or unrecognized bootstrap; preserve data and investigate without retry.'
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
