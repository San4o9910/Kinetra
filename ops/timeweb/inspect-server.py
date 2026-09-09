#!/usr/bin/env python3
"""Inspect the explicitly supplied empty server; never install or deploy.

The exact server ID and IP were confirmed in provisioning run 34398453344.
Host identity is trust on first use
(TOFU), not provider-attested. Serialize with provisioning/deployment workflows.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


BASE = "https://api.timeweb.cloud/api/v1"
REPOSITORY = "San4o9910/Kinetra"
SERVER_NAME = "kinetra-app-hourly-20260909"
SERVER_ID = 9069403
PUBLIC_IPV4 = "80.68.156.131"
MAX_BODY = 1_048_576
INSPECTION_SECONDS = 720
SERVER_READINESS_SECONDS = 300
PROPAGATION_SECONDS = 120
SELECTED_PORTS = frozenset({22, 80, 443, 5432, 6379, 8000, 8080})

# Executed unchanged over SSH. No supplied value is interpolated into this
# program. All command output is discarded or reduced to the fixed JSON schema.
GUEST_PROGRAM = r'''
import json, os, pathlib, shutil, subprocess

def command(args, timeout):
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False)
    except Exception:
        return None

try:
    cloud = subprocess.run(
        ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "180s",
         "/usr/bin/cloud-init", "status", "--wait"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=190, check=False)
    cloud_status = "PASS" if cloud.returncode == 0 else "FAILED_OR_WARNINGS"
except Exception:
    cloud_status = "TIMEOUT_OR_UNAVAILABLE"

try:
    marker = pathlib.Path("/var/lib/kinetra/bootstrap")
    bootstrap = marker.is_file() and marker.read_bytes() == b"empty-server-bootstrap-v1\n"
except Exception:
    bootstrap = False

# SSH_CONNECTION is used only to evaluate Match rules for this connection.
# Its contents and all other environment variables are never emitted.
ssh_values = {}
connection = os.environ.get("SSH_CONNECTION", "").split()
if len(connection) == 4:
    import ipaddress
    try:
        remote = str(ipaddress.ip_address(connection[0]))
        local = str(ipaddress.ip_address(connection[2]))
        port = int(connection[3])
        if not 1 <= port <= 65535:
            raise ValueError()
        context = "user=root,addr=" + remote + ",laddr=" + local + ",lport=" + str(port)
        result = command(["/usr/sbin/sshd", "-T", "-C", context], 10)
        if result is not None and result.returncode == 0 and len(result.stdout) <= 65536:
            ssh_values = dict(line.split(None, 1) for line in result.stdout.decode().splitlines() if " " in line)
    except Exception:
        pass
password_disabled = ssh_values.get("passwordauthentication") == "no"
interactive_disabled = ssh_values.get("kbdinteractiveauthentication") == "no"
root_key_only = ssh_values.get("permitrootlogin") in {"prohibit-password", "without-password"}

os_id, os_version = "UNKNOWN", "UNKNOWN"
try:
    import shlex
    for line in pathlib.Path("/etc/os-release").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"ID", "VERSION_ID"}:
            values = shlex.split(value)
            if len(values) == 1:
                if key == "ID": os_id = values[0]
                else: os_version = values[0]
except Exception:
    pass

ram_bytes, root_total_bytes, root_free_bytes = 0, 0, 0
try:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemTotal:"):
            ram_bytes = int(line.split()[1]) * 1024
    disk = shutil.disk_usage("/")
    root_total_bytes, root_free_bytes = disk.total, disk.free
except Exception:
    pass
ports, ports_verified = set(), False
listeners = command(["/usr/bin/ss", "-H", "-lntu"], 10)
if listeners is not None and listeners.returncode == 0 and len(listeners.stdout) <= 65536:
    try:
        for line in listeners.stdout.decode().splitlines():
            fields = line.split()
            port = fields[4].rsplit(":", 1)[-1]
            if port.isdigit() and int(port) in {22, 80, 443, 5432, 6379, 8000, 8080}:
                ports.add(int(port))
        ports_verified = True
    except Exception:
        ports, ports_verified = set(), False

print(json.dumps({
    "schema": 1, "cloud_init": cloud_status, "bootstrap_marker": bootstrap,
    "password_auth_disabled": password_disabled,
    "keyboard_interactive_disabled": interactive_disabled,
    "root_login_key_only": root_key_only,
    "os_id": os_id, "os_version": os_version, "cpu_count": os.cpu_count() or 0,
    "ram_bytes": ram_bytes, "root_total_bytes": root_total_bytes,
    "root_free_bytes": root_free_bytes,
    "docker_available": shutil.which("docker") is not None,
    "selected_listener_ports": sorted(ports), "listeners_verified": ports_verified,
}, sort_keys=True))
'''


class InspectError(Exception):
    """Only fixed, locally constructed codes may be emitted."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise InspectError("API_REDIRECT_REFUSED")


