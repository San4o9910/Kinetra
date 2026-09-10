#!/usr/bin/env python3
"""Offline wrapper/launcher tests. No Timeweb, SSH, Docker or provider calls."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("prepare_api", Path(__file__).with_name("prepare-api-host.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
inspection = prepare.inspection
COMMIT, NONCE = "a" * 40, "b" * 32
IMAGES = {
    "NODE_IMAGE": "node@sha256:" + "1" * 64,
    "NGINX_IMAGE": "nginxinc/nginx-unprivileged@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64,
    "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64,
}
# Offline fixtures only; never sent to a provider or server.
PROVIDERS = {"YUKASSA_SHOP_ID": "123456", "YUKASSA_SECRET_KEY": "offline-provider-key-" + "d" * 32,
    "AUTH_TOKEN_DELIVERY_WEBHOOK_URL": "https://delivery.kinetra.ru/token",
    "AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET": "offline-delivery-key-" + "e" * 32}
TIMEWEB_TOKEN = "offline-timeweb-token-do-not-print"
REGISTRY_TOKEN = "offline-registry-token-do-not-forward"
SOURCE = {name: {"sha256": "6" * 64, "base64": "c291cmNlCg=="} for name in prepare.stage.SOURCE_PATHS}
MIGRATIONS = {name: "7" * 64 for name in prepare.initialization.MIGRATIONS}


def approved():
    return {"schema": 1, "server_id": 9069403, "public_ipv4": "80.68.156.131", "commit": COMMIT,
        "images": dict(IMAGES), "source_hashes": {name: item["sha256"] for name, item in SOURCE.items()},
        "migration_hashes": dict(MIGRATIONS), "providers": dict(PROVIDERS)}


def successful_preparation():
    return {"result": "API_ENVIRONMENT_PREPARED_ONLY", "phase": "API_ENVIRONMENT_PREPARATION_COMPLETE", "error": None,
        "api_environment_installed": True, "application_started": False, "caddy_started": False,
        "provider_requests": 0, "candidate_directory": "api-preparation-" + "c" * 32}


def successful_remote():
    values = approved()
    return {"schema": 1, "result": "API_ENVIRONMENT_PREPARED_ONLY", "error": None,
        **{key: values[key] for key in ("commit", "images", "source_hashes", "migration_hashes")},
        "preparation": successful_preparation(), "guest_temp_cleanup": "REMOVED",
        "remote_directory": "/run/kinetra-api-preparation-" + NONCE}


def inspected_guest():
    return {"schema": 1, "cloud_init": "PASS", "bootstrap_marker": True, "password_auth_disabled": True,
        "keyboard_interactive_disabled": True, "root_login_key_only": True, "os_id": "ubuntu", "os_version": "24.04",
        "cpu_count": 2, "ram_bytes": 4 * 1024**3, "root_total_bytes": 50 * 1024**3,
        "root_free_bytes": 40 * 1024**3, "docker_available": True, "selected_listener_ports": [22], "listeners_verified": True}


class FakeApi:
    instances = []
    wrong_server = False
    wrong_key = False
    fail_delete = False

    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id, self.key_post_attempted, self.server_verified = None, False, False
        self.calls = []
        self.__class__.instances.append(self)

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET":
            return {"server": {"id": 9069404 if self.wrong_server else 9069403, "name": inspection.SERVER_NAME,
                "status": "on", "networks": [{"type": "public", "ips": [{"type": "ipv4", "is_main": True, "ip": "80.68.156.131"}]}]}}
        if method == "POST" and path == "/ssh-keys":
            self.key_post_attempted = True
            return {"ssh_key": {"id": 800004, **body, **({"name": "unrelated-existing-key"} if self.wrong_key else {})}}
        if method == "DELETE" and self.fail_delete:
            raise prepare.Error("API_CONNECTION_FAILED")
        return {}


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        FakeApi.instances = []
        FakeApi.wrong_server = FakeApi.wrong_key = FakeApi.fail_delete = False
        self.environ = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000009", "RUNNER_TEMP": str(self.root),
            "TIMEWEB_CLOUD_TOKEN": TIMEWEB_TOKEN, "GITHUB_TOKEN": REGISTRY_TOKEN, "GH_TOKEN": REGISTRY_TOKEN,
            "APPROVED_APP_COMMIT": COMMIT, "APP_CHECKOUT": str(self.root / "approved-checkout"), **IMAGES, **PROVIDERS}

    def run_wrapper(self, *, argv=None, remote=None, fingerprint=None, source_error=None, transport_error=None):
        output = io.StringIO()
        remote = (0, json.dumps(successful_remote()).encode(), b"") if remote is None else remote
        with patch.object(prepare.stage, "source_bundle", return_value=copy.deepcopy(SOURCE), side_effect=source_error) as source, \
             patch.object(prepare.initialization, "migration_hashes", return_value=dict(MIGRATIONS)) as migrations, \
             patch.object(inspection, "pin_host_key", return_value=(self.root / "known_hosts", fingerprint or prepare.stage.PINNED_FINGERPRINT)) as pin, \
             patch.object(inspection, "prepare_key", return_value=(self.root / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key"), \
             patch.object(inspection, "run_bounded", return_value=(0, json.dumps(inspected_guest()).encode(), b"")) as inspect, \
             patch.object(prepare.stage, "run_with_input", return_value=remote, side_effect=transport_error) as ssh, \
             patch.object(prepare.secrets, "token_hex", return_value=NONCE) as nonce, \
             patch.object(prepare.resource, "setrlimit"), contextlib.redirect_stdout(output):
            code = prepare.main(argv or ["--prepare-api-environment", "--provider-env"], self.environ, FakeApi)
        text = output.getvalue()
        for secret in (TIMEWEB_TOKEN, REGISTRY_TOKEN, *PROVIDERS.values()):
            self.assertNotIn(secret, text)
        states = [json.loads(line.split("=", 1)[1]) for line in text.splitlines()]
        return code, states[-1], SimpleNamespace(source=source, migrations=migrations, pin=pin, key=key, inspect=inspect, ssh=ssh, nonce=nonce)

    def test_missing_each_provider_makes_zero_api_calls_and_generates_nothing(self):
        for key in prepare.activation.PROVIDERS:
            with self.subTest(key=key):
                self.setUp()
                del self.environ[key]
                code, state, calls = self.run_wrapper()
                self.assertEqual((code, state["error"]), (1, "REQUIRED_PROVIDER_INPUTS_MISSING"))
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(any(call.called for call in (calls.pin, calls.key, calls.inspect, calls.ssh, calls.nonce)))
                self.assertEqual(list(self.root.iterdir()), [])

    def test_invalid_provider_and_wrong_target_fail_before_timeweb(self):
        for change in ({"AUTH_TOKEN_DELIVERY_WEBHOOK_URL": "https://delivery.kinetra.ru:bad/token"},
            {"ROOT_SUPPLIED_SERVER_ID": "9069404"}, {"ROOT_SUPPLIED_SERVER_IP": "80.68.156.132"},
            {"BACKEND_IMAGE": "ghcr.io/other/app@sha256:" + "3" * 64},
            {"POSTGRES_IMAGE": "postgres@sha256:" + "5" * 64}):
            with self.subTest(change=change):
                self.setUp()
                self.environ.update(change)
                code, _, calls = self.run_wrapper()
                self.assertEqual(code, 1)
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(calls.key.called or calls.ssh.called)

    def test_exact_checkout_failure_and_helper_pin_failure_prevent_api(self):
        code, state, calls = self.run_wrapper(source_error=prepare.Error("APP_CHECKOUT_COMMIT_MISMATCH"))
        self.assertEqual((code, state["error"]), (1, "APP_CHECKOUT_COMMIT_MISMATCH"))
        self.assertEqual(FakeApi.instances, [])
        calls.source.assert_called_once_with(str(self.root / "approved-checkout"), COMMIT)
        self.environ.update(TIMEWEB_CLOUD_TOKEN=TIMEWEB_TOKEN, **PROVIDERS)
        with patch.object(prepare, "public_helpers", side_effect=RuntimeError("changed public helper")):
            code, _, calls = self.run_wrapper()
        self.assertEqual(code, 1)
        self.assertEqual(FakeApi.instances, [])
        self.assertFalse(calls.nonce.called)

    def test_success_binds_sources_and_sends_secrets_only_on_stdin(self):
        code, state, calls = self.run_wrapper()
        self.assertEqual((code, state["result"]), (0, "API_ENVIRONMENT_PREPARED_ONLY"))
        self.assertFalse(state["application_started"] or state["caddy_started"])
        self.assertEqual(state["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        args, wire, timeout = calls.ssh.call_args.args
        payload = json.loads(wire)
        self.assertEqual(payload["approved"], approved())
        self.assertEqual(payload["nonce"], NONCE)
        self.assertEqual(set(payload["helpers"]), set(prepare.PINS))
        for name, body in payload["helpers"].items():
            self.assertEqual(hashlib.sha256(base64.b64decode(body)).hexdigest(), prepare.PINS[name])
        self.assertIn("root@80.68.156.131", args)
        self.assertIn("StrictHostKeyChecking=yes", args)
        for secret in (TIMEWEB_TOKEN, REGISTRY_TOKEN, *PROVIDERS.values()):
            self.assertNotIn(secret, " ".join(args))
        self.assertNotIn(TIMEWEB_TOKEN.encode(), wire)
        self.assertNotIn(REGISTRY_TOKEN.encode(), wire)
        for key in (*prepare.activation.PROVIDERS, "TIMEWEB_CLOUD_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
            self.assertNotIn(key, self.environ)
        calls.source.assert_called_once_with(str(self.root / "approved-checkout"), COMMIT)
        calls.migrations.assert_called_once_with(str(self.root / "approved-checkout"), COMMIT)
        api = FakeApi.instances[0]
        self.assertEqual(api.token, "")
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"], [
            ("DELETE", "/servers/9069403/ssh-keys/800004"), ("DELETE", "/ssh-keys/800004")])

    def test_private_provider_file_is_preserved_and_mode_or_ambiguity_refused(self):
        private = self.root / "providers.json"
        private.write_text(json.dumps(PROVIDERS))
        private.chmod(0o600)
        for key in PROVIDERS: self.environ.pop(key)
        code, _, _ = self.run_wrapper(argv=["--prepare-api-environment", "--provider-input", str(private)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(private.read_text()), PROVIDERS)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
        private.chmod(0o644)
        with self.assertRaisesRegex(prepare.Error, "PRIVATE_PROVIDER_FILE_INVALID"):
            prepare.provider_input(["--prepare-api-environment", "--provider-input", str(private)], {})
        private.chmod(0o600)
        with self.assertRaisesRegex(prepare.Error, "PROVIDER_SOURCE_AMBIGUOUS"):
            prepare.provider_input(["--prepare-api-environment", "--provider-input", str(private)], PROVIDERS)

    def test_server_response_or_ssh_pin_mismatch_cannot_create_keys(self):
        FakeApi.wrong_server = True
        code, state, calls = self.run_wrapper()
        self.assertEqual((code, state["error"]), (1, "SERVER_IDENTITY_MISMATCH"))
        self.assertFalse(calls.key.called or calls.ssh.called)
        self.setUp()
        code, state, calls = self.run_wrapper(fingerprint="SHA256:wrong")
        self.assertEqual((code, state["error"]), (1, "PINNED_HOST_KEY_MISMATCH"))
        self.assertFalse(calls.key.called or calls.ssh.called)

    def test_unverified_key_is_not_deleted_and_cleanup_failure_never_green(self):
        FakeApi.wrong_key = True
        code, state, calls = self.run_wrapper()
        self.assertEqual(code, 1)
        self.assertEqual(state["account_key_cleanup"], "UNVERIFIED_KEY_RECONCILE")
        self.assertFalse(calls.ssh.called)
        self.assertFalse(any(method == "DELETE" for method, _, _ in FakeApi.instances[0].calls))
        self.setUp()
        FakeApi.fail_delete = True
        code, state, _ = self.run_wrapper()
        self.assertEqual((code, state["error"]), (1, "CLEANUP_REQUIRES_RECONCILIATION"))
        self.assertEqual(state["preparation"]["result"], "API_ENVIRONMENT_PREPARED_ONLY")

    def test_remote_failure_keeps_actual_installed_state_and_lost_response_is_unknown(self):
        remote = successful_remote()
        remote.update(result="FAIL", error="API_PREPARATION_FAILED_PRIVATE_STATE_PRESERVED")
        remote["preparation"].update(result="FAIL", phase="VERIFY_INSTALLED_ENVIRONMENT", error="COMPILED_API_ENV_REJECTED")
        code, state, _ = self.run_wrapper(remote=(1, json.dumps(remote).encode(), b""))
        self.assertEqual(code, 1)
        self.assertTrue(state["preparation"]["preparation"]["api_environment_installed"])
        self.assertEqual(state["guest_temp_cleanup"], "REMOVED")
        self.setUp()
        code, state, _ = self.run_wrapper(transport_error=prepare.Error("REMOTE_STAGE_DEADLINE_EXCEEDED"))
        self.assertEqual(code, 1)
        self.assertIsNone(state["preparation"])
        self.assertEqual(state["guest_temp_cleanup"], "UNKNOWN_RECONCILE")
        self.assertEqual(state["remote_directory"], "/run/kinetra-api-preparation-" + NONCE)
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_remote_source_image_hashes_scope_and_sanitizer_are_not_optional(self):
        for mutate in (
            lambda d: d.update(commit="f" * 40),
            lambda d: d["images"].update(BACKEND_IMAGE="ghcr.io/other/app@sha256:" + "3" * 64),
            lambda d: d["source_hashes"].update({prepare.stage.SOURCE_PATHS[0]: "f" * 64}),
            lambda d: d["migration_hashes"].pop(prepare.initialization.MIGRATIONS[0]),
            lambda d: d.update(remote_directory="/srv/kinetra-stage"),
            lambda d: d.update(guest_temp_cleanup="NOT_NEEDED"),
            lambda d: d["preparation"].update(application_started=True),
            lambda d: d["preparation"].update(provider_requests=1),
            lambda d: d["preparation"].update(error=PROVIDERS["YUKASSA_SECRET_KEY"]),
            lambda d: d["preparation"].update(candidate_directory="../env/api.env"),
            lambda d: d["preparation"].update(api_environment_installed=False),
        ):
            value = successful_remote()
            mutate(value)
            with self.assertRaises(prepare.Error):
                prepare.validate_remote(json.dumps(value), approved(), NONCE)


class GuestLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.namespace = {"__name__": "offline_api_launcher"}
        exec(compile(prepare.GUEST_LAUNCHER, "<guest-launcher>", "exec"), self.namespace)
        self.body = b"# pinned offline helper fixture\n"
        self.pins = {"activate-application-host.py": hashlib.sha256(self.body).hexdigest()}

    def run_guest(self, *, mutate=None, helper=None, cleanup_failure=False):
        data = {"schema": 1, "nonce": NONCE, "approved": approved(),
            "helpers": {"activate-application-host.py": base64.b64encode(self.body).decode()}}
        if mutate: mutate(data)
        captured = []
        def popen(args, **kwargs):
            private = Path(args[-1])
            captured.append((args, kwargs, json.loads(private.read_bytes()), stat.S_IMODE(private.stat().st_mode)))
            self.assertEqual(stat.S_IMODE(private.parent.stat().st_mode), 0o700)
            return SimpleNamespace(returncode=0, pid=990001, stdout=io.BytesIO(), poll=lambda: 0,
                communicate=lambda **kw: (json.dumps(helper or successful_preparation()).encode(), None))
        run_path = SimpleNamespace(Path=lambda value: self.root if value == "/run" else Path(value))
        output = io.StringIO()
        changes = {"PINS": self.pins, "pathlib": run_path,
            "sys": SimpleNamespace(stdin=SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode())))}
        if cleanup_failure: changes["cleanup_owned"] = Mock(side_effect=OSError("retained fixture"))
        with patch.dict(self.namespace, changes), patch.object(self.namespace["subprocess"], "Popen", side_effect=popen) as call, \
             patch.object(self.namespace["resource"], "setrlimit"), patch.object(self.namespace["os"], "umask"), contextlib.redirect_stdout(output):
            code = self.namespace["main"]()
        for secret in PROVIDERS.values(): self.assertNotIn(secret, output.getvalue())
        return code, json.loads(output.getvalue()), captured, call

    def test_owned_guest_input_is_private_and_child_environment_is_secret_free(self):
        code, state, captured, _ = self.run_guest()
        self.assertEqual((code, state["result"], state["guest_temp_cleanup"]), (0, "API_ENVIRONMENT_PREPARED_ONLY", "REMOVED"))
        args, kwargs, data, mode = captured[0]
        self.assertEqual(data, approved())
        self.assertEqual(mode, 0o600)
        self.assertEqual(kwargs["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        self.assertIn("-B", args)
        for secret in PROVIDERS.values(): self.assertNotIn(secret, " ".join(args))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_public_helper_hash_failure_prevents_temp_files_and_child(self):
        code, state, _, call = self.run_guest(mutate=lambda d: d["helpers"].update({"activate-application-host.py": base64.b64encode(b"tampered").decode()}))
        self.assertEqual((code, state["error"]), (1, "PUBLIC_HELPER_HASH_MISMATCH"))
        self.assertFalse(call.called)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_failed_guest_temp_cleanup_does_not_claim_overall_success(self):
        code, state, _, _ = self.run_guest(cleanup_failure=True)
        self.assertEqual((code, state["result"], state["guest_temp_cleanup"]), (1, "FAIL", "FAILED_RECONCILE"))
        self.assertEqual(state["preparation"]["result"], "API_ENVIRONMENT_PREPARED_ONLY")
        self.assertTrue((self.root / ("kinetra-api-preparation-" + NONCE) / "private-input.json").is_file())

    def test_cleanup_refuses_unexpected_contents_before_deleting_anything(self):
        folder = self.root / "owned"
        folder.mkdir(mode=0o700)
        (folder / "private-input.json").write_bytes(b"retained private fixture")
        (folder / "unexpected-owner-file").write_bytes(b"preserve")
        info = folder.stat()
        with self.assertRaises(self.namespace["Error"]):
            self.namespace["cleanup_owned"](folder, (info.st_dev, info.st_ino))
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["private-input.json", "unexpected-owner-file"])


if __name__ == "__main__":
    unittest.main()
