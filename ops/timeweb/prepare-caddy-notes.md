# Caddy preparation, server 9069403

Run `bash prepare-caddy.sh --prepare-for-server-9069403` only through the reviewed
SSH wrapper targeting `80.68.156.131`, with Ed25519 fingerprint
`SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0` pinned before authentication.
The script installs Caddy and its configuration but never enables or starts the
service. Both configuration validations use isolated network namespaces. No ACME
certificate is requested. Existing Caddy accounts, configuration, state or units
cause failure before installation; a partial failed installation needs inspection
before a follow-up correction, rather than an unchanged rerun.

The [official v2.11.4 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4)
was checked through its
[release metadata](https://api.github.com/repos/caddyserver/caddy/releases/tags/v2.11.4).
Asset `436912315`, uploaded by `github-actions[bot]`, is
[caddy_2.11.4_linux_amd64.tar.gz](https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz),
17,238,873 bytes, SHA-256
`527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9`.
Verification uses this publisher-repository digest over HTTPS; no separate
Sigstore signature verification is claimed.

The embedded Caddyfile exactly matches application commit
`88199890d6f636fcf781d924137b15847a87e601`, file SHA-256
`c06f2a92c3daaf28c1f0db737c2389447c9f33604615bb599d082df114c9372d`.
Local `bash -n`, twelve isolated argument/path/checksum/source-contract checks,
and independent read-only review passed. The SSH wrapper adds mocked lifecycle,
timeout, cleanup and sanitized-output tests. Shell progress emits only six fixed
phase names; the wrapper retains the latest phase and numeric exit code, never
raw command diagnostics. The release binary was not downloaded or executed
locally; native Caddy and systemd validation occur on the target.

After application readiness is independently established, the separate launch
step can activate the unit. Until then ports 80/443 have no Caddy listener and
the application is not being presented as available.
