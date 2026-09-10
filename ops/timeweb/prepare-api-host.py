#!/usr/bin/env python3
"""Dormant outer wrapper for API_ENVIRONMENT_PREPARED_ONLY on the fixed host.

Caller MUST first pass the separate immutable source/image provenance gate.
No service startup, registry access, migration, seed or provider request.
Explicit --provider-env or --provider-input /absolute/owner0600/providers.json.
"""
from __future__ import annotations
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shlex
import signal
import stat
import sys
import tempfile
import time

PINS = {
    "activate-application-host.py": "73e2a6c2389206c11712d96e3a4736da481e6ab4d0494dc088abc6f447f9ea72",
    "initialize-database-host.py": "041f415dedf6b0b6922484281926c8c98c87828506dcb2e1ac6fb324b00b05bb",
    "prepare-database-host.py": "4621b1c0153ab56ae535e245fdb2de4ef2aff4a30ba5b592343a26795f0655ae",
    "bootstrap-server.py": "a19aca3ea953feecdcb9be6e9dcabdfc8b0e2b4f3938184391cdfb2ff3e87c9e",
    "inspect-server.py": "567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0",
}


def public_helpers():
    result = {}
    for name, digest in PINS.items():
        path = Path(__file__).with_name(name)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 262144:
            raise RuntimeError("CONTROL_HELPER_FILE_INVALID")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError("CONTROL_HELPER_HASH_MISMATCH")
        result[name] = base64.b64encode(raw).decode("ascii")
    return result


# Check all transitive public dependencies before executing their definitions.
public_helpers()
_spec = importlib.util.spec_from_file_location("kinetra_api_guest", Path(__file__).with_name("activate-application-host.py"))
activation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(activation)
initialization = activation.initialization
stage = activation.stage
inspection = stage.inspection
bootstrap = stage.bootstrap
Error = inspection.InspectError
PREPARE_SECONDS = 1800
REMOTE_SECONDS = 900


def require(condition, category):
    if not condition:
        raise Error(category)


# One shared sanitizer is executed both locally and inside the public launcher.
RESULT_VALIDATOR = r'''
def validate_preparation(value):
    keys = {'result', 'phase', 'error', 'api_environment_installed', 'application_started',
            'caddy_started', 'provider_requests', 'candidate_directory'}
    require(isinstance(value, dict) and set(value) == keys, 'API_RESULT_SCHEMA_INVALID')
    require(value['result'] in {'FAIL', 'API_ENVIRONMENT_PREPARED_ONLY'}, 'API_RESULT_INVALID')
    require(isinstance(value['phase'], str) and re.fullmatch(r'[A-Z_]{1,90}', value['phase']), 'API_RESULT_INVALID')
    require(value['error'] is None or isinstance(value['error'], str) and re.fullmatch(r'[A-Z_]{1,90}', value['error']), 'API_RESULT_INVALID')
    require(type(value['api_environment_installed']) is bool and value['application_started'] is False
            and value['caddy_started'] is False and type(value['provider_requests']) is int
            and value['provider_requests'] == 0, 'UNAUTHORIZED_API_PHASE_EFFECT')
    candidate = value['candidate_directory']
    require(candidate is None or isinstance(candidate, str) and re.fullmatch(r'api-preparation-[a-f0-9]{32}', candidate), 'API_RESULT_INVALID')
    if value['result'] == 'API_ENVIRONMENT_PREPARED_ONLY':
        require(value['phase'] == 'API_ENVIRONMENT_PREPARATION_COMPLETE' and value['error'] is None
                and value['api_environment_installed'] is True and candidate is not None, 'API_PASS_EVIDENCE_INCOMPLETE')
    else:
        require(value['error'] is not None, 'API_FAILURE_EVIDENCE_INCOMPLETE')
    return value
'''
exec(compile(RESULT_VALIDATOR, "<api-result-validator>", "exec"))