def alarm(_signum, _frame):
    raise InspectError("API_REQUEST_DEADLINE_EXCEEDED")


def interrupted(_signum, _frame):
    raise InspectError("RUN_INTERRUPTED")


def positive_id(value):
    if type(value) is not int or not 0 < value < 2**63:
        raise InspectError("RESOURCE_ID_INVALID")
    return value


def ssh_key_object(document):
    wrappers = [key for key in ("ssh_key", "ssh-key") if key in document]
    if len(wrappers) != 1 or not isinstance(document[wrappers[0]], dict):
        raise InspectError("SSH_KEY_RESPONSE_WRAPPER_INVALID")
    return document[wrappers[0]]


class Api:
    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id = None
        self.server_verified = False
        self.key_post_attempted = False
        self.attach_attempted = False
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def authorize(self, method, path):
        if method == "GET" and path == f"/servers/{self.server_id}":
            return
        if method == "POST" and path == "/ssh-keys" and self.server_verified and not self.key_post_attempted:
            self.key_post_attempted = True
            return
        if self.key_id is not None and self.server_verified:
            if method == "POST" and path == f"/servers/{self.server_id}/ssh-keys" and not self.attach_attempted:
                self.attach_attempted = True
                return
            if method == "DELETE" and path in {
                f"/servers/{self.server_id}/ssh-keys/{self.key_id}", f"/ssh-keys/{self.key_id}",
            }:
                return
        raise InspectError("API_OPERATION_REFUSED")

    def request(self, method, path, payload=None):
        self.authorize(method, path)
        timeout = 20 if method == "DELETE" else min(20, self.deadline - time.monotonic())
        if timeout <= 1:
            raise InspectError("INSPECTION_DEADLINE_EXCEEDED")
        data = json.dumps(payload, allow_nan=False).encode() if payload is not None else None
        if (method == "POST") != (isinstance(payload, dict)) or (data is not None and len(data) > 16384):
            raise InspectError("API_REQUEST_BODY_INVALID")
        request = urllib.request.Request(BASE + path, method=method, data=data, headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/json",
            "Content-Type": "application/json", "User-Agent": "kinetra-server-inspect/1",
        })
        previous = signal.signal(signal.SIGALRM, alarm)
        signal.setitimer(signal.ITIMER_REAL, timeout)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                expected = {200} if method == "GET" else ({200, 201} if path == "/ssh-keys" else {204})
                if response.status not in expected:
                    raise InspectError("API_UNEXPECTED_STATUS")
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise InspectError("API_RESPONSE_TOO_LARGE")
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if type(code) is not int or not 100 <= code <= 599:
                raise InspectError("API_HTTP_ERROR") from None
            raise InspectError("API_HTTP_" + str(code)) from None
        except (urllib.error.URLError, OSError, TimeoutError):
            raise InspectError("API_CONNECTION_FAILED") from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        if method == "DELETE" or (method == "POST" and path != "/ssh-keys"):
            return {}
        try:
            document = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise InspectError("API_JSON_INVALID") from None
        if not isinstance(document, dict):
            raise InspectError("API_RESPONSE_SHAPE_INVALID")
        return document


