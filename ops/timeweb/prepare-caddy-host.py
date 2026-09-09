#!/usr/bin/env python3
"""Prepare disabled Caddy on the fixed inspected host; never activate the edge."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shlex
import signal
import stat
import sys
import tempfile
import time

_spec = importlib.util.spec_from_file_location(
    "kinetra_caddy_inspection", Path(__file__).with_name("inspect-server.py")
)
inspection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inspection)
Error = inspection.InspectError
PINNED_FINGERPRINT = "SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0"
SCRIPT_PATH = Path(__file__).with_name("prepare-caddy.sh")
SCRIPT_SHA256 = "a23d52b21f7c638f757a723048ee632d37e8f217ae796f97dd92ec3bbb990e2d"
PREPARATION_SECONDS = 1200
REMOTE_SECONDS = 480

# The only inserted value is a base64 encoding of the locally hash-verified
# public script. No credentials or user-controlled command fragments are sent.
GUEST_PREPARATION = r'''
import base64, hashlib, json, os, pathlib, selectors, shutil, signal, stat, subprocess, tempfile, time

class PrepareError(Exception):
    pass

def interrupted(_signum, _frame):
    raise PrepareError("REMOTE_INTERRUPTED_PARTIAL_STATE")

PHASES = {"PRECONDITIONS", "DOWNLOAD", "DIGEST", "CONFIG_VALIDATE", "INSTALL", "UNIT_VERIFY"}

def capture_phase(line, state):
    for phase in PHASES:
        if line == ("KINETRA_CADDY_PHASE=" + phase).encode("ascii"):
            state["phase"] = phase
            return

def execute_script(script, state):
    process = subprocess.Popen(
        ["/usr/bin/bash", str(script), "--prepare-for-server-9069403"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
        start_new_session=True)
    deadline = time.monotonic() + 420
    pending, total = b"", 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PrepareError("REMOTE_SCRIPT_TIMEOUT_PARTIAL_STATE")
                for key, _event in selector.select(min(1, remaining)):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > 16384:
                        raise PrepareError("REMOTE_SCRIPT_OUTPUT_LIMIT_PARTIAL_STATE")
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        capture_phase(line, state)
        capture_phase(pending, state)
        state["exit_code"] = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if state["exit_code"] != 0:
            raise PrepareError("REMOTE_SCRIPT_FAILED_PARTIAL_STATE")
    except subprocess.TimeoutExpired:
        raise PrepareError("REMOTE_SCRIPT_TIMEOUT_PARTIAL_STATE") from None
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        process.stdout.close()

def unit_state(property_name):
    result = subprocess.run(
        ["/usr/bin/systemctl", "show", "--value", "--property=" + property_name, "caddy.service"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
        timeout=10, check=False)
    if result.returncode != 0 or len(result.stdout) > 128:
        raise PrepareError("REMOTE_UNIT_VERIFICATION_FAILED")
    return result.stdout.decode("ascii").strip()

def main(encoded):
    state = {"schema": 1, "result": "FAIL", "stage": "SOURCE_VERIFY", "error": None,
             "version": None, "service_enabled": None, "service_active": None,
             "temporary_script_cleanup": "NOT_CREATED", "activation_requested": False,
             "application_changes_requested": False, "phase": None, "exit_code": None}
    folder = None
    try:
        if os.geteuid() != 0:
            raise PrepareError("REMOTE_ROOT_REQUIRED")
        body = base64.b64decode(encoded, validate=True)
        if not 1 <= len(body) <= 32768 or hashlib.sha256(body).hexdigest() != "a23d52b21f7c638f757a723048ee632d37e8f217ae796f97dd92ec3bbb990e2d":
            raise PrepareError("REMOTE_SOURCE_HASH_MISMATCH")
        runtime = pathlib.Path("/run")
        info = runtime.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PrepareError("REMOTE_RUNTIME_DIRECTORY_UNSAFE")
        folder = pathlib.Path(tempfile.mkdtemp(prefix="kinetra-caddy-script-", dir=runtime))
        os.chmod(folder, 0o700)
        state["temporary_script_cleanup"] = "PENDING"
        script = folder / "prepare-caddy.sh"
        descriptor = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
        state["stage"] = "PREPARE_DISABLED_CADDY"
        execute_script(script, state)
        state["stage"] = "VERIFY_DISABLED_CADDY"
        if unit_state("UnitFileState") != "disabled" or unit_state("ActiveState") != "inactive":
            raise PrepareError("REMOTE_UNIT_NOT_DISABLED_INACTIVE")
        state.update(version="2.11.4", service_enabled="disabled", service_active="inactive",
                     result="PASS", stage="PREPARED_CADDY_ONLY")
    except PrepareError as error:
        state["error"] = str(error)
    except BaseException:
        state["error"] = "REMOTE_UNEXPECTED_ERROR_PARTIAL_STATE"
    finally:
        if folder is not None:
            try:
                shutil.rmtree(folder)
                state["temporary_script_cleanup"] = "REMOVED"
            except BaseException:
                state.update(result="FAIL", error="REMOTE_TEMP_CLEANUP_FAILED",
                             temporary_script_cleanup="FAILED")
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "PASS" else 1

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main(SCRIPT_BASE64))
'''


def emit(state):
    print("TIMEWEB_CADDY_PREPARATION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def verified_script():
    info = SCRIPT_PATH.lstat()
    if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= 32768:
        raise Error("REVIEWED_SCRIPT_SHAPE_INVALID")
    body = SCRIPT_PATH.read_bytes()
    if hashlib.sha256(body).hexdigest() != SCRIPT_SHA256:
        raise Error("REVIEWED_SCRIPT_HASH_MISMATCH")
    return body


def require_bootstrapped_guest(raw):
    guest = inspection.validate_guest(raw)
    if guest["cloud_init"] != "PASS" or not all(guest[key] for key in (
        "bootstrap_marker", "password_auth_disabled", "keyboard_interactive_disabled",
        "root_login_key_only", "listeners_verified", "docker_available",
    )) or guest["selected_listener_ports"] != [22]:
        raise Error("BOOTSTRAPPED_HOST_PRECONDITION_FAILED")
    return guest


def validate_preparation_result(raw):
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise Error("PREPARATION_RESULT_INVALID_PARTIAL_STATE") from None
    expected = {"schema", "result", "stage", "error", "version", "service_enabled",
                "service_active", "temporary_script_cleanup", "activation_requested",
                "application_changes_requested", "phase", "exit_code"}
    if not isinstance(result, dict) or set(result) != expected or type(result["schema"]) is not int or result["schema"] != 1:
        raise Error("PREPARATION_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    allowed = {
        "result": {"PASS", "FAIL"},
        "stage": {"SOURCE_VERIFY", "PREPARE_DISABLED_CADDY", "VERIFY_DISABLED_CADDY", "PREPARED_CADDY_ONLY"},
        "error": {None, "REMOTE_ROOT_REQUIRED", "REMOTE_SOURCE_HASH_MISMATCH", "REMOTE_RUNTIME_DIRECTORY_UNSAFE",
                  "REMOTE_INTERRUPTED_PARTIAL_STATE", "REMOTE_SCRIPT_FAILED_PARTIAL_STATE",
                  "REMOTE_SCRIPT_TIMEOUT_PARTIAL_STATE", "REMOTE_SCRIPT_OUTPUT_LIMIT_PARTIAL_STATE", "REMOTE_UNIT_VERIFICATION_FAILED",
                  "REMOTE_UNIT_NOT_DISABLED_INACTIVE", "REMOTE_UNEXPECTED_ERROR_PARTIAL_STATE",
                  "REMOTE_TEMP_CLEANUP_FAILED"},
        "version": {None, "2.11.4"}, "service_enabled": {None, "disabled"},
        "service_active": {None, "inactive"},
        "temporary_script_cleanup": {"NOT_CREATED", "PENDING", "REMOVED", "FAILED"},
        "phase": {None, "PRECONDITIONS", "DOWNLOAD", "DIGEST", "CONFIG_VALIDATE", "INSTALL", "UNIT_VERIFY"},
    }
    for field, values in allowed.items():
        if not (result[field] is None or isinstance(result[field], str)) or result[field] not in values:
            raise Error("PREPARATION_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    if result["activation_requested"] is not False or result["application_changes_requested"] is not False:
        raise Error("PREPARATION_UNEXPECTED_ACTION_EVIDENCE")
    if result["exit_code"] is not None and (type(result["exit_code"]) is not int or not -64 <= result["exit_code"] <= 255):
        raise Error("PREPARATION_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    if result["result"] == "PASS" and (result["stage"] != "PREPARED_CADDY_ONLY" or result["error"] is not None
            or result["version"] != "2.11.4" or result["service_enabled"] != "disabled"
            or result["service_active"] != "inactive" or result["temporary_script_cleanup"] != "REMOVED"
            or result["phase"] != "UNIT_VERIFY" or result["exit_code"] != 0):
        raise Error("PREPARATION_PASS_EVIDENCE_INCOMPLETE")
    return result


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {
        "result": "IN_PROGRESS", "server_id": inspection.SERVER_ID,
        "public_ipv4": inspection.PUBLIC_IPV4, "server_status": "UNKNOWN",
        "host_key_fingerprint": None, "host_key_trust": "PINNED_PREVIOUS_INSPECTION",
        "ssh_key_id": None, "guest_key_cleanup": "NOT_NEEDED",
        "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "before": None, "preparation": None, "after": None,
        "application_readiness": "NOT_DEPLOYED_OR_TESTED", "error": None,
    }
    api, folder = None, None
    try:
        if argv != ["--prepare-disabled-caddy-existing-server"]:
            raise Error("EXPLICIT_CADDY_PREPARATION_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != inspection.REPOSITORY or environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise Error("AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
            raise Error("SUPPLIED_RUN_ID_INVALID")
        if environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) != str(inspection.SERVER_ID) or environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) != inspection.PUBLIC_IPV4:
            raise Error("CONFIRMED_SERVER_OVERRIDE_REFUSED")
        script_body = verified_script()
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        if not runtime_temp.is_absolute() or not runtime_temp.is_dir():
            raise Error("RUNNER_TEMP_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        if not token or len(token) > 16384 or any(character.isspace() for character in token):
            raise Error("TIMEWEB_SECRET_MISSING_OR_INVALID")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + PREPARATION_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        del token
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on":
            raise Error("EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-caddy-host-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        if fingerprint != PINNED_FINGERPRINT:
            raise Error("PINNED_HOST_KEY_MISMATCH")
        state["host_key_fingerprint"] = PINNED_FINGERPRINT
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-caddy-prepare-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            raise Error("CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state.update(ssh_key_id=key_id, account_key_cleanup="PENDING", guest_key_cleanup="ATTACH_OUTCOME_UNKNOWN")
        emit(state)
        api.request("POST", f"/servers/{inspection.SERVER_ID}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on":
            raise Error("SERVER_NO_LONGER_ON")
        arguments = inspection.ssh_arguments(inspection.PUBLIC_IPV4, private, known_hosts)
        inspection.wait_for_key(arguments, deadline)
        inspect_command = "/usr/bin/python3 -c " + shlex.quote(inspection.GUEST_PROGRAM)
        code, output, _ = inspection.run_bounded(arguments + [inspect_command], min(215, deadline - time.monotonic()))
        if code != 0:
            raise Error("PRE_CADDY_INSPECTION_FAILED")
        state["before"] = require_bootstrapped_guest(output)
        emit(state)
        if deadline - time.monotonic() < REMOTE_SECONDS + 260:
            raise Error("INSUFFICIENT_PREPARATION_AND_CLEANUP_TIME")
        program = "SCRIPT_BASE64 = " + repr(base64.b64encode(script_body).decode("ascii")) + "\n" + GUEST_PREPARATION
        command = "/usr/bin/timeout --signal=TERM --kill-after=15s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -c " + shlex.quote(program)
        code, output, _ = inspection.run_bounded(arguments + [command], REMOTE_SECONDS + 30)
        state["preparation"] = validate_preparation_result(output)
        emit(state)
        if code != 0 or state["preparation"]["result"] != "PASS":
            raise Error("REMOTE_CADDY_PREPARATION_FAILED_PARTIAL_STATE")
        code, output, _ = inspection.run_bounded(arguments + [inspect_command], min(215, deadline - time.monotonic()))
        if code != 0:
            raise Error("POST_CADDY_SSH_RECONNECT_FAILED")
        state["after"] = require_bootstrapped_guest(output)
        state["result"] = "PASS_CADDY_PREPARED_DISABLED_ONLY"
    except Error as error:
        state["result"], state["error"] = "FAIL", str(error)
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_ERROR_PARTIAL_STATE_POSSIBLE"
    finally:
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup")):
            state["result"] = "FAIL"
            state["error"] = state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_CADDY_PREPARED_DISABLED_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
