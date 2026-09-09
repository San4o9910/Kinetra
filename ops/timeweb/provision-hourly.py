#!/usr/bin/env python3
"""Create one approved empty hourly Timeweb server from a guarded Actions run.

No payment, top-up, subscription, automatic payment, backup, application or
storage mutation is implemented here. A POST is never retried. An ambiguous
creation result requires read-only reconciliation before any further run.
Only explicitly selected, validated fields reach stdout.
The caller must serialize this script using a fixed Actions concurrency group.
"""

from __future__ import annotations

import base64
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import hashlib
import ipaddress
import json
import os
import re
import resource
import signal
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request


BASE = "https://api.timeweb.cloud/api/v1"
REPOSITORY = "San4o9910/Kinetra"
SERVER_NAME = "kinetra-app-hourly-20260909"
PRESET_ID = 2453
OS_ID = 99
# Read-only reconciliation of failed run 34397615093 identified this one
# orphan. Its POST /servers was never attempted. No other old key is eligible.
ORPHAN_KEY_ID = 768633
ORPHAN_KEY_NAME = "kinetra-ephemeral-34397615093"
ORPHAN_KEY_BODY_SHA256 = "c74814cb35e0d500da8553164d8c329ddd9bd2fb3f12e1f5eb1e266a900dbf22"
MAX_BODY = 4_194_304
MAX_PAGES = 100
PAGE_SIZE = 100
MAX_POLL_SECONDS = 300
MAX_PREFLIGHT_SECONDS = 240
READ_PATHS = frozenset({
    "/account/status", "/account/finances", "/presets/servers",
    "/os/servers", "/projects",
})
PUBLIC_STATUSES = frozenset({
    "on", "off", "installing", "creating", "starting", "stopping",
    "stopped", "rebooting", "updating", "cloning", "recovering",
    "not_paid", "no_paid", "blocked", "permanent_blocked", "removed",
    "error", "failed", "deleted", "removing",
})
CLOUD_INIT = """#cloud-config
ssh_pwauth: false
disable_root: false
write_files:
  - path: /etc/ssh/sshd_config.d/00-kinetra-auth.conf
    owner: root:root
    permissions: '0644'
    content: |
      PermitRootLogin prohibit-password
      PasswordAuthentication no
      KbdInteractiveAuthentication no
runcmd:
  - [sh, -c, '/usr/sbin/sshd -t && systemctl reload ssh && install -d -m 0755 /var/lib/kinetra && printf "empty-server-bootstrap-v1\\n" > /var/lib/kinetra/bootstrap']
"""


