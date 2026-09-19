#!/bin/sh
set -eu
umask 077
# Local, opt-in creation only. Does not install files, change permissions outside
# the new directory, distribute a CA key, or claim the PostgreSQL TLS gate passed.
if [ "$#" -ne 2 ] || [ "$1" != '--issue-approved-certificate' ]; then
  echo 'Dry run: no keys created. Usage: issue-server-certificate.sh --issue-approved-certificate /absolute/new-private-directory'
  exit 0
fi
cert_dir=$2
case "$cert_dir" in /*) ;; *) echo 'An absolute new directory is required.' >&2; exit 1 ;; esac
case "$cert_dir" in /|*/../*|*/./*|*/..|*/.|*/|*[!a-zA-Z0-9_./-]*) echo 'Use a normalized absolute path.' >&2; exit 1 ;; esac
if [ -e "$cert_dir" ] || [ -L "$cert_dir" ]; then
  echo 'Destination already exists; refusing to overwrite keys.' >&2
  exit 1
fi
parent_dir=$(dirname -- "$cert_dir")
if [ ! -d "$parent_dir" ] || [ "$(readlink -f -- "$parent_dir")" != "$parent_dir" ] || [ "$(stat -c %u "$parent_dir")" != "$(id -u)" ] || [ $((0$(stat -c %a "$parent_dir") & 0022)) -ne 0 ]; then
  echo 'Parent must exist, belong to the operator, have no symlink indirection, and deny group/world writes.' >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo 'An already-installed OpenSSL is required.' >&2; exit 1; }
mkdir -m 0700 -- "$cert_dir"
mkdir -m 0700 -- "$cert_dir/ca-private" "$cert_dir/server-private" "$cert_dir/public"
# Preserve partial results after errors for inspection; do not automatically retry.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$cert_dir/ca-private/ca.key" 2>"$cert_dir/openssl.log"
openssl req -new -x509 -sha256 -days 1825 -key "$cert_dir/ca-private/ca.key" \
  -subj '/CN=Kinetra PostgreSQL private root' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "$cert_dir/public/ca.crt" 2>>"$cert_dir/openssl.log"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$cert_dir/server-private/server.key" 2>>"$cert_dir/openssl.log"
openssl req -new -sha256 -key "$cert_dir/server-private/server.key" \
  -subj '/CN=postgres' -out "$cert_dir/server.csr" 2>>"$cert_dir/openssl.log"
cat > "$cert_dir/server.ext" <<'EXTENSIONS'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:postgres
EXTENSIONS
openssl x509 -req -sha256 -days 397 -in "$cert_dir/server.csr" \
  -CA "$cert_dir/public/ca.crt" -CAkey "$cert_dir/ca-private/ca.key" -CAcreateserial \
  -extfile "$cert_dir/server.ext" -out "$cert_dir/public/server.crt" 2>>"$cert_dir/openssl.log"
chmod 0644 "$cert_dir/public/ca.crt" "$cert_dir/public/server.crt"
openssl verify -CAfile "$cert_dir/public/ca.crt" -verify_hostname postgres \
  -purpose sslserver "$cert_dir/public/server.crt" >/dev/null 2>>"$cert_dir/openssl.log"
echo 'KINETRA_POSTGRES_CERTIFICATE=CREATED_LOCAL (protect CA key separately; host installation and live TLS verification remain)'
