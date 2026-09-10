# Public IPv4 HTTPS edge preparation

This is the HTTPS edge contract for the candidate in [SINGLE_SERVER_DEPLOYMENT.md](SINGLE_SERVER_DEPLOYMENT.md). It prepares configuration for one public IPv4 address without requiring a domain. It does not establish a running edge, an issued certificate, verified client-IP handling, successful infrastructure gates or production readiness. The commands below are operator instructions and have not been executed by this preparation.

The request path is: public HTTPS client → host Caddy → `127.0.0.1:8080` → existing frontend nginx → private `backend:3000`. Caddy terminates TLS; nginx continues serving the frontend and enforcing the existing API, upload and WebSocket routing. Keep the frontend publication exactly `127.0.0.1:8080:8080`. Publish no API or PostgreSQL port, and keep the Caddy administration endpoint private.

## Certificate and Caddy configuration

Let's Encrypt made IP certificates generally available on January 15, 2026. IP certificates require the `shortlived` profile, whose validity is **160 hours**. The public address must remain assigned to this host for validation and renewal. A change of public address requires a separately reviewed certificate and application-origin update. [General availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), [profile specification](https://letsencrypt.org/docs/profiles/#shortlived).

Use the reviewed **Caddy 2.11.4** release for this candidate and verify the installed binary's provenance. This release patches an upstream advisory affecting versions through 2.11.3. IPv4 HTTP-01 support starts at 2.10.1, but compatibility alone does not establish an acceptable deployment version. Recheck official release and security information before live installation. [Caddy 2.10.1 release](https://github.com/caddyserver/caddy/releases/tag/v2.10.1), [Caddy 2.11.4 release](https://github.com/caddyserver/caddy/releases/tag/v2.11.4), [patched advisory](https://github.com/caddyserver/caddy/security/advisories/GHSA-j8px-rmrx-76h9).

The reviewed source is `deploy/edge/Caddyfile`. Install a reviewed copy into the host service's configuration location and explicitly provide `PUBLIC_IPV4` in that service's environment. This value is one real, assigned public IPv4 address, with no scheme, port, whitespace or placeholder text. Do not add it to the strict API/job environment files or assume a variable exported in an administrator's shell reaches a systemd service.

The Caddyfile deliberately specifies:

- `default_sni {$PUBLIC_IPV4}` so clients that omit SNI can select this IP's certificate.
- An explicit ACME issuer with the Let's Encrypt production directory `https://acme-v02.api.letsencrypt.org/directory` and `profile shortlived`.
- `disable_tlsalpn_challenge`, keeping certificate validation on HTTP-01.
- HTTP server `protocols h1 h2`; this candidate does not require an HTTP/3 UDP listener.
- A reverse proxy to `127.0.0.1:8080` with `Forwarded` and `X-Real-IP` removed before forwarding.