class ProvisionError(Exception):
    """Only locally constructed constant error codes belong in this exception."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ProvisionError("API_REDIRECT_REFUSED")


def request_deadline(_signum, _frame):
    raise ProvisionError("API_REQUEST_DEADLINE_EXCEEDED")


def positive_id(value):
    if type(value) is not int or not 0 < value < 2**63:
        raise ProvisionError("API_RESOURCE_ID_INVALID")
    return value


def rows(document, key):
    value = document.get(key)
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ProvisionError("API_COLLECTION_SHAPE_INVALID")
    return value


def ssh_key_object(document):
    """CLI uses underscores; the generated SDK documents hyphen aliases.

    Accept exactly one documented wrapper and never search arbitrary fields.
    """
    if not isinstance(document, dict):
        raise ProvisionError("SSH_KEY_RESPONSE_SHAPE_INVALID")
    wrappers = [name for name in ("ssh_key", "ssh-key") if name in document]
    if len(wrappers) != 1 or not isinstance(document[wrappers[0]], dict):
        raise ProvisionError("SSH_KEY_RESPONSE_WRAPPER_INVALID")
    return document[wrappers[0]]


def money(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ProvisionError("MONEY_VALUE_INVALID")
    if len(str(value)) > 40:
        raise ProvisionError("MONEY_VALUE_INVALID")
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ProvisionError("MONEY_VALUE_INVALID") from None
    if not result.is_finite() or abs(result) > Decimal("1000000000"):
        raise ProvisionError("MONEY_VALUE_INVALID")
    return result


def reject_json_constant(_value):
    raise ProvisionError("API_JSON_NONFINITE_NUMBER")


class Api:
    """Fixed reads, single creates, verified new IDs and one verified orphan."""

    def __init__(self, token):
        self.token = token
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )
        self.key_id = None
        self.server_id = None
        self.key_post_attempted = False
        self.server_post_attempted = False
        self.preflight_passed = False
        self.key_identity_verified = False
        self.orphan_read_attempted = False
        self.orphan_identity_verified = False
        self.orphan_delete_attempted = False
        self.orphan_cleanup_complete = False

    def _authorize(self, method, path):
        if method == "GET" and path in READ_PATHS:
            return
        if method == "GET" and re.fullmatch(r"/servers\?limit=100&offset=[0-9]{1,5}", path):
            offset = int(path.rsplit("=", 1)[1])
            if offset < MAX_PAGES * PAGE_SIZE:
                return
        if path == f"/ssh-keys/{ORPHAN_KEY_ID}" and self.preflight_passed and not self.key_post_attempted:
            if method == "GET" and not self.orphan_read_attempted:
                self.orphan_read_attempted = True
                return
            if method == "DELETE" and self.orphan_identity_verified and not self.orphan_delete_attempted:
                self.orphan_delete_attempted = True
                return
        if method == "POST" and path == "/ssh-keys" and not self.key_post_attempted:
            if not self.preflight_passed or not self.orphan_cleanup_complete:
                raise ProvisionError("PREFLIGHT_AND_ORPHAN_CLEANUP_REQUIRED")
            self.key_post_attempted = True
            return
        if method == "POST" and path == "/servers" and not self.server_post_attempted:
            if self.key_id is None or not self.key_identity_verified:
                raise ProvisionError("SERVER_CREATE_WITHOUT_TRACKED_KEY_REFUSED")
            self.server_post_attempted = True
            return
        if self.server_id is not None and method == "GET" and path == f"/servers/{self.server_id}":
            return
        if self.key_id is not None and self.key_identity_verified and method == "DELETE":
            if path == f"/ssh-keys/{self.key_id}":
                return
            if self.server_id is not None and path == f"/servers/{self.server_id}/ssh-keys/{self.key_id}":
                return
        raise ProvisionError("API_OPERATION_REFUSED")

    def request(self, method, path, payload=None, timeout=20):
        self._authorize(method, path)
        if method == "POST":
            if not isinstance(payload, dict):
                raise ProvisionError("API_REQUEST_BODY_INVALID")
            data = json.dumps(payload, ensure_ascii=True, allow_nan=False).encode("utf-8")
            if len(data) > 65_536:
                raise ProvisionError("API_REQUEST_TOO_LARGE")
        else:
            if payload is not None:
                raise ProvisionError("API_REQUEST_BODY_REFUSED")
            data = None
        request = urllib.request.Request(
            BASE + path, method=method, data=data,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/json", "Content-Type": "application/json",
                "User-Agent": "kinetra-hourly-provision/1",
            },
        )
        # Socket timeouts do not bound a response delivered very slowly. This
        # Linux runner uses a separate wall-clock timer for the complete call.
        previous_handler = signal.signal(signal.SIGALRM, request_deadline)
        signal.setitimer(signal.ITIMER_REAL, max(1, min(timeout, 20)))
        try:
            with self.opener.open(request, timeout=max(1, min(timeout, 20))) as response:
                expected = {200} if method == "GET" else ({200, 201, 202} if method == "POST" else {204})
                if response.status not in expected:
                    raise ProvisionError("API_UNEXPECTED_STATUS")
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise ProvisionError("API_RESPONSE_TOO_LARGE")
        except urllib.error.HTTPError as error:
            # Never read or log provider error bodies, reasons, headers or URLs.
            code = error.code
            error.close()
            if type(code) is not int or not 100 <= code <= 599:
                raise ProvisionError("API_HTTP_ERROR") from None
            raise ProvisionError("API_HTTP_" + str(code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProvisionError("API_CONNECTION_FAILED") from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
        if method == "DELETE":
            return {}
        try:
            document = json.loads(raw, parse_constant=reject_json_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise ProvisionError("API_JSON_INVALID") from None
        if not isinstance(document, dict):
            raise ProvisionError("API_RESPONSE_SHAPE_INVALID")
        return document


def budget():
    """Planning assumption: 28-day price basis and a 31-day/744-hour month.

    Exact provider hourly rounding is not exposed by the inspected catalog.
    Round each resource's assumed hourly cost up to a kopeck. Include two
    future 79-RUB buckets and 130 RUB for 100 GB egress without buying them.
    This is a conservative estimate, not an enforceable provider spending cap.
    """
    quoted = Decimal("1000") + Decimal("200") + 2 * Decimal("79") + Decimal("130")
    hourly = sum(
        (price / Decimal(672)).quantize(Decimal("0.01"), rounding=ROUND_CEILING)
        for price in (Decimal("1000"), Decimal("200"), Decimal("79"), Decimal("79"))
    )
    projected = hourly * 744 + Decimal("130")
    if projected > Decimal("2000"):
        raise ProvisionError("MONTHLY_BUDGET_EXCEEDED")
    return {
        "budget_rub_per_month": "2000.00",
        "quoted_total_with_future_reserves_rub": str(quoted.quantize(Decimal("0.01"))),
        "conservative_total_with_future_reserves_rub": str(projected.quantize(Decimal("0.01"))),
        "projection_basis": "672_HOUR_PRICE_BASIS_744_HOUR_MONTH_KOPECK_CEILING_ASSUMPTION",
    }


def find_existing_servers(api, deadline):
    seen = set()
    matches = []
    offset = 0
    expected_total = None
    for _page in range(MAX_PAGES):
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise ProvisionError("PREFLIGHT_DEADLINE_EXCEEDED")
        document = api.request("GET", f"/servers?limit={PAGE_SIZE}&offset={offset}", timeout=remaining)
        page = rows(document, "servers")
        if len(page) > PAGE_SIZE:
            raise ProvisionError("SERVER_PAGINATION_INVALID")
        for server in page:
            server_id = positive_id(server.get("id"))
            if server_id in seen:
                raise ProvisionError("SERVER_PAGINATION_REPEATED")
            seen.add(server_id)
            name = server.get("name")
            if not isinstance(name, str) or not 1 <= len(name) <= 255:
                raise ProvisionError("SERVER_NAME_SHAPE_INVALID")
            if name == SERVER_NAME:
                matches.append(server_id)
        offset += len(page)
        metadata = document.get("meta")
        if not isinstance(metadata, dict) or type(metadata.get("total")) is not int:
            raise ProvisionError("SERVER_PAGINATION_TOTAL_UNKNOWN")
        total = metadata["total"]
        if not 0 <= total < MAX_PAGES * PAGE_SIZE or total < offset:
            raise ProvisionError("SERVER_PAGINATION_TOTAL_INVALID")
        if expected_total is not None and total != expected_total:
            raise ProvisionError("SERVER_PAGINATION_CHANGED_DURING_PREFLIGHT")
        expected_total = total
        if offset == total:
            return matches
        if not page:
            raise ProvisionError("SERVER_PAGINATION_INCOMPLETE")
    raise ProvisionError("SERVER_PAGINATION_LIMIT_REACHED")


def preflight(api, state):
    deadline = time.monotonic() + MAX_PREFLIGHT_SECONDS
    status = api.request("GET", "/account/status").get("status")
    if not isinstance(status, dict):
        raise ProvisionError("ACCOUNT_STATUS_SHAPE_INVALID")
    if status.get("is_blocked") is not False or status.get("is_permanent_blocked") is not False:
        raise ProvisionError("ACCOUNT_BLOCKED_OR_STATUS_UNKNOWN")
    finances = api.request("GET", "/account/finances").get("finances")
    if not isinstance(finances, dict) or finances.get("currency") != "RUB":
        raise ProvisionError("RUBLE_BILLING_NOT_CONFIRMED")
    if money(finances.get("balance")) <= 0:
        raise ProvisionError("POSITIVE_BALANCE_REQUIRED_NO_FUNDING_ATTEMPTED")
    # A positive balance is sufficient for this local gate. The provider may
    # still reject creation for its required initial charge; never fund it here.
    presets = rows(api.request("GET", "/presets/servers"), "server_presets")
    matches = [item for item in presets if item.get("id") == PRESET_ID]
    if len(matches) != 1:
        raise ProvisionError("APPROVED_PRESET_NOT_UNIQUE")
    preset = matches[0]
    expected = {"id": PRESET_ID, "location": "ru-1", "cpu": 2, "ram": 4096,
                "disk": 51200, "disk_type": "nvme"}
    if any(type(preset.get(key)) is not type(value) or preset.get(key) != value for key, value in expected.items()):
        raise ProvisionError("APPROVED_PRESET_CHANGED")
    if money(preset.get("price")) != Decimal("1000"):
        raise ProvisionError("APPROVED_PRESET_PRICE_CHANGED")
    systems = rows(api.request("GET", "/os/servers"), "servers_os")
    matches = [item for item in systems if item.get("id") == OS_ID]
    if len(matches) != 1 or matches[0].get("name") != "ubuntu" or matches[0].get("version") != "24.04":
        raise ProvisionError("APPROVED_OS_CHANGED_OR_MISSING")
    positive_id(matches[0].get("id"))
    projects = rows(api.request("GET", "/projects"), "projects")
    defaults = [project for project in projects if project.get("is_default") is True]
    if len(defaults) != 1:
        raise ProvisionError("DEFAULT_PROJECT_NOT_UNIQUE")
    state["project_id"] = positive_id(defaults[0].get("id"))
    state.update(budget())
    existing = find_existing_servers(api, deadline)
    if existing:
        state["existing_server_ids"] = existing
        raise ProvisionError("EXISTING_NAMED_SERVER_REQUIRES_READ_ONLY_RECONCILIATION")
    state["preflight"] = "PASS"


def cleanup_reconciled_orphan(api, state):
    """One GET and at most one DELETE of the specifically reconciled orphan."""
    state["orphan_key_cleanup"] = "CHECK_PENDING"
    try:
        document = api.request("GET", f"/ssh-keys/{ORPHAN_KEY_ID}")
    except ProvisionError as error:
        if str(error) != "API_HTTP_404":
            raise
        state["orphan_key_cleanup"] = "ALREADY_ABSENT"
        api.orphan_cleanup_complete = True
        return
    key = ssh_key_object(document)
    body = key.get("body")
    if (
        positive_id(key.get("id")) != ORPHAN_KEY_ID
        or key.get("name") != ORPHAN_KEY_NAME
        or key.get("is_default") is not False
        or not isinstance(body, str)
        or not 1 <= len(body) <= 16_384
        or hashlib.sha256(body.encode("utf-8")).hexdigest() != ORPHAN_KEY_BODY_SHA256
    ):
        state["orphan_key_cleanup"] = "IDENTITY_MISMATCH_RECONCILE"
        raise ProvisionError("RECONCILED_ORPHAN_IDENTITY_MISMATCH")
    api.orphan_identity_verified = True
    state["orphan_key_cleanup"] = "DELETE_OUTCOME_UNKNOWN_RECONCILE"
    emit(state)
    try:
        api.request("DELETE", f"/ssh-keys/{ORPHAN_KEY_ID}")
    except ProvisionError as error:
        if str(error) != "API_HTTP_404":
            raise
        state["orphan_key_cleanup"] = "ALREADY_ABSENT"
    else:
        state["orphan_key_cleanup"] = "API_DELETE_CONFIRMED"
    api.orphan_cleanup_complete = True


def ephemeral_public_key():
    """Keep private material in pipes/memory only; no private key file exists."""
    # Prevent crash dumps from persisting token/key process memory.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    private = None
    try:
        generated = subprocess.run(
            ["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15, check=True,
        )
        private = bytearray(generated.stdout)
        del generated
        if not 1 <= len(private) <= 4096:
            raise ProvisionError("EPHEMERAL_KEY_GENERATION_FAILED")
        public = subprocess.run(
            ["/usr/bin/openssl", "pkey", "-pubout", "-outform", "DER"],
            input=private, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        raise ProvisionError("EPHEMERAL_KEY_GENERATION_FAILED") from None
    finally:
        if private is not None:
            private[:] = b"\x00" * len(private)
    prefix = bytes.fromhex("302a300506032b6570032100")
    if len(public) != len(prefix) + 32 or not public.startswith(prefix):
        raise ProvisionError("EPHEMERAL_PUBLIC_KEY_FORMAT_INVALID")
    # OpenSSH wire format: two length-prefixed strings, algorithm then raw key.
    algorithm = b"ssh-ed25519"
    wire = struct.pack(">I", len(algorithm)) + algorithm + struct.pack(">I", 32) + public[len(prefix):]
    return "ssh-ed25519 " + base64.b64encode(wire).decode("ascii") + " kinetra-ephemeral"


def update_server_state(server, state, expected_id):
    state["public_ipv4"] = None
    if not isinstance(server, dict) or positive_id(server.get("id")) != expected_id:
        raise ProvisionError("CREATED_SERVER_RESPONSE_MISMATCH")
    status = server.get("status")
    state["server_status"] = status if isinstance(status, str) and status in PUBLIC_STATUSES else "UNKNOWN"
    addresses = set()
    networks = server.get("networks", [])
    if not isinstance(networks, list):
        raise ProvisionError("SERVER_NETWORK_SHAPE_INVALID")
    for network in networks:
        if not isinstance(network, dict) or network.get("type") != "public":
            continue
        ips = network.get("ips", [])
        if not isinstance(ips, list):
            raise ProvisionError("SERVER_NETWORK_SHAPE_INVALID")
        for entry in ips:
            if not isinstance(entry, dict) or entry.get("type") != "ipv4":
                continue
            if entry.get("is_main") is not True:
                raise ProvisionError("PUBLIC_IPV4_MAIN_FLAG_NOT_CONFIRMED")
            try:
                address = ipaddress.IPv4Address(entry.get("ip"))
            except (ipaddress.AddressValueError, ValueError, TypeError):
                raise ProvisionError("PUBLIC_IPV4_INVALID") from None
            if not address.is_global:
                raise ProvisionError("PUBLIC_IPV4_NOT_GLOBAL")
            addresses.add(str(address))
    if len(addresses) > 1:
        raise ProvisionError("MULTIPLE_PUBLIC_IPV4_UNEXPECTED")
    if addresses:
        state["public_ipv4"] = next(iter(addresses))


def wait_until_on(api, state):
    deadline = time.monotonic() + MAX_POLL_SECONDS
    while True:
        if state["server_status"] in {
            "error", "failed", "deleted", "removing", "not_paid", "no_paid",
            "blocked", "permanent_blocked", "removed",
        }:
            raise ProvisionError("CREATED_SERVER_FAILURE_STATE")
        if state["server_status"] == "on" and state["public_ipv4"]:
            state["server_poll"] = "ON_WITH_PUBLIC_IPV4"
            return
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise ProvisionError("CREATED_SERVER_POLL_TIMEOUT")
        time.sleep(min(10, remaining))
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise ProvisionError("CREATED_SERVER_POLL_TIMEOUT")
        server = api.request("GET", f"/servers/{api.server_id}", timeout=remaining).get("server")
        update_server_state(server, state, api.server_id)


def cleanup_keys(api, state):
    if api.key_id is None:
        if state["ssh_key_id"] is not None:
            state["account_key_cleanup"] = "UNVERIFIED_KEY_ID_RECONCILE"
        else:
            state["account_key_cleanup"] = "UNKNOWN_ID_RECONCILE" if api.key_post_attempted else "NOT_NEEDED"
        return
    # Cleanup operations deliberately have independent exception boundaries.
    if api.server_id is not None:
        try:
            api.request("DELETE", f"/servers/{api.server_id}/ssh-keys/{api.key_id}")
            state["guest_key_cleanup"] = "API_DETACH_CONFIRMED_GUEST_NOT_INSPECTED"
        except BaseException:
            state["guest_key_cleanup"] = "FAILED_REQUIRES_RECONCILIATION"
    elif api.server_post_attempted:
        state["guest_key_cleanup"] = "UNKNOWN_SERVER_ID_RECONCILE"
    try:
        api.request("DELETE", f"/ssh-keys/{api.key_id}")
        state["account_key_cleanup"] = "API_DELETE_CONFIRMED"
    except BaseException:
        state["account_key_cleanup"] = "FAILED_REQUIRES_RECONCILIATION"


def emit(state):
    # State is assembled only from fixed constants, validated IDs, validated IPs,
    # selected status enum values and local calculations. Never copy an API dict.
    rendered = json.dumps(state, sort_keys=True, ensure_ascii=True, allow_nan=False)
    print("TIMEWEB_HOURLY_SERVER=" + rendered, flush=True)


def interrupted(_signum, _frame):
    raise ProvisionError("RUN_INTERRUPTED")


def main(argv=None, environ=None, api_factory=Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {
        "result": "IN_PROGRESS", "preflight": "NOT_COMPLETED", "server_creation": "NOT_ATTEMPTED",
        "server_id": None, "server_status": "UNKNOWN", "public_ipv4": None,
        "ssh_key_id": None,
        "orphan_ssh_key_id": ORPHAN_KEY_ID, "orphan_key_cleanup": "NOT_CHECKED",
        "preset_id": PRESET_ID, "project_id": None, "server_poll": "NOT_COMPLETED",
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED",
        "billing_mode": "ORDINARY_CPU_HOURLY_NO_FINANCE_WRITES",
        "application_readiness": "NOT_DEPLOYED_OR_VERIFIED", "cloud_init_readiness": "NOT_VERIFIED",
        "error": None,
    }
    api = None
    try:
        if argv != ["--execute-hourly-server"]:
            raise ProvisionError("EXPLICIT_HOURLY_EXECUTION_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != REPOSITORY:
            raise ProvisionError("AUTHORIZED_GITHUB_RUN_REQUIRED")
        if environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise ProvisionError("REPEATED_RUN_REFUSED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id):
            raise ProvisionError("GITHUB_RUN_ID_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        if not token or len(token) > 16384 or any(character.isspace() for character in token):
            raise ProvisionError("TIMEWEB_SECRET_MISSING_OR_INVALID")
        # Remove the credential from inherited subprocess environments before
        # key generation. Do not print it or expose a token-valued CLI argument.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        api = api_factory(token)
        del token
        preflight(api, state)
        api.preflight_passed = True
        cleanup_reconciled_orphan(api, state)
        public_key = ephemeral_public_key()
        key_name = "kinetra-ephemeral-" + run_id
        key = ssh_key_object(api.request("POST", "/ssh-keys", {
            "name": key_name,
            "body": public_key, "is_default": False,
        }))
        # An ID alone does not authorize deletion: a malformed response could
        # identify an unrelated key. Record its safe ID but grant capabilities
        # only when it matches the new key's exact submitted identity.
        key_id = positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if (
            key_id == ORPHAN_KEY_ID
            or key.get("name") != key_name
            or key.get("body") != public_key
            or key.get("is_default") is not False
        ):
            raise ProvisionError("CREATED_SSH_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        api.key_identity_verified = True
        state["account_key_cleanup"] = "PENDING"
        emit(state)
        state["server_creation"] = "OUTCOME_UNKNOWN_RECONCILE_BEFORE_RETRY"
        emit(state)
        server = api.request("POST", "/servers", {
            "name": SERVER_NAME, "preset_id": PRESET_ID, "os_id": OS_ID,
            "project_id": state["project_id"], "ssh_keys_ids": [api.key_id],
            "is_ddos_guard": False, "network": {"floating_ip": "create_ip"},
            "cloud_init": CLOUD_INIT,
        }).get("server")
        if not isinstance(server, dict):
            raise ProvisionError("CREATED_SERVER_RESPONSE_INVALID")
        api.server_id = positive_id(server.get("id"))
        state["server_id"] = api.server_id
        state["server_creation"] = "CONFIRMED"
        state["guest_key_cleanup"] = "PENDING"
        # Commit the safe resource ID to the log before further validation/poll.
        emit(state)
        update_server_state(server, state, api.server_id)
        wait_until_on(api, state)
        state["result"] = "PASS_EMPTY_SERVER_ONLY"
    except ProvisionError as error:
        state["result"] = "FAIL"
        state["error"] = str(error)
    except BaseException:
        state["result"] = "FAIL"
        state["error"] = "UNEXPECTED_RESPONSE_OR_RUNTIME_ERROR"
    finally:
        if api is not None:
            cleanup_keys(api, state)
            api.token = ""
        cleanup_ok = state["account_key_cleanup"] in {"NOT_NEEDED", "API_DELETE_CONFIRMED"}
        cleanup_ok = cleanup_ok and state["guest_key_cleanup"] in {
            "NOT_NEEDED", "API_DETACH_CONFIRMED_GUEST_NOT_INSPECTED",
        }
        if not cleanup_ok:
            state["result"] = "FAIL"
            if state["error"] is None:
                state["error"] = "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_EMPTY_SERVER_ONLY" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