def run_bounded(arguments, timeout, limit=16384):
    """Capture bounded output without streaming any subprocess diagnostics."""
    if timeout <= 0:
        raise InspectError("INSPECTION_DEADLINE_EXCEEDED")
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    output = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise InspectError("SUBPROCESS_TIMEOUT")
                for key, _event in selector.select(min(remaining, 1)):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output[key.data].extend(chunk)
                        if sum(map(len, output.values())) > limit:
                            raise InspectError("SUBPROCESS_OUTPUT_TOO_LARGE")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise InspectError("SUBPROCESS_TIMEOUT")
            result = process.wait(timeout=remaining)
        return result, bytes(output["stdout"]), bytes(output["stderr"])
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def validate_server(document, server_id, public_ip):
    server = document.get("server")
    if not isinstance(server, dict) or positive_id(server.get("id")) != server_id or server.get("name") != SERVER_NAME:
        raise InspectError("SERVER_IDENTITY_MISMATCH")
    addresses = []
    networks = server.get("networks")
    if not isinstance(networks, list):
        raise InspectError("SERVER_NETWORK_SHAPE_INVALID")
    for network in networks:
        if not isinstance(network, dict) or network.get("type") != "public":
            continue
        ips = network.get("ips")
        if not isinstance(ips, list):
            raise InspectError("SERVER_NETWORK_SHAPE_INVALID")
        for entry in ips:
            if isinstance(entry, dict) and entry.get("type") == "ipv4":
                if entry.get("is_main") is not True:
                    raise InspectError("SERVER_PUBLIC_IP_NOT_MAIN")
                addresses.append(entry.get("ip"))
    if addresses != [public_ip]:
        raise InspectError("SERVER_PUBLIC_IP_MISMATCH")
    status = server.get("status")
    if status not in {"on", "off", "installing", "starting", "rebooting", "updating",
                      "blocked", "no_paid", "permanent_blocked", "removed", "error", "failed"}:
        raise InspectError("SERVER_STATUS_UNKNOWN")
    return {"server_id": server_id, "server_status": status, "public_ipv4": public_ip}


def wait_for_server(api, state):
    deadline = min(api.deadline, time.monotonic() + SERVER_READINESS_SECONDS)
    while deadline - time.monotonic() > 1:
        state.update(validate_server(api.request("GET", f"/servers/{SERVER_ID}"), SERVER_ID, PUBLIC_IPV4))
        emit(state)
        if state["server_status"] == "on":
            api.server_verified = True
            return
        if state["server_status"] in {"blocked", "no_paid", "permanent_blocked", "removed", "error", "failed"}:
            raise InspectError("SERVER_FAILURE_STATE")
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    raise InspectError("SERVER_READINESS_TIMEOUT")


def write_private_file(path, body):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(body)


def prepare_key(folder, deadline):
    private = folder / "id_ed25519"
    code, _stdout, _stderr = run_bounded([
        "/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C",
        "kinetra-inspect-ephemeral", "-f", str(private),
    ], min(15, deadline - time.monotonic()))
    if code != 0:
        raise InspectError("LOCAL_KEY_GENERATION_FAILED")
    info = private.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise InspectError("PRIVATE_KEY_PERMISSIONS_INVALID")
    public_path = folder / "id_ed25519.pub"
    if not public_path.is_file() or public_path.stat().st_size > 4096:
        raise InspectError("LOCAL_PUBLIC_KEY_INVALID")
    public_key = public_path.read_text(encoding="ascii").strip()
    fields = public_key.split()
    if len(fields) != 3 or fields[0] != "ssh-ed25519" or fields[2] != "kinetra-inspect-ephemeral":
        raise InspectError("LOCAL_PUBLIC_KEY_INVALID")
    return private, public_key


def pin_host_key(public_ip, folder, deadline):
    code, output, _stderr = run_bounded([
        "/usr/bin/ssh-keyscan", "-T", "10", "-t", "ed25519", public_ip,
    ], min(15, deadline - time.monotonic()))
    if code != 0:
        raise InspectError("HOST_KEY_SCAN_FAILED")
    try:
        lines = [line.split() for line in output.decode("ascii").splitlines() if line and not line.startswith("#")]
        if len(lines) != 1 or len(lines[0]) != 3 or lines[0][:2] != [public_ip, "ssh-ed25519"]:
            raise ValueError()
        encoded = lines[0][2]
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) != 51 or raw[:19] != struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise InspectError("HOST_KEY_SCAN_RESPONSE_INVALID") from None
    known_hosts = folder / "known_hosts"
    write_private_file(known_hosts, (public_ip + " ssh-ed25519 " + encoded + "\n").encode("ascii"))
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
    return known_hosts, fingerprint


