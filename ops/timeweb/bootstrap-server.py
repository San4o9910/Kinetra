#!/usr/bin/env python3
"""Install host prerequisites only on the previously inspected Kinetra server.

No application deployment, database, certificate issuance, resource purchases,
or billing mutations. Requires an explicitly started GitHub Actions run. The
caller must reserve at least two extra minutes after the 30-minute deadline for
ephemeral-key cleanup. A failed/timeout run can leave partial host changes;
inspect that evidence and correct the cause before starting another run.
"""

from __future__ import annotations

import importlib.util
import ipaddress
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

_spec = importlib.util.spec_from_file_location(
    "kinetra_server_inspection", Path(__file__).with_name("inspect-server.py")
)
inspection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inspection)
Error = inspection.InspectError
PINNED_FINGERPRINT = "SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0"
BOOTSTRAP_SECONDS = 1800
REMOTE_SECONDS = 1100

# This is a separate, fixed mutating program. The inspection program and helper
# module are never replaced or monkeypatched during production execution.
GUEST_BOOTSTRAP = r'''
import fcntl, ipaddress, json, os, pathlib, re, shlex, shutil, signal, stat, subprocess, tempfile, time

class BootstrapError(Exception):
    def __init__(self, code, unexpected_listener=None):
        super().__init__(code)
        self.unexpected_listener = unexpected_listener

def interrupted(_signum, _frame):
    raise BootstrapError("REMOTE_INTERRUPTED_PARTIAL_STATE")

def command(args, timeout=30, capture=False):
    """Every child has a bounded lifetime; package output never reaches SSH."""
    environment = dict(os.environ, LC_ALL="C", DEBIAN_FRONTEND="noninteractive")
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
        if output is not None and len(output) > 65536:
            raise BootstrapError("REMOTE_COMMAND_OUTPUT_TOO_LARGE")
        if process.returncode != 0:
            raise BootstrapError("REMOTE_COMMAND_FAILED")
        return (output or b"").decode("utf-8", errors="strict")
    except subprocess.TimeoutExpired:
        raise BootstrapError("REMOTE_COMMAND_TIMEOUT_PARTIAL_STATE") from None
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

def safe_directory(path):
    path = pathlib.Path(path)
    if not path.exists():
        path.mkdir(mode=0o755)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise BootstrapError("UNSAFE_CONFIGURATION_DIRECTORY")
    return path

def validate_log_configuration(document):
    if not isinstance(document, dict):
        raise BootstrapError("EXISTING_DOCKER_CONFIGURATION_INVALID")
    driver = document.get("log-driver")
    options = document.get("log-opts", {})
    if driver not in {"local", "json-file"} or not isinstance(options, dict):
        raise BootstrapError("EXISTING_DOCKER_LOG_LIMITS_NOT_CONFIRMED")
    # Docker's local driver has bounded defaults; json-file does not. Explicit
    # bounds are required here so both existing and created settings are clear.
    size, count = options.get("max-size"), options.get("max-file")
    if not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{0,2}m", size):
        raise BootstrapError("EXISTING_DOCKER_LOG_LIMITS_NOT_CONFIRMED")
    if int(size[:-1]) > 100 or not isinstance(count, str) or not re.fullmatch(r"[1-9]", count):
        raise BootstrapError("EXISTING_DOCKER_LOG_LIMITS_NOT_CONFIRMED")
    # Ubuntu's systemd unit supplies its own host flag. JSON hosts can conflict
    # even for a Unix socket; custom data roots could conceal existing workloads.
    if "hosts" in document:
        raise BootstrapError("EXISTING_DOCKER_HOST_CONFIGURATION_REFUSED")
    if "data-root" in document and document["data-root"] != "/var/lib/docker":
        raise BootstrapError("EXISTING_DOCKER_CUSTOM_DATA_ROOT_REFUSED")

def configure_docker(path=pathlib.Path("/etc/docker/daemon.json")):
    path = pathlib.Path(path)
    directory = safe_directory(path.parent)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 65536:
            raise BootstrapError("EXISTING_DOCKER_CONFIGURATION_UNSAFE")
        try:
            validate_log_configuration(json.loads(path.read_bytes()))
        except (ValueError, UnicodeError):
            raise BootstrapError("EXISTING_DOCKER_CONFIGURATION_INVALID") from None
        return "EXISTING_PRESERVED"
    body = b'{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}\n'
    # An exclusive hard-link makes the completed write visible atomically and
    # refuses to replace a file created concurrently. Only our temp file is removed.
    descriptor, temporary = tempfile.mkstemp(prefix=".kinetra-daemon-", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.link(temporary, path, follow_symlinks=False)
    finally:
        os.unlink(temporary)
    return "CREATED_BOUNDED_LOCAL_LOGS"

def assert_empty_docker():
    directory = pathlib.Path("/var/lib/docker")
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise BootstrapError("DOCKER_DATA_DIRECTORY_UNSAFE")
    if shutil.which("docker") is None:
        if directory.exists() and any(directory.iterdir()):
            raise BootstrapError("DOCKER_RETAINED_DATA_REQUIRES_INSPECTION")
        return
    active = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "docker"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=10, check=False).returncode == 0
    if not active:
        if directory.exists() and any(directory.iterdir()):
            raise BootstrapError("INACTIVE_DOCKER_DATA_REQUIRES_INSPECTION")
        return
    for arguments in (["container", "ls", "--all", "--quiet"],
                      ["image", "ls", "--all", "--quiet"], ["volume", "ls", "--quiet"]):
        if command(["/usr/bin/docker", *arguments], capture=True).strip():
            raise BootstrapError("EXISTING_DOCKER_WORKLOAD_REFUSED")

def assert_expected_ufw_rules():
    if shutil.which("ufw") is None:
        return
    output = command(["/usr/sbin/ufw", "show", "added"], capture=True)
    allowed = {"ufw allow 22/tcp", "ufw allow 80/tcp", "ufw allow 443/tcp"}
    for row in output.splitlines():
        row = row.strip()
        if row and not row.startswith("Added user rules") and row not in allowed:
            raise BootstrapError("EXISTING_UFW_RULES_REQUIRE_INSPECTION")

def assert_expected_listeners(output):
    """Parse numeric ss TCP output; expose only a normalized rejected endpoint."""
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        # `ss -H -lnt` emits State/Recv-Q/Send-Q/Local/Peer. Also handle the
        # explicit TCP Netid column without guessing indexes from other formats.
        offset = 1 if fields[0] == "tcp" else 0
        if len(fields) != offset + 5 or fields[offset] != "LISTEN" or not all(
            re.fullmatch(r"[0-9]+", value) for value in fields[offset + 1:offset + 3]
        ):
            raise BootstrapError("TCP_LISTENER_OUTPUT_INVALID")
        endpoint = fields[offset + 3]
        address, separator, port_text = endpoint.rpartition(":")
        if not separator or not re.fullmatch(r"[0-9]{1,5}", port_text) or not 1 <= int(port_text) <= 65535:
            raise BootstrapError("TCP_LISTENER_ENDPOINT_INVALID")
        port = int(port_text)
        if address.startswith("[") and address.endswith("]"):
            address = address[1:-1]
        elif "[" in address or "]" in address:
            raise BootstrapError("TCP_LISTENER_ENDPOINT_INVALID")
        if "%" in address:
            address, zone = address.split("%", 1)
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", zone):
                raise BootstrapError("TCP_LISTENER_ENDPOINT_INVALID")
        if address == "*":
            normalized, loopback = "*", False
        else:
            try:
                numeric = ipaddress.ip_address(address)
            except ValueError:
                raise BootstrapError("TCP_LISTENER_ENDPOINT_INVALID") from None
            normalized = str(numeric)
            loopback = numeric.is_loopback
            if isinstance(numeric, ipaddress.IPv6Address) and numeric.ipv4_mapped is not None:
                loopback = numeric.ipv4_mapped.is_loopback
        if port != 22 and not loopback:
            raise BootstrapError("EXISTING_PUBLIC_LISTENER_REFUSED", {
                "address": normalized, "port": port,
            })

def assert_empty_host():
    if os.geteuid() != 0:
        raise BootstrapError("ROOT_REQUIRED")
    os_release = {}
    for line in pathlib.Path("/etc/os-release").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator:
            parsed = shlex.split(value)
            if len(parsed) == 1:
                os_release[key] = parsed[0]
    if os_release.get("ID") != "ubuntu" or os_release.get("VERSION_ID") != "24.04":
        raise BootstrapError("GUEST_OS_UNEXPECTED")
    marker = pathlib.Path("/var/lib/kinetra/bootstrap")
    if marker.is_symlink() or not marker.is_file() or marker.read_bytes() != b"empty-server-bootstrap-v1\n":
        raise BootstrapError("EMPTY_SERVER_MARKER_MISSING")
    connection = os.environ.get("SSH_CONNECTION", "").split()
    if len(connection) != 4 or connection[3] != "22":
        raise BootstrapError("SSH_DESTINATION_PORT_UNEXPECTED")
    for location in ("/opt/kinetra", "/srv/kinetra", "/var/lib/postgresql"):
        path = pathlib.Path(location)
        if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
            raise BootstrapError("EXISTING_APPLICATION_DATA_REFUSED")
    if shutil.disk_usage("/").free < 5 * 1024**3:
        raise BootstrapError("FREE_DISK_TOO_SMALL")
    # Ignore loopback-only OS services; every public TCP listener must
    # be SSH on the already inspected port. No existing web app is disturbed.
    output = command(["/usr/bin/ss", "-H", "-lnt"], capture=True)
    assert_expected_listeners(output)
    assert_empty_docker()
    assert_expected_ufw_rules()

def install_packages():
    keyring = pathlib.Path("/usr/share/keyrings/ubuntu-archive-keyring.gpg")
    if not keyring.is_file():
        raise BootstrapError("UBUNTU_ARCHIVE_KEYRING_MISSING")
    # Use Ubuntu's signed official archives for this command only. Preserve all
    # persistent apt source files, package configuration, and existing data.
    source = (
        "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe\n"
        "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe\n"
        "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe\n"
    )
    with tempfile.TemporaryDirectory(prefix="kinetra-host-apt-", dir="/run") as directory:
        path = pathlib.Path(directory) / "sources.list"
        path.write_text(source)
        arguments = ["/usr/bin/apt-get", "-o", "Dir::Etc::sourcelist=" + str(path),
            "-o", "Dir::Etc::sourceparts=-", "-o", "Acquire::Retries=0",
            "-o", "Acquire::https::Timeout=30", "-o", "APT::Update::Error-Mode=any",
            "-o", "DPkg::Lock::Timeout=30", "-o", "Dpkg::Options::=--force-confold"]
        command([*arguments, "update"], timeout=180)
        command([*arguments, "--yes", "--no-remove", "--no-upgrade", "--no-install-recommends",
                 "install", "docker.io", "docker-compose-v2", "ufw"], timeout=480)

def configure_firewall():
    assert_expected_ufw_rules()
    for port in (22, 80, 443):
        command(["/usr/sbin/ufw", "allow", str(port) + "/tcp"])
    command(["/usr/sbin/ufw", "default", "deny", "incoming"])
    command(["/usr/sbin/ufw", "default", "allow", "outgoing"])
    command(["/usr/sbin/ufw", "--force", "enable"])
    status = command(["/usr/sbin/ufw", "status", "verbose"], capture=True)
    if "Status: active" not in status or "deny (incoming), allow (outgoing)" not in status:
        raise BootstrapError("UFW_ACTIVE_DEFAULTS_NOT_VERIFIED")
    for port in (22, 80, 443):
        if not re.search(r"^" + str(port) + r"/tcp\s+ALLOW IN\s+Anywhere\s*$", status, re.MULTILINE):
            raise BootstrapError("UFW_ALLOWED_PORT_NOT_VERIFIED")
    return "ACTIVE_22_80_443_ALLOWED_DEFAULT_INCOMING_DENY"

def main():
    state = {"schema": 1, "result": "FAIL", "stage": "PRECONDITIONS", "error": None,
             "docker_config": None, "docker_version": None, "compose_version": None,
             "firewall": None, "application_deployed": False, "unexpected_listener": None}
    descriptor = None
    try:
        descriptor = os.open("/run/kinetra-host-bootstrap.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise BootstrapError("REMOTE_LOCK_UNSAFE")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BootstrapError("REMOTE_BOOTSTRAP_ALREADY_RUNNING") from None
        assert_empty_host()
        state["stage"] = "DOCKER_CONFIGURATION"
        state["docker_config"] = configure_docker()
        state["stage"] = "PACKAGE_INSTALLATION"
        install_packages()
        state["stage"] = "DOCKER_START"
        command(["/usr/bin/dockerd", "--validate", "--config-file=/etc/docker/daemon.json"])
        command(["/usr/bin/systemctl", "enable", "docker"])
        command(["/usr/bin/systemctl", "restart", "docker"], timeout=90)
        assert_empty_docker()
        state["docker_version"] = command(["/usr/bin/docker", "version", "--format", "{{.Server.Version}}"], capture=True).strip()
        state["compose_version"] = command(["/usr/bin/docker", "compose", "version", "--short"], capture=True).strip()
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.~-]+)?", state["docker_version"] or ""):
            raise BootstrapError("DOCKER_VERSION_UNEXPECTED")
        if not re.fullmatch(r"v?2\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.~-]+)?", state["compose_version"] or ""):
            raise BootstrapError("COMPOSE_VERSION_UNEXPECTED")
        compose_minor = int(state["compose_version"].lstrip("v").split(".")[1])
        if compose_minor < 30:
            raise BootstrapError("COMPOSE_2_30_REQUIRED_FOR_RAW_ENV_FILES")
        state["stage"] = "FIREWALL_CONFIGURATION"
        state["firewall"] = configure_firewall()
        state["stage"], state["result"] = "HOST_PREREQUISITES_COMPLETE", "PASS"
    except BootstrapError as error:
        state["error"] = str(error)
        state["unexpected_listener"] = error.unexpected_listener
    except BaseException:
        state["error"] = "REMOTE_UNEXPECTED_ERROR_PARTIAL_STATE"
    finally:
        if descriptor is not None:
            os.close(descriptor)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "PASS" else 1

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
'''


