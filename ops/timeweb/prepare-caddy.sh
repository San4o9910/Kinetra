#!/usr/bin/env bash
# Prepare only. The invoking SSH wrapper must verify the pinned server host key.
set -euo pipefail
umask 077

fail() { printf 'KINETRA_CADDY_PREPARE=FAIL: %s\n' "$*" >&2; exit 1; }
require_absent() {
  local target
  for target in "$@"; do
    [[ ! -e "$target" && ! -L "$target" ]] || fail "existing path: $target"
  done
}
verify_sha() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
# Permit read-only sourcing of these helpers for isolated local contract checks.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

phase=PRECONDITIONS
phase_marker() { phase=$1; printf 'KINETRA_CADDY_PHASE=%s\n' "$phase"; }
trap 'printf "KINETRA_CADDY_PHASE=%s\n" "$phase" >&2' ERR
phase_marker PRECONDITIONS
[[ $# == 1 && "$1" == --prepare-for-server-9069403 ]] || fail 'explicit preparation argument required'
[[ $EUID == 0 ]] || fail 'root required'
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
for required in curl tar sha256sum systemctl systemd-analyze runuser unshare ip getent install; do
  command -v "$required" >/dev/null || fail "missing command: $required"
done
[[ $(uname -m) == x86_64 ]] || fail 'amd64 required'
[[ -f /etc/os-release ]] || fail 'OS metadata missing'
os_id=$(awk -F= '$1=="ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
os_version=$(awk -F= '$1=="VERSION_ID" {gsub(/"/, "", $2); print $2}' /etc/os-release)
[[ $os_id == ubuntu && $os_version == 24.04 ]] || fail 'Ubuntu 24.04 required'
ip -4 -o address show | awk '{split($4,a,"/"); if(a[1]=="80.68.156.131") ok=1} END {exit !ok}' || fail 'assigned IPv4 mismatch'
[[ ! -L /var/lib/kinetra/bootstrap && -f /var/lib/kinetra/bootstrap ]] || fail 'bootstrap marker missing'
[[ $(cat /var/lib/kinetra/bootstrap) == empty-server-bootstrap-v1 ]] || fail 'bootstrap marker mismatch'
for parent in /usr/local/bin /etc /var/lib /etc/systemd/system; do
  [[ -d $parent && ! -L $parent && $(stat -c %u "$parent") == 0 ]] || fail "unsafe parent: $parent"
  [[ $((8#$(stat -c %a "$parent") & 0022)) == 0 ]] || fail "writable parent: $parent"
done
require_absent /usr/local/bin/caddy /usr/bin/caddy /etc/caddy /var/lib/caddy \
  /etc/systemd/system/caddy.service /etc/systemd/system/caddy.service.d \
  /etc/systemd/system/caddy-api.service /etc/systemd/system/caddy-api.service.d \
  /lib/systemd/system/caddy.service /lib/systemd/system/caddy-api.service
if getent passwd caddy >/dev/null || getent group caddy >/dev/null; then fail 'existing caddy account or group'; fi
for unit in caddy.service caddy-api.service; do
  [[ $(systemctl show --property=LoadState --value "$unit") == not-found ]] || fail "existing unit: $unit"
done

stage=$(mktemp -d /var/tmp/kinetra-caddy-prepare.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
archive="$stage/caddy.tar.gz"
release_url=https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz
archive_sha=527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9
phase_marker DOWNLOAD
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 180 --output "$archive" "$release_url"
phase_marker DIGEST
verify_sha "$archive_sha" "$archive" || fail 'official release digest mismatch'
tar --extract --gzip --file "$archive" --directory "$stage" --no-same-owner --no-same-permissions caddy
[[ -f "$stage/caddy" && ! -L "$stage/caddy" ]] || fail 'archive binary is not a regular file'
chmod 0755 "$stage/caddy"
version=$("$stage/caddy" version)
[[ $version == 'v2.11.4 '* ]] || fail 'unexpected binary version'

cat >"$stage/Caddyfile" <<'CADDYFILE'
# Host Caddy 2.11.4. PUBLIC_IPV4 must be the assigned, retained public IPv4.
# Starting this configuration requests/renews public certificates; prep is offline.
{
	default_sni {$PUBLIC_IPV4}
	servers {
		protocols h1 h2
	}
}

https://{$PUBLIC_IPV4} {
	tls {
		issuer acme https://acme-v02.api.letsencrypt.org/directory {
			profile shortlived
			disable_tlsalpn_challenge
		}
	}

	# Caddy overwrites X-Forwarded-* by default; no upstream proxies are trusted.
	# nginx must trust only this edge's observed socket peer, never a broad subnet.
	reverse_proxy 127.0.0.1:8080 {
		header_up -Forwarded
		header_up -X-Real-IP
	}
}
CADDYFILE
verify_sha c06f2a92c3daaf28c1f0db737c2389447c9f33604615bb599d082df114c9372d "$stage/Caddyfile" || fail 'Caddyfile drift'
# No external interface exists in this namespace; validate never runs the config.
phase_marker CONFIG_VALIDATE
unshare --net -- env -i PATH="$PATH" HOME="$stage" XDG_DATA_HOME="$stage/data" \
  XDG_CONFIG_HOME="$stage/config" PUBLIC_IPV4=80.68.156.131 \
  "$stage/caddy" validate --config "$stage/Caddyfile" --adapter caddyfile

cat >"$stage/caddy.service" <<'UNIT'
[Unit]
Description=Kinetra HTTPS edge (prepared, activation is a separate step)
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=notify
User=caddy
Group=caddy
Environment=PUBLIC_IPV4=80.68.156.131
Environment=HOME=/var/lib/caddy
Environment=XDG_DATA_HOME=/var/lib/caddy/data
Environment=XDG_CONFIG_HOME=/var/lib/caddy/config
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
TimeoutStopSec=30s
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=/var/lib/caddy

[Install]
WantedBy=multi-user.target
UNIT

# These destinations were all absent. Do not replace existing installations/state.
phase_marker INSTALL
groupadd --system caddy
useradd --system --gid caddy --no-create-home --home-dir /var/lib/caddy \
  --shell /usr/sbin/nologin --comment 'Kinetra Caddy HTTPS edge' caddy
install -d -m 0700 -o caddy -g caddy /var/lib/caddy
install -d -m 0750 -o root -g caddy /etc/caddy
install -m 0755 -o root -g root "$stage/caddy" /usr/local/bin/caddy
install -m 0640 -o root -g caddy "$stage/Caddyfile" /etc/caddy/Caddyfile
install -m 0644 -o root -g root "$stage/caddy.service" /etc/systemd/system/caddy.service
phase_marker UNIT_VERIFY
systemd-analyze verify /etc/systemd/system/caddy.service
unshare --net -- runuser -u caddy -- env -i PATH="$PATH" HOME=/var/lib/caddy \
  XDG_DATA_HOME=/var/lib/caddy/data XDG_CONFIG_HOME=/var/lib/caddy/config PUBLIC_IPV4=80.68.156.131 \
  /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
[[ $(systemctl is-enabled caddy.service 2>/dev/null || true) == disabled ]] || fail 'unit is not disabled'
[[ $(systemctl is-active caddy.service 2>/dev/null || true) == inactive ]] || fail 'unit is not inactive'
printf 'KINETRA_CADDY_PREPARE=PASS\nCADDY_VERSION=2.11.4\nCADDY_SERVICE=disabled,inactive\nACME_ISSUANCE=NOT_STARTED\n'