def ssh_arguments(public_ip, private_key, known_hosts):
    return [
        "/usr/bin/ssh", "-F", "/dev/null", "-T", "-a", "-x",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(known_hosts),
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
        "-o", "VerifyHostKeyDNS=no", "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
        "-o", "PreferredAuthentications=publickey", "-o", "ClearAllForwardings=yes",
        "-o", "ConnectionAttempts=1", "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
        "-o", "LogLevel=ERROR", "-i", str(private_key), "root@" + public_ip,
    ]


def wait_for_key(arguments, deadline):
    end = min(deadline, time.monotonic() + PROPAGATION_SECONDS)
    while end - time.monotonic() > 1:
        try:
            code, output, error = run_bounded(arguments + ["/usr/bin/true"], min(12, end - time.monotonic()))
        except InspectError as failure:
            if str(failure) != "SUBPROCESS_TIMEOUT":
                raise
        else:
            if b"REMOTE HOST IDENTIFICATION HAS CHANGED" in error or b"Host key verification failed" in error:
                raise InspectError("SSH_HOST_KEY_MISMATCH")
            if code == 0 and not output:
                return
        remaining = end - time.monotonic()
        if remaining > 0:
            time.sleep(min(5, remaining))
    raise InspectError("SSH_KEY_PROPAGATION_TIMEOUT")


def validate_guest(raw):
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise InspectError("GUEST_RESULT_INVALID") from None
    expected = {
        "schema", "cloud_init", "bootstrap_marker", "password_auth_disabled",
        "keyboard_interactive_disabled", "root_login_key_only", "os_id", "os_version",
        "cpu_count", "ram_bytes", "root_total_bytes", "root_free_bytes", "docker_available",
        "selected_listener_ports", "listeners_verified",
    }
    if not isinstance(result, dict) or set(result) != expected or type(result["schema"]) is not int or result["schema"] != 1:
        raise InspectError("GUEST_RESULT_SCHEMA_INVALID")
    if result["cloud_init"] not in {"PASS", "FAILED_OR_WARNINGS", "TIMEOUT_OR_UNAVAILABLE"}:
        raise InspectError("GUEST_RESULT_SCHEMA_INVALID")
    for key in ("bootstrap_marker", "password_auth_disabled", "keyboard_interactive_disabled", "root_login_key_only", "docker_available", "listeners_verified"):
        if type(result[key]) is not bool:
            raise InspectError("GUEST_RESULT_SCHEMA_INVALID")
    if result["os_id"] != "ubuntu" or result["os_version"] != "24.04":
        raise InspectError("GUEST_OS_UNEXPECTED")
    for key in ("cpu_count", "ram_bytes", "root_total_bytes", "root_free_bytes"):
        if type(result[key]) is not int or not 0 <= result[key] < 2**50:
            raise InspectError("GUEST_RESULT_SCHEMA_INVALID")
    ports = result["selected_listener_ports"]
    if not isinstance(ports, list) or any(type(port) is not int or port not in SELECTED_PORTS for port in ports) or ports != sorted(set(ports)):
        raise InspectError("GUEST_RESULT_SCHEMA_INVALID")
    return result


def cleanup(api, folder, state):
    if api is not None and api.key_id is not None:
        for label, path in (
            ("guest_key_cleanup", f"/servers/{api.server_id}/ssh-keys/{api.key_id}"),
            ("account_key_cleanup", f"/ssh-keys/{api.key_id}"),
        ):
            try:
                api.request("DELETE", path)
                state[label] = "API_DELETE_CONFIRMED"
            except InspectError as error:
                state[label] = "ALREADY_ABSENT" if str(error) == "API_HTTP_404" else "FAILED_RECONCILE"
            except BaseException:
                state[label] = "FAILED_RECONCILE"
    elif api is not None and api.key_post_attempted:
        state["account_key_cleanup"] = "UNVERIFIED_KEY_RECONCILE"
    if folder is not None:
        try:
            shutil.rmtree(folder)
            state["local_key_cleanup"] = "REMOVED"
        except BaseException:
            state["local_key_cleanup"] = "FAILED"
    if api is not None:
        api.token = ""


