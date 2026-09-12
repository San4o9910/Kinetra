# Prepared HTTPS activation, fixed server 9069403

`activate-https-host.py` is frozen guest code. It has no workflow trigger, SSH
client, installer, image pull, deployment switch or automatic retry. Its explicit
command is `python3 -B activate-https-host.py --activate-prepared-https --private-input /absolute/root-owned-0600-input.json`.
Do not invoke it until the calling phase has authenticated current successful
source/image gates, the approved immutable images, the fixed Timeweb server/IP,
the pinned SSH host key and the complete successful local-activation outer result.
Hash binding inside the guest is not independent authentication of those sources.

The outer caller is now prepared in `https-caller.py`, with a dormant workflow
template at `https-activation.yml`. The template must be filled with the actual
successful image and local-application run, commit, workflow and artifact hashes
before activation. Its GitHub-only step independently verifies current source
and image gates and the exact successful local handoff artifact. A private,
same-run receipt binds those observations to the separate Timeweb-only step.
No SMTP credentials are passed to either HTTPS step.

The outer transport verifies the pinned SSH key before adding its temporary key,
requires the prepared host's SSH hardening, Docker and ports 22/8080, then sends
only the hash-pinned public helpers and private activation input through SSH
stdin. The frozen guest still proves the exact loopback address and all container
identities before starting Caddy. Earlier empty-host checks are intentionally not
reused after the frontend has started. Unexpected 80/443/database listeners fail.
Temporary key and directory cleanup must all complete before the outer caller
writes `accepted-https-handoff.json`. Failed or lost responses retain sanitized
attempt identities and never become successful handoffs.

The 17 offline caller tests cover immutable prior-run authentication, changed
attempt/checkpoint binding, private receipts, CLI handoff creation, transport and
secret handling, SSH pinning, prepared-host preconditions, timeout/rollback grace,
owned cleanup and lost-response reconciliation. They do not contact the host.

Input has exactly `schema:1`, `server_id:9069403`, `public_ipv4:80.68.156.131`,
`approved` (the frozen `start-application-host.py` input), `local_outer` (the final
successful `TIMEWEB_LOCAL_APPLICATION` object), `local_outer_sha256` and
`local_checkpoint_sha256`. The outer hash uses sorted compact JSON,
`ensure_ascii=True`, no newline. The checkpoint hash covers actual file bytes.
No provider URL, provider key or credential is accepted as a separate input.

Before recording a start attempt, the helper requires all prior key and temporary
file cleanup, exact nested success, the exact recorded application nonce and full
container IDs, matching local checkpoint bytes, original startup input, source and
configuration hashes. A standalone `CHECKPOINT_ONLY`, failed/lost outer response,
or changed attempt cannot proceed. Existing HTTPS attempts are preserved and
rejected; state-specific reconciliation is required before any resume.

Live acceptance repeats the exact private PostgreSQL/image/network/data-volume
identity, read-only migration ledger, backend readiness, both application
container sandboxes and qualified image revisions, unchanged loopback shell and
assets, health, 401 and readiness 404. Only the recorded three containers may
exist. Ports 3000/5432 must have no host listener; 8080 must bind only 127.0.0.1.

The existing Caddy binary, configuration and unit must be root-owned regular files
with exact modes and these hashes:

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `/usr/local/bin/caddy`              | `b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9` |
| `/etc/caddy/Caddyfile`              | `c06f2a92c3daaf28c1f0db737c2389447c9f33604615bb599d082df114c9372d` |
| `/etc/systemd/system/caddy.service` | `41493a3cc49bb8b26fc55d45d760ccbfd26585b6055d010a6af065d63354e492` |

The binary hash was extracted without executing it from the exact public
[Caddy 2.11.4 release archive](https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz),
after verifying the previously reviewed archive SHA-256
`527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9`
and size 17,238,873 bytes. The binary member is 48,521,378 bytes. Unit and Caddyfile
hashes match the literal heredocs in the pinned preparation script. This uses the
publisher-repository release digest; no additional signing method is claimed.

The loaded unit must also match its prepared configuration, without drop-ins,
pending reload, extra commands or environment files. It must be disabled/inactive
with no pending job. Configuration validation uses the existing isolated network
namespace and `caddy` user. No reinstall or origin change is performed.

Only after those checks does the helper persist an exclusive attempt and start
`caddy.service`. This is the point that allows Caddy's existing HTTP01 configuration
to request the public short-lived IP certificate. The service stays disabled at
boot. Trusted HTTPS checks use the system CA bundle explicitly, require IP SAN
80.68.156.131 and current validity, and reject certificate verification errors.
Certificate transport readiness has a ten-minute deadline; failed HTTP assertions
are not retried. Only anonymous GET requests occur. Redirect must be 308 to the
same HTTPS origin. Public shell/assets/API boundaries must match local acceptance.

After a confirmed start, rollback may stop only the same recorded systemd
InvocationID with matching binary/unit/config identity. A timeout before ownership
is confirmed, changed InvocationID or uncertain stop becomes `UNKNOWN_RECONCILE`;
it never authorizes stopping an unowned service. Backend, frontend, PostgreSQL,
all data, credentials, certificate state and existing evidence remain in place.

Successful stdout is `HTTPS_ACCEPTED_ONLY`. The persistent result deliberately
remains `CHECKPOINT_ONLY` with `requires_matching_outer_success:true`; it cannot
stand alone as a later activation handoff, including after a final durability
failure and rollback. External browser acceptance, certificate renewal monitoring,
database restart policy, boot enablement, backups and user launch remain separate
unfinished phases. This guest's requests originate on the server itself and do
not prove reachability from a user's network.

Local tests use synthetic private files and mocked systemd, Docker, SQL and HTTP.
They do not execute Caddy, request certificates, connect providers or deploy.
