#!/usr/bin/env python3
"""Offline HTTPS contracts. Host commands, containers and HTTP are fixtures only."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import types
import unittest
from unittest.mock import Mock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


https = load("https_activation_under_test", "activate-https-host.py")
CHECK_APPLICATION = https.check_application
fixtures = load("https_local_fixture_supplier", "test-start-application-host.py")
INVOCATION = "8" * 32
CERTIFICATE = {"sha256": "9" * 64, "ip_san": https.PUBLIC_IP, "not_before": 1,
               "not_after": 4_000_000_000, "trusted": True}


class HttpsActivationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LocalActivationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.fake_runtime()
        code, accepted = self.fixture.run_main()
        self.assertEqual((code, accepted["result"]), (0, "APPLICATION_LOCAL_ACCEPTED_ONLY"))
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(https, "local", fixtures.start))
        for name, value in (("STAGE", self.fixture.stage), ("LOCK", self.fixture.root / "lock"),
                            ("safe_parent", fixtures.start.safe_parent), ("private_read", fixtures.start.private_read),
                            ("write_new", fixtures.start.write_new), ("sync_directory", fixtures.start.sync_directory)):
            self.stack.enter_context(patch.object(https, name, value))
        self.stage = self.fixture.stage
        self.active, self.invocation = False, ""
        self.calls = []
        self.stack.enter_context(patch.object(https, "command", side_effect=self.host_command))
        self.identity = self.stack.enter_context(patch.object(https, "check_caddy_identity", side_effect=self.caddy_identity))
        self.stack.enter_context(patch.object(https, "check_listeners"))
        self.application = self.stack.enter_context(patch.object(https, "check_application", return_value={"id": fixtures.PG, "restart": "no"}))
        self.stack.enter_context(patch.object(https.shutil, "which", return_value="/usr/sbin/ip"))
        self.stack.enter_context(patch.object(https.http.client, "HTTPSConnection", side_effect=AssertionError("external HTTPS forbidden")))
        self.http = self.stack.enter_context(patch.object(https, "https_get", side_effect=self.public_http))
        response = Mock(status=308)
        response.getheader.side_effect = lambda name: {"Location": https.ORIGIN + "/"}.get(name)
        self.redirect = Mock()
        self.redirect.getresponse.return_value = response
        self.stack.enter_context(patch.object(https.http.client, "HTTPConnection", return_value=self.redirect))
        approved = copy.deepcopy(self.fixture.data)
        directory = "/run/kinetra-local-activation-" + "7" * 32
        remote = {"schema": 1, "result": "APPLICATION_LOCAL_ACCEPTED_ONLY", "error": None,
                  "approved_input_sha256": https.canonical(approved), "commit": approved["commit"],
                  "images": approved["images"], "start": accepted, "activation_outcome": "ACCEPTED_OBSERVED",
                  "guest_temp_cleanup": "REMOVED", "remote_directory": directory}
        local_outer = {"schema": 1, "result": "APPLICATION_LOCAL_ACCEPTED_ONLY", "server_id": https.SERVER_ID,
                       "public_ipv4": https.PUBLIC_IP, "host_key_fingerprint": fixtures.start.stage.PINNED_FINGERPRINT,
                       "server_status": "on", "ssh_key_id": 123, "remote_directory": directory,
                       "guest_key_cleanup": "API_DELETE_CONFIRMED", "account_key_cleanup": "API_DELETE_CONFIRMED",
                       "local_key_cleanup": "REMOVED", "guest_temp_cleanup": "REMOVED", "activation": remote,
                       "activation_outcome": "ACCEPTED_OBSERVED", "error": None,
                       "approved_input_sha256": https.canonical(approved), "provenance_sha256": "a" * 64,
                       "caddy_started": False, "database_policy_changed": False, "provider_requests": 0,
                       "full_launch_accepted": False}
        self.data = {"schema": 1, "server_id": https.SERVER_ID, "public_ipv4": https.PUBLIC_IP,
                     "approved": approved, "local_outer": local_outer, "local_outer_sha256": https.canonical(local_outer),
                     "local_checkpoint_sha256": https.sha256((self.stage / "evidence/application-start-result.json").read_bytes())}

    def host_command(self, arguments, **options):
        self.calls.append(list(arguments))
        if arguments == ["/usr/sbin/ip", "-4", "-o", "address", "show"]:
            return "2: eth0 inet " + https.PUBLIC_IP + "/24 scope global eth0\n"
        if arguments == [str(https.CADDY_BINARY), "version"]:
            return "v2.11.4 offline fixture\n"
        if arguments[:3] == ["/usr/bin/unshare", "--net", "--"]:
            return ""
        if arguments == ["/usr/bin/systemctl", "start", "--job-mode=fail", "caddy.service"]:
            self.active, self.invocation = True, INVOCATION
            return ""
        if arguments == ["/usr/bin/systemctl", "stop", "caddy.service"]:
            self.active = False
            return ""
        raise AssertionError("unreviewed offline host command")

    def caddy_identity(self, *, inactive):
        if inactive and self.active:
            raise https.Error("CADDY_MUST_BE_INACTIVE_DISABLED")
        return {"ActiveState": "active" if self.active else "inactive", "SubState": "running" if self.active else "dead",
                "MainPID": "1234" if self.active else "0", "InvocationID": self.invocation}

    @staticmethod
    def public_http(path):
        return (*fixtures.LocalActivationTests.http(path), dict(CERTIFICATE))

    def run_main(self, data=None):
        path = self.fixture.root / "https-input.json"
        self.fixture.json_write(path, self.data if data is None else data)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = https.main(["--activate-prepared-https", "--private-input", str(path)])
        return code, json.loads(output.getvalue())

    def mutations(self):
        return [args for args in self.calls if args[:2] in (["/usr/bin/systemctl", "start"], ["/usr/bin/systemctl", "stop"])]

    def test_success_accepts_https_but_persists_only_checkpoint_and_starts_only_caddy(self):
        code, state = self.run_main()
        self.assertEqual((code, state["result"]), (0, "HTTPS_ACCEPTED_ONLY"))
        self.assertEqual(self.mutations(), [["/usr/bin/systemctl", "start", "--job-mode=fail", "caddy.service"]])
        self.assertEqual(state["owned_invocation"], INVOCATION)
        self.assertEqual(state["https"]["http"], self.data["local_outer"]["activation"]["start"]["local_http"])
        self.assertEqual(state["provider_requests"], 0)
        self.assertFalse(state["database_policy_changed"])
        self.assertFalse(state["boot_enabled"])
        self.assertFalse(state["full_launch_accepted"])
        self.assertIn("EXTERNAL_BROWSER_ACCEPTANCE", state["remaining"])
        self.assertEqual(self.fixture.stopped, [])
        self.assertEqual(self.fixture.containers[fixtures.PG]["restart"], "no")
        record = json.loads((self.stage / "evidence/https-start-result.json").read_text())
        self.assertEqual(record["result"], "CHECKPOINT_ONLY")
        self.assertEqual(record["checkpoint_kind"], "HTTPS_OBSERVATIONS_NOT_A_LAUNCH_HANDOFF")
        self.assertTrue(record["requires_matching_outer_success"])
        self.redirect.request.assert_called_once_with("GET", "/", headers={"Host": https.PUBLIC_IP, "Connection": "close"})

    def test_missing_outer_refuses_before_any_command(self):
        data = copy.deepcopy(self.data)
        del data["local_outer"]
        code, state = self.run_main(data)
        self.assertEqual(code, 1)
        self.assertFalse(state["attempt_recorded"])
        self.assertEqual(self.calls, [])

    def test_changed_outer_and_failed_cleanup_refuse_even_with_recomputed_outer_hash(self):
        changes = (("server_id", 123), ("guest_key_cleanup", "FAILED"), ("account_key_cleanup", "FAILED"),
                   ("local_key_cleanup", "FAILED"), ("guest_temp_cleanup", "FAILED"),
                   ("approved_input_sha256", "b" * 64), ("full_launch_accepted", True))
        for key, value in changes:
            with self.subTest(key=key):
                data = copy.deepcopy(self.data)
                data["local_outer"][key] = value
                data["local_outer_sha256"] = https.canonical(data["local_outer"])
                code, state = self.run_main(data)
                self.assertEqual(code, 1)
                self.assertFalse(state["attempt_recorded"])
                self.assertEqual(self.calls, [])

    def test_invalid_inner_guest_result_refuses_before_start(self):
        data = copy.deepcopy(self.data)
        data["local_outer"]["activation"]["start"]["uncertain_start_services"] = ["backend"]
        data["local_outer_sha256"] = https.canonical(data["local_outer"])
        code, state = self.run_main(data)
        self.assertEqual(code, 1)
        self.assertFalse(state["attempt_recorded"])
        self.assertEqual(self.calls, [])

    def test_changed_checkpoint_refuses_even_when_its_supplied_hash_is_updated(self):
        path = self.stage / "evidence/application-start-result.json"
        record = json.loads(path.read_text())
        record["owned_containers"]["backend"] = "1" * 64
        self.fixture.json_write(path, record)
        self.data["local_checkpoint_sha256"] = https.sha256(path.read_bytes())
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "MATCHING_SUCCESSFUL_LOCAL_CHECKPOINT_REQUIRED"))
        self.assertEqual(self.calls, [])

    def test_missing_checkpoint_refuses_without_start(self):
        (self.stage / "evidence/application-start-result.json").unlink()
        code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertFalse(state["start_attempted"])
        self.assertEqual(self.calls, [])

    def test_existing_attempt_is_preserved_without_retry(self):
        sentinel = self.stage / "evidence/https-start-attempt.json"
        self.fixture.write(sentinel, b"previous HTTPS attempt retained\n")
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "EXISTING_HTTPS_ATTEMPT_PRESERVED"))
        self.assertEqual(sentinel.read_bytes(), b"previous HTTPS attempt retained\n")
        self.assertEqual(self.calls, [])

    def test_already_active_caddy_is_preserved_without_start_or_stop(self):
        self.active = True
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "CADDY_MUST_BE_INACTIVE_DISABLED"))
        self.assertFalse(state["attempt_recorded"])
        self.assertEqual(self.mutations(), [])
        self.assertTrue(self.active)

    def test_caddy_configuration_drift_refuses_before_start(self):
        self.identity.side_effect = https.Error("PREPARED_CADDY_IDENTITY_CHANGED")
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "PREPARED_CADDY_IDENTITY_CHANGED"))
        self.assertFalse(state["attempt_recorded"])
        self.assertEqual(self.mutations(), [])

    def test_failed_http_stops_only_the_same_owned_caddy_invocation(self):
        self.http.side_effect = https.Error("HTTPS_BODY_TOO_LARGE")
        code, state = self.run_main()
        self.assertEqual((code, state["rollback"]), (1, "OWNED_CADDY_STOPPED"))
        self.assertEqual([args[1] for args in self.mutations()], ["start", "stop"])
        self.assertFalse(self.active)
        self.assertEqual(self.fixture.stopped, [])

    def test_timeout_before_invocation_capture_never_stops_observed_caddy(self):
        def uncertain_start(arguments, **options):
            result = self.host_command(arguments, **options)
            if arguments[:2] == ["/usr/bin/systemctl", "start"]:
                raise https.Error("CHILD_DEADLINE_EXCEEDED_PARTIAL_STATE")
            return result
        with patch.object(https, "command", side_effect=uncertain_start):
            code, state = self.run_main()
        self.assertEqual((code, state["rollback"]), (1, "UNKNOWN_RECONCILE"))
        self.assertIsNone(state["owned_invocation"])
        self.assertEqual([args[1] for args in self.mutations()], ["start"])
        self.assertTrue(self.active)

    def test_changed_invocation_during_http_failure_is_not_stopped(self):
        def changed_invocation(_path):
            self.invocation = "6" * 32
            raise https.Error("HTTPS_BODY_TOO_LARGE")
        self.http.side_effect = changed_invocation
        code, state = self.run_main()
        self.assertEqual((code, state["rollback"]), (1, "UNKNOWN_RECONCILE"))
        self.assertEqual(state["owned_invocation"], INVOCATION)
        self.assertEqual([args[1] for args in self.mutations()], ["start"])
        self.assertTrue(self.active)

    def test_durable_result_write_failure_stops_owned_caddy(self):
        original = https.write_new
        def fail_result(path, raw, **options):
            if path.name == "https-start-result.json":
                raise OSError("offline result disk fixture")
            return original(path, raw, **options)
        with patch.object(https, "write_new", side_effect=fail_result):
            code, state = self.run_main()
        self.assertEqual((code, state["error"], state["rollback"]), (1, "HTTPS_RESULT_NOT_DURABLE", "OWNED_CADDY_STOPPED"))
        self.assertEqual([args[1] for args in self.mutations()], ["start", "stop"])

    def test_fsync_failure_leaves_only_checkpoint_and_stops_owned_caddy(self):
        original = https.sync_directory
        def fail_after_write(path):
            if (self.stage / "evidence/https-start-result.json").exists():
                raise OSError("offline fsync fixture")
            return original(path)
        with patch.object(https, "sync_directory", side_effect=fail_after_write):
            code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "HTTPS_RESULT_NOT_DURABLE"))
        self.assertEqual(state["rollback"], "OWNED_CADDY_STOPPED")
        record = json.loads((self.stage / "evidence/https-start-result.json").read_text())
        self.assertEqual(record["result"], "CHECKPOINT_ONLY")
        self.assertTrue(record["requires_matching_outer_success"])


class ApplicationIdentityTests(unittest.TestCase):
    def setUp(self):
        self.flow = HttpsActivationTests()
        self.flow.setUp()
        self.addCleanup(self.flow.doCleanups)
        self.data = self.flow.data
        self.handoff = https.read_handoff(self.data)
        self.containers = self.flow.fixture.containers
        self.containers[fixtures.PG].update(
            id=fixtures.PG, image=fixtures.IMAGES["POSTGRES_IMAGE"], image_id="sha256:" + "5" * 64,
            project=https.PROJECT, service="postgres", readonly=True, ports={},
            mounts=[{"Destination": "/var/lib/postgresql/data", "Type": "volume", "Name": https.PROJECT + "_postgres17_data", "RW": True}])
        self.networks = {
            fixtures.DB_NETWORK: {"Id": fixtures.DB_NETWORK, "Name": https.PROJECT + "_database", "Driver": "bridge", "Internal": True,
                                  "Labels": {"com.docker.compose.project": https.PROJECT}, "Containers": {fixtures.PG: {}, fixtures.BACKEND: {}}},
            fixtures.NETWORK: {"Id": fixtures.NETWORK, "Name": https.PROJECT + "_backend", "Driver": "bridge", "Internal": False,
                              "EnableIPv6": False, "Labels": {"com.docker.compose.project": https.PROJECT},
                              "Containers": {fixtures.BACKEND: {}, fixtures.FRONTEND: {}}},
        }
        self.volume = {"Driver": "local", "Options": {"type": "none", "o": "bind", "device": str(self.flow.stage / "postgres/data")},
                       "Labels": {"com.docker.compose.project": https.PROJECT}}
        self.flow.stack.enter_context(patch.object(https, "command", side_effect=self.host_read))

    def host_read(self, arguments, **options):
        if arguments == ["/usr/bin/docker", "container", "ls", "--all", "--quiet", "--no-trunc"]:
            return "\n".join(self.containers) + "\n"
        if arguments[:3] == ["/usr/bin/docker", "network", "inspect"]:
            return json.dumps(self.networks[arguments[-1]])
        if arguments[:3] == ["/usr/bin/docker", "volume", "inspect"]:
            return json.dumps(self.volume)
        if arguments[:3] == ["/usr/bin/docker", "image", "inspect"]:
            return ("sha256:" + "5" * 64 if arguments[-2] == "{{.Id}}" else fixtures.COMMIT) + "\n"
        raise AssertionError("unreviewed offline host command")

    def test_three_owned_healthy_containers_with_isolated_networks_pass(self):
        result = CHECK_APPLICATION(self.data, self.handoff)
        self.assertEqual(result["id"], fixtures.PG)
        self.assertEqual(result["restart"], "no")
        self.assertEqual(self.flow.fixture.stopped, [])

    def test_changed_container_id_database_image_network_member_and_public_port_fail(self):
        cases = ("container_id", "database_image", "private_member", "public_port", "volume_path")
        for case in cases:
            with self.subTest(case=case):
                containers, networks, volume = copy.deepcopy((self.containers, self.networks, self.volume))
                if case == "container_id":
                    self.containers[fixtures.BACKEND]["id"] = "1" * 64
                elif case == "database_image":
                    self.containers[fixtures.PG]["image_id"] = "sha256:" + "1" * 64
                elif case == "private_member":
                    self.networks[fixtures.DB_NETWORK]["Containers"]["1" * 64] = {}
                elif case == "public_port":
                    self.containers[fixtures.FRONTEND]["ports"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
                else:
                    self.volume["Options"]["device"] = "/srv/another-project/data"
                with self.assertRaises((https.Error, fixtures.start.Error)):
                    CHECK_APPLICATION(self.data, self.handoff)
                self.containers.clear()
                self.containers.update(containers)
                self.networks, self.volume = networks, volume
                self.assertEqual(self.flow.fixture.stopped, [])

    def test_staged_source_and_api_environment_drift_fail_before_any_inspection(self):
        for relative in ("source/deploy/compose.production.yml", "env/api.env"):
            with self.subTest(path=relative):
                path = self.flow.stage / relative
                previous = path.read_bytes()
                path.write_bytes(previous + b"# offline drift\n")
                with patch.object(https, "command", side_effect=AssertionError("inspection after drift forbidden")) as host:
                    with self.assertRaises(fixtures.start.Error):
                        CHECK_APPLICATION(self.data, self.handoff)
                    host.assert_not_called()
                path.write_bytes(previous)


class TrustedTlsTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(https, "command", side_effect=AssertionError("host command forbidden")))
        self.stack.enter_context(patch.object(https.http.client, "HTTPConnection", side_effect=AssertionError("external HTTP forbidden")))
        self.connection = Mock()
        self.factory = self.stack.enter_context(patch.object(https.http.client, "HTTPSConnection", return_value=self.connection))

    def test_environment_cannot_disable_trust_or_enable_tls_key_logging(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": "/nonexistent/untrusted.pem", "SSL_CERT_DIR": "/nonexistent",
                                     "SSLKEYLOGFILE": "/nonexistent/should-not-write", "PYTHONHTTPSVERIFY": "0"}):
            context = https.tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreaterEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertIsNone(context.keylog_filename)
        self.assertGreater(context.cert_store_stats()["x509_ca"], 0)
        self.factory.assert_not_called()

    def test_certificate_verification_failure_is_not_retried(self):
        with patch.object(https, "https_get", side_effect=ssl.SSLCertVerificationError("offline trust fixture")) as get, \
             patch.object(https.time, "sleep") as sleep:
            with self.assertRaisesRegex(https.Error, "HTTPS_CERTIFICATE_TRUST_REJECTED"):
                https.wait_for_certificate(seconds=5)
        get.assert_called_once_with("/")
        sleep.assert_not_called()

    def test_transport_readiness_is_bounded_and_retries_only_transport_errors(self):
        result = (*fixtures.LocalActivationTests.http("/"), dict(CERTIFICATE))
        with patch.object(https, "https_get", side_effect=[ConnectionRefusedError(), result]) as get, \
             patch.object(https.time, "monotonic", side_effect=[0, 0, 1]), patch.object(https.time, "sleep") as sleep:
            self.assertEqual(https.wait_for_certificate(seconds=5), result)
        self.assertEqual(get.call_count, 2)
        sleep.assert_called_once_with(2)
        with patch.object(https, "https_get", side_effect=ConnectionRefusedError()), \
             patch.object(https.time, "monotonic", side_effect=[0, 0, 6]), patch.object(https.time, "sleep"):
            with self.assertRaisesRegex(https.Error, "HTTPS_CERTIFICATE_READINESS_DEADLINE"):
                https.wait_for_certificate(seconds=5)

    def test_only_allowlisted_initial_handshake_alerts_are_retryable(self):
        result = (*fixtures.LocalActivationTests.http("/"), dict(CERTIFICATE))
        for reason in ("TLSV1_ALERT_INTERNAL_ERROR", "SSLV3_ALERT_HANDSHAKE_FAILURE", "UNEXPECTED_EOF_WHILE_READING"):
            error = ssl.SSLError("offline pending ACME fixture")
            error.reason = reason
            with self.subTest(reason=reason), patch.object(https, "https_get", side_effect=[error, result]) as get, \
                 patch.object(https.time, "monotonic", side_effect=[0, 0, 1]), patch.object(https.time, "sleep"):
                self.assertEqual(https.wait_for_certificate(seconds=5), result)
                self.assertEqual(get.call_count, 2)

    def test_http_assertion_and_unexpected_tls_errors_are_not_retried(self):
        protocol_error = ssl.SSLError("offline unexpected TLS fixture")
        protocol_error.reason = "WRONG_VERSION_NUMBER"
        for failure in (https.Error("HTTPS_BODY_TOO_LARGE"), protocol_error):
            with self.subTest(error=type(failure).__name__), patch.object(https, "https_get", side_effect=failure) as get, \
                 patch.object(https.time, "sleep") as sleep:
                with self.assertRaises(https.Error):
                    https.wait_for_certificate(seconds=5)
                get.assert_called_once_with("/")
                sleep.assert_not_called()

    def test_unsafe_http_paths_are_rejected_before_connection(self):
        for path in ("//other.invalid/a", "https://other.invalid/", "/\r\nInjected: yes"):
            with self.subTest(path=path), self.assertRaisesRegex(https.Error, "HTTPS_PATH_INVALID"):
                https.https_get(path)
        self.factory.assert_not_called()

    def test_fixed_ip_certificate_and_validity_are_required_before_http_request(self):
        valid = {"subjectAltName": (("IP Address", https.PUBLIC_IP),),
                 "notBefore": "Jan  1 00:00:00 2026 GMT", "notAfter": "Jan  1 00:00:00 2030 GMT"}
        for certificate, category in (({**valid, "subjectAltName": (("IP Address", "127.0.0.1"),)}, "EXPECTED_IP_CERTIFICATE_REQUIRED"),
                                      ({**valid, "notAfter": "Jan  1 00:00:00 2026 GMT"}, "CURRENT_TRUSTED_CERTIFICATE_REQUIRED")):
            with self.subTest(category=category):
                self.connection.sock.getpeercert.side_effect = lambda binary_form=False: b"offline cert" if binary_form else certificate
                with patch.object(https.time, "time", return_value=1_800_000_000), self.assertRaisesRegex(https.Error, category):
                    https.https_get("/")
                self.connection.request.assert_not_called()
        self.assertEqual(self.factory.call_args.args, (https.PUBLIC_IP, 443))
        context = self.factory.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)


class CaddyIdentityTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(https, "command", side_effect=AssertionError("host command forbidden")))
        self.properties = {
            "LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "UnitFileState": "disabled",
            "FragmentPath": str(https.CADDY_UNIT), "DropInPaths": "", "NeedDaemonReload": "no", "User": "caddy", "Group": "caddy",
            "Type": "notify", "NoNewPrivileges": "yes", "ProtectSystem": "strict", "EnvironmentFiles": "",
            "ExecCondition": "", "ExecStartPre": "", "ExecStartPost": "", "ExecStop": "", "ExecStopPost": "",
            "Environment": "PUBLIC_IPV4=" + https.PUBLIC_IP + " HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy/data XDG_CONFIG_HOME=/var/lib/caddy/config",
            "ExecStart": "{ path=/usr/local/bin/caddy ; argv[]=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile ; ignore_errors=no ; }",
            "ExecReload": "{ path=/usr/local/bin/caddy ; argv[]=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile ; ignore_errors=no ; }",
            "MainPID": "0", "InvocationID": "", "Job": "",
        }
        self.unit = self.stack.enter_context(patch.object(https, "unit_properties", side_effect=lambda: dict(self.properties)))
        self.bodies = {https.CADDY_BINARY: b"offline binary", https.CADDY_CONFIG: b"offline configuration", https.CADDY_UNIT: b"offline unit"}
        self.read = self.stack.enter_context(patch.object(https, "private_read", side_effect=lambda path, **kwargs: self.bodies[path]))
        for key, path in (("CADDY_BINARY_SHA256", https.CADDY_BINARY), ("CADDY_CONFIG_SHA256", https.CADDY_CONFIG), ("CADDY_UNIT_SHA256", https.CADDY_UNIT)):
            self.stack.enter_context(patch.object(https, key, https.sha256(self.bodies[path])))
        account = types.SimpleNamespace(pw_uid=123, pw_gid=123, pw_dir="/var/lib/caddy", pw_shell="/usr/sbin/nologin")
        self.stack.enter_context(patch.object(https.pwd, "getpwnam", return_value=account))
        self.stack.enter_context(patch.object(Path, "stat", return_value=types.SimpleNamespace(st_gid=123, st_uid=123)))

    def test_exact_prepared_inactive_identity_is_accepted(self):
        self.assertEqual(https.check_caddy_identity(inactive=True), self.properties)
        self.assertEqual(self.read.call_count, 3)
        self.assertEqual([entry.kwargs["mode"] for entry in self.read.call_args_list], [0o755, 0o640, 0o644])

    def test_binary_configuration_and_unit_drift_each_reject(self):
        for path in self.bodies:
            with self.subTest(path=str(path)):
                previous = self.bodies[path]
                self.bodies[path] += b" drift"
                with self.assertRaisesRegex(https.Error, "PREPARED_CADDY_IDENTITY_CHANGED"):
                    https.check_caddy_identity(inactive=True)
                self.bodies[path] = previous

    def test_effective_dropins_reload_environment_and_extra_commands_are_rejected(self):
        changes = (("DropInPaths", "/run/systemd/system/caddy.service.d/override.conf"), ("NeedDaemonReload", "yes"),
                   ("EnvironmentFiles", "/tmp/unreviewed.env"), ("ExecStartPre", "/bin/sh"), ("ExecStopPost", "/bin/sh"),
                   ("User", "root"), ("UnitFileState", "enabled"), ("Type", "simple"),
                   ("Environment", self.properties["Environment"] + " UNREVIEWED=1"),
                   ("ExecStart", self.properties["ExecStart"].replace("caddy run", "caddy run --resume")),
                   ("ExecReload", self.properties["ExecReload"].replace("caddy reload", "caddy reload --force")))
        for key, value in changes:
            with self.subTest(key=key):
                previous = self.properties[key]
                self.properties[key] = value
                with self.assertRaises(https.Error):
                    https.check_caddy_identity(inactive=True)
                self.properties[key] = previous

    def test_queued_job_and_active_state_refuse_inactive_precondition(self):
        for key, value in (("ActiveState", "active"), ("SubState", "start"), ("MainPID", "1234"), ("Job", "1")):
            with self.subTest(key=key):
                previous = self.properties[key]
                self.properties[key] = value
                with self.assertRaisesRegex(https.Error, "CADDY_MUST_BE_INACTIVE_DISABLED"):
                    https.check_caddy_identity(inactive=True)
                self.properties[key] = previous

    def test_active_process_executable_must_match_prepared_binary(self):
        self.properties.update(ActiveState="active", SubState="running", MainPID="1234", InvocationID=INVOCATION)
        with patch.object(Path, "resolve", return_value=Path("/usr/bin/another-process")):
            with self.assertRaisesRegex(https.Error, "CADDY_PROCESS_IDENTITY_CHANGED"):
                https.check_caddy_identity(inactive=False)


class PublicBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        paths = ("/", "/assets/index-123.js", "/assets/index-123.css", "/health", "/ready", "/api/v1/me")
        self.replies = {path: list((*fixtures.LocalActivationTests.http(path), dict(CERTIFICATE))) for path in paths}
        self.expected = {path: {"status": reply[0], "sha256": https.sha256(reply[2])} for path, reply in self.replies.items()}
        self.stack.enter_context(patch.object(https, "command", side_effect=AssertionError("host command forbidden")))
        self.stack.enter_context(patch.object(https, "wait_for_certificate", side_effect=lambda: self.replies["/"]))
        self.stack.enter_context(patch.object(https, "https_get", side_effect=lambda path: self.replies[path]))
        self.stack.enter_context(patch.object(https.http.client, "HTTPSConnection", side_effect=AssertionError("external HTTPS forbidden")))
        self.response = Mock(status=308)
        self.headers = {"Location": https.ORIGIN + "/"}
        self.response.getheader.side_effect = self.headers.get
        self.connection = Mock()
        self.connection.getresponse.return_value = self.response
        self.stack.enter_context(patch.object(https.http.client, "HTTPConnection", return_value=self.connection))

    def test_public_boundaries_require_auth_401_private_ready_404_and_matching_assets(self):
        for path, replacement in (("/api/v1/me", 200), ("/ready", 200), ("/health", 503), ("/assets/index-123.js", 404)):
            with self.subTest(path=path):
                previous = self.replies[path][0]
                self.replies[path][0] = replacement
                with self.assertRaisesRegex(https.Error, "HTTPS_API_OR_ASSET_BOUNDARY_FAILED"):
                    https.public_acceptance(self.expected)
                self.replies[path][0] = previous

    def test_cross_origin_redirect_cannot_be_accepted_or_followed(self):
        self.headers["Location"] = "https://other.invalid/"
        with self.assertRaisesRegex(https.Error, "HTTPS_REDIRECT_REQUIRED"):
            https.public_acceptance(self.expected)
        self.connection.request.assert_called_once_with("GET", "/", headers={"Host": https.PUBLIC_IP, "Connection": "close"})

    def test_changed_script_content_fails_even_when_path_and_status_match(self):
        self.replies["/assets/index-123.js"][2] = b"changed frontend script"
        with self.assertRaisesRegex(https.Error, "HTTPS_LOCAL_APPLICATION_MISMATCH"):
            https.public_acceptance(self.expected)

    def test_missing_csp_or_auth_cache_header_fails(self):
        del self.replies["/"][1]["content-security-policy"]
        with self.assertRaisesRegex(https.Error, "HTTPS_CSP_REJECTED"):
            https.public_acceptance(self.expected)
        self.replies["/"][1] = fixtures.LocalActivationTests.http("/")[1]
        self.replies["/api/v1/me"][1]["cache-control"] = "public"
        with self.assertRaisesRegex(https.Error, "HTTPS_API_NO_STORE_REQUIRED"):
            https.public_acceptance(self.expected)


if __name__ == "__main__":
    unittest.main()
