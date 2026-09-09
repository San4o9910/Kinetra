#!/usr/bin/env python3
"""Read-only diagnosis of port 10050 on the pinned existing Kinetra host.

Only the temporary SSH key is created/removed. This script never installs,
changes services/firewalls, reads process command lines, or opens TLS/PSK files.
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

_spec = importlib.util.spec_from_file_location("server_inspection", Path(__file__).with_name("inspect-server.py"))
inspection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inspection)
Error = inspection.InspectError
PINNED_FINGERPRINT = "SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0"

# Shared pure parsers are used by the guest and the output validator. They never
# perform IO and accept only the specific numeric endpoints/hostnames requested.
PARSERS = r'''
import ipaddress, re

def host(value, networks=False):
    if not isinstance(value, str) or len(value) > 253 or "%" in value:
        raise ValueError("INVALID_HOST")
    try:
        if "/" in value:
            if not networks:
                raise ValueError("NETWORK_NOT_ALLOWED")
            return str(ipaddress.ip_network(value, strict=False))
        return str(ipaddress.ip_address(value))
    except ValueError:
        if "/" in value:
            raise ValueError("INVALID_NETWORK") from None
    value = value.removesuffix(".").lower()
    labels = value.split(".")
    if not labels or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
        raise ValueError("INVALID_HOSTNAME")
    return value

def active_endpoint(value):
    if value.startswith("["):
        match = re.fullmatch(r"\[([^\]]+)\](?::([0-9]{1,5}))?", value)
        if not match:
            raise ValueError("INVALID_ACTIVE_ENDPOINT")
        address, port = match.groups()
        if not isinstance(ipaddress.ip_address(address), ipaddress.IPv6Address):
            raise ValueError("INVALID_ACTIVE_ENDPOINT")
    else:
        try:
            ipaddress.ip_address(value)
            address, port = value, None
        except ValueError:
            if value.count(":") > 1:
                raise ValueError("INVALID_ACTIVE_ENDPOINT") from None
            address, separator, port = value.partition(":")
            port = port if separator else None
    if port is not None and (not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535):
        raise ValueError("INVALID_ACTIVE_PORT")
    return {"host": host(address), "port": int(port) if port is not None else None}

def configuration_value(key, value):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("VALUE_TOO_LONG")
    if key == "ListenPort":
        if not re.fullmatch(r"[0-9]{1,5}", value) or not 1 <= int(value) <= 65535:
            raise ValueError("INVALID_LISTEN_PORT")
        return int(value)
    if not value:
        return []
    entries = value.split(",")
    if len(entries) > 32 or any(not entry.strip() for entry in entries):
        raise ValueError("INVALID_VALUE_LIST")
    if key == "Server":
        return [host(entry.strip(), networks=True) for entry in entries]
    if key == "ListenIP":
        return [str(ipaddress.ip_address(entry.strip())) for entry in entries]
    if key == "ServerActive":
        clusters = [entry.strip().split(";") for entry in entries]
        if any(len(cluster) > 16 for cluster in clusters):
            raise ValueError("INVALID_ACTIVE_CLUSTER")
        return [[active_endpoint(endpoint.strip()) for endpoint in cluster] for cluster in clusters]
    raise ValueError("UNAPPROVED_CONFIG_KEY")

def approved_config_path(value, pattern=False):
    # Only the default agent configs and conventional agent include directories.
    if not isinstance(value, str) or len(value) > 240:
        return False
    if value in {"/etc/zabbix/zabbix_agentd.conf", "/etc/zabbix/zabbix_agent2.conf"}:
        return True
    match = re.fullmatch(r"/etc/zabbix/(zabbix_agentd(?:\.conf)?\.d|zabbix_agent2\.d)/([A-Za-z0-9_*.-]+\.conf)", value)
    if not match or match.group(2) in {"..", "."} or ".." in match.group(2):
        return False
    if not pattern and "*" in match.group(2):
        return False
    # A config include named for key material is not needed for this diagnosis.
    return not re.search(r"(?:psk|private|secret|certificate|tls|\.key)", match.group(2), re.IGNORECASE)
'''
_parsers = {}
exec(compile(PARSERS, "<monitoring-pure-parsers>", "exec"), _parsers)

GUEST_PROGRAM = PARSERS + r'''
import errno, glob, itertools, json, os, pathlib, stat, subprocess

def command(args, timeout=10):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=timeout, check=False,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        if result.returncode != 0 or len(result.stdout) > 131072:
            return None
        return result.stdout.decode("utf-8", errors="strict")
    except Exception:
        return None

def read_small(path, limit=4096):
    with open(path, "rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("FILE_TOO_LARGE")
    return raw.decode("utf-8", errors="strict")

def socket_evidence(output):
    listeners, pids = [], set()
    for line in output.splitlines():
        fields = line.split()
        offset = 1 if fields and fields[0] == "tcp" else 0
        if len(fields) < offset + 5 or fields[offset] != "LISTEN":
            raise ValueError("SOCKET_FORMAT_INVALID")
        address, separator, port = fields[offset + 3].rpartition(":")
        if not separator or port != "10050":
            raise ValueError("SOCKET_PORT_MISMATCH")
        address = address.removeprefix("[").removesuffix("]").split("%", 1)[0]
        address = "*" if address == "*" else str(ipaddress.ip_address(address))
        owners = sorted(set(int(value) for value in re.findall(r"\bpid=([1-9][0-9]{0,8})(?:,|\))", line)))
        if not owners or len(owners) > 32:
            raise ValueError("SOCKET_PROCESS_UNCONFIRMED")
        listeners.append({"address": address, "port": 10050, "pids": owners})
        pids.update(owners)
        if len(listeners) > 16 or len(pids) > 32:
            raise ValueError("SOCKET_RESULT_TOO_LARGE")
    return listeners, sorted(pids)

def package_owner(executable):
    output = command(["/usr/bin/dpkg-query", "--search", executable])
    if output is None:
        return None
    owners = []
    for line in output.splitlines():
        name, separator, path = line.partition(": ")
        if separator and path == executable and re.fullmatch(r"[a-z0-9][a-z0-9+.-]{0,79}(?::[a-z0-9]+)?", name):
            owners.append(name)
    return owners[0] if len(owners) == 1 else None

def process_evidence(pid):
    entry = {"pid": pid, "name": None, "executable": None, "package": None,
             "service": None, "service_state": None, "status": "UNCONFIRMED"}
    try:
        name = read_small("/proc/" + str(pid) + "/comm", 64).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name):
            raise ValueError("PROCESS_NAME_UNEXPECTED")
        executable = os.readlink("/proc/" + str(pid) + "/exe")
        if not re.fullmatch(r"/(?:usr/)?(?:s?bin|lib|libexec)/[A-Za-z0-9_./+-]{1,220}", executable) or ".." in executable:
            raise ValueError("EXECUTABLE_PATH_UNEXPECTED")
        entry.update(name=name, executable=executable, package=package_owner(executable))
        cgroup = read_small("/proc/" + str(pid) + "/cgroup")
        services = set(re.findall(r"/system\.slice/([A-Za-z0-9_.@-]{1,120}\.service)(?:/|$)", cgroup, re.MULTILINE))
        if len(services) == 1:
            service = services.pop()
            output = command(["/usr/bin/systemctl", "show", service,
                "--property=Id,LoadState,ActiveState,SubState"])
            if output is not None:
                values = dict(row.split("=", 1) for row in output.splitlines() if "=" in row)
                if set(values) == {"Id", "LoadState", "ActiveState", "SubState"} and values["Id"] == service and all(
                    re.fullmatch(r"[a-z-]{1,32}", values[key]) for key in ("LoadState", "ActiveState", "SubState")
                ):
                    entry["service"], entry["service_state"] = service, values
        entry["status"] = "IDENTIFIED"
    except Exception:
        pass
    return entry

def read_configuration_file(path):
    if not approved_config_path(str(path)):
        return "OUTSIDE_APPROVED_CONFIG_PATHS", None
    # Open every component relative to a verified directory descriptor. A path
    # replacement between inspection and read cannot redirect this read to a
    # symlink target, secret file, or writable directory elsewhere.
    descriptor, file_descriptor = None, None
    try:
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            info = os.fstat(descriptor)
            if info.st_uid != 0 or info.st_mode & 0o022:
                return "UNSAFE_CONFIG_PATH", None
        file_descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        info = os.fstat(file_descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            return "UNSAFE_CONFIG_FILE", None
        if info.st_size > 262144:
            return "CONFIG_TOO_LARGE", None
        with os.fdopen(file_descriptor, "rb") as stream:
            file_descriptor = None
            raw = stream.read(262145)
        if len(raw) > 262144:
            return "CONFIG_TOO_LARGE", None
        return None, raw.decode("utf-8", errors="strict")
    except FileNotFoundError:
        return "NOT_PRESENT", None
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            return "SYMLINK_OR_NON_DIRECTORY_REFUSED", None
        return "UNREADABLE_CONFIG_FILE", None
    finally:
        if file_descriptor is not None:
            os.close(file_descriptor)
        if descriptor is not None:
            os.close(descriptor)

def configuration_evidence(paths):
    pending, queued, seen, results = list(paths), set(paths), set(), []
    while pending:
        path = pathlib.Path(pending.pop(0))
        if str(path) in seen:
            continue
        seen.add(str(path))
        if len(seen) > 32:
            raise ValueError("CONFIG_INCLUDE_LIMIT_EXCEEDED")
        entry = {"path": str(path), "status": "READ_APPROVED_KEYS_ONLY", "values": {}, "includes": [], "issues": []}
        problem, contents = read_configuration_file(path)
        if problem is not None:
            entry["status"] = problem
            results.append(entry)
            continue
        for line in contents.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if not separator or key not in {"Server", "ServerActive", "ListenIP", "ListenPort", "Include"}:
                continue
            if key == "Include":
                if not approved_config_path(value, pattern=True):
                    entry["issues"].append("INCLUDE_OUTSIDE_APPROVED_CONFIG_PATHS")
                    continue
                directory = pathlib.Path(value).parent
                if any(component.is_symlink() for component in [directory, *directory.parents]):
                    entry["issues"].append("INCLUDE_DIRECTORY_SYMLINK_REFUSED")
                    continue
                if value in entry["includes"]:
                    continue
                if len(entry["includes"]) >= 32:
                    raise ValueError("CONFIG_INCLUDE_LIMIT_EXCEEDED")
                entry["includes"].append(value)
                matches = list(itertools.islice(glob.iglob(value), 33))
                if len(matches) > 32:
                    raise ValueError("CONFIG_INCLUDE_LIMIT_EXCEEDED")
                for match in sorted(matches):
                    if approved_config_path(match):
                        if match not in queued:
                            if len(queued) >= 32:
                                raise ValueError("CONFIG_INCLUDE_LIMIT_EXCEEDED")
                            queued.add(match)
                            pending.append(match)
                    else:
                        entry["issues"].append("INCLUDE_OUTSIDE_APPROVED_CONFIG_PATHS")
                continue
            try:
                if key in entry["values"]:
                    entry["issues"].append("DUPLICATE_APPROVED_KEY")
                else:
                    entry["values"][key] = configuration_value(key, value)
            except ValueError:
                entry["issues"].append("INVALID_APPROVED_KEY_VALUE")
        entry["issues"] = sorted(set(entry["issues"]))
        results.append(entry)
    return results

def main():
    state = {"schema": 1, "result": "FAIL", "error": None, "listeners": [], "processes": [], "configs": [],
        "config_scope": "DEFAULT_ZABBIX_AGENT_PATHS_NOT_COMMAND_LINE_VERIFIED", "mutations": False}
    try:
        output = command(["/usr/bin/ss", "-H", "-lntp", "sport = :10050"])
        if output is None:
            raise ValueError("SOCKET_QUERY_FAILED")
        state["listeners"], pids = socket_evidence(output)
        state["processes"] = [process_evidence(pid) for pid in pids]
        paths = []
        executables = {entry["executable"] for entry in state["processes"]}
        if "/usr/sbin/zabbix_agentd" in executables:
            paths.append("/etc/zabbix/zabbix_agentd.conf")
        if "/usr/sbin/zabbix_agent2" in executables:
            paths.append("/etc/zabbix/zabbix_agent2.conf")
        state["configs"] = configuration_evidence(paths)
        state["result"] = "PASS_READ_ONLY_INSPECTION"
    except ValueError as error:
        code = str(error)
        state["error"] = code if re.fullmatch(r"[A-Z_]{1,64}", code) else "MONITORING_RESPONSE_INVALID"
    except BaseException:
        state["error"] = "MONITORING_INSPECTION_RUNTIME_ERROR"
    print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state["result"] == "PASS_READ_ONLY_INSPECTION" else 1

if __name__ == "__main__":
    raise SystemExit(main())
'''


def require_shape(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise Error("MONITORING_RESULT_SCHEMA_INVALID")


def validate_result(raw):
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise Error("MONITORING_RESULT_JSON_INVALID") from None
    require_shape(value, "schema result error listeners processes configs config_scope mutations")
    if type(value["schema"]) is not int or value["schema"] != 1 or value["mutations"] is not False or value["result"] not in {"PASS_READ_ONLY_INSPECTION", "FAIL"} or value["config_scope"] != "DEFAULT_ZABBIX_AGENT_PATHS_NOT_COMMAND_LINE_VERIFIED":
        raise Error("MONITORING_RESULT_SCHEMA_INVALID")
    if value["error"] is not None and (not isinstance(value["error"], str) or not re.fullmatch(r"[A-Z_]{1,64}", value["error"])):
        raise Error("MONITORING_RESULT_SCHEMA_INVALID")
    if value["result"] == "PASS_READ_ONLY_INSPECTION" and value["error"] is not None:
        raise Error("MONITORING_RESULT_SCHEMA_INVALID")
    for name, limit in (("listeners", 16), ("processes", 32), ("configs", 32)):
        if not isinstance(value[name], list) or len(value[name]) > limit:
            raise Error("MONITORING_RESULT_SCHEMA_INVALID")
    socket_pids = set()
    for listener in value["listeners"]:
        require_shape(listener, "address port pids")
        address = listener["address"]
        try:
            if not isinstance(address, str) or (address != "*" and (str(ipaddress.ip_address(address)) != address or "%" in address)):
                raise ValueError()
        except ValueError:
            raise Error("MONITORING_LISTENER_INVALID") from None
        if type(listener["port"]) is not int or listener["port"] != 10050 or not isinstance(listener["pids"], list) or not 1 <= len(listener["pids"]) <= 32 or any(type(pid) is not int or not 1 <= pid <= 999999999 for pid in listener["pids"]):
            raise Error("MONITORING_LISTENER_INVALID")
        socket_pids.update(listener["pids"])
    process_pids = set()
    for process in value["processes"]:
        require_shape(process, "pid name executable package service service_state status")
        pid = process["pid"]
        if type(pid) is not int or pid not in socket_pids or pid in process_pids or process["status"] not in {"IDENTIFIED", "UNCONFIRMED"}:
            raise Error("MONITORING_PROCESS_INVALID")
        process_pids.add(pid)
        for key, pattern in (
            ("name", r"[A-Za-z0-9_.-]{1,64}"),
            ("executable", r"/(?:usr/)?(?:s?bin|lib|libexec)/[A-Za-z0-9_./+-]{1,220}"),
            ("package", r"[a-z0-9][a-z0-9+.-]{0,79}(?::[a-z0-9]+)?"),
            ("service", r"[A-Za-z0-9_.@-]{1,120}\.service"),
        ):
            item = process[key]
            if item is not None and (not isinstance(item, str) or not re.fullmatch(pattern, item) or (key == "executable" and ".." in item)):
                raise Error("MONITORING_PROCESS_INVALID")
        if process["status"] == "IDENTIFIED" and (process["name"] is None or process["executable"] is None):
            raise Error("MONITORING_PROCESS_INVALID")
        service = process["service_state"]
        if service is not None:
            require_shape(service, "Id LoadState ActiveState SubState")
            if service["Id"] != process["service"] or any(not isinstance(service[key], str) or not re.fullmatch(r"[a-z-]{1,32}", service[key]) for key in ("LoadState", "ActiveState", "SubState")):
                raise Error("MONITORING_SERVICE_INVALID")
    if process_pids != socket_pids:
        raise Error("MONITORING_PROCESS_EVIDENCE_INCOMPLETE")
    for config in value["configs"]:
        require_shape(config, "path status values includes issues")
        if not _parsers["approved_config_path"](config["path"]) or config["status"] not in {
            "READ_APPROVED_KEYS_ONLY", "OUTSIDE_APPROVED_CONFIG_PATHS", "NOT_PRESENT", "SYMLINK_OR_NON_DIRECTORY_REFUSED", "UNSAFE_CONFIG_FILE", "UNSAFE_CONFIG_PATH", "UNREADABLE_CONFIG_FILE", "CONFIG_TOO_LARGE",
        } or not isinstance(config["values"], dict) or not set(config["values"]) <= {"Server", "ServerActive", "ListenIP", "ListenPort"}:
            raise Error("MONITORING_CONFIG_INVALID")
        if not isinstance(config["includes"], list) or len(config["includes"]) > 32 or any(not _parsers["approved_config_path"](path, pattern=True) for path in config["includes"]):
            raise Error("MONITORING_INCLUDE_INVALID")
        if not isinstance(config["issues"], list) or len(config["issues"]) > 8 or any(issue not in {
            "INCLUDE_OUTSIDE_APPROVED_CONFIG_PATHS", "INCLUDE_DIRECTORY_SYMLINK_REFUSED", "DUPLICATE_APPROVED_KEY", "INVALID_APPROVED_KEY_VALUE",
        } for issue in config["issues"]):
            raise Error("MONITORING_CONFIG_INVALID")
        try:
            for key, item in config["values"].items():
                if key == "ListenPort":
                    if type(item) is not int or not 1 <= item <= 65535:
                        raise ValueError()
                elif key in {"Server", "ListenIP"}:
                    if not isinstance(item, list) or len(item) > 32:
                        raise ValueError()
                    for entry in item:
                        canonical = _parsers["host"](entry, networks=True) if key == "Server" else str(ipaddress.ip_address(entry))
                        if canonical != entry or "%" in entry:
                            raise ValueError()
                else:
                    if not isinstance(item, list) or len(item) > 32:
                        raise ValueError()
                    for cluster in item:
                        if not isinstance(cluster, list) or not 1 <= len(cluster) <= 16:
                            raise ValueError()
                        for endpoint in cluster:
                            require_shape(endpoint, "host port")
                            if _parsers["host"](endpoint["host"]) != endpoint["host"]:
                                raise ValueError()
                            if endpoint["port"] is not None and (type(endpoint["port"]) is not int or not 1 <= endpoint["port"] <= 65535):
                                raise ValueError()
        except (ValueError, TypeError):
            raise Error("MONITORING_CONFIG_VALUE_INVALID") from None
    return value


def emit(state):
    print("TIMEWEB_HOST_MONITORING_INSPECTION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "server_status": "UNKNOWN", "host_key_fingerprint": None, "ssh_key_id": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "inspection": None, "error": None}
    api, folder = None, None
    try:
        if argv != ["--inspect-existing-host-monitoring"]:
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
        folder = Path(tempfile.mkdtemp(prefix="kinetra-monitoring-inspect-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        if fingerprint != PINNED_FINGERPRINT:
            raise Error("PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-monitoring-inspect-" + run_id
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
            raise Error("MONITORING_READ_ONLY_INSPECTION_FAILED")
        state["result"] = "PASS_READ_ONLY_HOST_MONITORING_INSPECTION"
    except Error as error:
        state["result"], state["error"] = "FAIL", str(error)
    except BaseException:
        state["result"], state["error"] = "FAIL", "MONITORING_INSPECTION_UNEXPECTED_ERROR"
    finally:
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup")):
            state["result"] = "FAIL"
            state["error"] = state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_READ_ONLY_HOST_MONITORING_INSPECTION" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