# No supplied provider value appears in this program or the SSH command line.
# Only pinned public helper files and private input are written in an owned /run
# directory. The reviewed guest owns persistent stage/env/candidate changes.
GUEST_LAUNCHER = "PINS = " + repr(PINS) + "\n" + r'''
import base64, hashlib, json, os, pathlib, re, resource, signal, stat, subprocess, sys
sys.dont_write_bytecode = True
class Error(Exception): pass
def require(condition, category):
    if not condition: raise Error(category)
def interrupted(_signum, _frame): raise Error('API_LAUNCHER_INTERRUPTED')
''' + RESULT_VALIDATOR + r'''

def write_new(path, raw, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())

def cleanup_owned(folder, identity):
    info = folder.lstat()
    require(not folder.is_symlink() and (info.st_dev, info.st_ino) == identity
            and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'TEMP_DIRECTORY_IDENTITY_CHANGED')
    allowed = set(PINS) | {'private-input.json'}
    paths = list(folder.iterdir())
    for path in paths:
        entry = path.lstat()
        require(path.name in allowed and stat.S_ISREG(entry.st_mode) and entry.st_uid == 0,
                'TEMP_DIRECTORY_CONTENT_CHANGED')
    for path in paths: path.unlink()
    folder.rmdir()

def main():
    state = {'schema': 1, 'result': 'FAIL', 'error': None, 'commit': None, 'images': None,
             'source_hashes': None, 'migration_hashes': None, 'preparation': None,
             'guest_temp_cleanup': 'NOT_NEEDED', 'remote_directory': None}
    folder, identity, child = None, None, None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, 'API_TRANSPORT_INPUT_TOO_LARGE')
        data = json.loads(raw)
        require(isinstance(data, dict) and set(data) == {'schema', 'nonce', 'approved', 'helpers'}
                and type(data['schema']) is int and data['schema'] == 1, 'API_TRANSPORT_INPUT_INVALID')
        require(isinstance(data['nonce'], str) and re.fullmatch(r'[a-f0-9]{32}', data['nonce']), 'API_TRANSPORT_NONCE_INVALID')
        require(isinstance(data['helpers'], dict) and set(data['helpers']) == set(PINS), 'PUBLIC_HELPER_SET_INVALID')
        files = {}
        for name, digest in PINS.items():
            body = base64.b64decode(data['helpers'][name], validate=True)
            require(0 < len(body) <= 262144 and hashlib.sha256(body).hexdigest() == digest, 'PUBLIC_HELPER_HASH_MISMATCH')
            files[name] = body
        approved = data['approved']
        require(isinstance(approved, dict) and set(approved) == {'schema', 'server_id', 'public_ipv4', 'commit',
                'images', 'source_hashes', 'migration_hashes', 'providers'}, 'API_APPROVED_INPUT_INVALID')
        require(approved['server_id'] == 9069403 and approved['public_ipv4'] == '80.68.156.131', 'FIXED_SERVER_REQUIRED')
        run = pathlib.Path('/run')
        info = run.lstat()
        require(stat.S_ISDIR(info.st_mode) and run.resolve() == run and info.st_uid == 0
                and info.st_mode & 0o022 == 0, 'PRIVATE_RUNTIME_PARENT_INVALID')
        proposed = run / ('kinetra-api-preparation-' + data['nonce'])
        proposed.mkdir(mode=0o700)
        folder = proposed
        info = folder.lstat()
        identity = (info.st_dev, info.st_ino)
        state.update(guest_temp_cleanup='PENDING', remote_directory=str(folder))
        for name, body in files.items(): write_new(folder / name, body, 0o644)
        private_input = folder / 'private-input.json'
        write_new(private_input, (json.dumps(approved, allow_nan=False) + '\n').encode(), 0o600)
        # No providers or account/registry tokens enter the child's environment.
        child = subprocess.Popen(['/usr/bin/python3', '-B', str(folder / 'activate-application-host.py'),
            '--prepare-validated-api-environment', '--private-input', str(private_input)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, start_new_session=True)
        output, _ = child.communicate(timeout=600)
        require(len(output) <= 65536, 'API_GUEST_OUTPUT_TOO_LARGE')
        result = validate_preparation(json.loads(output))
        state.update(commit=approved['commit'], images=approved['images'], source_hashes=approved['source_hashes'],
                     migration_hashes=approved['migration_hashes'], preparation=result)
        require(child.returncode == 0 and result['result'] == 'API_ENVIRONMENT_PREPARED_ONLY', 'API_PREPARATION_FAILED_PRIVATE_STATE_PRESERVED')
        state['result'] = 'API_ENVIRONMENT_PREPARED_ONLY'
    except Error as error:
        state['error'] = str(error) if re.fullmatch(r'[A-Z_]{1,90}', str(error)) else 'API_LAUNCHER_VALIDATION_FAILED'
    except BaseException:
        state['error'] = 'API_LAUNCHER_FAILED_PRIVATE_STATE_PRESERVED'
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=30)
            except BaseException:
                try:
                    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except BaseException:
                    state['error'] = 'API_CHILD_EXIT_REQUIRES_RECONCILIATION'
        if child is not None and child.stdout is not None: child.stdout.close()
        if folder is not None:
            try:
                require(child is None or child.poll() is not None, 'API_CHILD_STILL_RUNNING')
                cleanup_owned(folder, identity)
                state['guest_temp_cleanup'] = 'REMOVED'
            except BaseException:
                state['guest_temp_cleanup'] = 'FAILED_RECONCILE'
                state['error'] = state['error'] or 'GUEST_TEMP_CLEANUP_REQUIRES_RECONCILIATION'
        if state['error'] is not None: state['result'] = 'FAIL'
        print(json.dumps(state, sort_keys=True, allow_nan=False), flush=True)
    return 0 if state['result'] == 'API_ENVIRONMENT_PREPARED_ONLY' else 1

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
'''


