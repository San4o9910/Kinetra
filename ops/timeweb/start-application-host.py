#!/usr/bin/env python3
"""Dormant guest-only local activation; never starts Caddy or changes DB policy.

The outer caller must verify current CI/image provenance, both successful host
handoffs including SSH-key cleanup, fixed Timeweb identity and pinned SSH.
Success means private/local application acceptance, not HTTPS or user launch.
The persistent result is a checkpoint, never an activation handoff: a later
phase must require matching successful outer stdout/key cleanup and reinspect
the recorded live container identities. A checkpoint alone authorizes nothing.
"""
from __future__ import annotations

import fcntl
import hashlib
import http.client
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import secrets
import signal
import stat
import sys
import time

# Load exactly the reviewed helpers, never their CLI entrypoints.
HELPER_HASHES = {
    "activate-application-host.py": "73e2a6c2389206c11712d96e3a4736da481e6ab4d0494dc088abc6f447f9ea72",
    "initialize-database-host.py": "041f415dedf6b0b6922484281926c8c98c87828506dcb2e1ac6fb324b00b05bb",
    "prepare-database-host.py": "4621b1c0153ab56ae535e245fdb2de4ef2aff4a30ba5b592343a26795f0655ae",
    "bootstrap-server.py": "a19aca3ea953feecdcb9be6e9dcabdfc8b0e2b4f3938184391cdfb2ff3e87c9e",
    "inspect-server.py": "567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0",
}
for name, digest in HELPER_HASHES.items():
    path = Path(__file__).with_name(name)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError("REVIEWED_ACTIVATION_HELPER_REQUIRED")
_spec = importlib.util.spec_from_file_location("kinetra_api_preparation", Path(__file__).with_name("activate-application-host.py"))
preparation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(preparation)
Error = preparation.Error
stage = preparation.stage
initialization = preparation.initialization
require = preparation.require
private_read = preparation.private_read
public_source = preparation.public_source
parse_env = preparation.parse_env
sha256 = preparation.sha256
command = preparation.command
write_new = preparation.write_new
safe_parent = preparation.safe_parent
sync_directory = preparation.sync_directory
STAGE = Path("/srv/kinetra-stage")
LOCK = Path("/run/kinetra-database-stage.lock")
SERVER_ID = 9069403
PUBLIC_IP = "80.68.156.131"
PROJECT = "kinetra-production"
EVIDENCE_FILES = ("stage.json", "initialization.json", "application-env-attempt.json", "application-env.json")
CONFIG_FILES = ("env/production.env", "env/single-server.env", "env/api.env", "env/jobs/migrate.env", "edge/nginx-real-ip.conf")
INPUT_KEYS = {"schema", "server_id", "public_ipv4", "commit", "images", "source_hashes", "migration_hashes", "handoff_hashes", "configuration_hashes"}
CID = re.compile(r"[a-f0-9]{64}")
SERVICE_LABEL = "com.kinetra.activation"


def validate_input(data):
    require(isinstance(data, dict) and set(data) == INPUT_KEYS, "ACTIVATION_INPUT_INVALID")
    require(type(data["schema"]) is int and data["schema"] == 1 and type(data["server_id"]) is int
            and data["server_id"] == SERVER_ID and data["public_ipv4"] == PUBLIC_IP, "FIXED_SERVER_REQUIRED")
    require(isinstance(data["images"], dict) and set(data["images"]) == set(stage.IMAGE_PATTERNS), "IMAGE_SET_INVALID")
    stage.metadata({"APPROVED_APP_COMMIT": data["commit"], **data["images"]})
    require(re.fullmatch(r"(?:docker\.io/library/)?postgres:17(?:\.[0-9]+)?-bookworm@sha256:[a-f0-9]{64}", data["images"]["POSTGRES_IMAGE"]), "TAGGED_POSTGRES_DIGEST_REQUIRED")
    for name, keys in (("source_hashes", stage.SOURCE_PATHS), ("migration_hashes", initialization.MIGRATIONS),
                       ("handoff_hashes", EVIDENCE_FILES), ("configuration_hashes", CONFIG_FILES)):
        values = data[name]
        require(isinstance(values, dict) and set(values) == set(keys)
                and all(isinstance(value, str) and CID.fullmatch(value) for value in values.values()), "APPROVED_HASH_SET_INVALID")
    return data


