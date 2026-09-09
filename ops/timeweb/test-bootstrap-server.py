#!/usr/bin/env python3
"""Offline-only bootstrap contracts; API, SSH, apt and systemd are mocked."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap", Path(__file__).with_name("bootstrap-server.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
inspection = bootstrap.inspection
guest = {"__name__": "offline_guest_contracts"}
exec(compile(bootstrap.GUEST_BOOTSTRAP, "<guest-bootstrap>", "exec"), guest)


def inspected_guest(docker=False):
    return {
        "schema": 1, "cloud_init": "PASS", "bootstrap_marker": True,
        "password_auth_disabled": True, "keyboard_interactive_disabled": True,
        "root_login_key_only": True, "os_id": "ubuntu", "os_version": "24.04",
        "cpu_count": 2, "ram_bytes": 4 * 1024**3, "root_total_bytes": 50 * 1024**3,
        "root_free_bytes": 45 * 1024**3, "docker_available": docker,
        "selected_listener_ports": [22], "listeners_verified": True,
    }


def successful_bootstrap():
    return {
        "schema": 1, "result": "PASS", "stage": "HOST_PREREQUISITES_COMPLETE", "error": None,
        "docker_config": "CREATED_BOUNDED_LOCAL_LOGS", "docker_version": "28.2.2",
        "compose_version": "2.37.1", "firewall": "ACTIVE_22_80_443_ALLOWED_DEFAULT_INCOMING_DENY",
        "application_deployed": False,
        "unexpected_listener": None,
    }


class FakeApi:
    instances = []
    fail_attach = False
    fail_delete = False

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
            return {"ssh_key": {"id": 800001, **payload}}
        if method == "POST" and self.fail_attach:
            raise bootstrap.Error("API_CONNECTION_FAILED")
        if method == "DELETE" and self.fail_delete:
            raise bootstrap.Error("API_CONNECTION_FAILED")
        return {}


class BootstrapOrchestrationTests(unittest.TestCase):
    def setUp(self):
        FakeApi.instances = []
        FakeApi.fail_attach = FakeApi.fail_delete = False
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000000",
            "RUNNER_TEMP": self.directory.name, "TIMEWEB_CLOUD_TOKEN": "offline-fake-token",
        }

    def run_bootstrap(self, *, fingerprint=bootstrap.PINNED_FINGERPRINT, responses=None, environ=None):
        if responses is None:
            responses = [(0, json.dumps(inspected_guest()).encode(), b""),
                (0, json.dumps(successful_bootstrap()).encode(), b""),
                (0, json.dumps(inspected_guest(True)).encode(), b"")]
        output = io.StringIO()
        with patch.object(inspection, "pin_host_key", return_value=(Path(self.directory.name) / "known_hosts", fingerprint)) as host_scan, \
             patch.object(inspection, "prepare_key", return_value=(Path(self.directory.name) / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key") as wait, \
             patch.object(inspection, "run_bounded", side_effect=responses) as ssh, \
             patch.object(bootstrap.resource, "setrlimit"), contextlib.redirect_stdout(output):
            result = bootstrap.main(["--bootstrap-existing-empty-server"],
                self.environment if environ is None else environ, FakeApi)
        states = [json.loads(line.split("=", 1)[1]) for line in output.getvalue().splitlines()]
        self.assertNotIn("offline-fake-token", output.getvalue())
        return result, states[-1], ssh, key, wait, host_scan

    def test_success_reconnects_and_cleans_only_ephemeral_key(self):
        result, state, ssh, *_ = self.run_bootstrap()
        self.assertEqual(result, 0)
        self.assertEqual(state["result"], "PASS_HOST_PREREQUISITES_ONLY")
        self.assertEqual(ssh.call_count, 3)
        self.assertEqual(ssh.call_args_list[0].args[0], ssh.call_args_list[2].args[0])
        self.assertIn("--kill-after=15s", ssh.call_args_list[1].args[0][-1])
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        api = FakeApi.instances[0]
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"], [
            ("DELETE", "/servers/9069403/ssh-keys/800001"), ("DELETE", "/ssh-keys/800001")])
        self.assertEqual(api.token, "")
        self.assertNotIn("TIMEWEB_CLOUD_TOKEN", self.environment)

    def test_pin_mismatch_blocks_key_creation_and_all_ssh(self):
        result, state, ssh, key, wait, _ = self.run_bootstrap(fingerprint="SHA256:wrong")
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "PINNED_HOST_KEY_MISMATCH")
        self.assertFalse(ssh.called or key.called or wait.called)
        self.assertEqual([method for method, _, _ in FakeApi.instances[0].calls], ["GET"])

    def test_server_override_rejected_before_api(self):
        self.environment["ROOT_SUPPLIED_SERVER_ID"] = "1234"
        result, state, *_ = self.run_bootstrap()
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        self.assertEqual(FakeApi.instances, [])

    def test_attach_uncertainty_still_cleans_guest_and_account(self):
        FakeApi.fail_attach = True
        result, state, ssh, *_ = self.run_bootstrap()
        self.assertEqual(result, 1)
        self.assertFalse(ssh.called)
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_preexisting_service_prevents_mutation(self):
        before = inspected_guest()
        before["selected_listener_ports"] = [22, 80]
        result, state, ssh, *_ = self.run_bootstrap(responses=[(0, json.dumps(before).encode(), b"")])
        self.assertEqual(result, 1)
        self.assertEqual(ssh.call_count, 1)
        self.assertEqual(state["error"], "GUEST_SSH_OR_EMPTY_HOST_PRECONDITION_FAILED")

    def test_partial_remote_failure_is_reported_without_retry(self):
        failure = successful_bootstrap()
        failure.update(result="FAIL", stage="PACKAGE_INSTALLATION", error="REMOTE_COMMAND_FAILED")
        result, state, ssh, *_ = self.run_bootstrap(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""), (1, json.dumps(failure).encode(), b"")])
        self.assertEqual(result, 1)
        self.assertEqual(ssh.call_count, 2)
        self.assertEqual(state["bootstrap"]["stage"], "PACKAGE_INSTALLATION")
        self.assertEqual(state["error"], "REMOTE_BOOTSTRAP_FAILED_PARTIAL_STATE")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_reconnect_failure_never_reports_success(self):
        result, state, ssh, *_ = self.run_bootstrap(responses=[
            (0, json.dumps(inspected_guest()).encode(), b""),
            (0, json.dumps(successful_bootstrap()).encode(), b""), (255, b"", b"hidden")])
        self.assertEqual(result, 1)
        self.assertEqual(ssh.call_count, 3)
        self.assertEqual(state["error"], "POST_FIREWALL_SSH_RECONNECT_FAILED")

    def test_cleanup_failure_overrides_success(self):
        FakeApi.fail_delete = True
        result, state, *_ = self.run_bootstrap()
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "KEY_CLEANUP_REQUIRES_RECONCILIATION")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")

    def test_unvalidated_remote_text_never_echoes(self):
        response = successful_bootstrap()
        response["error"] = "secret material should never be emitted"
        with self.assertRaisesRegex(bootstrap.Error, "SCHEMA_INVALID"):
            bootstrap.validate_bootstrap_result(json.dumps(response))

    def test_pass_requires_complete_evidence(self):
        response = successful_bootstrap()
        response["firewall"] = None
        with self.assertRaisesRegex(bootstrap.Error, "PASS_EVIDENCE_INCOMPLETE"):
            bootstrap.validate_bootstrap_result(json.dumps(response))

    def test_pass_rejects_compose_without_raw_env_file_support(self):
        response = successful_bootstrap()
        response["compose_version"] = "2.29.7"
        with self.assertRaisesRegex(bootstrap.Error, "COMPOSE_2_30_REQUIRED"):
            bootstrap.validate_bootstrap_result(json.dumps(response))
        response["compose_version"] = "2.30.0"
        self.assertEqual(bootstrap.validate_bootstrap_result(json.dumps(response))["result"], "PASS")

    def test_rejected_listener_evidence_accepts_only_sanitized_endpoint(self):
        response = successful_bootstrap()
        response.update(result="FAIL", stage="PRECONDITIONS", error="EXISTING_PUBLIC_LISTENER_REFUSED",
            unexpected_listener={"address": "80.68.156.131", "port": 443})
        self.assertEqual(bootstrap.validate_bootstrap_result(json.dumps(response))["unexpected_listener"],
            {"address": "80.68.156.131", "port": 443})
        for evidence in (
            {"address": "80.68.156.131", "port": 443, "process": "do not emit"},
            {"address": "secret.example", "port": 443},
            {"address": "127.0.0.53", "port": 53},
            {"address": "fe80::1%secret", "port": 443},
            {"address": "80.68.156.131", "port": 22},
            {"address": "80.68.156.131", "port": True},
        ):
            with self.subTest(evidence=evidence), self.assertRaisesRegex(bootstrap.Error, "LISTENER_EVIDENCE_INVALID"):
                bootstrap.validate_bootstrap_result(json.dumps({**response, "unexpected_listener": evidence}))

    def test_rejected_listener_requires_evidence_and_fail_result(self):
        response = successful_bootstrap()
        response.update(result="FAIL", stage="PRECONDITIONS", error="EXISTING_PUBLIC_LISTENER_REFUSED")
        with self.assertRaisesRegex(bootstrap.Error, "LISTENER_EVIDENCE_MISSING"):
            bootstrap.validate_bootstrap_result(json.dumps(response))
        response.update(result="PASS", unexpected_listener={"address": "*", "port": 443})
        with self.assertRaisesRegex(bootstrap.Error, "LISTENER_EVIDENCE_INVALID"):
            bootstrap.validate_bootstrap_result(json.dumps(response))


class GuestOperationTests(unittest.TestCase):
    def test_standard_ss_loopback_dns_and_ssh_formats_are_accepted(self):
        output = "\n".join([
            "LISTEN 0 4096 127.0.0.53:53 0.0.0.0:*",
            "LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*",
            "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
            "LISTEN 0 4096 127.127.1.2:8080 0.0.0.0:*",
            "LISTEN 0 4096 [::1]:631 [::]:*",
            "LISTEN 0 4096 [::1%lo]:631 [::]:*",
            "LISTEN 0 4096 ::1:631 :::*",
            "LISTEN 0 4096 [::ffff:127.0.0.53]:53 [::]:*",
            "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
            "LISTEN 0 4096 [::]:22 [::]:*",
            "LISTEN 0 4096 *:22 *:*",
            "tcp LISTEN 0 4096 80.68.156.131:22 0.0.0.0:*",
        ])
        guest["assert_expected_listeners"](output)

    def test_non_loopback_services_still_rejected_with_only_address_and_port(self):
        for endpoint, normalized in (
            ("80.68.156.131:443", "80.68.156.131"), ("0.0.0.0:443", "0.0.0.0"),
            ("*:443", "*"), ("[::]:443", "::"),
            ("[2001:DB8::1]:443", "2001:db8::1"),
            ("[fe80::1%ens18]:443", "fe80::1"), ("10.0.0.1:443", "10.0.0.1"),
        ):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(guest["BootstrapError"], "EXISTING_PUBLIC_LISTENER_REFUSED") as raised:
                guest["assert_expected_listeners"]("LISTEN 0 4096 " + endpoint + " *:*")
            self.assertEqual(raised.exception.unexpected_listener, {"address": normalized, "port": 443})

    def test_invalid_ss_formats_fail_without_reflecting_raw_output(self):
        for output in (
            "secret text", "LISTEN 0 4096 secret.example:443 *:*", "LISTEN 0 4096 0.0.0.0:65536 *:*",
            "LISTEN 0 4096 127.0.0.53:domain *:*", "LISTEN 0 4096 [::1:443 *:*",
            "LISTEN 0 4096 127.0.0.53%bad%scope:53 *:*", "LISTEN 0 4096 127.0.0.53:53 *:* users:secret",
        ):
            with self.subTest(output=output), self.assertRaises(guest["BootstrapError"]) as raised:
                guest["assert_expected_listeners"](output)
            self.assertIsNone(raised.exception.unexpected_listener)
            self.assertNotIn("secret", str(raised.exception))

    def test_existing_valid_docker_config_preserved_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "daemon.json"
            body = b'{ "log-driver": "json-file", "log-opts": {"max-size":"20m", "max-file":"4"}, "live-restore": true }\n'
            path.write_bytes(body)
            self.assertEqual(guest["configure_docker"](path), "EXISTING_PRESERVED")
            self.assertEqual(path.read_bytes(), body)

    def test_unbounded_docker_config_is_refused_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "daemon.json"
            body = b'{"live-restore": true}\n'
            path.write_bytes(body)
            with self.assertRaisesRegex(guest["BootstrapError"], "LOG_LIMITS_NOT_CONFIRMED"):
                guest["configure_docker"](path)
            self.assertEqual(path.read_bytes(), body)

    def test_custom_data_root_and_hosts_are_refused(self):
        base = {"log-driver": "local", "log-opts": {"max-size": "10m", "max-file": "3"}}
        for extra in ({"data-root": "/other-docker-data"}, {"hosts": ["unix:///var/run/docker.sock"]}):
            with self.subTest(extra=extra), self.assertRaises(guest["BootstrapError"]):
                guest["validate_log_configuration"]({**base, **extra})

    def test_fresh_configuration_has_bounded_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "daemon.json"
            self.assertEqual(guest["configure_docker"](path), "CREATED_BOUNDED_LOCAL_LOGS")
            guest["validate_log_configuration"](json.loads(path.read_bytes()))
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_symlink_configuration_is_never_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text("unchanged")
            path = Path(directory) / "daemon.json"
            path.symlink_to(target)
            with self.assertRaisesRegex(guest["BootstrapError"], "CONFIGURATION_UNSAFE"):
                guest["configure_docker"](path)
            self.assertEqual(target.read_text(), "unchanged")

    def test_active_existing_workload_rejected(self):
        with patch.object(guest["shutil"], "which", return_value="/usr/bin/docker"), \
             patch.object(guest["subprocess"], "run") as status, \
             patch.dict(guest, {"command": lambda *_args, **_kwargs: "existing-container\n"}):
            status.return_value.returncode = 0
            with self.assertRaisesRegex(guest["BootstrapError"], "EXISTING_DOCKER_WORKLOAD"):
                guest["assert_empty_docker"]()

    def test_absent_docker_cli_does_not_hide_retained_data(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "existing-data").write_text("retained")
            with patch.object(guest["shutil"], "which", return_value=None), \
                 patch.object(guest["pathlib"], "Path", return_value=Path(directory)):
                with self.assertRaisesRegex(guest["BootstrapError"], "RETAINED_DATA"):
                    guest["assert_empty_docker"]()

    def test_unexpected_ufw_rule_rejected(self):
        with patch.object(guest["shutil"], "which", return_value="/usr/sbin/ufw"), \
             patch.dict(guest, {"command": lambda *_args, **_kwargs: "Added user rules:\nufw deny 22/tcp\n"}):
            with self.assertRaisesRegex(guest["BootstrapError"], "UFW_RULES_REQUIRE_INSPECTION"):
                guest["assert_expected_ufw_rules"]()

    def test_firewall_allows_ports_before_enable(self):
        calls = []
        status = "Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n"
        status += "\n".join(str(port) + "/tcp ALLOW IN Anywhere" for port in (22, 80, 443))
        def command(args, **_kwargs):
            calls.append(args)
            return status if args[1:] == ["status", "verbose"] else ""
        with patch.dict(guest, {"command": command, "assert_expected_ufw_rules": lambda: None}):
            self.assertEqual(guest["configure_firewall"](), "ACTIVE_22_80_443_ALLOWED_DEFAULT_INCOMING_DENY")
        enabled = calls.index(["/usr/sbin/ufw", "--force", "enable"])
        for port in (22, 80, 443):
            self.assertLess(calls.index(["/usr/sbin/ufw", "allow", str(port) + "/tcp"]), enabled)
        self.assertFalse(any("reset" in call for call in calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