def provider_input(argv, environment_providers):
    if argv == ["--prepare-api-environment", "--provider-env"]:
        return {key: value for key, value in environment_providers.items() if value}
    require(len(argv) == 3 and argv[:2] == ["--prepare-api-environment", "--provider-input"], "EXPLICIT_API_PREPARATION_ARGUMENTS_REQUIRED")
    require(not any(environment_providers.values()), "PROVIDER_SOURCE_AMBIGUOUS")
    path = Path(argv[2])
    require(path.is_absolute() and path.resolve() == path, "PRIVATE_PROVIDER_PATH_INVALID")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_size <= 16384, "PRIVATE_PROVIDER_FILE_INVALID")
        raw = stream.read(16385)
    require(len(raw) <= 16384, "PRIVATE_PROVIDER_FILE_TOO_LARGE")
    return json.loads(raw)


def validate_remote(raw, expected, nonce):
    value = json.loads(raw)
    require(isinstance(value, dict) and set(value) == {"schema", "result", "error", "commit", "images",
        "source_hashes", "migration_hashes", "preparation", "guest_temp_cleanup", "remote_directory"}, "REMOTE_API_RESULT_SCHEMA_INVALID")
    require(type(value["schema"]) is int and value["schema"] == 1 and value["result"] in {"FAIL", "API_ENVIRONMENT_PREPARED_ONLY"}, "REMOTE_API_RESULT_INVALID")
    require(value["error"] is None or isinstance(value["error"], str) and re.fullmatch(r"[A-Z_]{1,90}", value["error"]), "REMOTE_API_RESULT_INVALID")
    require(value["guest_temp_cleanup"] in {"NOT_NEEDED", "REMOVED", "FAILED_RECONCILE"}, "REMOTE_TEMP_CLEANUP_INVALID")
    require(value["remote_directory"] in {None, "/run/kinetra-api-preparation-" + nonce}, "REMOTE_TEMP_SCOPE_INVALID")
    if value["preparation"] is not None:
        validate_preparation(value["preparation"])
        for key in ("commit", "images", "source_hashes", "migration_hashes"):
            require(value[key] == expected[key], "REMOTE_APPROVED_IDENTITY_MISMATCH")
    else:
        require(all(value[key] is None for key in ("commit", "images", "source_hashes", "migration_hashes")), "REMOTE_API_RESULT_INVALID")
    if value["result"] == "API_ENVIRONMENT_PREPARED_ONLY":
        require(value["error"] is None and value["preparation"] is not None
            and value["preparation"]["result"] == "API_ENVIRONMENT_PREPARED_ONLY"
            and value["guest_temp_cleanup"] == "REMOVED" and value["remote_directory"] is not None,
            "REMOTE_API_PASS_EVIDENCE_INCOMPLETE")
    else:
        require(value["error"] is not None, "REMOTE_API_FAILURE_EVIDENCE_INCOMPLETE")
    return value