def check_hashes(data):
    evidence = {}
    for name, digest in data["handoff_hashes"].items():
        raw = private_read(STAGE / "evidence" / name)
        require(sha256(raw) == digest, "HANDOFF_EVIDENCE_CHANGED")
        evidence[name] = json.loads(raw)
    for name, digest in data["source_hashes"].items():
        require(sha256(public_source(STAGE / "source" / name)) == digest, "STAGED_SOURCE_CHANGED")
    for name, digest in data["configuration_hashes"].items():
        raw = public_source(STAGE / name) if name.startswith("edge/") else private_read(STAGE / name)
        require(sha256(raw) == digest, "PREPARED_CONFIGURATION_CHANGED")
    return evidence


def read_handoff(data):
    safe_parent(STAGE)
    require(stat.S_IMODE(STAGE.stat().st_mode) == 0o700, "STAGE_PRIVACY_INVALID")
    records = check_hashes(data)
    staged, initialized = records["stage.json"], records["initialization.json"]
    stage.validate_stage_result(json.dumps({k: v for k, v in staged.items() if k not in {"images", "source_hashes"}}))
    initialization.validate_initialization_result(json.dumps({k: v for k, v in initialized.items() if k not in {"images", "migration_hashes"}}))
    require(staged["result"] == "STAGED_ONLY" and initialized["result"] == "DATABASE_INITIALIZED_ONLY", "SUCCESSFUL_DATABASE_HANDOFF_REQUIRED")
    for record in (staged, initialized):
        require(record["commit"] == data["commit"] and record["images"] == data["images"], "HANDOFF_IDENTITY_MISMATCH")
    require(staged["source_hashes"] == data["source_hashes"] and initialized["migration_hashes"] == data["migration_hashes"], "HANDOFF_HASH_SET_MISMATCH")
    prepared, attempt = records["application-env.json"], records["application-env-attempt.json"]
    require(prepared.get("schema") == 1 and prepared.get("result") == "API_ENVIRONMENT_PREPARED_ONLY"
            and prepared.get("phase") == "API_ENVIRONMENT_PREPARATION_COMPLETE" and prepared.get("error") is None
            and prepared.get("api_environment_installed") is True and prepared.get("application_started") is False
            and prepared.get("caddy_started") is False and prepared.get("provider_requests") == 0,
            "SUCCESSFUL_ENVIRONMENT_HANDOFF_REQUIRED")
    for key in ("commit", "images", "source_hashes", "migration_hashes"):
        require(prepared.get(key) == data[key], "PREPARED_ENVIRONMENT_IDENTITY_MISMATCH")
    folder = prepared.get("candidate_directory", "")
    require(isinstance(folder, str) and re.fullmatch(r"api-preparation-[a-f0-9]{32}", folder), "PREPARED_DIRECTORY_INVALID")
    require(attempt.get("schema") == 1 and attempt.get("commit") == data["commit"] and attempt.get("images") == data["images"]
            and attempt.get("candidate_directory") == folder, "PREPARATION_ATTEMPT_MISMATCH")
    api = private_read(STAGE / "env/api.env")
    require(prepared.get("api_sha256") == sha256(api) and private_read(STAGE / "env" / folder / "api.env") == api,
            "VALIDATED_API_ENVIRONMENT_CHANGED")
    require(sha256(private_read(STAGE / "env" / folder / "previous-api.env")) == attempt.get("previous_api_sha256"), "PREVIOUS_ENVIRONMENT_CHANGED")
    expected = {key: data["images"][key] for key in ("NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE")}
    expected.update(VCS_REF=data["commit"], VITE_API_URL="https://" + PUBLIC_IP, VITE_PRIVATE_MEDIA_ORIGIN="",
                    KINETRA_API_ENV_FILE=str(STAGE / "env/api.env"), KINETRA_VIDEO_SCRATCH_DIR="")
    require(parse_env(private_read(STAGE / "env/production.env")) == expected, "PUBLIC_METADATA_CHANGED")
    values = parse_env(api)
    require(all(values.get(key) == "false" for key in ("CHAT_ENABLED", "CHAT_PHOTO_UPLOADS_ENABLED", "TRAINER_VIDEO_UPLOADS_ENABLED")), "MEDIA_FLAGS_MUST_REMAIN_DISABLED")
    for name in ("application-start-attempt.json", "application-start-result.json"):
        path = STAGE / "evidence" / name
        require(not path.exists() and not path.is_symlink(), "EXISTING_ACTIVATION_ATTEMPT_PRESERVED")
    return {"staged": staged, "initialized": initialized, "prepared": prepared}


