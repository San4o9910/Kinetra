#!/usr/bin/env python3
"""Dormant, explicit local-only application activation on the fixed existing host.

CLI: --activate-local-application --private-input /absolute/owner0600/input.json
Input has schema=1, approved (frozen guest input), provenance, database_outer,
api_outer. Provenance keys below bind canonical JSON SHA256 (sorted keys, compact
separators, ensure_ascii=True, no newline), exact commits, run/artifact IDs and
refs to caller environment. The caller MUST authenticate those GitHub artifacts
and current successful exact-head/merge-ref/image gates before invoking this
wrapper. Hash binding is not a substitute for that authentication. The complete
DB/API outer stdout records and guest evidence/config hashes are private input.
Only approved guest input goes over SSH stdin; no provider credentials enter it.

Success requires guest stdout plus all cleanup. A persisted guest CHECKPOINT_ONLY
record alone is never acceptance. A lost response is UNKNOWN_RECONCILE: inspect
existing attempts and live identities before any subsequent activation. This
phase neither enables boot nor starts Caddy, changes DB policy or proves launch.
A future caller job must allow at least 70 minutes: TOTAL_SECONDS is 3600 and
Actions cancellation/cleanup/artifact upload need an additional allowance.
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
    "start-application-host.py": "e7363f6caf31384c5d57f52c665a5b64cef6996b7019ed82d4d2d9f382ff7874",
    "activate-application-host.py": "6f80b6a42ef4cdde9744b1b5a2bba88fb65dc44fead2cdea045fca25abfa3497",
    "initialize-database-host.py": "041f415dedf6b0b6922484281926c8c98c87828506dcb2e1ac6fb324b00b05bb",
    "prepare-database-host.py": "4621b1c0153ab56ae535e245fdb2de4ef2aff4a30ba5b592343a26795f0655ae",
    "bootstrap-server.py": "a19aca3ea953feecdcb9be6e9dcabdfc8b0e2b4f3938184391cdfb2ff3e87c9e",
    "inspect-server.py": "567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0",
}
LOCAL_PINS = {**PINS, "prepare-api-host.py": "d7416e41104965321a55780b91ef54ece9f321867c428aa770bde674a0243bb4"}


def public_helpers():
    result = {}
    for name, digest in LOCAL_PINS.items():
        path = Path(__file__).with_name(name)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not 0 < info.st_size <= 262144:
            raise RuntimeError("CONTROL_HELPER_FILE_INVALID")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise RuntimeError("CONTROL_HELPER_HASH_MISMATCH")
        if name in PINS: result[name] = base64.b64encode(raw).decode("ascii")
    return result


public_helpers()
_spec = importlib.util.spec_from_file_location("kinetra_verified_api_outer", Path(__file__).with_name("prepare-api-host.py"))
prepare = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepare)
initialization, stage, inspection, bootstrap = prepare.initialization, prepare.stage, prepare.inspection, prepare.bootstrap
Error, require = prepare.Error, prepare.require
TOTAL_SECONDS, REMOTE_SECONDS = 3600, 1800
EVIDENCE_FILES = {"stage.json", "initialization.json", "application-env-attempt.json", "application-env.json"}
CONFIG_FILES = {"env/production.env", "env/single-server.env", "env/api.env", "env/jobs/migrate.env", "edge/nginx-real-ip.conf"}
IDENTITY_KEYS = ("commit", "images", "source_hashes", "migration_hashes", "handoff_hashes", "configuration_hashes")
PROVENANCE_ENV = {
    "app_commit": "APPROVED_APP_COMMIT", "base_commit": "APPROVED_BASE_COMMIT", "merge_commit": "APPROVED_MERGE_COMMIT",
    "control_commit": "GITHUB_SHA", "head_run": "APPROVED_HEAD_RUN", "merge_run": "APPROVED_MERGE_RUN",
    "image_run": "APPROVED_IMAGE_RUN", "image_control_commit": "APPROVED_IMAGE_CONTROL_COMMIT",
    "image_workflow_sha256": "APPROVED_IMAGE_WORKFLOW_SHA256", "image_artifact_id": "APPROVED_IMAGE_ARTIFACT_ID",
    "image_artifact_sha256": "APPROVED_IMAGE_ARTIFACT_SHA256",
    "database_outer_sha256": "APPROVED_DATABASE_OUTER_SHA256", "api_outer_sha256": "APPROVED_API_OUTER_SHA256",
}


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def private_input(argv):
    require(len(argv) == 3 and argv[:2] == ["--activate-local-application", "--private-input"], "EXPLICIT_LOCAL_ACTIVATION_ARGUMENTS_REQUIRED")
    path = Path(argv[2])
    require(path.is_absolute() and path.resolve() == path, "PRIVATE_INPUT_PATH_INVALID")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_size <= 131072, "PRIVATE_INPUT_FILE_INVALID")
        raw = stream.read(131073)
    require(len(raw) <= 131072, "PRIVATE_INPUT_TOO_LARGE")
    return json.loads(raw)


def validate_approved(data):
    require(isinstance(data, dict) and set(data) == {"schema", "server_id", "public_ipv4", *IDENTITY_KEYS}, "APPROVED_INPUT_INVALID")
    require(type(data["schema"]) is int and data["schema"] == 1 and type(data["server_id"]) is int
            and data["server_id"] == 9069403 and data["public_ipv4"] == "80.68.156.131", "FIXED_SERVER_REQUIRED")
    require(isinstance(data["images"], dict) and set(data["images"]) == set(stage.IMAGE_PATTERNS), "IMAGE_SET_INVALID")
    stage.metadata({"APPROVED_APP_COMMIT": data["commit"], **data["images"]})
    require(re.fullmatch(r"(?:docker\.io/library/)?postgres:17(?:\.[0-9]+)?-bookworm@sha256:[a-f0-9]{64}", data["images"]["POSTGRES_IMAGE"]), "TAGGED_POSTGRES_DIGEST_REQUIRED")
    for name, keys in (("source_hashes", stage.SOURCE_PATHS), ("migration_hashes", initialization.MIGRATIONS),
                       ("handoff_hashes", EVIDENCE_FILES), ("configuration_hashes", CONFIG_FILES)):
        require(isinstance(data[name], dict) and set(data[name]) == set(keys)
                and all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in data[name].values()), "APPROVED_HASH_SET_INVALID")


def successful_outer(value, *, api):
    common = {"result", "server_id", "public_ipv4", "host_key_fingerprint", "server_status", "ssh_key_id",
              "guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "error"}
    keys = common | ({"remote_directory", "guest_temp_cleanup", "preparation", "application_started", "caddy_started"}
                     if api else {"initialization", "application_readiness"})
    require(isinstance(value, dict) and set(value) == keys, "PRIOR_OUTER_SCHEMA_INVALID")
    require(type(value["server_id"]) is int and value["server_id"] == 9069403 and value["public_ipv4"] == "80.68.156.131"
            and value["server_status"] == "on" and value["host_key_fingerprint"] == stage.PINNED_FINGERPRINT
            and type(value["ssh_key_id"]) is int and value["ssh_key_id"] > 0, "PRIOR_OUTER_IDENTITY_INVALID")
    require(value["error"] is None and value["guest_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and value["account_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and value["local_key_cleanup"] == "REMOVED", "PRIOR_OUTER_CLEANUP_REQUIRED")
    if api:
        require(value["result"] == "API_ENVIRONMENT_PREPARED_ONLY" and value["guest_temp_cleanup"] == "REMOVED"
                and value["application_started"] is False and value["caddy_started"] is False, "SUCCESSFUL_API_OUTER_REQUIRED")
        require(isinstance(value["remote_directory"], str) and re.fullmatch(r"/run/kinetra-api-preparation-[a-f0-9]{32}", value["remote_directory"]), "PRIOR_API_TEMP_IDENTITY_INVALID")
    else:
        require(value["result"] == "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED"
                and value["application_readiness"] == "BLOCKED_MISSING_PROVIDER_INPUTS", "SUCCESSFUL_DATABASE_OUTER_REQUIRED")
    return value


def validate_request(request, environ):
    require(isinstance(request, dict) and set(request) == {"schema", "approved", "provenance", "database_outer", "api_outer"}
            and type(request["schema"]) is int and request["schema"] == 1, "ACTIVATION_REQUEST_SCHEMA_INVALID")
    data, provenance = request["approved"], request["provenance"]
    validate_approved(data)
    extra = {"repository", "pr_number", "head_ref", "merge_ref", "billing", "monthly_budget_rub", "approved_input_sha256"}
    require(isinstance(provenance, dict) and set(provenance) == set(PROVENANCE_ENV) | extra, "IMMUTABLE_PROVENANCE_REQUIRED")
    require(provenance["repository"] == inspection.REPOSITORY and type(provenance["pr_number"]) is int and provenance["pr_number"] == 21
            and provenance["head_ref"] == "refs/heads/feature/onboarding-exploration-mode" and provenance["merge_ref"] == "refs/pull/21/merge",
            "PROVENANCE_REFS_INVALID")
    require(provenance["billing"] == "hourly" and type(provenance["monthly_budget_rub"]) is int
            and provenance["monthly_budget_rub"] == 2000, "EXISTING_HOURLY_BUDGET_REQUIRED")
    for key, env in PROVENANCE_ENV.items():
        pattern = r"[a-f0-9]{64}" if key.endswith("sha256") else r"[a-f0-9]{40}" if key.endswith("commit") else r"[1-9][0-9]{0,19}"
        require(isinstance(provenance[key], str) and re.fullmatch(pattern, provenance[key])
                and provenance[key] == environ.get(env), "PROVENANCE_ENVIRONMENT_MISMATCH")
    require(len({provenance[key] for key in ("head_run", "merge_run", "image_run")}) == 3, "DISTINCT_REQUIRED_GATE_RUNS")
    require(provenance["app_commit"] == data["commit"] and provenance["approved_input_sha256"] == canonical_hash(data)
            and environ.get("APPROVED_PROVENANCE_SHA256") == canonical_hash(provenance), "PROVENANCE_BINDING_MISMATCH")
    for kind in ("database", "api"):
        require(canonical_hash(request[kind + "_outer"]) == provenance[kind + "_outer_sha256"], "PRIOR_OUTER_HASH_MISMATCH")
        successful_outer(request[kind + "_outer"], api=kind == "api")
    db = initialization.validate_initialization_result(json.dumps(request["database_outer"]["initialization"]))
    require(db["result"] == "DATABASE_INITIALIZED_ONLY" and db["commit"] == data["commit"], "DATABASE_HANDOFF_COMMIT_MISMATCH")
    api = request["api_outer"]
    result = prepare.validate_remote(json.dumps(api["preparation"]), data, api["remote_directory"].rsplit("-", 1)[1])
    require(result["result"] == "API_ENVIRONMENT_PREPARED_ONLY", "SUCCESSFUL_API_HANDOFF_REQUIRED")
    for field in ("handoff_hashes", "configuration_hashes"):
        require(result["preparation"][field] == data[field], "SUCCESSFUL_API_HASH_BINDING_MISMATCH")
    # Frozen writers use sorted JSON with default separators and a newline.
    # Reconstructing their exact bytes binds cleanup success to the actual DB
    # container and API candidate, not merely another attempt on the same SHA.
    db_record = dict(db, images=data["images"], migration_hashes=data["migration_hashes"])
    api_record = dict({key: value for key, value in result["preparation"].items()
                       if key not in {"handoff_hashes", "configuration_hashes"}}, schema=1, commit=data["commit"], images=data["images"],
                      source_hashes=data["source_hashes"], migration_hashes=data["migration_hashes"],
                      api_sha256=data["configuration_hashes"]["env/api.env"])
    for name, record in (("initialization.json", db_record), ("application-env.json", api_record)):
        digest = hashlib.sha256((json.dumps(record, sort_keys=True) + "\n").encode()).hexdigest()
        require(digest == data["handoff_hashes"][name], "SUCCESSFUL_OUTER_HANDOFF_HASH_MISMATCH")
    require(stage.metadata(environ) == {key: data[key] for key in ("commit", "images")}, "APPROVED_METADATA_MISMATCH")
    files = stage.source_bundle(environ.get("APP_CHECKOUT", ""), data["commit"])
    require({name: entry["sha256"] for name, entry in files.items()} == data["source_hashes"], "APPROVED_SOURCE_HASH_MISMATCH")
    require(initialization.migration_hashes(environ.get("APP_CHECKOUT", ""), data["commit"]) == data["migration_hashes"], "APPROVED_MIGRATION_HASH_MISMATCH")
    return data, provenance


# Identical strict public result sanitizer on both sides of SSH. No arbitrary
# guest strings, headers, response bodies, paths or exception text are emitted.
RESULT_VALIDATOR = r'''
def validate_start(value):
    keys = {'schema', 'result', 'phase', 'error', 'nonce', 'attempt_recorded', 'attempted_services',
            'start_attempted_services', 'uncertain_start_services', 'owned_containers', 'rollback', 'local_http',
            'caddy_started', 'database_policy_changed', 'provider_requests', 'remaining'}
    require(isinstance(value, dict) and set(value) == keys and type(value['schema']) is int and value['schema'] == 1, 'START_RESULT_SCHEMA_INVALID')
    require(value['result'] in {'FAIL', 'APPLICATION_LOCAL_ACCEPTED_ONLY'} and isinstance(value['phase'], str)
            and re.fullmatch(r'[A-Z_]{1,90}', value['phase']), 'START_RESULT_INVALID')
    require(value['error'] is None or isinstance(value['error'], str) and re.fullmatch(r'[A-Z_]{1,90}', value['error']), 'START_RESULT_INVALID')
    require(value['nonce'] is None or isinstance(value['nonce'], str) and re.fullmatch(r'[a-f0-9]{32}', value['nonce']), 'START_RESULT_NONCE_INVALID')
    require(type(value['attempt_recorded']) is bool and (not value['attempt_recorded'] or value['nonce'] is not None), 'START_ATTEMPT_INVALID')
    for key in ('attempted_services', 'start_attempted_services'):
        require(value[key] in ([], ['backend'], ['backend', 'frontend']), 'START_SERVICE_ORDER_INVALID')
    require(isinstance(value['uncertain_start_services'], list) and len(set(value['uncertain_start_services'])) == len(value['uncertain_start_services'])
            and set(value['uncertain_start_services']) <= set(value['start_attempted_services'])
            and set(value['start_attempted_services']) <= set(value['attempted_services']), 'START_UNCERTAINTY_INVALID')
    require(not value['attempted_services'] or value['attempt_recorded'], 'START_ATTEMPT_INVALID')
    owned = value['owned_containers']
    require(isinstance(owned, dict) and set(owned) <= set(value['attempted_services']) and set(value['start_attempted_services']) <= set(owned)
            and all(isinstance(cid, str) and re.fullmatch(r'[a-f0-9]{64}', cid) for cid in owned.values())
            and len(set(owned.values())) == len(owned), 'START_CONTAINER_OWNERSHIP_INVALID')
    rollback = value['rollback']
    require(isinstance(rollback, dict) and set(rollback) <= set(value['attempted_services'])
            and all(item in {'NO_CONTAINER_OBSERVED', 'CREATED_NOT_STARTED', 'STOPPED', 'UNCONFIRMED_REQUIRES_REVIEW'} for item in rollback.values()), 'START_ROLLBACK_INVALID')
    for service, outcome in rollback.items():
        require(outcome not in {'CREATED_NOT_STARTED', 'STOPPED'} or service in owned, 'START_ROLLBACK_OWNERSHIP_INVALID')
        require(service not in value['uncertain_start_services'] or outcome == 'UNCONFIRMED_REQUIRES_REVIEW', 'START_ROLLBACK_UNCERTAINTY_INVALID')
    require(value['caddy_started'] is False and value['database_policy_changed'] is False and type(value['provider_requests']) is int
            and value['provider_requests'] == 0, 'UNAUTHORIZED_START_PHASE_EFFECT')
    require(value['remaining'] == ['CADDY_IDENTITY_AND_HTTPS', 'DATABASE_PERSISTENT_POLICY', 'BOOT_ENABLEMENT', 'BROWSER_ACCEPTANCE', 'BACKUP_AND_USER_LAUNCH'], 'START_REMAINING_SCOPE_INVALID')
    http = value['local_http']
    require(isinstance(http, dict) and len(http) <= 16, 'START_HTTP_EVIDENCE_INVALID')
    for path, entry in http.items():
        require(path in {'/', '/health', '/ready', '/api/v1/me'} or isinstance(path, str) and len(path) <= 240
                and re.fullmatch(r'/assets/[A-Za-z0-9_./-]+\.(?:js|css)', path) and '..' not in path, 'START_HTTP_PATH_INVALID')
        require(isinstance(entry, dict) and set(entry) == {'status', 'sha256'} and type(entry['status']) is int
                and entry['status'] == {'/ready': 404, '/api/v1/me': 401}.get(path, 200)
                and isinstance(entry['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', entry['sha256']), 'START_HTTP_EVIDENCE_INVALID')
    if value['result'] == 'APPLICATION_LOCAL_ACCEPTED_ONLY':
        require(value['phase'] == 'LOCAL_APPLICATION_ACCEPTANCE_COMPLETE' and value['error'] is None
                and value['attempt_recorded'] and value['attempted_services'] == ['backend', 'frontend']
                and value['start_attempted_services'] == ['backend', 'frontend'] and not value['uncertain_start_services']
                and set(owned) == {'backend', 'frontend'} and not rollback, 'START_PASS_EVIDENCE_INCOMPLETE')
        require({'/', '/health', '/ready', '/api/v1/me'} <= set(http) and any(p.endswith('.js') for p in http)
                and any(p.endswith('.css') for p in http), 'START_HTTP_ACCEPTANCE_INCOMPLETE')
    else:
        require(value['error'] is not None and set(rollback) == set(value['attempted_services']), 'START_FAILURE_EVIDENCE_INCOMPLETE')
    return value
'''
exec(compile(RESULT_VALIDATOR, "<local-start-result-validator>", "exec"))


GUEST_LAUNCHER = "PINS = " + repr(PINS) + "\n" + r'''
import base64, hashlib, json, os, pathlib, re, resource, signal, stat, subprocess, sys
sys.dont_write_bytecode = True
class Error(Exception): pass
def require(condition, category):
    if not condition: raise Error(category)
def interrupted(_signum, _frame): raise Error('LOCAL_LAUNCHER_INTERRUPTED')
def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()
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
    paths = list(folder.iterdir())
    for path in paths:
        entry = path.lstat()
        require(path.name in set(PINS) | {'private-input.json'} and stat.S_ISREG(entry.st_mode)
                and entry.st_uid == 0, 'TEMP_DIRECTORY_CONTENT_CHANGED')
    for path in paths: path.unlink()
    folder.rmdir()

def main():
    state = {'schema': 1, 'result': 'FAIL', 'error': None, 'approved_input_sha256': None, 'commit': None, 'images': None,
             'start': None, 'activation_outcome': 'NOT_ATTEMPTED', 'guest_temp_cleanup': 'NOT_NEEDED', 'remote_directory': None}
    folder, identity, child = None, None, None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, 'LOCAL_TRANSPORT_INPUT_TOO_LARGE')
        data = json.loads(raw)
        require(isinstance(data, dict) and set(data) == {'schema', 'nonce', 'approved', 'helpers'}
                and type(data['schema']) is int and data['schema'] == 1, 'LOCAL_TRANSPORT_INPUT_INVALID')
        require(isinstance(data['nonce'], str) and re.fullmatch(r'[a-f0-9]{32}', data['nonce']), 'LOCAL_TRANSPORT_NONCE_INVALID')
        require(isinstance(data['helpers'], dict) and set(data['helpers']) == set(PINS), 'PUBLIC_HELPER_SET_INVALID')
        files = {}
        for name, digest in PINS.items():
            body = base64.b64decode(data['helpers'][name], validate=True)
            require(0 < len(body) <= 262144 and hashlib.sha256(body).hexdigest() == digest, 'PUBLIC_HELPER_HASH_MISMATCH')
            files[name] = body
        approved = data['approved']
        require(isinstance(approved, dict) and set(approved) == {'schema', 'server_id', 'public_ipv4', 'commit', 'images',
                'source_hashes', 'migration_hashes', 'handoff_hashes', 'configuration_hashes'}, 'LOCAL_APPROVED_INPUT_INVALID')
        require(type(approved['server_id']) is int and approved['server_id'] == 9069403
                and approved['public_ipv4'] == '80.68.156.131', 'FIXED_SERVER_REQUIRED')
        run = pathlib.Path('/run')
        info = run.lstat()
        require(stat.S_ISDIR(info.st_mode) and run.resolve() == run and info.st_uid == 0
                and info.st_mode & 0o022 == 0, 'PRIVATE_RUNTIME_PARENT_INVALID')
        proposed = run / ('kinetra-local-activation-' + data['nonce'])
        proposed.mkdir(mode=0o700)
        folder = proposed
        info = folder.lstat()
        identity = (info.st_dev, info.st_ino)
        state.update(guest_temp_cleanup='PENDING', remote_directory=str(folder))
        for name, body in files.items(): write_new(folder / name, body, 0o644)
        private = folder / 'private-input.json'
        write_new(private, (json.dumps(approved, allow_nan=False) + '\n').encode(), 0o600)
        # Record uncertainty BEFORE process creation: spawn itself may have an
        # indeterminate outcome. Never report an application as stopped by guess.
        state.update(activation_outcome='UNKNOWN_RECONCILE', approved_input_sha256=canonical_hash(approved),
                     commit=approved['commit'], images=approved['images'])
        child = subprocess.Popen(['/usr/bin/python3', '-B', str(folder / 'start-application-host.py'),
            '--start-validated-local-application', '--private-input', str(private)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, start_new_session=True)
        output, _ = child.communicate(timeout=900)
        require(len(output) <= 65536, 'LOCAL_GUEST_OUTPUT_TOO_LARGE')
        result = validate_start(json.loads(output))
        state.update(start=result, activation_outcome='ACCEPTED_OBSERVED' if result['result'] == 'APPLICATION_LOCAL_ACCEPTED_ONLY' else 'FAILED_OBSERVED')
        require(child.returncode == 0 and result['result'] == 'APPLICATION_LOCAL_ACCEPTED_ONLY', 'LOCAL_ACTIVATION_FAILED_STATE_PRESERVED')
        state['result'] = 'APPLICATION_LOCAL_ACCEPTED_ONLY'
    except Error as error:
        state['error'] = str(error) if re.fullmatch(r'[A-Z_]{1,90}', str(error)) else 'LOCAL_LAUNCHER_VALIDATION_FAILED'
    except BaseException:
        state['error'] = 'LOCAL_LAUNCHER_FAILED_STATE_PRESERVED'
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                # Two-service rollback permits 270s; failed checkpoint durability
                # can invoke it a second time. Preserve both bounded attempts.
                child.wait(timeout=600)
            except BaseException:
                try:
                    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except BaseException:
                    state['error'] = 'LOCAL_CHILD_EXIT_REQUIRES_RECONCILIATION'
        if child is not None and child.stdout is not None: child.stdout.close()
        if folder is not None:
            try:
                require(child is None or child.poll() is not None, 'LOCAL_CHILD_STILL_RUNNING')
                cleanup_owned(folder, identity)
                state['guest_temp_cleanup'] = 'REMOVED'
            except BaseException:
                state['guest_temp_cleanup'] = 'FAILED_RECONCILE'
                state['error'] = state['error'] or 'GUEST_TEMP_CLEANUP_REQUIRES_RECONCILIATION'
        if state['error'] is not None: state['result'] = 'FAIL'
        print(json.dumps(state, sort_keys=True, allow_nan=False), flush=True)
    return 0 if state['result'] == 'APPLICATION_LOCAL_ACCEPTED_ONLY' else 1

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
'''


def validate_remote(raw, approved, nonce):
    value = json.loads(raw)
    keys = {"schema", "result", "error", "approved_input_sha256", "commit", "images", "start", "activation_outcome", "guest_temp_cleanup", "remote_directory"}
    require(isinstance(value, dict) and set(value) == keys and type(value["schema"]) is int and value["schema"] == 1, "REMOTE_LOCAL_RESULT_SCHEMA_INVALID")
    require(value["result"] in {"FAIL", "APPLICATION_LOCAL_ACCEPTED_ONLY"}
            and (value["error"] is None or isinstance(value["error"], str) and re.fullmatch(r"[A-Z_]{1,90}", value["error"])), "REMOTE_LOCAL_RESULT_INVALID")
    require(value["guest_temp_cleanup"] in {"NOT_NEEDED", "REMOVED", "FAILED_RECONCILE"}
            and value["remote_directory"] in {None, "/run/kinetra-local-activation-" + nonce}, "REMOTE_TEMP_IDENTITY_INVALID")
    require((value["remote_directory"] is None) == (value["guest_temp_cleanup"] == "NOT_NEEDED"), "REMOTE_TEMP_EVIDENCE_INVALID")
    outcome = value["activation_outcome"]
    require(outcome in {"NOT_ATTEMPTED", "UNKNOWN_RECONCILE", "FAILED_OBSERVED", "ACCEPTED_OBSERVED"}, "REMOTE_OUTCOME_INVALID")
    if outcome != "NOT_ATTEMPTED":
        require(value["approved_input_sha256"] == canonical_hash(approved) and value["commit"] == approved["commit"]
                and value["images"] == approved["images"] and value["remote_directory"] is not None, "REMOTE_APPROVED_IDENTITY_MISMATCH")
    else:
        require(all(value[key] is None for key in ("approved_input_sha256", "commit", "images", "start")), "REMOTE_NOT_ATTEMPTED_INVALID")
    if value["start"] is not None:
        validate_start(value["start"])
        require(outcome == ("ACCEPTED_OBSERVED" if value["start"]["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" else "FAILED_OBSERVED"), "REMOTE_OBSERVED_OUTCOME_INVALID")
    else:
        require(outcome in {"NOT_ATTEMPTED", "UNKNOWN_RECONCILE"}, "REMOTE_MISSING_GUEST_RESULT")
    if value["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY":
        require(value["error"] is None and outcome == "ACCEPTED_OBSERVED" and value["guest_temp_cleanup"] == "REMOVED", "REMOTE_LOCAL_PASS_INCOMPLETE")
    else:
        require(value["error"] is not None, "REMOTE_LOCAL_FAILURE_INCOMPLETE")
    return value


def emit(state):
    print("TIMEWEB_LOCAL_APPLICATION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"schema": 1, "result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "host_key_fingerprint": None, "server_status": "UNKNOWN", "ssh_key_id": None, "remote_directory": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "guest_temp_cleanup": "NOT_NEEDED", "activation": None, "activation_outcome": "NOT_ATTEMPTED", "error": None,
        "approved_input_sha256": None, "provenance_sha256": None, "caddy_started": False, "database_policy_changed": False,
        "provider_requests": 0, "full_launch_accepted": False}
    api, folder, payload, request = None, None, b"", None
    token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
    for key in (*prepare.activation.PROVIDER_ENV_KEYS, "GITHUB_TOKEN", "GH_TOKEN"): environ.pop(key, None)
    try:
        request = private_input(argv)
        require(environ.get("GITHUB_ACTIONS") == "true" and environ.get("GITHUB_REPOSITORY") == inspection.REPOSITORY
                and environ.get("GITHUB_RUN_ATTEMPT") == "1", "AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "SUPPLIED_RUN_ID_INVALID")
        require(environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) == str(inspection.SERVER_ID)
                and environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) == inspection.PUBLIC_IPV4, "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        require(runtime_temp.is_absolute() and runtime_temp.resolve() == runtime_temp and runtime_temp.is_dir(), "RUNNER_TEMP_INVALID")
        require(token and len(token) <= 16384 and not any(character.isspace() for character in token), "TIMEWEB_SECRET_MISSING_OR_INVALID")
        data, provenance = validate_request(request, environ)
        public = public_helpers()
        state.update(approved_input_sha256=canonical_hash(data), provenance_sha256=canonical_hash(provenance))
        nonce = secrets.token_hex(16)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + TOTAL_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        token = ""
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        require(state["server_status"] == "on", "EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-local-activate-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        require(fingerprint == stage.PINNED_FINGERPRINT, "PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-local-activate-" + run_id
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
        require(code == 0, "PRE_LOCAL_ACTIVATION_INSPECTION_FAILED")
        bootstrap.require_inspected_guest(output, after=True)
        require(deadline - time.monotonic() >= REMOTE_SECONDS + 870, "INSUFFICIENT_ACTIVATION_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=630s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -B -c " + shlex.quote(GUEST_LAUNCHER)
        payload = json.dumps({"schema": 1, "nonce": nonce, "approved": data, "helpers": public}, allow_nan=False).encode()
        state.update(activation_outcome="UNKNOWN_RECONCILE", guest_temp_cleanup="UNKNOWN_RECONCILE", remote_directory="/run/kinetra-local-activation-" + nonce)
        code, output, _ = stage.run_with_input(arguments + [command], payload, REMOTE_SECONDS + 690)
        payload = b""
        remote = validate_remote(output, data, nonce)
        state.update(activation=remote, guest_temp_cleanup=remote["guest_temp_cleanup"], activation_outcome=remote["activation_outcome"], remote_directory=remote["remote_directory"])
        require(code == 0 and remote["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY", "REMOTE_LOCAL_ACTIVATION_FAILED_STATE_PRESERVED")
        state["result"] = "APPLICATION_LOCAL_ACCEPTED_ONLY"
    except (Error, prepare.activation.Error) as error:
        category = str(error)
        state["result"], state["error"] = "FAIL", category if re.fullmatch(r"[A-Z_]{1,90}", category) else "LOCAL_ACTIVATION_VALIDATION_FAILED"
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_LOCAL_ACTIVATION_ERROR_STATE_PRESERVED"
    finally:
        token, payload, request = "", b"", None
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"}
               for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup")):
            state["result"], state["error"] = "FAIL", state["error"] or "CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    raise SystemExit(main())
