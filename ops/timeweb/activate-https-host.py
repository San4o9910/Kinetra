#!/usr/bin/env python3
"""Dormant guest-only HTTPS activation of the already prepared fixed host.

The outer caller authenticates current image/CI provenance, the prior successful
local-activation outer result including all key cleanup, Timeweb identity and
pinned SSH. This helper alone neither authenticates that caller nor proves an
external browser, reboot readiness, renewal monitoring, backup or user launch.
No installer, image pull, Compose mutation, DB-policy change or user message.
"""
from __future__ import annotations

import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import resource
import secrets
import shlex
import shutil
import signal
import ssl
import stat
import sys
import time

HELPER_HASHES = {
    "start-application-host.py": "e7363f6caf31384c5d57f52c665a5b64cef6996b7019ed82d4d2d9f382ff7874",
    "activate-local-application-host.py": "ff830efde33df94ae08899c9b6199f4c3addffa595c03b823b7036d2bd4f38bb",
    "prepare-caddy.sh": "a23d52b21f7c638f757a723048ee632d37e8f217ae796f97dd92ec3bbb990e2d",
}
for name, digest in HELPER_HASHES.items():
    path = Path(__file__).with_name(name)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError("REVIEWED_HTTPS_HELPER_REQUIRED")


def load_helper(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


local = load_helper("kinetra_https_local_guest", "start-application-host.py")
outer = load_helper("kinetra_https_local_validation", "activate-local-application-host.py")
Error, require = local.Error, local.require
private_read, public_source, safe_parent = local.private_read, local.public_source, local.safe_parent
command, write_new, sync_directory, sha256 = local.command, local.write_new, local.sync_directory, local.sha256
STAGE, LOCK = local.STAGE, local.LOCK
SERVER_ID, PUBLIC_IP, PROJECT = local.SERVER_ID, local.PUBLIC_IP, local.PROJECT
ORIGIN = "https://" + PUBLIC_IP
CID = local.CID
CADDY_BINARY = Path("/usr/local/bin/caddy")
CADDY_CONFIG = Path("/etc/caddy/Caddyfile")
CADDY_UNIT = Path("/etc/systemd/system/caddy.service")
TRUST_STORE = "/etc/ssl/certs/ca-certificates.crt"
CADDY_BINARY_SHA256 = "b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9"
CADDY_CONFIG_SHA256 = "c06f2a92c3daaf28c1f0db737c2389447c9f33604615bb599d082df114c9372d"
CADDY_UNIT_SHA256 = "41493a3cc49bb8b26fc55d45d760ccbfd26585b6055d010a6af065d63354e492"
INPUT_KEYS = {"schema", "server_id", "public_ipv4", "approved", "local_outer", "local_outer_sha256", "local_checkpoint_sha256"}
OUTER_KEYS = {"schema", "result", "server_id", "public_ipv4", "host_key_fingerprint", "server_status", "ssh_key_id", "remote_directory",
              "guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup", "activation", "activation_outcome",
              "error", "approved_input_sha256", "provenance_sha256", "caddy_started", "database_policy_changed", "provider_requests", "full_launch_accepted"}


def canonical(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode())


def validate_input(data):
    require(isinstance(data, dict) and set(data) == INPUT_KEYS, "HTTPS_INPUT_INVALID")
    require(type(data["schema"]) is int and data["schema"] == 1 and type(data["server_id"]) is int
            and data["server_id"] == SERVER_ID and data["public_ipv4"] == PUBLIC_IP, "FIXED_SERVER_REQUIRED")
    approved = local.validate_input(data["approved"])
    value = data["local_outer"]
    require(isinstance(value, dict) and set(value) == OUTER_KEYS, "LOCAL_OUTER_SCHEMA_INVALID")
    require(type(value["schema"]) is int and value["schema"] == 1 and value["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY"
            and type(value["server_id"]) is int and value["server_id"] == SERVER_ID and value["public_ipv4"] == PUBLIC_IP
            and value["host_key_fingerprint"] == local.stage.PINNED_FINGERPRINT and value["server_status"] == "on"
            and type(value["ssh_key_id"]) is int and value["ssh_key_id"] > 0 and value["error"] is None, "SUCCESSFUL_LOCAL_OUTER_REQUIRED")
    require(value["guest_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and value["account_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and value["local_key_cleanup"] == value["guest_temp_cleanup"] == "REMOVED", "LOCAL_OUTER_CLEANUP_REQUIRED")
    require(value["caddy_started"] is False and value["database_policy_changed"] is False and value["full_launch_accepted"] is False
            and type(value["provider_requests"]) is int and value["provider_requests"] == 0
            and value["activation_outcome"] == "ACCEPTED_OBSERVED", "LOCAL_OUTER_EFFECTS_INVALID")
    require(isinstance(value["remote_directory"], str) and re.fullmatch(r"/run/kinetra-local-activation-[a-f0-9]{32}", value["remote_directory"]), "LOCAL_OUTER_ATTEMPT_INVALID")
    require(value["approved_input_sha256"] == canonical(approved) and isinstance(value["provenance_sha256"], str)
            and CID.fullmatch(value["provenance_sha256"]), "LOCAL_OUTER_PROVENANCE_INVALID")
    for key in ("local_outer_sha256", "local_checkpoint_sha256"):
        require(isinstance(data[key], str) and CID.fullmatch(data[key]), "LOCAL_ACCEPTANCE_HASH_REQUIRED")
    require(canonical(value) == data["local_outer_sha256"], "LOCAL_OUTER_HASH_MISMATCH")
    remote = outer.validate_remote(json.dumps(value["activation"]), approved, value["remote_directory"].rsplit("-", 1)[1])
    require(remote["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" and remote["remote_directory"] == value["remote_directory"], "SUCCESSFUL_LOCAL_GUEST_REQUIRED")
    return data


def read_handoff(data):
    approved = data["approved"]
    safe_parent(STAGE)
    require(stat.S_IMODE(STAGE.stat().st_mode) == 0o700, "STAGE_PRIVACY_INVALID")
    records = local.check_hashes(approved)
    staged, initialized = records["stage.json"], records["initialization.json"]
    local.stage.validate_stage_result(json.dumps({k: v for k, v in staged.items() if k not in {"images", "source_hashes"}}))
    local.initialization.validate_initialization_result(json.dumps({k: v for k, v in initialized.items() if k not in {"images", "migration_hashes"}}))
    require(staged["result"] == "STAGED_ONLY" and initialized["result"] == "DATABASE_INITIALIZED_ONLY", "DATABASE_HANDOFF_REQUIRED")
    for record in (staged, initialized):
        require(record["commit"] == approved["commit"] and record["images"] == approved["images"], "DATABASE_HANDOFF_IDENTITY_MISMATCH")
    require(staged["source_hashes"] == approved["source_hashes"] and initialized["migration_hashes"] == approved["migration_hashes"], "DATABASE_HANDOFF_HASH_MISMATCH")
    accepted = data["local_outer"]["activation"]["start"]
    checkpoint = dict(accepted, result="CHECKPOINT_ONLY", requires_matching_outer_success=True,
                      checkpoint_kind="LOCAL_OBSERVATIONS_NOT_AN_ACTIVATION_HANDOFF", commit=approved["commit"], images=approved["images"],
                      handoff_hashes=approved["handoff_hashes"], configuration_hashes=approved["configuration_hashes"])
    raw = private_read(STAGE / "evidence/application-start-result.json")
    require(sha256(raw) == data["local_checkpoint_sha256"] and raw == (json.dumps(checkpoint, sort_keys=True) + "\n").encode(), "MATCHING_SUCCESSFUL_LOCAL_CHECKPOINT_REQUIRED")
    attempt = json.loads(private_read(STAGE / "evidence/application-start-attempt.json"))
    require(attempt == dict(approved, nonce=accepted["nonce"], phase="START_BACKEND"), "LOCAL_ACTIVATION_ATTEMPT_MISMATCH")
    for filename in ("https-start-attempt.json", "https-start-result.json"):
        path = STAGE / "evidence" / filename
        require(not path.exists() and not path.is_symlink(), "EXISTING_HTTPS_ATTEMPT_PRESERVED")
    return {"staged": staged, "initialized": initialized, "accepted": accepted}


def unit_properties():
    names = ("LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "DropInPaths", "NeedDaemonReload",
             "User", "Group", "Type", "Environment", "EnvironmentFiles", "ExecStart", "ExecReload", "ExecCondition", "ExecStartPre", "ExecStartPost",
             "ExecStop", "ExecStopPost", "MainPID", "InvocationID", "Job", "NoNewPrivileges", "ProtectSystem")
    raw = command(["/usr/bin/systemctl", "show", "--all", "--property=" + ",".join(names), "caddy.service"], capture=True)
    result = {}
    for line in raw.splitlines():
        key, separator, value = line.partition("=")
        require(separator and key in names and key not in result, "CADDY_UNIT_OUTPUT_INVALID")
        result[key] = value
    require(set(result) == set(names), "CADDY_UNIT_OUTPUT_INCOMPLETE")
    return result


def check_caddy_identity(*, inactive):
    for path, digest, mode, limit in ((CADDY_BINARY, CADDY_BINARY_SHA256, 0o755, 50_000_000),
                                      (CADDY_CONFIG, CADDY_CONFIG_SHA256, 0o640, 65536), (CADDY_UNIT, CADDY_UNIT_SHA256, 0o644, 65536)):
        require(sha256(private_read(path, mode=mode, limit=limit)) == digest, "PREPARED_CADDY_IDENTITY_CHANGED")
    account = pwd.getpwnam("caddy")
    require(account.pw_uid > 0 and account.pw_gid > 0 and account.pw_dir == "/var/lib/caddy" and account.pw_shell == "/usr/sbin/nologin"
            and CADDY_CONFIG.stat().st_gid == account.pw_gid, "PREPARED_CADDY_ACCOUNT_CHANGED")
    properties = unit_properties()
    expected = {"LoadState": "loaded", "UnitFileState": "disabled", "FragmentPath": str(CADDY_UNIT), "DropInPaths": "", "NeedDaemonReload": "no",
                "User": "caddy", "Group": "caddy", "Type": "notify", "NoNewPrivileges": "yes", "ProtectSystem": "strict", "EnvironmentFiles": "",
                "ExecCondition": "", "ExecStartPre": "", "ExecStartPost": "", "ExecStop": "", "ExecStopPost": ""}
    require(all(properties[key] == value for key, value in expected.items()), "PREPARED_CADDY_UNIT_CHANGED")
    require(set(shlex.split(properties["Environment"])) == {"PUBLIC_IPV4=" + PUBLIC_IP, "HOME=/var/lib/caddy", "XDG_DATA_HOME=/var/lib/caddy/data", "XDG_CONFIG_HOME=/var/lib/caddy/config"}, "CADDY_ENVIRONMENT_CHANGED")
    execution = properties["ExecStart"]
    require(execution.count("path=") == 1 and "path=/usr/local/bin/caddy ;" in execution
            and "argv[]=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile ;" in execution, "CADDY_EXECUTION_CHANGED")
    reload = properties["ExecReload"]
    require(reload.count("path=") == 1 and "path=/usr/local/bin/caddy ;" in reload
            and "argv[]=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile ;" in reload, "CADDY_EXECUTION_CHANGED")
    require(properties["MainPID"].isdigit() and (not properties["InvocationID"] or re.fullmatch(r"[a-f0-9]{32}", properties["InvocationID"])), "CADDY_PROCESS_IDENTITY_INVALID")
    if inactive:
        require(properties["ActiveState"] == "inactive" and properties["SubState"] == "dead" and properties["MainPID"] == "0" and properties["Job"] == "", "CADDY_MUST_BE_INACTIVE_DISABLED")
    elif properties["ActiveState"] == "active":
        require(int(properties["MainPID"]) > 0 and Path("/proc/" + properties["MainPID"] + "/exe").resolve() == CADDY_BINARY
                and Path("/proc/" + properties["MainPID"]).stat().st_uid == account.pw_uid, "CADDY_PROCESS_IDENTITY_CHANGED")
    return properties


def check_listeners(*, before):
    listeners = command(["/usr/bin/ss", "-H", "-lnt"], capture=True)
    ports = set()
    for line in listeners.splitlines():
        fields = line.split()
        require(len(fields) >= 4, "HOST_LISTENER_OUTPUT_INVALID")
        address, _, port = fields[3].rpartition(":")
        require(port.isdigit(), "HOST_LISTENER_OUTPUT_INVALID")
        require(port not in {"3000", "5432"} and (port != "8080" or address == "127.0.0.1"), "PUBLIC_UPSTREAM_PORT_REFUSED")
        require(not before or port not in {"80", "443"}, "EXISTING_EDGE_LISTENER_REFUSED")
        ports.add(port)
    if not before: require({"80", "443", "8080"} <= ports, "HTTPS_LISTENER_MISSING")


def check_application(data, handoff):
    approved, accepted = data["approved"], handoff["accepted"]
    local.check_hashes(approved)
    postgres_id = handoff["initialized"]["postgres_id"]
    identifiers = command(["/usr/bin/docker", "container", "ls", "--all", "--quiet", "--no-trunc"], capture=True).splitlines()
    require(len(identifiers) == 3 and set(identifiers) == {postgres_id, *accepted["owned_containers"].values()}, "PERSISTENT_CONTAINER_SET_CHANGED")
    database = local.inspect_container(postgres_id)
    require(database.get("id") == postgres_id and database.get("image") == approved["images"]["POSTGRES_IMAGE"]
            and database.get("project") == PROJECT and database.get("service") == "postgres"
            and database.get("running") is True and database.get("health") == "healthy" and database.get("restart") == "no"
            and database.get("readonly") is True and not any((database.get("ports") or {}).values()), "LIVE_DATABASE_IDENTITY_CHANGED")
    image_id = command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", approved["images"]["POSTGRES_IMAGE"]], capture=True).strip()
    require(database.get("image_id") == image_id, "DATABASE_IMAGE_ID_CHANGED")
    networks = database.get("networks", {})
    require(set(networks) == {PROJECT + "_database"}, "DATABASE_NETWORK_CHANGED")
    database_network_id = networks[PROJECT + "_database"].get("NetworkID")
    require(isinstance(database_network_id, str) and CID.fullmatch(database_network_id), "DATABASE_NETWORK_ID_REQUIRED")
    private = json.loads(command(["/usr/bin/docker", "network", "inspect", "--format", "{{json .}}", database_network_id], capture=True))
    require(private.get("Id") == database_network_id and private.get("Name") == PROJECT + "_database" and private.get("Driver") == "bridge"
            and private.get("Internal") is True and private.get("Labels", {}).get("com.docker.compose.project") == PROJECT
            and set(private.get("Containers", {})) == {postgres_id, accepted["owned_containers"]["backend"]}, "DATABASE_NETWORK_ISOLATION_CHANGED")
    frontend_network = json.loads(command(["/usr/bin/docker", "network", "inspect", "--format", "{{json .}}", handoff["staged"]["network_id"]], capture=True))
    require(frontend_network.get("Id") == handoff["staged"]["network_id"] and frontend_network.get("Name") == PROJECT + "_backend"
            and frontend_network.get("Driver") == "bridge" and frontend_network.get("Internal") is False
            and frontend_network.get("EnableIPv6") is False and frontend_network.get("Labels", {}).get("com.docker.compose.project") == PROJECT
            and set(frontend_network.get("Containers", {})) == set(accepted["owned_containers"].values()), "APPLICATION_NETWORK_ISOLATION_CHANGED")
    volume = json.loads(command(["/usr/bin/docker", "volume", "inspect", "--format", "{{json .}}", PROJECT + "_postgres17_data"], capture=True))
    require(volume.get("Driver") == "local" and volume.get("Options") == {"type": "none", "o": "bind", "device": str(STAGE / "postgres/data")}
            and volume.get("Labels", {}).get("com.docker.compose.project") == PROJECT, "DATABASE_VOLUME_IDENTITY_CHANGED")
    mounted = [item for item in database.get("mounts", []) if item.get("Destination") == "/var/lib/postgresql/data"]
    require(len(mounted) == 1 and mounted[0].get("Type") == "volume" and mounted[0].get("Name") == PROJECT + "_postgres17_data" and mounted[0].get("RW") is True, "DATABASE_DATA_MOUNT_CHANGED")
    for service, identifier in accepted["owned_containers"].items():
        info = local.inspect_container(identifier)
        local.check_owned(info, service, approved, accepted["nonce"], identifier)
        local.check_runtime(info, service, approved, accepted["nonce"], handoff["staged"]["network_id"], database_network_id)
        require(info.get("running") is True and (service != "backend" or info.get("health") == "healthy"), "LOCAL_APPLICATION_NOT_HEALTHY")
        revision = command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', info["image"]], capture=True).strip()
        require(revision == approved["commit"], "QUALIFIED_APPLICATION_REVISION_CHANGED")
    local.database_readonly_handoff(postgres_id, approved["migration_hashes"])
    local.backend_ready(accepted["owned_containers"]["backend"])
    require(local.local_acceptance() == accepted["local_http"], "LOCAL_APPLICATION_ACCEPTANCE_CHANGED")
    return database


def tls_context():
    # Explicit store: SSL_CERT_FILE, SSL_CERT_DIR and SSLKEYLOGFILE cannot alter
    # verification or create a key log through create_default_context defaults.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = True
    context.load_verify_locations(cafile=TRUST_STORE)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def https_get(path):
    require(path.startswith("/") and not path.startswith("//") and not re.search(r"[\x00-\x20\x7f]", path), "HTTPS_PATH_INVALID")
    connection = http.client.HTTPSConnection(PUBLIC_IP, 443, context=tls_context(), timeout=5)
    try:
        connection.connect()
        certificate = connection.sock.getpeercert()
        leaf = connection.sock.getpeercert(binary_form=True)
        require(("IP Address", PUBLIC_IP) in certificate.get("subjectAltName", ()), "EXPECTED_IP_CERTIFICATE_REQUIRED")
        now = time.time()
        not_before, not_after = (ssl.cert_time_to_seconds(certificate[key]) for key in ("notBefore", "notAfter"))
        require(not_before <= now < not_after, "CURRENT_TRUSTED_CERTIFICATE_REQUIRED")
        evidence = {"sha256": sha256(leaf), "ip_san": PUBLIC_IP, "not_before": int(not_before), "not_after": int(not_after), "trusted": True}
        connection.request("GET", path, headers={"Host": PUBLIC_IP, "Connection": "close"})
        response = connection.getresponse()
        body = response.read(2_097_153)
        require(len(body) <= 2_097_152, "HTTPS_BODY_TOO_LARGE")
        return response.status, {key.lower(): value for key, value in response.getheaders()}, body, evidence
    finally:
        connection.close()


def wait_for_certificate(*, seconds=600):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            return https_get("/")
        except ssl.SSLCertVerificationError:
            raise Error("HTTPS_CERTIFICATE_TRUST_REJECTED") from None
        except ssl.SSLError as error:
            # Caddy can accept TCP before its first ACME certificate is ready.
            # An invalid chain/IP/date above is never treated as readiness.
            require(error.reason in {"TLSV1_ALERT_INTERNAL_ERROR", "SSLV3_ALERT_HANDSHAKE_FAILURE", "UNEXPECTED_EOF_WHILE_READING"}, "HTTPS_PROTOCOL_REJECTED")
        except (ConnectionRefusedError, ConnectionResetError, TimeoutError, ssl.SSLEOFError, http.client.RemoteDisconnected):
            pass  # Only transport readiness; never retry failed HTTP assertions.
        time.sleep(2)
    raise Error("HTTPS_CERTIFICATE_READINESS_DEADLINE")


def public_acceptance(expected):
    first = wait_for_certificate()
    certificate = first[3]
    def get(path):
        result = first if path == "/" else https_get(path)
        require(result[3]["trusted"] is True and result[3]["ip_san"] == PUBLIC_IP, "HTTPS_TRUST_EVIDENCE_REQUIRED")
        return result[:3]
    status, headers, body = get("/")
    require(status == 200 and "text/html" in headers.get("content-type", ""), "HTTPS_SHELL_HTTP_FAILED")
    require(headers.get("x-content-type-options") == "nosniff" and headers.get("x-frame-options") == "DENY"
            and headers.get("referrer-policy") == "no-referrer" and "set-cookie" not in headers, "HTTPS_SECURITY_HEADERS_MISSING")
    directives = [item.strip() for item in headers.get("content-security-policy", "").split(";") if item.strip()]
    require(all(item in directives for item in ("default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"))
            and len({item.split()[0] for item in directives}) == len(directives), "HTTPS_CSP_REJECTED")
    parser = local.Assets()
    parser.feed(body.decode("utf8"))
    require(parser.paths == set(expected) - {"/", "/health", "/ready", "/api/v1/me"}, "HTTPS_ASSET_SET_CHANGED")
    results = {"/": {"status": status, "sha256": sha256(body)}}
    for path in sorted(set(expected) - {"/"}):
        status, headers, body = get(path)
        require(status == expected[path]["status"] and "set-cookie" not in headers, "HTTPS_API_OR_ASSET_BOUNDARY_FAILED")
        if path == "/api/v1/me": require("no-store" in headers.get("cache-control", "").split(","), "HTTPS_API_NO_STORE_REQUIRED")
        if path == "/health": require(json.loads(body).get("status") == "ok", "HTTPS_API_HEALTH_FAILED")
        if path.startswith("/assets/"): require(body and "text/html" not in headers.get("content-type", ""), "HTTPS_BUILT_ASSET_FAILED")
        results[path] = {"status": status, "sha256": sha256(body)}
    require(results == expected, "HTTPS_LOCAL_APPLICATION_MISMATCH")
    connection = http.client.HTTPConnection(PUBLIC_IP, 80, timeout=5)
    try:
        connection.request("GET", "/", headers={"Host": PUBLIC_IP, "Connection": "close"})
        response = connection.getresponse()
        require(response.status == 308 and response.getheader("Location") == ORIGIN + "/" and response.getheader("Set-Cookie") is None, "HTTPS_REDIRECT_REQUIRED")
    finally:
        connection.close()
    return {"http": results, "certificate": certificate, "redirect_status": 308}


def rollback(state):
    if state["rollback"] == "OWNED_CADDY_STOPPED": return
    if state["owned_invocation"] is None:
        if state["start_attempted"]: state["rollback"] = "UNKNOWN_RECONCILE"
        return
    try:
        current = check_caddy_identity(inactive=False)
        require(current["InvocationID"] == state["owned_invocation"], "CADDY_INVOCATION_OWNERSHIP_CHANGED")
        command(["/usr/bin/systemctl", "stop", "caddy.service"], timeout=45)
        after = check_caddy_identity(inactive=True)
        require(after["ActiveState"] == "inactive", "OWNED_CADDY_STOP_UNCONFIRMED")
        state["rollback"] = "OWNED_CADDY_STOPPED"
    except BaseException:
        state["rollback"] = "UNKNOWN_RECONCILE"


def activate(data, state):
    state["phase"] = "VERIFY_LOCAL_HANDOFF"
    handoff = read_handoff(data)
    tool = shutil.which("ip", path="/usr/sbin:/usr/bin:/sbin:/bin")
    require(tool is not None and re.search(r"\binet " + re.escape(PUBLIC_IP) + r"/\d+\b", command([tool, "-4", "-o", "address", "show"], capture=True)), "FIXED_HOST_ADDRESS_REQUIRED")
    database_before = check_application(data, handoff)
    previous = check_caddy_identity(inactive=True)
    check_listeners(before=True)
    version = command([str(CADDY_BINARY), "version"], capture=True)
    require(version.startswith("v2.11.4 "), "PREPARED_CADDY_VERSION_CHANGED")
    command(["/usr/bin/unshare", "--net", "--", "/usr/sbin/runuser", "-u", "caddy", "--", "/usr/bin/env", "-i",
             "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/var/lib/caddy", "XDG_DATA_HOME=/var/lib/caddy/data", "XDG_CONFIG_HOME=/var/lib/caddy/config",
             "PUBLIC_IPV4=" + PUBLIC_IP, str(CADDY_BINARY), "validate", "--config", str(CADDY_CONFIG), "--adapter", "caddyfile"], timeout=30)
    check_caddy_identity(inactive=True)
    local.check_hashes(data["approved"])
    state["nonce"], state["phase"] = secrets.token_hex(16), "START_PREPARED_CADDY"
    attempt = {"schema": 1, "nonce": state["nonce"], "input_sha256": canonical(data), "commit": data["approved"]["commit"],
               "local_outer_sha256": data["local_outer_sha256"], "previous_invocation": previous["InvocationID"]}
    write_new(STAGE / "evidence/https-start-attempt.json", (json.dumps(attempt, sort_keys=True) + "\n").encode())
    state["attempt_recorded"] = True
    sync_directory(STAGE / "evidence")
    state["start_attempted"] = True
    command(["/usr/bin/systemctl", "start", "--job-mode=fail", "caddy.service"], timeout=90)
    current = check_caddy_identity(inactive=False)
    require(current["ActiveState"] == "active" and current["SubState"] == "running" and int(current["MainPID"]) > 0
            and current["InvocationID"] and current["InvocationID"] != previous["InvocationID"], "NEW_CADDY_INVOCATION_REQUIRED")
    state["owned_invocation"] = current["InvocationID"]
    state["phase"] = "TRUSTED_HTTPS_ACCEPTANCE"
    state["https"] = public_acceptance(handoff["accepted"]["local_http"])
    check_listeners(before=False)
    require(check_application(data, handoff) == database_before, "DATABASE_CHANGED_DURING_HTTPS_ACCEPTANCE")
    final = check_caddy_identity(inactive=False)
    require(final["InvocationID"] == state["owned_invocation"] and final["ActiveState"] == "active" and final["SubState"] == "running"
            and int(final["MainPID"]) > 0, "CADDY_CHANGED_DURING_HTTPS_ACCEPTANCE")
    state.update(result="HTTPS_ACCEPTED_ONLY", phase="HTTPS_ACCEPTANCE_COMPLETE")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    state = {"schema": 1, "result": "FAIL", "phase": "VALIDATE_INPUT", "error": None, "nonce": None,
             "attempt_recorded": False, "start_attempted": False, "owned_invocation": None, "rollback": "NOT_NEEDED", "https": {},
             "database_policy_changed": False, "boot_enabled": False, "provider_requests": 0, "full_launch_accepted": False,
             "remaining": ["EXTERNAL_BROWSER_ACCEPTANCE", "DATABASE_PERSISTENT_POLICY", "BOOT_ENABLEMENT", "BACKUP_AND_USER_LAUNCH"]}
    lock, data = None, None
    try:
        require(len(argv) == 3 and argv[:2] == ["--activate-prepared-https", "--private-input"], "EXPLICIT_HTTPS_ACTIVATION_REQUIRED")
        data = validate_input(json.loads(private_read(Path(argv[2]), limit=131072)))
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        private_read(LOCK)
        lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activate(data, state)
    except BaseException as error:
        category = str(error)
        state["result"], state["error"] = "FAIL", category if isinstance(error, (Error, outer.Error, local.stage.Error)) and re.fullmatch(r"[A-Z_]{1,90}", category) else "HTTPS_FAILED_PRIVATE_STATE_PRESERVED"
        if state["start_attempted"]: rollback(state)
    finally:
        if state["attempt_recorded"]:
            try:
                record = dict(state, result="CHECKPOINT_ONLY", requires_matching_outer_success=True, checkpoint_kind="HTTPS_OBSERVATIONS_NOT_A_LAUNCH_HANDOFF",
                              commit=data["approved"]["commit"], input_sha256=canonical(data), local_outer_sha256=data["local_outer_sha256"])
                write_new(STAGE / "evidence/https-start-result.json", (json.dumps(record, sort_keys=True) + "\n").encode())
                sync_directory(STAGE / "evidence")
            except BaseException:
                state["result"], state["error"] = "FAIL", "HTTPS_RESULT_NOT_DURABLE"
                if state["start_attempted"]: rollback(state)
        if lock is not None: os.close(lock)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "HTTPS_ACCEPTED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, local.preparation.shared["interrupted"])
    signal.signal(signal.SIGINT, local.preparation.shared["interrupted"])
    raise SystemExit(main())
