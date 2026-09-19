#!/bin/sh
set -eu
umask 077
# The official entrypoint runs this as OS postgres, using its local peer identity.
# Secret-backed Compose mounts preserve host mode/UID: all eight files must be
# UID 999, mode 0600. Never pass passwords in command arguments or enable xtrace.
for role in bootstrap migrate api notifications renewals chat_cleanup video_cleanup video_verify; do
  secret_file=/run/secrets/${role}_password
  if [ ! -f "$secret_file" ] || [ "$(stat -c %a "$secret_file")" != 600 ] || [ "$(stat -c %u "$secret_file")" != 999 ]; then
    echo 'PostgreSQL bootstrap requires UID999 mode0600 password files.' >&2
    exit 1
  fi
  # Fixed alphabet avoids env/URL/psql interpolation surprises; require at least
  # 256 bits of randomly generated material, independently generated per role.
  secret=$(cat "$secret_file")
  if [ "${#secret}" -lt 43 ] || [ "${#secret}" -gt 128 ] || ! printf '%s' "$secret" | LC_ALL=C grep -Eq '^[A-Za-z0-9_-]+$'; then
    echo 'PostgreSQL bootstrap password format is invalid.' >&2
    exit 1
  fi
done
# psql reads env values into SQL-quoted variables; credentials never enter argv.
KINETRA_MIGRATE_PASSWORD=$(cat /run/secrets/migrate_password)
KINETRA_API_PASSWORD=$(cat /run/secrets/api_password)
KINETRA_NOTIFICATIONS_PASSWORD=$(cat /run/secrets/notifications_password)
KINETRA_RENEWALS_PASSWORD=$(cat /run/secrets/renewals_password)
KINETRA_CHAT_CLEANUP_PASSWORD=$(cat /run/secrets/chat_cleanup_password)
KINETRA_VIDEO_CLEANUP_PASSWORD=$(cat /run/secrets/video_cleanup_password)
KINETRA_VIDEO_VERIFY_PASSWORD=$(cat /run/secrets/video_verify_password)
export KINETRA_MIGRATE_PASSWORD KINETRA_API_PASSWORD KINETRA_NOTIFICATIONS_PASSWORD KINETRA_RENEWALS_PASSWORD
export KINETRA_CHAT_CLEANUP_PASSWORD KINETRA_VIDEO_CLEANUP_PASSWORD KINETRA_VIDEO_VERIFY_PASSWORD
psql --no-psqlrc --no-password --username=kinetra_bootstrap --dbname=kinetra \
  --set=ON_ERROR_STOP=1 --file=/etc/kinetra-postgres/roles.sql
unset KINETRA_MIGRATE_PASSWORD KINETRA_API_PASSWORD KINETRA_NOTIFICATIONS_PASSWORD KINETRA_RENEWALS_PASSWORD
unset KINETRA_CHAT_CLEANUP_PASSWORD KINETRA_VIDEO_CLEANUP_PASSWORD KINETRA_VIDEO_VERIFY_PASSWORD secret
# Written only after a successful transaction; this is not schema/gate evidence.
touch "$PGDATA/.kinetra-bootstrap-complete"