def compose(arguments, override, *, timeout=30, capture=False):
    prefix = ["/usr/bin/env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C",
              "/usr/bin/docker", "compose", "--project-name", PROJECT,
              "--env-file", str(STAGE / "env/production.env"), "--env-file", str(STAGE / "env/single-server.env"),
              "-f", str(STAGE / "source/deploy/compose.production.yml"), "-f", str(STAGE / "source/deploy/compose.single-server.yml"),
              "-f", str(override)]
    return command(prefix + arguments, timeout=timeout, capture=capture)


def inspect_container(identifier):
    require(isinstance(identifier, str) and CID.fullmatch(identifier), "CONTAINER_ID_REQUIRED")
    # Never fetch Config.Env, health logs, provider secrets or arbitrary labels.
    template = '{"id":{{json .Id}},"image":{{json .Config.Image}},"image_id":{{json .Image}},"user":{{json .Config.User}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"nonce":{{json (index .Config.Labels "com.kinetra.activation")}},"running":{{json .State.Running}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"cap_drop":{{json .HostConfig.CapDrop}},"cap_add":{{json .HostConfig.CapAdd}},"security":{{json .HostConfig.SecurityOpt}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}},"restart":{{json .HostConfig.RestartPolicy.Name}}}'
    return json.loads(command(["/usr/bin/docker", "inspect", "--type", "container", "--format", template, identifier], capture=True))


def candidate_ids(service, nonce):
    require(service in {"backend", "frontend"} and re.fullmatch(r"[a-f0-9]{32}", nonce), "OWNERSHIP_SCOPE_INVALID")
    values = command(["/usr/bin/docker", "container", "ls", "--all", "--quiet", "--no-trunc",
                      "--filter", "label=com.docker.compose.project=" + PROJECT,
                      "--filter", "label=com.docker.compose.service=" + service,
                      "--filter", "label=" + SERVICE_LABEL + "=" + nonce], capture=True).splitlines()
    require(len(values) <= 1 and all(CID.fullmatch(value) for value in values), "OWNED_CONTAINER_SET_AMBIGUOUS")
    return values


def check_owned(info, service, data, nonce, expected_id=None):
    require(info.get("project") == PROJECT and info.get("service") == service and info.get("nonce") == nonce
            and info.get("image") == data["images"][service.upper() + "_IMAGE"] and CID.fullmatch(info.get("id", ""))
            and (expected_id is None or info["id"] == expected_id), "ACTIVATION_CONTAINER_OWNERSHIP_MISMATCH")