The explicit issuer and profile are necessary for the public IP certificate contract. Do not substitute `tls internal`, a manually trusted certificate or a bare-IP default configuration. [Caddy ACME issuer options](https://caddyserver.com/docs/caddyfile/directives/tls#acme), [default SNI and HTTP protocol options](https://caddyserver.com/docs/caddyfile/options).

## Network access

| Direction              | Required access                  | Purpose                                                          |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Internet to host       | TCP 80                           | HTTP-01 issuance and every renewal; Caddy answers the challenge. |
| Internet to host       | TCP 443                          | Public HTTPS application traffic.                                |
| Host to Internet       | TCP 443                          | ACME directory, issuance and renewal requests.                   |
| Host Caddy to frontend | Loopback TCP 8080                | Existing nginx ingress; never publish it on all interfaces.      |
| Frontend to API        | Private Docker network, TCP 3000 | Existing application proxying.                                   |

Leave TCP 80 available after initial issuance. HTTP-01 always starts on port 80; changing a local challenge port does not change the CA's destination port. Let's Encrypt does not publish fixed validation source-IP ranges or fixed ACME service ranges, so do not use a static CA IP allowlist. DNS-01 cannot validate an IP address. These are certificate requirements, in addition to the application's existing approved outbound dependencies. [Challenge types](https://letsencrypt.org/docs/challenge-types/), [firewall requirements](https://letsencrypt.org/docs/integration-guide/#firewall-configuration).

## Establish the exact nginx socket peer before trusting headers

Caddy is the direct public edge in this topology. Keep its trusted-proxy list unset: its reverse proxy ignores client-supplied `X-Forwarded-*` values when constructing forwarding headers. Do not add a CDN, load balancer or broad trusted range without reviewing the entire trust contract. [Caddy reverse-proxy defaults](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

nginx optionally includes `/etc/nginx/kinetra-edge/*.conf`. With no active real-IP include, nginx's `$remote_addr` is the immediate socket peer. That peer can differ from `127.0.0.1` after Docker port forwarding. **A Docker bridge gateway is not evidence of the observed peer.** Never choose a gateway from convention or trust an entire Docker, private, loopback or public subnet to make the configuration work.

During separately authorized host acceptance, with application traffic still closed:

1. Observe the actual nginx socket peer before activating any real-IP trust. Use an isolated, temporary diagnostic in the intended nginx network context with the optional trust include absent. The ready-to-launch single-server overlay requires the final trust file; an empty directory is not a substitute for its validated configuration.
2. Send one synthetic request through the intended host-to-`127.0.0.1:8080` path to a dedicated harmless diagnostic path. Include no credentials, cookies, authorization header, query string or request body. Restrict temporary diagnostics to that request and record only the numeric socket peer needed for this decision. Do not enable broad production request logging or capture traffic payloads.
3. Record the observed peer and the relevant host/Docker network identity in the operator's acceptance evidence. During the later authorized Caddy acceptance, confirm a synthetic request through Caddy reaches nginx from that same peer. If the observation differs, stop and correct the exact peer configuration before admitting application traffic.
4. Remove the temporary diagnostic route/log configuration and its transient output. Recheck the peer whenever Docker networking, container recreation, host forwarding or the Caddy placement changes. Do not widen the trust range when a peer changes.

## External real-IP configuration directory

The single-server overlay requires `KINETRA_EDGE_CONFIG_DIR` in the external `single-server.env` public metadata file. It mounts that directory read-only at `/etc/nginx/kinetra-edge`; it must be prepared by the operator outside the repository. Use a dedicated path such as `/etc/kinetra/edge`. Keep it separate from the Caddyfile, certificate storage, PostgreSQL files and secret environment files.

The directory must have a canonical absolute path with no whitespace or symlink components, be root-owned and mode `0755`, and contain **only** the regular file `nginx-real-ip.conf`. Every ancestor directory must also be root-owned, with no group/world write permissions or symlinks. That file must be root-owned, mode `0644`, and contain exactly these three directives as three canonical LF-separated lines, with at most one final newline, after replacing the explanatory peer placeholder:

```nginx
set_real_ip_from EXACT_ACTUAL_SOCKET_PEER/32;
real_ip_header X-Forwarded-For;
real_ip_recursive off;
```

Use `/32` for one observed numeric IPv4 address, or replace the first argument with one observed numeric IPv6 address followed by `/128`. Hostnames, UNIX sockets, broader CIDRs, placeholder text, additional directives, extra files, symlinks and repository template directories are rejected by the local single-server validation contract. Create the deployed file from the observed evidence; do not mount `deploy/edge` or any source template directory. That directory must never contain the Caddyfile or a private key.

`real_ip_recursive off` means nginx takes the final address in `X-Forwarded-For` only when the original socket peer matches the exact trusted address. nginx then forwards its resulting `$remote_addr` as a single `X-Forwarded-For` value to the backend. Preserve **`TRUST_PROXY_HOPS=1`** in the backend: nginx has normalized the external edge's value into the existing one-hop API contract. [nginx real-IP semantics](https://nginx.org/en/docs/http/ngx_http_realip_module.html).

An exact peer address identifies the trusted network path, not the Caddy process. Keep host and Docker administration restricted and prevent untrusted processes or containers from using that trusted path. Root/Docker access remains privileged. Retain the existing private port bindings and access controls.

Run the existing local validator against the explicitly staged metadata after creating the final directory:

```sh
node deploy/postgres/validate-single-server.mjs /srv/kinetra-stage/env/single-server.env /srv/kinetra-stage/env/production.env
```

This instruction performs file/configuration validation only. Passing it does not prove the peer observation, live forwarding-header behavior, firewall isolation, TLS issuance or any PostgreSQL, S3 or browser gate. Do not loosen ownership, add a broad trust rule or bypass validation to pass it.

## Renewal, persistence and monitoring

Caddy manages certificate issuance and renewal while running with this configuration. Preserve its service data directory across restarts, redeployments and upgrades: it contains certificates, private keys and ACME account state. Give only the service identity and approved administrators the required access, keep a protected recovery copy under the approved backup policy, and maintain a working system clock. Do not store this state in temporary storage, a build image or the repository. Determine the actual data directory from the installed service environment; do not infer it from an interactive shell. [Automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy data directory](https://caddyserver.com/docs/conventions#data-directory).

No separate Certbot renewal job is needed for this Caddy-managed certificate. As an alternative design, Certbot's webroot mode supports IP issuance from version 5.4.0, but it would require a separately reviewed challenge route, certificate ownership and reload schedule. Do not run two ACME clients for this edge. [Official Certbot IP-certificate guidance](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Before live acceptance, configure operator-controlled monitoring that independently checks the certificate actually served at `https://PUBLIC_IPV4`, verifies its chain and IP SAN without a trust bypass, and measures remaining validity. Use a warning at **48 hours** and a critical alert at **24 hours** remaining, with an explicit operator response for renewal failure, stale or missing monitoring results, and an unavailable edge. These thresholds are this deployment's operational policy. Monitor service/ACME failures promptly instead of waiting for expiry; ensure alerts reach the assigned operator and test their delivery within the approved scope. This repository does not install monitoring, an alert destination or a host service.

At live acceptance, record the exact Caddy binary version/provenance, installed configuration identity, observed nginx socket peer, public certificate issuer/SAN/expiry, renewal evidence and monitoring owner. Starting Caddy with this production issuer can contact ACME and obtain a real certificate; it is a live operation. The January availability announcement, a local Caddyfile parse, a validator result or a synthetic diagnostic is not issuance or renewal evidence. The owner subsequently authorized continuous diagnosis and justified retries of PostgreSQL17, S3 and browser gates, plus deployment on existing server 9069403 only after all mandatory checks pass. This preparation itself supplies no runtime evidence; preserve every assertion and withhold traffic until acceptance succeeds.
