#!/usr/bin/env python3
"""Offline tests: API, SSH, Caddy execution and systemd are all mocked."""

import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).with_name("prepare-caddy-host.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
inspection = prepare.inspection
guest = {"__name__": "offline_guest_contracts"}
exec(compile(prepare.GUEST_PREPARATION, "<guest-caddy-preparation>", "exec"), guest)


def inspected_guest():
    return {
        "schema": 1, "cloud_init": "PASS", "bootstrap_marker": True,
        "password_auth_disabled": True, "keyboard_interactive_disabled": True,
        "root_login_key_only": True, "os_id": "ubuntu", "os_version": "24.04",
        "cpu_count": 2, "ram_bytes": 4 * 1024**3, "root_total_bytes": 50 * 1024**3,
        "root_free_bytes": 45 * 1024**3, "docker_available": True,
        "selected_listener_ports": [22], "listeners_verified": True,
    }


def successful_preparation():
    return {"schema": 1, "result": "PASS", "stage": "PREPARED_CADDY_ONLY", "error": None,
            "version": "2.11.4", "service_enabled": "disabled", "service_active": "inactive",
            "temporary_script_cleanup": "REMOVED", "activation_requested": False,
            "application_changes_requested": False, "phase": "UNIT_VERIFY", "exit_code": 0}


class FakeApi:
    instances = []
    fail_attach = False
    fail_delete = False
    wrong_key = False

    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id, self.server_verified, self.key_post_attempted = None, False, False
        self.calls = []
        self.__class__.instances.append(self)

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if method == "GET":
            return {"server": {"id": inspection.SERVER_ID, "name": inspection.SERVER_NAME,
                "status": "on", "networks": [{"type": "public", "ips": [{"type": "ipv4",
                    "is_main": True, "ip": inspection.PUBLIC_IPV4}]}]}}
        if method == "POST" and path == "/ssh-keys":
            self.key_post_attempted = True
            key = {"id": 800002, **payload}
            if self.wrong_key:
                key["name"] = "unrelated-project-key"
            return {"ssh_key": key}
        if method == "POST" and self.fail_attach:
            raise prepare.Error("API_CONNECTION_FAILED")
        if method == "DELETE" and self.fail_delete:
            raise prepare.Error("API_CONNECTION_FAILED")
        return {}


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        FakeApi.instances = []
        FakeApi.fail_attach = FakeApi.fail_delete = FakeApi.wrong_key = False
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000000",
            "RUNNER_TEMP": self.directory.name, "TIMEWEB_CLOUD_TOKEN": "offline-fake-token",
        }

    def run_preparation(self, *, fingerprint=prepare.PINNED_FINGERPRINT, responses=None):
        if responses is None:
            responses = [(0, json.dumps(inspected_guest()).encode(), b""),
                (0, json.dumps(successful_preparation()).encode(), b""),
                (0, json.dumps(inspected_guest()).encode(), b"")]
        output = io.StringIO()
        with patch.object(inspection, "pin_host_key", return_value=(Path(self.directory.name) / "known_hosts", fingerprint)), \
             patch.object(inspection, "prepare_key", return_value=(Path(self.directory.name) / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key") as wait, \
             patch.object(inspection, "run_bounded", side_effect=responses) as ssh, \
             patch.object(prepare.resource, "setrlimit"), contextlib.redirect_stdout(output):
            result = prepare.main(["--prepare-disabled-caddy-existing-server"], self.environment, FakeApi)
        states = [json.loads(line.split("=", 1)[1]) for line in output.getvalue().splitlines()]
        self.assertNotIn("offline-fake-token", output.getvalue())
        self.assertNotIn("hidden-remote-secret", output.getvalue())
        return result, states[-1], ssh, key, wait

    def test_success_reconnects_and_cleans_exact_ephemeral_key(self):
        result, state, ssh, *_ = self.run_preparation()
        self.assertEqual(result, 0)
        self.assertEqual(state["result"], "PASS_CADDY_PREPARED_DISABLED_ONLY")
        self.assertEqual(ssh.call_count, 3)
        self.assertEqual(ssh.call_args_list[0].args[0], ssh.call_args_list[2].args[0])
        self.assertIn("--kill-after=15s", ssh.call_args_list[1].args[0][-1])
        self.assertIn("SCRIPT_BASE64", ssh.call_args_list[1].args[0][-1])
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        api = FakeApi.instances[0]
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"], [
            ("DELETE", "/servers/9069403/ssh-keys/800002"), ("DELETE", "/ssh-keys/800002")])
        self.assertEqual(api.token, "")
        self.assertNotIn("TIMEWEB_CLOUD_TOKEN", self.environment)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_host_pin_mismatch_blocks_cloud_key_and_ssh(self):
        result, state, ssh, key, wait = self.run_preparation(fingerprint="SHA256:wrong")
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "PINNED_HOST_KEY_MISMATCH")
        self.assertIsNone(state["host_key_fingerprint"])
        self.assertFalse(ssh.called or key.called or wait.called)
        self.assertEqual([method for method, _, _ in FakeApi.instances[0].calls], ["GET"])

    def test_hash_drift_refused_before_any_api(self):
        drifted = Path(self.directory.name) / "modified.sh"
        drifted.write_text("echo not reviewed\n")
        with patch.object(prepare, "SCRIPT_PATH", drifted):
            result, state, ssh, key, wait = self.run_preparation()
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "REVIEWED_SCRIPT_HASH_MISMATCH")
        self.assertEqual(FakeApi.instances, [])
        self.assertFalse(ssh.called or key.called or wait.called)

    def test_wrong_server_refused_before_any_api(self):
        self.environment["ROOT_SUPPLIED_SERVER_ID"] = "42"
        result, state, *_ = self.run_preparation()
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        self.assertEqual(FakeApi.instances, [])

    def test_unbootstrapped_or_active_host_never_runs_script(self):
        for changes in ({"docker_available": False}, {"password_auth_disabled": False},
                        {"root_login_key_only": False}, {"bootstrap_marker": False},
                        {"selected_listener_ports": [22, 443]}):
            with self.subTest(changes=changes):
                self.environment["TIMEWEB_CLOUD_TOKEN"] = "offline-fake-token"
                before = {**inspected_guest(), **changes}
                result, state, ssh, *_ = self.run_preparation(responses=[(0, json.dumps(before).encode(), b"")])
                self.assertEqual(result, 1)
                self.assertEqual(ssh.call_count, 1)
                self.assertEqual(state["error"], "BOOTSTRAPPED_HOST_PRECONDITION_FAILED")

    def test_attach_uncertainty_still_cleans_both_cloud_key_records(self):
        FakeApi.fail_attach = True
        result, state, ssh, *_ = self.run_preparation()
        self.assertEqual(result, 1)
        self.assertFalse(ssh.called)
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_unverified_returned_key_is_not_attached_or_deleted(self):
        FakeApi.wrong_key = True
        result, state, ssh, *_ = self.run_preparation()
        self.assertEqual(result, 1)
        self.assertFalse(ssh.called)
        self.assertIsNone(FakeApi.instances[0].key_id)
        self.assertFalse(any(method == "DELETE" for method, _, _ in FakeApi.instances[0].calls))
        self.assertEqual(state["account_key_cleanup"], "UNVERIFIED_KEY_RECONCILE")
        self.assertEqual(state["error"], "CREATED_KEY_IDENTITY_MISMATCH")

    def test_remote_error_is_sanitized_and_cleanup_runs_without_retry(self):
        failed = {**successful_preparation(), "result": "FAIL", "stage": "PREPARE_DISABLED_CADDY",
                  "error": "REMOTE_SCRIPT_FAILED_PARTIAL_STATE"}
        result, state, ssh, *_ = self.run_preparation(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""),
            (1, json.dumps(failed).encode(), b"hidden-remote-secret")])
        self.assertEqual(result, 1)
        self.assertEqual(ssh.call_count, 2)
        self.assertEqual(state["error"], "REMOTE_CADDY_PREPARATION_FAILED_PARTIAL_STATE")
        self.assertEqual(state["preparation"]["stage"], "PREPARE_DISABLED_CADDY")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_raw_remote_output_is_rejected_without_reflection(self):
        result, state, *_ = self.run_preparation(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""), (1, b"hidden-remote-secret", b"")])
        self.assertEqual(result, 1)
        self.assertIsNone(state["preparation"])
        self.assertEqual(state["error"], "PREPARATION_RESULT_INVALID_PARTIAL_STATE")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")

    def test_timeout_cleans_keys_and_never_claims_success(self):
        result, state, ssh, *_ = self.run_preparation(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""), prepare.Error("SUBPROCESS_TIMEOUT")])
        self.assertEqual(result, 1)
        self.assertEqual(ssh.call_count, 2)
        self.assertEqual(state["error"], "SUBPROCESS_TIMEOUT")
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_cleanup_failure_overrides_success(self):
        FakeApi.fail_delete = True
        result, state, *_ = self.run_preparation()
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "KEY_CLEANUP_REQUIRES_RECONCILIATION")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")

    def test_reconnect_failure_cleans_keys(self):
        result, state, *_ = self.run_preparation(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""),
            (0, json.dumps(successful_preparation()).encode(), b""), (255, b"", b"hidden-remote-secret")])
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "POST_CADDY_SSH_RECONNECT_FAILED")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_output_schema_rejects_unknown_fields_values_and_missing_evidence(self):
        for changes in ({"error": "hidden-remote-secret"}, {"extra": "hidden-remote-secret"},
                        {"version": ["2.11.4"]}, {"activation_requested": True},
                        {"application_changes_requested": True}, {"service_enabled": None},
                        {"temporary_script_cleanup": "PENDING"}, {"phase": "hidden-remote-secret"},
                        {"exit_code": True}, {"exit_code": 256}):
            with self.subTest(changes=changes), self.assertRaises(prepare.Error):
                prepare.validate_preparation_result(json.dumps({**successful_preparation(), **changes}))