def check_runtime(info, service, data, nonce, network_id, database_network_id):
    check_owned(info, service, data, nonce)
    expected_user = "1000:1000" if service == "backend" else "101:101"
    require(info.get("user") == expected_user and info.get("readonly") is True and info.get("cap_drop") == ["ALL"]
            and not info.get("cap_add") and info.get("security") == ["no-new-privileges:true"]
            and info.get("restart") == "unless-stopped", "APPLICATION_CONTAINER_SANDBOX_MISMATCH")
    image_id = command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", info["image"]], capture=True).strip()
    require(info.get("image_id") == image_id, "APPLICATION_IMAGE_ID_MISMATCH")
    networks = info.get("networks", {})
    expected_networks = {PROJECT + "_backend": network_id}
    if service == "backend": expected_networks[PROJECT + "_database"] = database_network_id
    require(set(networks) == set(expected_networks) and all(networks[name].get("NetworkID") == value for name, value in expected_networks.items()), "APPLICATION_NETWORK_MISMATCH")
    published = {key: value for key, value in (info.get("ports") or {}).items() if value}
    expected_ports = {} if service == "backend" else {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}
    require(published == expected_ports, "APPLICATION_PORT_PUBLICATION_REFUSED")
    mounts = info.get("mounts", [])
    expected_mount = (str(STAGE / "tls/issued/public/ca.crt"), "/run/kinetra/postgres-ca.crt") if service == "backend" else (str(STAGE / "edge"), "/etc/nginx/kinetra-edge")
    binds = [item for item in mounts if item.get("Type") == "bind"]
    require(len(binds) == 1 and binds[0].get("RW") is False
            and (binds[0].get("Source"), binds[0].get("Destination")) == expected_mount
            and all(item.get("Type") == "bind" or (item.get("Type") == "tmpfs" and item.get("Destination") == "/tmp") for item in mounts), "APPLICATION_MOUNTS_MISMATCH")


def database_readonly_handoff(postgres_id, expected):
    sql = "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT json_build_object('version',current_setting('server_version_num')::integer,'migrations',(SELECT json_object_agg(filename,checksum) FROM schema_migrations)); COMMIT;"
    output = command(["/usr/bin/docker", "exec", "--user", "999:999", postgres_id, "psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align",
                      "--username", "kinetra_bootstrap", "--dbname", "kinetra", "--set", "ON_ERROR_STOP=1", "--command", sql], timeout=15, capture=True)
    result = json.loads(output)
    require(type(result.get("version")) is int and 170000 <= result["version"] < 180000 and result.get("migrations") == expected, "READONLY_MIGRATION_HANDOFF_MISMATCH")


def wait_for_backend(identifier, *, seconds=150):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        info = inspect_container(identifier)
        if info.get("running") is True and info.get("health") == "healthy": return
        require(info.get("status") in {"created", "running"} and info.get("health") in {None, "starting"}, "BACKEND_HEALTH_FAILED")
        time.sleep(2)
    raise Error("BACKEND_HEALTH_DEADLINE")


def backend_ready(identifier):
    program = "const r=await fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)});const j=await r.json();if(r.status!==200||j.status!=='ready')process.exit(1);console.log('KINETRA_BACKEND_READY=PASS');"
    output = command(["/usr/bin/docker", "exec", "--user", "1000:1000", identifier, "node", "--input-type=module", "-e", program], timeout=10, capture=True)
    require(output.strip() == "KINETRA_BACKEND_READY=PASS", "BACKEND_READINESS_REJECTED")


def wait_for_frontend_listener(*, seconds=30):
    # Only transport readiness is retried. HTTP status, CSP and asset failures
    # are evaluated once by the strict acceptance phase below.
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=1)
        try:
            connection.connect()
            return
        except (ConnectionRefusedError, ConnectionResetError, TimeoutError, http.client.RemoteDisconnected):
            pass
        finally:
            connection.close()
        time.sleep(1)
    raise Error("FRONTEND_LISTENER_DEADLINE")


