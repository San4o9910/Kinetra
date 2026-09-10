#!/usr/bin/env python3
"""Prepare and validate API credentials on the already initialized fixed host.

Guest-only, explicit CLI; no SSH/API client or live workflow. The caller must
verify server 9069403 and pinned SSH plus current source/image CI provenance.
This completed phase never starts app/edge services, jobs or provider requests.
Private candidates, previous credentials and failure evidence are preserved.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shutil
import signal
import stat
import sys
from urllib.parse import urlsplit

_spec = importlib.util.spec_from_file_location("kinetra_db_init", Path(__file__).with_name("initialize-database-host.py"))
initialization = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(initialization)
stage = initialization.stage
helpers = {"__name__": "kinetra_api_preparation_helpers"}
exec(compile(initialization.GUEST_INITIALIZE, "<reviewed-database-helpers>", "exec"), helpers)
shared = helpers["shared"]
Error = shared["StageError"]
command = shared["command"]
disposable = shared["disposable_container"]
safe_parent = shared["safe_parent"]
write_new = shared["write_new"]
STAGE = Path("/srv/kinetra-stage")
LOCK = Path("/run/kinetra-database-stage.lock")
SERVER_ID = 9069403
PUBLIC_IP = "80.68.156.131"
ORIGIN = "https://" + PUBLIC_IP
PROVIDERS = ("YUKASSA_SHOP_ID", "YUKASSA_SECRET_KEY", "AUTH_TOKEN_DELIVERY_WEBHOOK_URL", "AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET")
PRIVATE_INPUT_KEYS = {"schema", "server_id", "public_ipv4", "commit", "images", "source_hashes", "migration_hashes", "providers"}
BAD_VALUE = re.compile(r"replace|example|change[_-]?me|placeholder|dummy|fake|local.only", re.I)


def require(condition, category):
    if not condition:
        raise Error(category)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def private_read(path, *, uid=0, mode=0o600, limit=65536):
    require(path.is_absolute(), "ABSOLUTE_PRIVATE_PATH_REQUIRED")
    safe_parent(path.parent)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == mode
                and info.st_size <= limit, "PRIVATE_FILE_IDENTITY_INVALID")
        value = stream.read(limit + 1)
    require(len(value) <= limit, "PRIVATE_FILE_TOO_LARGE")
    return value


def public_source(path):
    return private_read(path, mode=0o644, limit=262144)


def parse_env(raw):
    values = {}
    for line in raw.decode("ascii").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        require(match is not None and match[1] not in values and match[2] == match[2].strip()
                and not re.search(r"[\x00-\x1f\x7f$'\"`]", match[2]), "ENV_SYNTAX_INVALID")
        values[match[1]] = match[2]
    return values


def env_bytes(values):
    value = "".join(key + "=" + item + "\n" for key, item in values.items()).encode("ascii")
    require(parse_env(value) == values, "ENV_SERIALIZATION_INVALID")
    return value


def validate_input(data):
    require(isinstance(data, dict) and set(data) == PRIVATE_INPUT_KEYS, "PRIVATE_INPUT_SHAPE_INVALID")
    require(type(data["schema"]) is int and data["schema"] == 1 and type(data["server_id"]) is int
            and data["server_id"] == SERVER_ID and data["public_ipv4"] == PUBLIC_IP, "FIXED_SERVER_REQUIRED")
    providers = data["providers"]
    # Validate every missing/unsafe provider input before any host command,
    # lock, key generation, temporary directory or file mutation.
    require(isinstance(providers, dict) and set(providers) == set(PROVIDERS), "REQUIRED_PROVIDER_INPUTS_MISSING")
    for key in PROVIDERS:
        value = providers[key]
        require(isinstance(value, str) and 1 <= len(value) <= 2048 and value == value.strip()
                and not BAD_VALUE.search(value) and not re.search(r"[^!-~]|[$'\"`]", value), "PROVIDER_INPUT_INVALID")
    require(32 <= len(providers["AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET"]) <= 512, "DELIVERY_SECRET_INVALID")
    try:
        url = urlsplit(providers["AUTH_TOKEN_DELIVERY_WEBHOOK_URL"])
        port = url.port
    except ValueError:
        raise Error("DELIVERY_URL_INVALID") from None
    require(url.scheme == "https" and url.hostname and not url.username and not url.password
            and not url.query and not url.fragment and url.hostname != "localhost"
            and not url.hostname.endswith((".localhost", ".invalid", ".local"))
            and (port is None or 1 <= port <= 65535), "DELIVERY_URL_INVALID")
    try:
        require(ipaddress.ip_address(url.hostname).is_global, "DELIVERY_URL_INVALID")
    except ValueError:
        pass  # Domain ownership/reachability is an operator/provider input, not an HTTP probe.
    require(isinstance(data["images"], dict) and set(data["images"]) == set(stage.IMAGE_PATTERNS), "IMAGE_SET_INVALID")
    stage.metadata({"APPROVED_APP_COMMIT": data["commit"], **data["images"]})
    require(re.fullmatch(r"(?:docker\.io/library/)?postgres:17(?:\.[0-9]+)?-bookworm@sha256:[a-f0-9]{64}",
                         data["images"]["POSTGRES_IMAGE"]), "APP_VALIDATOR_REQUIRES_TAGGED_POSTGRES_DIGEST")
    for name, keys in (("source_hashes", stage.SOURCE_PATHS), ("migration_hashes", initialization.MIGRATIONS)):
        values = data[name]
        require(isinstance(values, dict) and set(values) == set(keys)
                and all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in values.values()),
                "APPROVED_HASH_SET_INVALID")
    return data


def read_handoff(data):
    safe_parent(STAGE)
    require(stat.S_IMODE(STAGE.stat().st_mode) == 0o700, "STAGE_PRIVACY_INVALID")
    staged = json.loads(private_read(STAGE / "evidence/stage.json"))
    stage_core = {key: value for key, value in staged.items() if key not in {"images", "source_hashes"}}
    stage.validate_stage_result(json.dumps(stage_core))
    require(staged["result"] == "STAGED_ONLY" and staged["images"] == data["images"]
            and staged["source_hashes"] == data["source_hashes"] and staged["commit"] == data["commit"], "STAGE_IDENTITY_MISMATCH")
    initialized = json.loads(private_read(STAGE / "evidence/initialization.json"))
    init_core = {key: value for key, value in initialized.items() if key not in {"images", "migration_hashes"}}
    initialization.validate_initialization_result(json.dumps(init_core))
    require(initialized["result"] == "DATABASE_INITIALIZED_ONLY" and initialized["images"] == data["images"]
            and initialized["migration_hashes"] == data["migration_hashes"] and initialized["commit"] == data["commit"], "INITIALIZATION_IDENTITY_MISMATCH")
    for name, digest in data["source_hashes"].items():
        require(sha256(public_source(STAGE / "source" / name)) == digest, "STAGED_SOURCE_CHANGED")
    old_api = private_read(STAGE / "env/api.env")
    require(parse_env(old_api) == {"NODE_ENV": "production"}, "EXISTING_API_CREDENTIALS_PRESERVED")
    main = parse_env(private_read(STAGE / "env/production.env"))
    expected = {key: data["images"][key] for key in ("NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE")}
    expected.update(VCS_REF=data["commit"], VITE_API_URL=ORIGIN, VITE_PRIVATE_MEDIA_ORIGIN="",
                    KINETRA_API_ENV_FILE=str(STAGE / "env/api.env"), KINETRA_VIDEO_SCRATCH_DIR="")
    require(main == expected, "PUBLIC_METADATA_CHANGED")
    for name in ("application-env-attempt.json", "application-env.json"):
        path = STAGE / "evidence" / name
        require(not path.exists() and not path.is_symlink(), "EXISTING_PREPARATION_PRESERVED")
    return {"staged": staged, "initialized": initialized, "main": main, "old_api": old_api}


def check_live_identity(data, handoff):
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    ip_command = shutil.which("ip", path="/usr/sbin:/usr/bin:/sbin:/bin")
    require(ip_command is not None, "HOST_ADDRESS_TOOL_MISSING")
    addresses = command([ip_command, "-4", "-o", "address", "show"], capture=True)
    require(re.search(r"\binet " + re.escape(PUBLIC_IP) + r"/\d+\b", addresses), "ASSIGNED_HOST_ADDRESS_MISMATCH")
    for property_name, expected in (("ActiveState", "inactive"), ("UnitFileState", "disabled")):
        require(command(["/usr/bin/systemctl", "show", "--property=" + property_name, "--value", "caddy.service"], capture=True).strip() == expected,
                "CADDY_MUST_REMAIN_PREPARED_INACTIVE")
    helpers["final_isolation"](handoff["initialized"]["postgres_id"], data["images"]["POSTGRES_IMAGE"], handoff["staged"]["network_id"])
    database_state = json.loads(command(["/usr/bin/docker", "inspect", "--format", "{{json .State}}",
                                       handoff["initialized"]["postgres_id"]], capture=True))
    require(database_state.get("Running") is True and database_state.get("Health", {}).get("Status") == "healthy",
            "INITIALIZED_DATABASE_MUST_BE_HEALTHY")
    for key in ("BACKEND_IMAGE", "FRONTEND_IMAGE"):
        revision = command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', data["images"][key]], capture=True).strip()
        require(revision == data["commit"], "LOCAL_QUALIFIED_IMAGE_MISMATCH")


KEY_PROGRAM = """const {createECDH}=require('node:crypto');const pair=createECDH('prime256v1');pair.generateKeys();console.log(JSON.stringify({public:pair.getPublicKey().toString('base64url'),private:pair.getPrivateKey().toString('base64url')}));"""


def generate_vapid(image):
    raw = disposable(["--network", "none", "--log-driver", "none", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
                      "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m",
                      "--memory-swap", "128m", "--cpus", "0.25", "--entrypoint", "node"], image,
                     ["-e", KEY_PROGRAM], capture=True)
    values = json.loads(raw)
    require(isinstance(values, dict) and set(values) == {"public", "private"}, "VAPID_GENERATION_FAILED")
    for key, size in (("public", 65), ("private", 32)):
        require(isinstance(values[key], str) and re.fullmatch(r"[A-Za-z0-9_-]+", values[key]), "VAPID_GENERATION_FAILED")
        decoded = base64.urlsafe_b64decode(values[key] + "=" * (-len(values[key]) % 4))
        require(len(decoded) == size and (key != "public" or decoded[0] == 4), "VAPID_GENERATION_FAILED")
    return values


def api_values(data, vapid):
    password = private_read(STAGE / "postgres/secrets/api_password", uid=999).decode("ascii").removesuffix("\n")
    require(re.fullmatch(r"[A-Za-z0-9_-]{43,128}", password), "EXISTING_API_ROLE_SECRET_INVALID")
    return {
        "NODE_ENV": "production", "HOST": "0.0.0.0", "PORT": "3000",
        "DATABASE_URL": "postgresql://kinetra_api:" + password + "@postgres:5432/kinetra?sslmode=verify-full",
        "CORS_ORIGIN": ORIGIN, "TRUST_PROXY_HOPS": "1", "JWT_ACCESS_SECRET": secrets.token_urlsafe(48),
        "AUTH_REFRESH_COOKIE_SECURE": "true", "AUTH_TOKEN_DELIVERY_MODE": "webhook",
        "AUTH_TOKEN_DELIVERY_WEBHOOK_URL": data["providers"]["AUTH_TOKEN_DELIVERY_WEBHOOK_URL"],
        "AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET": data["providers"]["AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET"],
        "AUTH_TOKEN_DELIVERY_TIMEOUT_MS": "10000", "YUKASSA_SHOP_ID": data["providers"]["YUKASSA_SHOP_ID"],
        "YUKASSA_SECRET_KEY": data["providers"]["YUKASSA_SECRET_KEY"], "YUKASSA_RETURN_URL": ORIGIN + "/payment/success",
        "YUKASSA_REQUEST_TIMEOUT_MS": "10000", "VAPID_PUBLIC_KEY": vapid["public"], "VAPID_PRIVATE_KEY": vapid["private"],
        "VAPID_SUBJECT": ORIGIN, "CHAT_ENABLED": "false", "CHAT_PHOTO_UPLOADS_ENABLED": "false",
        "TRAINER_VIDEO_UPLOADS_ENABLED": "false", "S3_ENDPOINT": "", "S3_REGION": "", "S3_BUCKET": "",
        "S3_ACCESS_KEY_ID": "", "S3_SECRET_ACCESS_KEY": "", "S3_FORCE_PATH_STYLE": "false",
        "VIDEO_S3_SERVER_SIDE_ENCRYPTION": "AES256", "VIDEO_S3_KMS_KEY_ID": "",
        "READINESS_TIMEOUT_MS": "2000", "SHUTDOWN_DRAIN_MS": "5000", "SHUTDOWN_TIMEOUT_MS": "25000",
    }


def validate_candidate(image, main_file, api_file):
    mounts = [STAGE / "source", STAGE / "env", STAGE / "postgres/data", STAGE / "postgres/secrets",
              STAGE / "tls/issued/public/ca.crt", STAGE / "tls/issued/public/server.crt",
              STAGE / "tls/issued/server-private/server.key", STAGE / "edge"]
    options = ["--network", "none", "--log-driver", "none", "--user", "0:0", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
               "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.25"]
    for path in mounts:
        options.extend(["--mount", "type=bind,source=" + str(path) + ",target=" + str(path) + ",readonly"])
    output = disposable(options, image, ["node", str(STAGE / "source/deploy/postgres/validate-single-server.mjs"),
                         str(STAGE / "env/single-server.env"), str(main_file)], capture=True)
    require(output.strip() == "KINETRA_SINGLE_SERVER_CONFIG=VALIDATED_LOCAL (no service or required infrastructure gate executed)",
            "STRICT_API_VALIDATION_FAILED")
    output = disposable(["--network", "none", "--log-driver", "none", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
                         "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m",
                         "--memory-swap", "128m", "--cpus", "0.25", "--env-file", str(api_file), "--entrypoint", "node"], image,
                        ["--input-type=module", "-e", "await import('./apps/backend/dist/config/env.js');console.log('KINETRA_API_RUNTIME_ENV=PASS');"], capture=True)
    require(output.strip() == "KINETRA_API_RUNTIME_ENV=PASS", "COMPILED_API_ENV_REJECTED")


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def install_preserving_previous(candidate, previous, original, state):
    target = STAGE / "env/api.env"
    require(private_read(target) == original, "API_ENV_CHANGED_BEFORE_INSTALL")
    os.link(target, previous, follow_symlinks=False)
    require(private_read(previous) == original, "PREVIOUS_API_BACKUP_MISMATCH")
    install_link = candidate.parent / "install-api.env"
    os.link(candidate, install_link, follow_symlinks=False)
    # Make the retained previous/candidate links durable before replacing the
    # active pathname; a later failure must not discard either credential set.
    sync_directory(candidate.parent)
    require(private_read(target) == original, "API_ENV_CHANGED_BEFORE_INSTALL")
    os.replace(install_link, target)
    state["api_environment_installed"] = True
    sync_directory(target.parent)
    sync_directory(candidate.parent)


def prepare(data, state):
    handoff = read_handoff(data)
    check_live_identity(data, handoff)
    nonce = secrets.token_hex(16)
    folder = STAGE / "env" / ("api-preparation-" + nonce)
    shared["new_directory"](folder)
    state.update(phase="GENERATE_CANDIDATE", candidate_directory=folder.name)
    attempt = {"schema": 1, "commit": data["commit"], "images": data["images"], "previous_api_sha256": sha256(handoff["old_api"]), "candidate_directory": folder.name}
    write_new(STAGE / "evidence/application-env-attempt.json", (json.dumps(attempt, sort_keys=True) + "\n").encode())
    sync_directory(STAGE / "evidence")
    candidate = folder / "api.env"
    write_new(candidate, env_bytes(api_values(data, generate_vapid(data["images"]["BACKEND_IMAGE"]))))
    candidate_main = folder / "production.env"
    main = dict(handoff["main"], KINETRA_API_ENV_FILE=str(candidate))
    write_new(candidate_main, env_bytes(main))
    state["phase"] = "VALIDATE_CANDIDATE"
    validate_candidate(data["images"]["BACKEND_IMAGE"], candidate_main, candidate)
    check_live_identity(data, handoff)
    state["phase"] = "INSTALL_VALIDATED_ENVIRONMENT"
    install_preserving_previous(candidate, folder / "previous-api.env", handoff["old_api"], state)
    state["phase"] = "VERIFY_INSTALLED_ENVIRONMENT"
    require(private_read(STAGE / "env/api.env") == private_read(candidate), "INSTALLED_API_ENV_MISMATCH")
    validate_candidate(data["images"]["BACKEND_IMAGE"], STAGE / "env/production.env", STAGE / "env/api.env")
    check_live_identity(data, handoff)
    state.update(result="API_ENVIRONMENT_PREPARED_ONLY", phase="API_ENVIRONMENT_PREPARATION_COMPLETE")
    record = dict(state, schema=1, commit=data["commit"], images=data["images"], source_hashes=data["source_hashes"],
                  migration_hashes=data["migration_hashes"], api_sha256=sha256(private_read(candidate)))
    write_new(STAGE / "evidence/application-env.json", (json.dumps(record, sort_keys=True) + "\n").encode())
    sync_directory(STAGE / "evidence")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    state = {"result": "FAIL", "phase": "VALIDATE_PRIVATE_INPUT", "error": None, "api_environment_installed": False,
             "application_started": False, "caddy_started": False, "provider_requests": 0, "candidate_directory": None}
    lock = None
    try:
        require(len(argv) == 3 and argv[:2] == ["--prepare-validated-api-environment", "--private-input"], "EXPLICIT_PREPARATION_ARGUMENTS_REQUIRED")
        data = validate_input(json.loads(private_read(Path(argv[2]))))
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        # This lock already exists from initialization; no blind creation/reset.
        private_read(LOCK)
        lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state["phase"] = "VERIFY_INITIALIZED_HANDOFF"
        prepare(data, state)
    except (Error, stage.Error) as error:
        category = str(error)
        state["error"] = category if re.fullmatch(r"[A-Z_]{1,90}", category) else "PREPARATION_VALIDATION_FAILED"
        state["result"] = "FAIL"
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_ERROR_PRIVATE_STATE_PRESERVED"
    finally:
        if lock is not None:
            os.close(lock)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "API_ENVIRONMENT_PREPARED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shared["interrupted"])
    signal.signal(signal.SIGINT, shared["interrupted"])
    raise SystemExit(main())
