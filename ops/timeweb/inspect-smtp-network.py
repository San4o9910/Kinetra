#!/usr/bin/env python3
"""Verify Yandex SMTP TLS connectivity from the existing pinned Kinetra server.

No mailbox secrets, authentication, mail, installation, firewall or service change.
Only invocation-owned temporary SSH access uses the existing cleanup contract.
"""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shlex
import signal
import sys
import tempfile
import time

_spec = importlib.util.spec_from_file_location("server_inspection", Path(__file__).with_name("inspect-server.py"))
inspection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inspection)
Error = inspection.InspectError
PINNED_FINGERPRINT = "SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0"

GUEST_PROGRAM = r'''
import json, smtplib, socket, ssl
result = {"result": "FAIL", "host": "smtp.yandex.ru", "port": 465,
          "tls_verified": False, "ehlo_ok": False, "auth_advertised": False,
          "authentication_attempted": False, "email_sent": False, "error": None}
try:
    with smtplib.SMTP_SSL("smtp.yandex.ru", 465, local_hostname="[127.0.0.1]",
                          timeout=15, context=ssl.create_default_context()) as smtp:
        result["tls_verified"] = True
        code, _ = smtp.ehlo("[127.0.0.1]")
        result["ehlo_ok"] = code == 250
        result["auth_advertised"] = smtp.has_extn("auth")
        if result["ehlo_ok"] and result["auth_advertised"]:
            result["result"] = "PASS_READ_ONLY_INSPECTION"
        else:
            result["error"] = "SMTP_CAPABILITIES_UNAVAILABLE"
except ssl.SSLCertVerificationError:
    result["error"] = "TLS_CERTIFICATE_VERIFICATION_FAILED"
except (TimeoutError, socket.timeout):
    result["error"] = "SMTP_CONNECTION_TIMEOUT"
except socket.gaierror:
    result["error"] = "SMTP_DNS_FAILED"
except (OSError, smtplib.SMTPException):
    result["error"] = "SMTP_CONNECTION_FAILED"
except Exception:
    result["error"] = "SMTP_PROBE_FAILED"
if result["error"] is not None:
    result["result"] = "FAIL"
print(json.dumps(result, sort_keys=True))
'''


def validate_result(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError, UnicodeError):
        raise Error("SMTP_RESULT_INVALID") from None
    keys = {"result", "host", "port", "tls_verified", "ehlo_ok", "auth_advertised",
            "authentication_attempted", "email_sent", "error"}
    if not isinstance(value, dict) or set(value) != keys:
        raise Error("SMTP_RESULT_INVALID")
    if value["host"] != "smtp.yandex.ru" or type(value["port"]) is not int or value["port"] != 465:
        raise Error("SMTP_TARGET_INVALID")
    flags = ("tls_verified", "ehlo_ok", "auth_advertised", "authentication_attempted", "email_sent")
    if any(type(value[key]) is not bool for key in flags):
        raise Error("SMTP_RESULT_INVALID")
    if value["authentication_attempted"] or value["email_sent"]:
        raise Error("SMTP_PROBE_SCOPE_EXCEEDED")
    if value["result"] not in {"PASS_READ_ONLY_INSPECTION", "FAIL"} or value["error"] not in {
        None, "TLS_CERTIFICATE_VERIFICATION_FAILED", "SMTP_CONNECTION_TIMEOUT", "SMTP_DNS_FAILED",
        "SMTP_CONNECTION_FAILED", "SMTP_PROBE_FAILED", "SMTP_CAPABILITIES_UNAVAILABLE"}:
        raise Error("SMTP_RESULT_INVALID")
    if value["result"] == "PASS_READ_ONLY_INSPECTION" and (
        value["error"] is not None or not all(value[key] for key in flags[:3])
    ):
        raise Error("SMTP_FALSE_SUCCESS")
    return value


def emit(state):
    print("TIMEWEB_SMTP_NETWORK_INSPECTION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "server_status": "UNKNOWN", "host_key_fingerprint": None, "ssh_key_id": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "inspection": None, "error": None}
    api, folder = None, None
    try:
        if argv != ["--inspect-smtp-network"]:
            raise Error("EXPLICIT_READ_ONLY_INSPECTION_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != inspection.REPOSITORY or environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise Error("AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
            raise Error("SUPPLIED_RUN_ID_INVALID")
        if environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) != str(inspection.SERVER_ID) or environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) != inspection.PUBLIC_IPV4:
            raise Error("CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        if not runtime_temp.is_absolute() or not runtime_temp.is_dir():
            raise Error("RUNNER_TEMP_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        if not token or len(token) > 16384 or any(character.isspace() for character in token):
            raise Error("TIMEWEB_SECRET_MISSING_OR_INVALID")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + 600
        api = api_factory(token, inspection.SERVER_ID, deadline)
        del token
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on":
            raise Error("EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-smtp-inspect-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        if fingerprint != PINNED_FINGERPRINT:
            raise Error("PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-smtp-inspect-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            raise Error("CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state["account_key_cleanup"], state["guest_key_cleanup"] = "PENDING", "ATTACH_OUTCOME_UNKNOWN"
        emit(state)
        api.request("POST", f"/servers/{inspection.SERVER_ID}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        arguments = inspection.ssh_arguments(inspection.PUBLIC_IPV4, private, known_hosts)
        inspection.wait_for_key(arguments, deadline)
        command = "/usr/bin/python3 -c " + shlex.quote(GUEST_PROGRAM)
        code, output, _ = inspection.run_bounded(arguments + [command], min(180, deadline - time.monotonic()), limit=131072)
        state["inspection"] = validate_result(output)
        if code != 0 or state["inspection"]["result"] != "PASS_READ_ONLY_INSPECTION":
            raise Error("SMTP_NETWORK_NOT_READY")
        state["result"] = "PASS_SMTP_NETWORK_INSPECTION"
    except Error as error:
        state["result"], state["error"] = "FAIL", str(error)
    except BaseException:
        state["result"], state["error"] = "FAIL", "SMTP_INSPECTION_UNEXPECTED_ERROR"
    finally:
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup")):
            state["result"] = "FAIL"
            state["error"] = state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_SMTP_NETWORK_INSPECTION" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
