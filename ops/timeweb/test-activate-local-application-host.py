#!/usr/bin/env python3
"""Offline boundary tests: no Timeweb/SSH/Docker/provider calls or host changes."""
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
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("local_activation", Path(__file__).with_name("activate-local-application-host.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
inspection = module.inspection
COMMIT, NONCE = "a" * 40, "b" * 32
TOKEN, REGISTRY_TOKEN = "offline-timeweb-secret", "offline-registry-secret"
IMAGES = {"NODE_IMAGE": "node@sha256:" + "1" * 64, "NGINX_IMAGE": "nginxinc/nginx-unprivileged@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64, "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64}
SOURCES = {name: {"sha256": "6" * 64, "base64": "c291cmNlCg=="} for name in module.stage.SOURCE_PATHS}
MIGRATIONS = {name: "7" * 64 for name in module.initialization.MIGRATIONS}


def approved():
    return {"schema": 1, "server_id": 9069403, "public_ipv4": "80.68.156.131", "commit": COMMIT, "images": dict(IMAGES),
        "source_hashes": {name: item["sha256"] for name, item in SOURCES.items()}, "migration_hashes": dict(MIGRATIONS),
        "handoff_hashes": {name: "8" * 64 for name in module.EVIDENCE_FILES},
        "configuration_hashes": {name: "9" * 64 for name in module.CONFIG_FILES}}


def previous_outer(api=False):
    value = {"result": "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED", "server_id": 9069403, "public_ipv4": "80.68.156.131",
        "host_key_fingerprint": module.stage.PINNED_FINGERPRINT, "server_status": "on", "ssh_key_id": 800002,
        "guest_key_cleanup": "API_DELETE_CONFIRMED", "account_key_cleanup": "API_DELETE_CONFIRMED", "local_key_cleanup": "REMOVED", "error": None}
    if not api:
        value.update(application_readiness="BLOCKED_MISSING_PROVIDER_INPUTS", initialization={"schema": 1, "result": "DATABASE_INITIALIZED_ONLY",
            "stage": "INITIALIZATION_COMPLETE", "error": None, "commit": COMMIT, "postgres_id": "c" * 64, "database_initialized": True,
            "application_started": False, "migrations": 13, "content_seed": True, "runtime_grants": True, "readonly_acceptance": True})
    else:
        value.update(result="API_ENVIRONMENT_PREPARED_ONLY", application_started=False, caddy_started=False, guest_temp_cleanup="REMOVED",
            remote_directory="/run/kinetra-api-preparation-" + "d" * 32,
            preparation={"schema": 1, "result": "API_ENVIRONMENT_PREPARED_ONLY", "error": None,
                **{key: approved()[key] for key in ("commit", "images", "source_hashes", "migration_hashes")},
                "preparation": {"result": "API_ENVIRONMENT_PREPARED_ONLY", "phase": "API_ENVIRONMENT_PREPARATION_COMPLETE", "error": None,
                    "api_environment_installed": True, "application_started": False, "caddy_started": False, "provider_requests": 0,
                    "candidate_directory": "api-preparation-" + "e" * 32},
                "guest_temp_cleanup": "REMOVED", "remote_directory": "/run/kinetra-api-preparation-" + "d" * 32})
    return value


def request():
    data = {"schema": 1, "approved": approved(), "database_outer": previous_outer(), "api_outer": previous_outer(api=True)}
    data["provenance"] = {"repository": inspection.REPOSITORY, "pr_number": 21, "head_ref": "refs/heads/feature/onboarding-exploration-mode",
        "merge_ref": "refs/pull/21/merge", "billing": "hourly", "monthly_budget_rub": 2000,
        "app_commit": COMMIT, "base_commit": "b" * 40, "merge_commit": "c" * 40, "control_commit": "d" * 40,
        "head_run": "34500000001", "merge_run": "34500000002", "image_run": "34500000003", "image_control_commit": "e" * 40,
        "image_workflow_sha256": "a" * 64, "image_artifact_id": "12345678", "image_artifact_sha256": "b" * 64}
    return bind_request(data)


def bind_request(data):
    values = data["approved"]
    db = dict(data["database_outer"]["initialization"], images=values["images"], migration_hashes=values["migration_hashes"])
    api = dict(data["api_outer"]["preparation"]["preparation"], schema=1,
        **{key: values[key] for key in ("commit", "images", "source_hashes", "migration_hashes")},
        api_sha256=values["configuration_hashes"]["env/api.env"])
    for name, record in (("initialization.json", db), ("application-env.json", api)):
        values["handoff_hashes"][name] = hashlib.sha256((json.dumps(record, sort_keys=True) + "\n").encode()).hexdigest()
    data["provenance"].update(approved_input_sha256=module.canonical_hash(data["approved"]),
        database_outer_sha256=module.canonical_hash(data["database_outer"]), api_outer_sha256=module.canonical_hash(data["api_outer"]))
    return data


def successful_start():
    return {"schema": 1, "result": "APPLICATION_LOCAL_ACCEPTED_ONLY", "phase": "LOCAL_APPLICATION_ACCEPTANCE_COMPLETE", "error": None,
        "nonce": "c" * 32, "attempt_recorded": True, "attempted_services": ["backend", "frontend"],
        "start_attempted_services": ["backend", "frontend"], "uncertain_start_services": [], "owned_containers": {"backend": "d" * 64, "frontend": "e" * 64},
        "rollback": {}, "local_http": {path: {"status": status, "sha256": "f" * 64} for path, status in
            (("/", 200), ("/health", 200), ("/ready", 404), ("/api/v1/me", 401), ("/assets/index-abc.js", 200), ("/assets/index-abc.css", 200))},
        "caddy_started": False, "database_policy_changed": False, "provider_requests": 0,
        "remaining": ["CADDY_IDENTITY_AND_HTTPS", "DATABASE_PERSISTENT_POLICY", "BOOT_ENABLEMENT", "BROWSER_ACCEPTANCE", "BACKUP_AND_USER_LAUNCH"]}


def successful_remote():
    return {"schema": 1, "result": "APPLICATION_LOCAL_ACCEPTED_ONLY", "error": None, "approved_input_sha256": module.canonical_hash(request()["approved"]),
        "commit": COMMIT, "images": dict(IMAGES), "start": successful_start(), "activation_outcome": "ACCEPTED_OBSERVED",
        "guest_temp_cleanup": "REMOVED", "remote_directory": "/run/kinetra-local-activation-" + NONCE}


def inspected_guest():
    return {"schema": 1, "cloud_init": "PASS", "bootstrap_marker": True, "password_auth_disabled": True,
        "keyboard_interactive_disabled": True, "root_login_key_only": True, "os_id": "ubuntu", "os_version": "24.04",
        "cpu_count": 2, "ram_bytes": 4 * 1024**3, "root_total_bytes": 50 * 1024**3, "root_free_bytes": 40 * 1024**3,
        "docker_available": True, "selected_listener_ports": [22], "listeners_verified": True}


class FakeApi:
    instances = []
    wrong_server = wrong_key = fail_delete = False

    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id, self.key_post_attempted, self.server_verified = None, False, False
        self.calls = []
        self.__class__.instances.append(self)

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET":
            return {"server": {"id": 9069404 if self.wrong_server else 9069403, "name": inspection.SERVER_NAME, "status": "on",
                "networks": [{"type": "public", "ips": [{"type": "ipv4", "is_main": True, "ip": "80.68.156.131"}]}]}}
        if method == "POST" and path == "/ssh-keys":
            self.key_post_attempted = True
            return {"ssh_key": {"id": 800004, **body, **({"name": "unrelated-key"} if self.wrong_key else {})}}
        if method == "DELETE" and self.fail_delete: raise module.Error("API_CONNECTION_FAILED")
        return {}


class WrapperTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        FakeApi.instances = []
        FakeApi.wrong_server = FakeApi.wrong_key = FakeApi.fail_delete = False
        self.data = request()
        self.environ = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY, "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_RUN_ID": "34500000009", "RUNNER_TEMP": str(self.root), "TIMEWEB_CLOUD_TOKEN": TOKEN,
            "GITHUB_TOKEN": REGISTRY_TOKEN, "GH_TOKEN": REGISTRY_TOKEN, "APP_CHECKOUT": str(self.root / "checkout"), **IMAGES,
            **{key: "offline-provider-secret" for key in module.prepare.activation.PROVIDER_ENV_KEYS}}
        self.bind()

    def bind(self):
        bind_request(self.data)
        self.environ.update({env: self.data["provenance"][key] for key, env in module.PROVENANCE_ENV.items()})
        self.environ["APPROVED_PROVENANCE_SHA256"] = module.canonical_hash(self.data["provenance"])

    def run_wrapper(self, *, remote=None, transport_error=None, fingerprint=None, source=None, source_error=None):
        output = io.StringIO()
        remote = (0, json.dumps(successful_remote()).encode(), b"") if remote is None else remote
        with patch.object(module, "private_input", return_value=self.data), \
             patch.object(module.stage, "source_bundle", return_value=copy.deepcopy(SOURCES) if source is None else source, side_effect=source_error) as blobs, \
             patch.object(module.initialization, "migration_hashes", return_value=dict(MIGRATIONS)), \
             patch.object(inspection, "pin_host_key", return_value=(self.root / "known_hosts", fingerprint or module.stage.PINNED_FINGERPRINT)) as pin, \
             patch.object(inspection, "prepare_key", return_value=(self.root / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key"), \
             patch.object(inspection, "run_bounded", return_value=(0, json.dumps(inspected_guest()).encode(), b"")), \
             patch.object(module.stage, "run_with_input", return_value=remote, side_effect=transport_error) as ssh, \
             patch.object(module.secrets, "token_hex", return_value=NONCE) as nonce, \
             patch.object(module.resource, "setrlimit"), contextlib.redirect_stdout(output):
            code = module.main(["--activate-local-application", "--private-input", str(self.root / "input.json")], self.environ, FakeApi)
        text = output.getvalue()
        for secret in (TOKEN, REGISTRY_TOKEN, "offline-provider-secret"):
            self.assertNotIn(secret, text)
        state = json.loads(text.splitlines()[-1].split("=", 1)[1])
        return code, state, SimpleNamespace(pin=pin, key=key, ssh=ssh, nonce=nonce, blobs=blobs)

    def test_missing_each_required_handoff_prevents_all_actions(self):
        for key in ("database_outer", "api_outer", "provenance"):
            with self.subTest(key=key):
                self.setUp()
                del self.data[key]
                code, _, calls = self.run_wrapper()
                self.assertEqual(code, 1)
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(calls.nonce.called or calls.key.called or calls.ssh.called)
                self.assertEqual(list(self.root.iterdir()), [])

    def test_prior_success_requires_matching_commit_identity_and_actual_cleanup(self):
        changes = [lambda d: d["database_outer"].update(guest_key_cleanup="NOT_NEEDED"),
            lambda d: d["database_outer"]["initialization"].update(commit="f" * 40),
            lambda d: d["api_outer"].update(guest_temp_cleanup="FAILED_RECONCILE"),
            lambda d: d["api_outer"]["preparation"].update(commit="f" * 40),
            lambda d: d["api_outer"]["preparation"]["preparation"].update(api_environment_installed=False),
            lambda d: d["api_outer"].update(server_id=9069404)]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                change(self.data)
                self.bind()  # Even re-hashed invalid evidence cannot pass.
                code, _, calls = self.run_wrapper()
                self.assertEqual(code, 1)
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(calls.nonce.called or calls.ssh.called)

    def test_immutable_refs_hashes_and_environment_cannot_drift(self):
        changes = [lambda d: d["provenance"].update(merge_ref="refs/pull/22/merge"),
            lambda d: d["provenance"].update(head_ref="refs/heads/main"),
            lambda d: d["provenance"].update(image_run=d["provenance"]["head_run"]),
            lambda d: d["provenance"].update(billing="monthly"),
            lambda d: d["approved"]["configuration_hashes"].update({"env/api.env": "a" * 64}),
            lambda d: d["database_outer"]["initialization"].update(postgres_id="b" * 64)]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                change(self.data)
                code, _, calls = self.run_wrapper()
                self.assertEqual(code, 1)
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(calls.nonce.called)
        self.setUp()
        self.environ["APPROVED_MERGE_COMMIT"] = "f" * 40
        self.assertEqual(self.run_wrapper()[0], 1)
        self.assertEqual(FakeApi.instances, [])

    def test_exact_source_blob_and_all_helper_pins_precede_api(self):
        changed = copy.deepcopy(SOURCES)
        changed[next(iter(changed))]["sha256"] = "f" * 64
        code, state, _ = self.run_wrapper(source=changed)
        self.assertEqual((code, state["error"]), (1, "APPROVED_SOURCE_HASH_MISMATCH"))
        self.assertEqual(FakeApi.instances, [])
        self.setUp()
        with patch.object(module, "public_helpers", side_effect=RuntimeError("CONTROL_HELPER_HASH_MISMATCH")):
            code, _, calls = self.run_wrapper()
        self.assertEqual(code, 1)
        self.assertEqual(FakeApi.instances, [])
        self.assertFalse(calls.nonce.called)
        with patch.object(module, "LOCAL_PINS", {"start-application-host.py": "0" * 64}):
            with self.assertRaisesRegex(RuntimeError, "CONTROL_HELPER_HASH_MISMATCH"): module.public_helpers()

    def test_same_commit_success_from_another_attempt_cannot_replace_handoff(self):
        for kind in ("database", "api"):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == "database":
                    self.data["database_outer"]["initialization"]["postgres_id"] = "f" * 64
                else:
                    self.data["api_outer"]["preparation"]["preparation"]["candidate_directory"] = "api-preparation-" + "f" * 32
                # An authenticated but different successful outer attempt is
                # still incompatible with the original staged handoff hashes.
                self.data["provenance"][kind + "_outer_sha256"] = module.canonical_hash(self.data[kind + "_outer"])
                self.environ.update({env: self.data["provenance"][key] for key, env in module.PROVENANCE_ENV.items()})
                self.environ["APPROVED_PROVENANCE_SHA256"] = module.canonical_hash(self.data["provenance"])
                code, state, calls = self.run_wrapper()
                self.assertEqual((code, state["error"]), (1, "SUCCESSFUL_OUTER_HANDOFF_HASH_MISMATCH"))
                self.assertEqual(FakeApi.instances, [])
                self.assertFalse(calls.nonce.called or calls.ssh.called)

    def test_success_is_local_only_with_exact_stdin_and_owned_cleanup(self):
        code, state, calls = self.run_wrapper()
        self.assertEqual((code, state["result"]), (0, "APPLICATION_LOCAL_ACCEPTED_ONLY"))
        self.assertFalse(state["full_launch_accepted"] or state["caddy_started"] or state["database_policy_changed"])
        self.assertEqual(state["activation_outcome"], "ACCEPTED_OBSERVED")
        self.assertEqual(state["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        for name in (*module.prepare.activation.PROVIDER_ENV_KEYS, "GITHUB_TOKEN", "GH_TOKEN"):
            self.assertNotIn(name, self.environ)
        args, wire, _ = calls.ssh.call_args.args
        payload = json.loads(wire)
        self.assertEqual(payload["approved"], request()["approved"])
        self.assertEqual(set(payload), {"schema", "nonce", "approved", "helpers"})
        self.assertEqual(set(payload["helpers"]), set(module.PINS))
        for name, body in payload["helpers"].items():
            self.assertEqual(hashlib.sha256(base64.b64decode(body)).hexdigest(), module.PINS[name])
        self.assertIn("root@80.68.156.131", args)
        self.assertIn("StrictHostKeyChecking=yes", args)
        for secret in (TOKEN, REGISTRY_TOKEN, "offline-provider-secret"):
            self.assertNotIn(secret, " ".join(args))
            self.assertNotIn(secret.encode(), wire)
        calls.blobs.assert_called_once_with(str(self.root / "checkout"), COMMIT)
        api = FakeApi.instances[0]
        self.assertEqual(api.token, "")
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"],
            [("DELETE", "/servers/9069403/ssh-keys/800004"), ("DELETE", "/ssh-keys/800004")])

    def test_pin_and_server_mismatch_cannot_create_key(self):
        for wrong_server in (True, False):
            self.setUp()
            FakeApi.wrong_server = wrong_server
            code, _, calls = self.run_wrapper(fingerprint="SHA256:wrong")
            self.assertEqual(code, 1)
            self.assertFalse(calls.key.called or calls.ssh.called)
            self.assertFalse(any(m == "POST" for m, _, _ in FakeApi.instances[0].calls))

    def test_lost_response_retains_unknown_while_keys_are_cleaned(self):
        code, state, _ = self.run_wrapper(transport_error=module.Error("REMOTE_STAGE_DEADLINE_EXCEEDED"))
        self.assertEqual(code, 1)
        self.assertEqual(state["activation_outcome"], "UNKNOWN_RECONCILE")
        self.assertEqual(state["guest_temp_cleanup"], "UNKNOWN_RECONCILE")
        self.assertIsNone(state["activation"])
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")

    def test_cleanup_failure_preserves_observed_running_outcome_but_never_pass(self):
        FakeApi.fail_delete = True
        code, state, _ = self.run_wrapper()
        self.assertEqual(code, 1)
        self.assertEqual(state["result"], "FAIL")
        self.assertEqual(state["activation_outcome"], "ACCEPTED_OBSERVED")
        self.assertEqual(set(state["activation"]["start"]["owned_containers"]), {"backend", "frontend"})
        self.assertEqual(state["account_key_cleanup"], "FAILED_RECONCILE")
        self.setUp()
        FakeApi.wrong_key = True
        code, state, calls = self.run_wrapper()
        self.assertEqual(code, 1)
        self.assertEqual(state["account_key_cleanup"], "UNVERIFIED_KEY_RECONCILE")
        self.assertFalse(calls.ssh.called)
        self.assertFalse(any(m == "DELETE" for m, _, _ in FakeApi.instances[0].calls))

    def test_private_file_explicit_mode_and_preservation(self):
        path = self.root / "private.json"
        path.write_text(json.dumps(self.data))
        path.chmod(0o600)
        argv = ["--activate-local-application", "--private-input", str(path)]
        self.assertEqual(module.private_input(argv), self.data)
        self.assertTrue(path.exists())
        path.chmod(0o644)
        with self.assertRaisesRegex(module.Error, "PRIVATE_INPUT_FILE_INVALID"): module.private_input(argv)
        with self.assertRaisesRegex(module.Error, "EXPLICIT_LOCAL_ACTIVATION_ARGUMENTS_REQUIRED"): module.private_input([])


class ResultTests(unittest.TestCase):
    def test_untrusted_result_cannot_leak_strings_or_claim_unproved_ownership(self):
        changes = [lambda d: d.update(error="secret=https://example.com/token"), lambda d: d.update(caddy_started=True),
            lambda d: d.update(provider_requests=1), lambda d: d["owned_containers"].update(frontend="d" * 64),
            lambda d: d["owned_containers"].update(postgres="c" * 64), lambda d: d["local_http"].update({"/secret?token=abc": {}}),
            lambda d: d["local_http"]["/"].update(body="private-response"), lambda d: d["local_http"]["/api/v1/me"].update(status=200),
            lambda d: d.update(start_attempted_services=["frontend"]), lambda d: d.update(rollback={"frontend": "STOPPED"})]
        for change in changes:
            with self.subTest(change=change):
                data = successful_start()
                change(data)
                with self.assertRaises(module.Error): module.validate_start(data)

    def test_failure_preserves_owned_ids_and_uncertain_start(self):
        data = successful_start()
        data.update(result="FAIL", phase="START_FRONTEND", error="ACTIVATION_FAILED_PRIVATE_STATE_PRESERVED",
            uncertain_start_services=["frontend"], rollback={"frontend": "UNCONFIRMED_REQUIRES_REVIEW", "backend": "STOPPED"})
        self.assertEqual(module.validate_start(data), data)
        data["rollback"]["frontend"] = "STOPPED"
        with self.assertRaisesRegex(module.Error, "START_ROLLBACK_UNCERTAINTY_INVALID"): module.validate_start(data)

    def test_remote_identity_and_temp_cleanup_are_mandatory(self):
        changes = [lambda d: d.update(approved_input_sha256="0" * 64), lambda d: d.update(commit="f" * 40),
            lambda d: d["images"].update(BACKEND_IMAGE="ghcr.io/other/project@sha256:" + "3" * 64),
            lambda d: d.update(remote_directory="/run/other-directory"), lambda d: d.update(guest_temp_cleanup="FAILED_RECONCILE"),
            lambda d: d.update(start=None), lambda d: d.update(activation_outcome="NOT_ATTEMPTED")]
        for change in changes:
            data = successful_remote()
            change(data)
            with self.assertRaises(module.Error): module.validate_remote(json.dumps(data), request()["approved"], NONCE)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.ns = {"__name__": "offline_launcher"}
        exec(compile(module.GUEST_LAUNCHER, "<offline-launcher>", "exec"), self.ns)
        self.body = b"# offline public helper fixture\n"
        self.ns["PINS"] = {"start-application-host.py": hashlib.sha256(self.body).hexdigest()}
        self.data = {"schema": 1, "nonce": NONCE, "approved": request()["approved"],
            "helpers": {"start-application-host.py": base64.b64encode(self.body).decode()}}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.root.chmod(0o700)

    def invoke(self, *, child_timeout=False, extra_file=False, bad_hash=False):
        if bad_hash: self.data["helpers"]["start-application-host.py"] = base64.b64encode(b"tampered").decode()
        output, observed = io.StringIO(), {}
        fake = SimpleNamespace(returncode=None, pid=12345, stdout=io.BytesIO(), running=True)

        def spawn(args, **kwargs):
            observed.update(args=args, kwargs=kwargs)
            path = self.root / ("kinetra-local-activation-" + NONCE)
            observed["private"] = json.loads((path / "private-input.json").read_text())
            observed["mode"] = stat.S_IMODE((path / "private-input.json").stat().st_mode)
            if extra_file: (path / "unexpected").write_text("preserve me")
            return fake

        def communicate(timeout):
            observed["communicate_timeout"] = timeout
            if child_timeout: raise subprocess.TimeoutExpired("offline", timeout)
            fake.returncode, fake.running = 0, False
            return json.dumps(successful_start()).encode(), b""

        def wait(timeout):
            observed["wait_timeout"] = timeout
            # A slow but legally bounded first/second rollback needs >120s.
            self.assertGreaterEqual(timeout, 540)
            fake.returncode, fake.running = 1, False
            return 1

        fake.communicate, fake.poll, fake.wait = communicate, lambda: None if fake.running else fake.returncode, wait
        actual_path = Path
        with patch.object(self.ns["pathlib"], "Path", side_effect=lambda path: self.root if path == "/run" else actual_path(path)), \
             patch.object(self.ns["sys"], "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(self.data).encode()))), \
             patch.object(self.ns["subprocess"], "Popen", side_effect=spawn) as popen, \
             patch.object(self.ns["os"], "killpg") as killpg, \
             patch.object(self.ns["resource"], "setrlimit"), contextlib.redirect_stdout(output):
            code = self.ns["main"]()
        return code, json.loads(output.getvalue()), observed, popen, killpg

    def test_launcher_stdin_privacy_and_owned_temp_cleanup(self):
        code, result, observed, _, _ = self.invoke()
        self.assertEqual((code, result["result"]), (0, "APPLICATION_LOCAL_ACCEPTED_ONLY"))
        self.assertEqual(result["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(observed["private"], self.data["approved"])
        self.assertEqual(observed["mode"], 0o600)
        self.assertEqual(observed["kwargs"]["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        self.assertIn("--start-validated-local-application", observed["args"])
        self.assertNotIn("approved", " ".join(observed["args"]))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_timeout_allows_rollback_grace_but_remains_unknown(self):
        code, result, observed, _, killpg = self.invoke(child_timeout=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "UNKNOWN_RECONCILE")
        self.assertIsNone(result["start"])
        self.assertEqual(result["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(observed["wait_timeout"], 600)
        killpg.assert_called_once_with(12345, module.signal.SIGTERM)

    def test_unexpected_temp_file_prevents_any_unlink_and_pass(self):
        code, result, _, _, _ = self.invoke(extra_file=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "ACCEPTED_OBSERVED")
        self.assertEqual(result["guest_temp_cleanup"], "FAILED_RECONCILE")
        folder = self.root / ("kinetra-local-activation-" + NONCE)
        self.assertEqual({path.name for path in folder.iterdir()}, {"start-application-host.py", "private-input.json", "unexpected"})

    def test_public_pin_mismatch_starts_nothing_and_creates_no_temp(self):
        code, result, _, popen, _ = self.invoke(bad_hash=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "NOT_ATTEMPTED")
        self.assertFalse(popen.called)
        self.assertEqual(list(self.root.iterdir()), [])


class PortabilityTests(unittest.TestCase):
    def test_modeled_runner_owned_checkout_does_not_import_root_only_guest(self):
        # This managed scratch FS cannot chown to unmapped UIDs. Model runner
        # ownership on real files while retaining their exact bytes and modes.
        real_lstat = Path.lstat

        def runner_owned(path):
            info = real_lstat(path)
            return os.stat_result((*info[:4], 1000, 1000, *info[6:]))

        spec = importlib.util.spec_from_file_location("runner_owned_outer", Path(__file__).with_name("activate-local-application-host.py"))
        candidate = importlib.util.module_from_spec(spec)
        with patch.object(Path, "lstat", runner_owned), patch.object(os, "geteuid", return_value=1000):
            spec.loader.exec_module(candidate)
            self.assertEqual(len(candidate.public_helpers()), 6)
            # Importing start-application-host.py here would reject UID1000.
            self.assertFalse(hasattr(candidate, "start_guest"))


if __name__ == "__main__": unittest.main()