def local_get(path):
    require(path.startswith("/") and not path.startswith("//") and not re.search(r"[\x00-\x20\x7f]", path), "LOCAL_HTTP_PATH_INVALID")
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
    try:
        connection.request("GET", path, headers={"Host": PUBLIC_IP, "Connection": "close"})
        response = connection.getresponse()
        body = response.read(2_097_153)
        require(len(body) <= 2_097_152, "LOCAL_HTTP_BODY_TOO_LARGE")
        return response.status, {key.lower(): value for key, value in response.getheaders()}, body
    finally:
        connection.close()


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        path = attributes.get("src") if tag == "script" else attributes.get("href") if tag == "link" and attributes.get("rel") == "stylesheet" else None
        if path is not None:
            require(re.fullmatch(r"/assets/[A-Za-z0-9_./-]+\.(?:js|css)", path) and ".." not in path, "UNREVIEWED_ASSET_ORIGIN")
            self.paths.add(path)


def local_acceptance():
    status, headers, body = local_get("/")
    require(status == 200 and "text/html" in headers.get("content-type", ""), "LOCAL_SHELL_HTTP_FAILED")
    require(headers.get("x-content-type-options") == "nosniff" and headers.get("x-frame-options") == "DENY"
            and headers.get("referrer-policy") == "no-referrer", "LOCAL_SECURITY_HEADERS_MISSING")
    csp = headers.get("content-security-policy", "")
    directives = [item.strip() for item in csp.split(";") if item.strip()]
    require(all(item in directives for item in ("default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"))
            and len({item.split()[0] for item in directives}) == len(directives), "LOCAL_CSP_REJECTED")
    parser = Assets()
    parser.feed(body.decode("utf8"))
    require(2 <= len(parser.paths) <= 12 and any(path.endswith(".js") for path in parser.paths) and any(path.endswith(".css") for path in parser.paths), "REAL_BUILT_ASSETS_REQUIRED")
    results = {"/": {"status": status, "sha256": sha256(body)}}
    for path in sorted(parser.paths):
        status, headers, body = local_get(path)
        require(status == 200 and body and "text/html" not in headers.get("content-type", ""), "LOCAL_BUILT_ASSET_FAILED")
        results[path] = {"status": status, "sha256": sha256(body)}
    for path, expected in (("/health", 200), ("/ready", 404), ("/api/v1/me", 401)):
        status, headers, body = local_get(path)
        require(status == expected and "set-cookie" not in headers, "LOCAL_API_BOUNDARY_FAILED")
        if path == "/api/v1/me": require("no-store" in headers.get("cache-control", "").split(","), "API_NO_STORE_REQUIRED")
        if path == "/health": require(json.loads(body).get("status") == "ok", "LOCAL_API_HEALTH_FAILED")
        results[path] = {"status": status, "sha256": sha256(body)}
    return results


def rollback(data, state):
    for service in ("frontend", "backend"):
        if service not in state["attempted_services"]: continue
        try:
            identifiers = candidate_ids(service, state["nonce"])
            known = state["owned_containers"].get(service)
            require(known is None or identifiers == [known], "OWNED_CONTAINER_DISAPPEARED_OR_CHANGED")
            if not identifiers:
                # A timed-out create may finish later, but --no-start cannot
                # make that late-created container run an application.
                state["rollback"][service] = "NO_CONTAINER_OBSERVED"
                continue
            info = inspect_container(identifiers[0])
            check_owned(info, service, data, state["nonce"], known)
            state["owned_containers"][service] = info["id"]
            if info.get("running") is True:
                command(["/usr/bin/docker", "stop", "--time", "35" if service == "backend" else "15", info["id"]], timeout=45)
            after = inspect_container(info["id"])
            check_owned(after, service, data, state["nonce"], info["id"])
            require(after.get("running") is False, "OWNED_CONTAINER_STOP_NOT_CONFIRMED")
            state["rollback"][service] = (
                "UNCONFIRMED_REQUIRES_REVIEW" if service in state["uncertain_start_services"]
                else "STOPPED" if service in state["start_attempted_services"] else "CREATED_NOT_STARTED"
            )
        except BaseException:
            state["rollback"][service] = "UNCONFIRMED_REQUIRES_REVIEW"