def emit(state):
    print("TIMEWEB_SERVER_INSPECTION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None, environ=None, api_factory=Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {
        "result": "IN_PROGRESS", "server_id": None, "server_status": "UNKNOWN", "public_ipv4": None,
        "ssh_key_id": None, "host_key_fingerprint": None, "host_key_trust": "TOFU_NOT_PROVIDER_ATTESTED",
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "guest": None, "application_readiness": "NOT_TESTED", "error": None,
        "ssh_configuration_scope": "ROOT_AND_CURRENT_ADDRESS_CONTEXT",
    }
    api, folder = None, None
    try:
        if argv != ["--inspect-existing-server"]:
            raise InspectError("EXPLICIT_INSPECTION_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != REPOSITORY or environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise InspectError("AUTHORIZED_FIRST_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
            raise InspectError("SUPPLIED_RUN_ID_INVALID")
        server_id, public_ip = SERVER_ID, PUBLIC_IPV4
        if environ.get("ROOT_SUPPLIED_SERVER_ID", str(server_id)) != str(server_id) or environ.get("ROOT_SUPPLIED_SERVER_IP", public_ip) != public_ip:
            raise InspectError("CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        if not runtime_temp.is_absolute() or not runtime_temp.is_dir():
            raise InspectError("RUNNER_TEMP_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        if not token or len(token) > 16384 or any(character.isspace() for character in token):
            raise InspectError("TIMEWEB_SECRET_MISSING_OR_INVALID")
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + INSPECTION_SECONDS
        api = api_factory(token, server_id, deadline)
        del token
        wait_for_server(api, state)
        folder = Path(tempfile.mkdtemp(prefix="kinetra-inspect-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        private, public_key = prepare_key(folder, deadline)
        name = "kinetra-inspect-" + run_id
        key = ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            raise InspectError("CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state["account_key_cleanup"] = "PENDING"
        emit(state)
        state["guest_key_cleanup"] = "ATTACH_OUTCOME_UNKNOWN"
        emit(state)
        api.request("POST", f"/servers/{server_id}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        # Revalidate the server/IP immediately before the one TOFU scan.
        state.update(validate_server(api.request("GET", f"/servers/{server_id}"), server_id, public_ip))
        if state["server_status"] != "on":
            raise InspectError("SERVER_NO_LONGER_ON")
        known_hosts, fingerprint = pin_host_key(public_ip, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        emit(state)
        arguments = ssh_arguments(public_ip, private, known_hosts)
        wait_for_key(arguments, deadline)
        import shlex
        command = "/usr/bin/python3 -c " + shlex.quote(GUEST_PROGRAM)
        code, output, _error = run_bounded(arguments + [command], min(215, deadline - time.monotonic()))
        if code != 0:
            raise InspectError("GUEST_INSPECTION_COMMAND_FAILED")
        state["guest"] = validate_guest(output)
        guest = state["guest"]
        if guest["cloud_init"] != "PASS" or not all(guest[key] for key in (
            "bootstrap_marker", "password_auth_disabled", "keyboard_interactive_disabled", "root_login_key_only",
        )):
            raise InspectError("GUEST_BOOTSTRAP_OR_SSH_CONFIGURATION_NOT_READY")
        state["result"] = "PASS_EMPTY_SERVER_INSPECTION_ONLY"
    except InspectError as error:
        state["result"], state["error"] = "FAIL", str(error)
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_RESPONSE_OR_RUNTIME_ERROR"
    finally:
        cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in (
            "guest_key_cleanup", "account_key_cleanup", "local_key_cleanup",
        )):
            state["result"] = "FAIL"
            state["error"] = state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_EMPTY_SERVER_INSPECTION_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