def emit(state):
    print("TIMEWEB_API_PREPARATION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "host_key_fingerprint": None, "server_status": "UNKNOWN", "ssh_key_id": None, "remote_directory": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "guest_temp_cleanup": "NOT_NEEDED", "preparation": None, "error": None,
        "application_started": False, "caddy_started": False}
    api, folder, data, payload = None, None, None, b""
    provider_environment = {key: environ.pop(key, "") for key in activation.PROVIDER_ENV_KEYS}
    providers = {key: provider_environment[key] for key in activation.PROVIDERS}
    token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
    environ.pop("GITHUB_TOKEN", None)
    environ.pop("GH_TOKEN", None)
    try:
        require(not any(provider_environment[key] for key in activation.PAYMENT_PROVIDER_KEYS),
                "PAYMENT_PROVIDER_INPUTS_NOT_ALLOWED")
        provider_environment = None
        providers = provider_input(argv, providers)
        require(environ.get("GITHUB_ACTIONS") == "true" and environ.get("GITHUB_REPOSITORY") == inspection.REPOSITORY
                and environ.get("GITHUB_RUN_ATTEMPT") == "1", "AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "SUPPLIED_RUN_ID_INVALID")
        require(environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) == str(inspection.SERVER_ID)
                and environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) == inspection.PUBLIC_IPV4, "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        require(runtime_temp.is_absolute() and runtime_temp.is_dir(), "RUNNER_TEMP_INVALID")
        require(token and len(token) <= 16384 and not any(character.isspace() for character in token), "TIMEWEB_SECRET_MISSING_OR_INVALID")
        metadata = stage.metadata(environ)
        files = stage.source_bundle(environ.get("APP_CHECKOUT", ""), metadata["commit"])
        data = {"schema": 1, "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
            **metadata, "source_hashes": {name: entry["sha256"] for name, entry in files.items()},
            "migration_hashes": initialization.migration_hashes(environ.get("APP_CHECKOUT", ""), metadata["commit"]), "providers": providers}
        # Frozen guest validation checks both required auth providers before any
        # API call, nonce/key generation, local temp directory or host action.
        activation.validate_input(data)
        public = public_helpers()
        nonce = secrets.token_hex(16)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + PREPARE_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        token = ""
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        require(state["server_status"] == "on", "EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-api-prepare-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        require(fingerprint == stage.PINNED_FINGERPRINT, "PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-api-prepare-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        require(key.get("name") == name and key.get("body") == public_key and key.get("is_default") is False, "CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state.update(account_key_cleanup="PENDING", guest_key_cleanup="ATTACH_OUTCOME_UNKNOWN")
        emit(state)
        api.request("POST", f"/servers/{inspection.SERVER_ID}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        require(state["server_status"] == "on", "SERVER_NO_LONGER_ON")
        arguments = inspection.ssh_arguments(inspection.PUBLIC_IPV4, private, known_hosts)
        inspection.wait_for_key(arguments, deadline)
        code, output, _ = inspection.run_bounded(arguments + ["/usr/bin/python3 -c " + shlex.quote(inspection.GUEST_PROGRAM)], 215)
        require(code == 0, "PRE_API_INSPECTION_FAILED")
        bootstrap.require_inspected_guest(output, after=True)
        require(deadline - time.monotonic() >= REMOTE_SECONDS + 180, "INSUFFICIENT_API_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=45s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -B -c " + shlex.quote(GUEST_LAUNCHER)
        payload = json.dumps({"schema": 1, "nonce": nonce, "approved": data, "helpers": public}, allow_nan=False).encode()
        state.update(guest_temp_cleanup="UNKNOWN_RECONCILE", remote_directory="/run/kinetra-api-preparation-" + nonce)
        code, output, _ = stage.run_with_input(arguments + [command], payload, REMOTE_SECONDS + 60)
        payload = b""
        state["preparation"] = validate_remote(output, data, nonce)
        state["guest_temp_cleanup"] = state["preparation"]["guest_temp_cleanup"]
        require(code == 0 and state["preparation"]["result"] == "API_ENVIRONMENT_PREPARED_ONLY", "REMOTE_API_PREPARATION_FAILED_PRIVATE_STATE_PRESERVED")
        state["result"] = "API_ENVIRONMENT_PREPARED_ONLY"
    except (Error, activation.Error) as error:
        category = str(error)
        state["result"], state["error"] = "FAIL", category if re.fullmatch(r"[A-Z_]{1,90}", category) else "API_PREPARATION_VALIDATION_FAILED"
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_API_PREPARATION_ERROR_PRIVATE_STATE_PRESERVED"
    finally:
        token, payload = "", b""
        if data is not None: data.pop("providers", None)
        if isinstance(providers, dict): providers.clear()
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"}
               for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup")):
            state["result"], state["error"] = "FAIL", state["error"] or "CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "API_ENVIRONMENT_PREPARED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    raise SystemExit(main())