def activate(data, state):
    handoff = read_handoff(data)
    preparation.check_live_identity(data, handoff)
    preparation.validate_candidate(data["images"]["BACKEND_IMAGE"], STAGE / "env/production.env", STAGE / "env/api.env")
    postgres_id = handoff["initialized"]["postgres_id"]
    database_readonly_handoff(postgres_id, data["migration_hashes"])
    preparation.check_live_identity(data, handoff)
    database_before = inspect_container(postgres_id)
    db_network_id = database_before["networks"][PROJECT + "_database"]["NetworkID"]
    check_hashes(data)
    state["nonce"] = secrets.token_hex(16)
    state["phase"] = "START_BACKEND"
    attempt = dict(data, nonce=state["nonce"], phase=state["phase"])
    write_new(STAGE / "evidence/application-start-attempt.json", (json.dumps(attempt, sort_keys=True) + "\n").encode())
    state["attempt_recorded"] = True
    sync_directory(STAGE / "evidence")
    override = STAGE / "evidence" / ("application-" + state["nonce"] + ".compose.json")
    write_new(override, (json.dumps({"services": {name: {"labels": {SERVICE_LABEL: state["nonce"]}} for name in ("backend", "frontend")}}) + "\n").encode())
    sync_directory(STAGE / "evidence")
    compose(["config", "--quiet"], override)
    for service in ("backend", "frontend"):
        state["phase"] = "START_" + service.upper()
        check_hashes(data)
        state["attempted_services"].append(service)
        # Create first without starting: even an indeterminate Compose timeout
        # cannot leave a running service whose ID this invocation never learned.
        compose(["up", "--no-start", "--no-deps", "--no-build", "--pull", "never", service], override, timeout=120)
        identifiers = candidate_ids(service, state["nonce"])
        require(len(identifiers) == 1, "CREATED_CONTAINER_ID_REQUIRED")
        info = inspect_container(identifiers[0])
        check_owned(info, service, data, state["nonce"])
        state["owned_containers"][service] = info["id"]
        require(info.get("running") is False and info.get("status") == "created", "CREATED_APPLICATION_MUST_NOT_ALREADY_RUN")
        state["start_attempted_services"].append(service)
        try:
            command(["/usr/bin/docker", "start", info["id"]], timeout=60)
        except BaseException:
            state["uncertain_start_services"].append(service)
            raise
        info = inspect_container(info["id"])
        check_runtime(info, service, data, state["nonce"], handoff["staged"]["network_id"], db_network_id)
        if service == "backend":
            wait_for_backend(info["id"])
            backend_ready(info["id"])
        else:
            require(info.get("running") is True, "FRONTEND_NOT_RUNNING")
            command(["/usr/bin/docker", "exec", "--user", "101:101", info["id"], "nginx", "-t"], timeout=10)
    state["phase"] = "LOCAL_ACCEPTANCE"
    wait_for_frontend_listener()
    state["local_http"] = local_acceptance()
    for service, identifier in state["owned_containers"].items():
        info = inspect_container(identifier)
        check_runtime(info, service, data, state["nonce"], handoff["staged"]["network_id"], db_network_id)
        require(info.get("running") is True and (service != "backend" or info.get("health") == "healthy"), "APPLICATION_EXITED_DURING_ACCEPTANCE")
    identifiers = command(["/usr/bin/docker", "container", "ls", "--all", "--quiet", "--no-trunc"], capture=True).splitlines()
    require(set(identifiers) == {postgres_id, *state["owned_containers"].values()}, "UNEXPECTED_PERSISTENT_CONTAINER")
    database = inspect_container(postgres_id)
    require(database.get("running") is True and database.get("health") == "healthy" and database.get("restart") == "no", "DATABASE_STATE_CHANGED")
    require(all(database.get(key) == database_before.get(key) for key in (
        "id", "image", "image_id", "user", "project", "service", "readonly", "cap_drop", "cap_add", "security", "ports", "networks", "mounts", "restart"
    )), "DATABASE_ISOLATION_CHANGED")
    listeners = command(["/usr/bin/ss", "-H", "-lnt"], capture=True)
    for line in listeners.splitlines():
        fields = line.split()
        require(len(fields) >= 4, "HOST_LISTENER_OUTPUT_INVALID")
        address, _, port = fields[3].rpartition(":")
        require(port not in {"3000", "5432"} and (port != "8080" or address == "127.0.0.1"), "UNEXPECTED_PUBLIC_APP_OR_DATABASE_LISTENER")
    for property_name, expected in (("ActiveState", "inactive"), ("UnitFileState", "disabled")):
        require(command(["/usr/bin/systemctl", "show", "--property=" + property_name, "--value", "caddy.service"], capture=True).strip() == expected, "CADDY_STATE_CHANGED")
    check_hashes(data)
    state.update(result="APPLICATION_LOCAL_ACCEPTED_ONLY", phase="LOCAL_APPLICATION_ACCEPTANCE_COMPLETE")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    state = {"schema": 1, "result": "FAIL", "phase": "VALIDATE_INPUT", "error": None, "nonce": None,
             "attempt_recorded": False, "attempted_services": [], "start_attempted_services": [], "uncertain_start_services": [],
             "owned_containers": {}, "rollback": {}, "local_http": {},
             "caddy_started": False, "database_policy_changed": False, "provider_requests": 0,
             "remaining": ["CADDY_IDENTITY_AND_HTTPS", "DATABASE_PERSISTENT_POLICY", "BOOT_ENABLEMENT", "BROWSER_ACCEPTANCE", "BACKUP_AND_USER_LAUNCH"]}
    lock, data = None, None
    try:
        require(len(argv) == 3 and argv[:2] == ["--start-validated-local-application", "--private-input"], "EXPLICIT_LOCAL_ACTIVATION_REQUIRED")
        data = validate_input(json.loads(private_read(Path(argv[2]))))
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        private_read(LOCK)
        lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state["phase"] = "VERIFY_HANDOFF"
        activate(data, state)
    except BaseException as error:
        state["result"] = "FAIL"
        category = str(error)
        state["error"] = category if isinstance(error, (Error, stage.Error)) and re.fullmatch(r"[A-Z_]{1,90}", category) else "ACTIVATION_FAILED_PRIVATE_STATE_PRESERVED"
        if data is not None and state["attempted_services"]: rollback(data, state)
    finally:
        if state["attempt_recorded"]:
            try:
                # Never persist authoritative acceptance before final fsync.
                # Even if the file is written and fsync then fails/rolls back,
                # it remains explicitly unsuitable as a next-phase handoff.
                record = dict(state, result="CHECKPOINT_ONLY", requires_matching_outer_success=True,
                              checkpoint_kind="LOCAL_OBSERVATIONS_NOT_AN_ACTIVATION_HANDOFF",
                              commit=data["commit"], images=data["images"], handoff_hashes=data["handoff_hashes"], configuration_hashes=data["configuration_hashes"])
                write_new(STAGE / "evidence/application-start-result.json", (json.dumps(record, sort_keys=True) + "\n").encode())
                sync_directory(STAGE / "evidence")
            except BaseException:
                state["result"], state["error"] = "FAIL", "ACTIVATION_RESULT_NOT_DURABLE"
                if data is not None and state["attempted_services"]: rollback(data, state)
        if lock is not None: os.close(lock)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, preparation.shared["interrupted"])
    signal.signal(signal.SIGINT, preparation.shared["interrupted"])
    raise SystemExit(main())
