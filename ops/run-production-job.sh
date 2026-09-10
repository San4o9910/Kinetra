#!/bin/sh
set -eu
# Execution is an operator action requiring separate authorization.
if [ "${1:-}" != '--execute-approved-job' ] || { [ "$#" -ne 4 ] && [ "$#" -ne 5 ]; }; then
  echo 'Dry run: no job executed. Usage: run-production-job.sh --execute-approved-job /absolute/production.env job /absolute/job.env [/absolute/single-server.env]'
  exit 0
fi
main_file=$2
job_name=$3
job_file=$4
case "$job_name" in migrate|notifications|renewals|chat-cleanup|video-cleanup|video-verify) ;; *) echo 'Unknown job.' >&2; exit 1 ;; esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Avoid inherited shell values overriding the validated Compose metadata.
unset NODE_IMAGE NGINX_IMAGE BACKEND_IMAGE FRONTEND_IMAGE VCS_REF \
  VITE_API_URL VITE_PRIVATE_MEDIA_ORIGIN KINETRA_API_ENV_FILE KINETRA_VIDEO_SCRATCH_DIR \
  KINETRA_JOB_ENV_FILE POSTGRES_IMAGE KINETRA_POSTGRES_DATA_DIR KINETRA_POSTGRES_CA_FILE \
  KINETRA_POSTGRES_CERT_FILE KINETRA_POSTGRES_KEY_FILE KINETRA_POSTGRES_SECRETS_DIR KINETRA_EDGE_CONFIG_DIR \
  COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES \
  COMPOSE_PATH_SEPARATOR COMPOSE_CONVERT_WINDOWS_PATHS COMPOSE_DISABLE_ENV_FILE \
  COMPOSE_COMPATIBILITY COMPOSE_REMOVE_ORPHANS COMPOSE_IGNORE_ORPHANS
if [ "$#" -eq 5 ]; then
  single_file=$5
  # This validator includes existing strict production/job validation, plus
  # the private network hostname, dedicated role/password and real TLS files.
  node "$script_dir/../deploy/postgres/validate-single-server.mjs" \
    "$single_file" "$main_file" "$job_name" "$job_file"
  set -- compose --env-file "$main_file" --env-file "$single_file" \
    -f "$script_dir/../deploy/compose.production.yml" \
    -f "$script_dir/../deploy/compose.single-server.yml"
else
  node "$script_dir/validate-production-env.mjs" "$main_file" "$job_name" "$job_file"
  set -- compose --env-file "$main_file" -f "$script_dir/../deploy/compose.production.yml"
fi
KINETRA_JOB_ENV_FILE=$job_file
export KINETRA_JOB_ENV_FILE
exec docker "$@" --profile jobs run --rm --no-deps "$job_name"
