#!/bin/sh
set -eu
umask 077

# This helper only creates a new, bounded staging tree. It never installs
# software, provisions cloud resources, changes services/firewalls, generates
# secrets, starts containers or runs PostgreSQL/S3/browser gates.
if [ "$#" -ne 2 ] || [ "$1" != '--stage-approved' ]; then
  echo 'Dry run: no host changes. Usage: prepare-single-server.sh --stage-approved /absolute/new-staging-directory'
  echo 'Target: Ubuntu 24.04, 2 vCPU, 4 GB RAM, 50 GB disk; hourly billing and total cost must be verified externally.'
  echo 'Would create: env/jobs, postgres/data, postgres/secrets, tls/public, tls/private and evidence (private directories only).'
  exit 0
fi

staging_dir=$2
case "$staging_dir" in /*) ;; *) echo 'An absolute staging directory is required.' >&2; exit 1 ;; esac
case "$staging_dir" in /|*/../*|*/./*|*/..|*/.|*/|*[!a-zA-Z0-9_./-]*) echo 'Use a normalized absolute path with letters, digits, slash, underscore, dot or hyphen.' >&2; exit 1 ;; esac
case "$staging_dir" in /proc/*|/sys/*|/dev/*|/run/*) echo 'Use a persistent filesystem staging directory.' >&2; exit 1 ;; esac
if [ -e "$staging_dir" ] || [ -L "$staging_dir" ]; then
  echo 'Staging destination already exists; refusing to modify it.' >&2
  exit 1
fi
parent_dir=$(dirname -- "$staging_dir")
if [ ! -d "$parent_dir" ] || [ "$(readlink -f -- "$parent_dir")" != "$parent_dir" ]; then
  echo 'Parent must already exist and contain no symlink/path indirection.' >&2
  exit 1
fi
if [ "$(stat -c %u "$parent_dir")" != "$(id -u)" ]; then
  echo 'Parent must be owned by the executing operator.' >&2
  exit 1
fi
if [ $((0$(stat -c %a "$parent_dir") & 0022)) -ne 0 ]; then
  echo 'Parent must not be group/world writable.' >&2
  exit 1
fi
mkdir -m 0700 -- "$staging_dir"
mkdir -m 0700 -- "$staging_dir/env" "$staging_dir/env/jobs" \
  "$staging_dir/postgres" "$staging_dir/postgres/data" "$staging_dir/postgres/secrets" \
  "$staging_dir/tls" "$staging_dir/tls/public" "$staging_dir/tls/private" "$staging_dir/evidence"
echo 'KINETRA_SINGLE_SERVER_STAGE=CREATED (empty private directories only; no deployment or encryption attested)'