class RemoteContracts(unittest.TestCase):
    def test_remote_script_hash_drift_does_not_create_temp_or_execute(self):
        output = io.StringIO()
        with patch.object(guest["os"], "geteuid", return_value=0), \
             patch.object(guest["tempfile"], "mkdtemp") as temporary, \
             patch.dict(guest, {"execute_script": Mock()}) as _patch, contextlib.redirect_stdout(output):
            result = guest["main"](base64.b64encode(b"changed").decode())
            self.assertFalse(guest["execute_script"].called)
        state = prepare.validate_preparation_result(output.getvalue())
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "REMOTE_SOURCE_HASH_MISMATCH")
        self.assertFalse(temporary.called)

    def test_remote_script_error_removes_private_temp_file(self):
        with tempfile.TemporaryDirectory() as parent:
            folder = Path(parent) / "root-private"
            folder.mkdir(mode=0o700)
            output = io.StringIO()
            def execute(script, state):
                self.assertEqual(script.read_bytes(), prepare.verified_script())
                self.assertEqual(script.stat().st_mode & 0o777, 0o600)
                state.update(phase="INSTALL", exit_code=1)
                raise guest["PrepareError"]("REMOTE_SCRIPT_FAILED_PARTIAL_STATE")
            with patch.object(guest["os"], "geteuid", return_value=0), \
                 patch.object(guest["tempfile"], "mkdtemp", return_value=str(folder)), \
                 patch.dict(guest, {"execute_script": execute}), contextlib.redirect_stdout(output):
                result = guest["main"](base64.b64encode(prepare.verified_script()).decode())
            self.assertEqual(result, 1)
            self.assertFalse(folder.exists())
            state = prepare.validate_preparation_result(output.getvalue())
            self.assertEqual(state["temporary_script_cleanup"], "REMOVED")
            self.assertEqual(state["phase"], "INSTALL")
            self.assertEqual(state["exit_code"], 1)

    def test_script_child_timeout_kills_its_process_group_and_hides_output(self):
        process = Mock(pid=54321)
        process.wait.return_value = 0
        process.poll.return_value = None
        with patch.object(guest["subprocess"], "Popen", return_value=process) as start, \
             patch.object(guest["selectors"], "DefaultSelector") as selector, \
             patch.object(guest["time"], "monotonic", side_effect=[0, 421]), \
             patch.object(guest["os"], "killpg") as kill:
            selector.return_value.__enter__.return_value.get_map.return_value = {1: True}
            with self.assertRaisesRegex(guest["PrepareError"], "REMOTE_SCRIPT_TIMEOUT_PARTIAL_STATE"):
                guest["execute_script"](Path("/run/mock/prepare-caddy.sh"), {})
        self.assertEqual(kill.call_args.args[0], 54321)
        self.assertEqual(start.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(start.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(start.call_args.kwargs["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})

    def test_only_exact_whitelisted_phase_markers_are_retained(self):
        state = {"phase": None}
        for line in [b"hidden-remote-secret", b"KINETRA_CADDY_PHASE=secret", b"KINETRA_CADDY_PHASE=INSTALL extra"]:
            guest["capture_phase"](line, state)
            self.assertIsNone(state["phase"])
        guest["capture_phase"](b"KINETRA_CADDY_PHASE=DOWNLOAD", state)
        self.assertEqual(state["phase"], "DOWNLOAD")

    def test_script_failure_retains_only_phase_and_numeric_exit_code(self):
        process = Mock(pid=54321)
        process.wait.return_value = 22
        process.poll.return_value = 22
        state = {"phase": None, "exit_code": None}
        ready = Mock()
        ready.fileobj.fileno.return_value = 123
        with patch.object(guest["subprocess"], "Popen", return_value=process), \
             patch.object(guest["selectors"], "DefaultSelector") as factory, \
             patch.object(guest["os"], "read", side_effect=[b"hidden-remote-secret\nKINETRA_CADDY_PHASE=DOWNLOAD\n", b""]):
            selector = factory.return_value.__enter__.return_value
            selector.get_map.side_effect = [{1: True}, {1: True}, {}]
            selector.select.return_value = [(ready, 1)]
            with self.assertRaisesRegex(guest["PrepareError"], "REMOTE_SCRIPT_FAILED_PARTIAL_STATE"):
                guest["execute_script"](Path("/run/mock/prepare-caddy.sh"), state)
        self.assertEqual(state, {"phase": "DOWNLOAD", "exit_code": 22})
        self.assertTrue(process.stdout.close.called)

    def test_excess_remote_output_is_bounded_and_child_is_terminated(self):
        process = Mock(pid=54321)
        process.poll.return_value = None
        process.wait.return_value = 0
        ready = Mock()
        ready.fileobj.fileno.return_value = 123
        with patch.object(guest["subprocess"], "Popen", return_value=process), \
             patch.object(guest["selectors"], "DefaultSelector") as factory, \
             patch.object(guest["os"], "read", return_value=b"x" * 4096) as read, \
             patch.object(guest["os"], "killpg") as kill:
            selector = factory.return_value.__enter__.return_value
            selector.get_map.return_value = {1: True}
            selector.select.return_value = [(ready, 1)]
            with self.assertRaisesRegex(guest["PrepareError"], "REMOTE_SCRIPT_OUTPUT_LIMIT_PARTIAL_STATE"):
                guest["execute_script"](Path("/run/mock/prepare-caddy.sh"), {})
        self.assertEqual(read.call_count, 5)
        self.assertEqual(kill.call_args.args[0], 54321)


if __name__ == "__main__":
    unittest.main(verbosity=2)