def emit(state):
    print("TIMEWEB_HOST_BOOTSTRAP=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def require_inspected_guest(raw, *, after=False):
    guest = inspection.validate_guest(raw)
    if guest["cloud_init"] != "PASS" or not all(guest[key] for key in (
        "bootstrap_marker", "password_auth_disabled", "keyboard_interactive_disabled",
        "root_login_key_only", "listeners_verified",
    )) or guest["selected_listener_ports"] != [22]:
        raise Error("GUEST_SSH_OR_EMPTY_HOST_PRECONDITION_FAILED")
    if after and not guest["docker_available"]:
        raise Error("POST_BOOTSTRAP_DOCKER_UNAVAILABLE")
    return guest


def validate_bootstrap_result(raw):
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise Error("BOOTSTRAP_RESULT_INVALID_PARTIAL_STATE") from None
    expected = {"schema", "result", "stage", "error", "docker_config", "docker_version",
                "compose_version", "firewall", "application_deployed", "unexpected_listener"}
    if not isinstance(result, dict) or set(result) != expected or type(result["schema"]) is not int or result["schema"] != 1 or result["application_deployed"] is not False:
        raise Error("BOOTSTRAP_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    if result["result"] not in {"PASS", "FAIL"}:
        raise Error("BOOTSTRAP_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    # The remote output is never reflected until every string is restricted.
    for name in ("stage", "error", "docker_config", "firewall"):
        value = result[name]
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[A-Z0-9_]{1,96}", value)):
            raise Error("BOOTSTRAP_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    for name in ("docker_version", "compose_version"):
        value = result[name]
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.~-]+)?", value)):
            raise Error("BOOTSTRAP_RESULT_SCHEMA_INVALID_PARTIAL_STATE")
    listener = result["unexpected_listener"]
    if listener is not None:
        if not isinstance(listener, dict) or set(listener) != {"address", "port"}:
            raise Error("BOOTSTRAP_LISTENER_EVIDENCE_INVALID")
        address, port = listener["address"], listener["port"]
        if not isinstance(address, str) or type(port) is not int or not 1 <= port <= 65535 or port == 22:
            raise Error("BOOTSTRAP_LISTENER_EVIDENCE_INVALID")
        if address != "*":
            try:
                numeric = ipaddress.ip_address(address)
            except ValueError:
                raise Error("BOOTSTRAP_LISTENER_EVIDENCE_INVALID") from None
            if str(numeric) != address or "%" in address or numeric.is_loopback or (
                isinstance(numeric, ipaddress.IPv6Address) and numeric.ipv4_mapped is not None and numeric.ipv4_mapped.is_loopback
            ):
                raise Error("BOOTSTRAP_LISTENER_EVIDENCE_INVALID")
        if result["result"] != "FAIL" or result["stage"] != "PRECONDITIONS" or result["error"] != "EXISTING_PUBLIC_LISTENER_REFUSED":
            raise Error("BOOTSTRAP_LISTENER_EVIDENCE_INVALID")
    elif result["error"] == "EXISTING_PUBLIC_LISTENER_REFUSED":
        raise Error("BOOTSTRAP_LISTENER_EVIDENCE_MISSING")
    if result["result"] == "PASS" and (
        result["stage"] != "HOST_PREREQUISITES_COMPLETE" or result["error"] is not None
        or result["docker_config"] not in {"EXISTING_PRESERVED", "CREATED_BOUNDED_LOCAL_LOGS"}
        or not result["docker_version"] or not result["compose_version"]
        or result["firewall"] != "ACTIVE_22_80_443_ALLOWED_DEFAULT_INCOMING_DENY"
    ):
        raise Error("BOOTSTRAP_PASS_EVIDENCE_INCOMPLETE")
    if result["result"] == "PASS":
        version = result["compose_version"].lstrip("v").split(".")
        if int(version[0]) != 2 or int(version[1]) < 30:
            raise Error("BOOTSTRAP_COMPOSE_2_30_REQUIRED")
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
        "before": None, "bootstrap": None, "after": None,
        "application_readiness": "NOT_DEPLOYED_OR_TESTED", "error": None,
    }
    api, folder = None, None
    try:
        if argv != ["--bootstrap-existing-empty-server"]:
            raise Error("EXPLICIT_HOST_BOOTSTRAP_FLAG_REQUIRED")
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
        deadline = time.monotonic() + BOOTSTRAP_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        del token
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on":
            raise Error("EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-host-bootstrap-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        # Scan and compare before creating a cloud key, and before any SSH.
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        if fingerprint != PINNED_FINGERPRINT:
            raise Error("PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-host-bootstrap-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            raise Error("CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state["account_key_cleanup"] = "PENDING"
        state["guest_key_cleanup"] = "ATTACH_OUTCOME_UNKNOWN"
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
            raise Error("PRE_BOOTSTRAP_INSPECTION_FAILED")
        state["before"] = require_inspected_guest(output)
        emit(state)
        # Reserve a full remote execution window, a fresh-connection inspection,
        # and API cleanup. Do not start mutations with insufficient time left.
        if deadline - time.monotonic() < REMOTE_SECONDS + 260:
            raise Error("INSUFFICIENT_BOOTSTRAP_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=15s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -c " + shlex.quote(GUEST_BOOTSTRAP)
        code, output, _ = inspection.run_bounded(arguments + [command], REMOTE_SECONDS + 30)
        state["bootstrap"] = validate_bootstrap_result(output)
        emit(state)
        if code != 0 or state["bootstrap"]["result"] != "PASS":
            raise Error("REMOTE_BOOTSTRAP_FAILED_PARTIAL_STATE")
        # A separate SSH process verifies that firewall changes allow a fresh
        # connection, with the same pinned host identity and key-only settings.
        code, output, _ = inspection.run_bounded(arguments + [inspect_command], min(215, deadline - time.monotonic()))
        if code != 0:
            raise Error("POST_FIREWALL_SSH_RECONNECT_FAILED")
        state["after"] = require_inspected_guest(output, after=True)
        state["result"] = "PASS_HOST_PREREQUISITES_ONLY"
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
    return 0 if state["result"] == "PASS_HOST_PREREQUISITES_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
