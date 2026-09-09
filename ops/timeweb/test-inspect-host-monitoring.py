#!/usr/bin/env python3
"""Offline fixtures: no cloud, SSH, package, service, or real config IO."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitoring", Path(__file__).with_name("inspect-host-monitoring.py"))
monitoring = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitoring)
guest = {"__name__": "offline_contracts"}
exec(compile(monitoring.GUEST_PROGRAM, "<monitoring-guest>", "exec"), guest)


def result_fixture():
    return {"schema": 1, "result": "PASS_READ_ONLY_INSPECTION", "error": None,
        "listeners": [{"address": "0.0.0.0", "port": 10050, "pids": [777]}],
        "processes": [{"pid": 777, "name": "zabbix_agentd", "executable": "/usr/sbin/zabbix_agentd",
            "package": "zabbix-agent", "service": "zabbix-agent.service", "service_state": {
                "Id": "zabbix-agent.service", "LoadState": "loaded", "ActiveState": "active", "SubState": "running"},
            "status": "IDENTIFIED"}], "configs": [],
        "config_scope": "DEFAULT_ZABBIX_AGENT_PATHS_NOT_COMMAND_LINE_VERIFIED", "mutations": False}


class MonitoringDataTests(unittest.TestCase):
    def test_exact_port_pid_association(self):
        listeners, pids = guest["socket_evidence"]('LISTEN 0 128 0.0.0.0:10050 0.0.0.0:* users:(("zabbix_agentd",pid=777,fd=4))')
        self.assertEqual(pids, [777])
        self.assertEqual(listeners, [{"address": "0.0.0.0", "port": 10050, "pids": [777]}])
        with self.assertRaisesRegex(ValueError, "PORT_MISMATCH"):
            guest["socket_evidence"]('LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=777,fd=4))')

    def test_owner_must_be_identified_from_socket(self):
        with self.assertRaisesRegex(ValueError, "PROCESS_UNCONFIRMED"):
            guest["socket_evidence"]("LISTEN 0 128 [::]:10050 [::]:*")

    def test_process_reads_only_comm_executable_cgroup_and_service_state(self):
        reads, commands = [], []
        def read(path, *_args):
            reads.append(path)
            return "zabbix_agentd\n" if path.endswith("/comm") else "0::/system.slice/zabbix-agent.service\n"
        def command(args, **_kwargs):
            commands.append(args)
            if args[0].endswith("dpkg-query"):
                return "zabbix-agent: /usr/sbin/zabbix_agentd\n"
            return "Id=zabbix-agent.service\nLoadState=loaded\nActiveState=active\nSubState=running\n"
        with patch.dict(guest, {"read_small": read, "command": command}), \
             patch.object(guest["os"], "readlink", return_value="/usr/sbin/zabbix_agentd"):
            result = guest["process_evidence"](777)
        self.assertEqual(result["package"], "zabbix-agent")
        self.assertEqual(result["service"], "zabbix-agent.service")
        self.assertEqual(reads, ["/proc/777/comm", "/proc/777/cgroup"])
        self.assertFalse(any("cmdline" in str(args) or "Environment" in str(args) for args in commands))

    def test_address_normalization_preserves_active_clusters(self):
        self.assertEqual(guest["configuration_value"]("Server", "192.0.2.13/24,MONITOR.EXAMPLE.,2001:db8::1"),
            ["192.0.2.0/24", "monitor.example", "2001:db8::1"])
        self.assertEqual(guest["configuration_value"]("ServerActive", "monitor.example:10051;[2001:db8::1]:10052"),
            [[{"host": "monitor.example", "port": 10051}, {"host": "2001:db8::1", "port": 10052}]])

    def test_rejects_secret_and_traversal_include_paths(self):
        for path in ("/etc/zabbix/agent.psk", "/etc/zabbix/zabbix_agentd.d/private.conf",
            "/etc/zabbix/zabbix_agentd.d/tls.conf", "/etc/zabbix/zabbix_agentd.d/../secrets.conf",
            "/root/secret.conf", "/etc/zabbix/zabbix_agentd.d/*"):
            with self.subTest(path=path):
                self.assertFalse(guest["approved_config_path"](path, pattern=True))

    def test_config_reader_ignores_tls_keys_and_does_not_open_secret_includes(self):
        reads = []
        def read(path, *_args):
            reads.append(str(path))
            return None, "\n".join([
                "Server=192.0.2.1", "ListenPort=10050", "TLSPSKFile=/etc/zabbix/agent.psk",
                "TLSPSKIdentity=NEVER-EMIT-THIS", "Include=/etc/zabbix/zabbix_agentd.d/private.conf",
                "UserParameter=key,NEVER-EMIT-COMMAND", "Hostname=NEVER-EMIT-ARBITRARY-NAME",
            ])
        with patch.dict(guest, {"read_configuration_file": read}):
            results = guest["configuration_evidence"](["/etc/zabbix/zabbix_agentd.conf"])
        self.assertEqual(reads, ["/etc/zabbix/zabbix_agentd.conf"])
        self.assertEqual(results[0]["values"], {"Server": ["192.0.2.1"], "ListenPort": 10050})
        self.assertNotIn("NEVER-EMIT", json.dumps(results))
        self.assertNotIn("agent.psk", json.dumps(results))
        self.assertIn("INCLUDE_OUTSIDE_APPROVED_CONFIG_PATHS", results[0]["issues"])

    def test_duplicate_includes_do_not_expand_queue_or_output(self):
        reads = []
        def read(path):
            reads.append(str(path))
            content = "Include=/etc/zabbix/zabbix_agentd.d/common.conf\n" * 100 if str(path).endswith("zabbix_agentd.conf") else "ListenPort=10050\n"
            return None, content
        with patch.dict(guest, {"read_configuration_file": read}), \
             patch.object(guest["pathlib"].Path, "is_symlink", return_value=False), \
             patch.object(guest["glob"], "iglob", return_value=iter(["/etc/zabbix/zabbix_agentd.d/common.conf"])):
            results = guest["configuration_evidence"](["/etc/zabbix/zabbix_agentd.conf"])
        self.assertEqual(len(reads), 2)
        self.assertEqual(results[0]["includes"], ["/etc/zabbix/zabbix_agentd.d/common.conf"])

    def test_configuration_open_refuses_symlink_without_reading_contents(self):
        import errno
        with patch.object(guest["os"], "open", side_effect=OSError(errno.ELOOP, "loop")) as opened, \
             patch.object(guest["os"], "fdopen") as read:
            status, contents = guest["read_configuration_file"](Path("/etc/zabbix/zabbix_agentd.conf"))
        self.assertEqual(status, "SYMLINK_OR_NON_DIRECTORY_REFUSED")
        self.assertIsNone(contents)
        self.assertFalse(read.called)
        self.assertTrue(opened.call_args.args[1] & guest["os"].O_NOFOLLOW)

    def test_output_validator_rejects_process_commands_and_wrong_pid(self):
        fixture = result_fixture()
        monitoring.validate_result(json.dumps(fixture))
        fixture["processes"][0]["cmdline"] = "secret"
        with self.assertRaises(monitoring.Error):
            monitoring.validate_result(json.dumps(fixture))
        fixture = result_fixture()
        fixture["processes"][0]["pid"] = 778
        with self.assertRaises(monitoring.Error):
            monitoring.validate_result(json.dumps(fixture))

    def test_output_validator_rejects_unapproved_config_keys(self):
        fixture = result_fixture()
        fixture["configs"] = [{"path": "/etc/zabbix/zabbix_agentd.conf", "status": "READ_APPROVED_KEYS_ONLY",
            "values": {"TLSPSKFile": "/root/secret"}, "includes": [], "issues": []}]
        with self.assertRaises(monitoring.Error):
            monitoring.validate_result(json.dumps(fixture))


class FakeApi:
    instances = []
    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id, self.key_post_attempted, self.server_verified = None, False, False
        self.calls = []
        self.__class__.instances.append(self)
    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if method == "GET":
            return {"server": {"id": monitoring.inspection.SERVER_ID, "name": monitoring.inspection.SERVER_NAME,
                "status": "on", "networks": [{"type": "public", "ips": [{"type": "ipv4", "is_main": True,
                    "ip": monitoring.inspection.PUBLIC_IPV4}]}]}}
        if method == "POST" and path == "/ssh-keys":
            self.key_post_attempted = True
            return {"ssh_key": {"id": 800002, **payload}}
        return {}


class MonitoringTransportTests(unittest.TestCase):
    def run_inspection(self, fingerprint=monitoring.PINNED_FINGERPRINT, code=0):
        FakeApi.instances = []
        with tempfile.TemporaryDirectory() as directory:
            environ = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": monitoring.inspection.REPOSITORY,
                "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000000", "RUNNER_TEMP": directory,
                "TIMEWEB_CLOUD_TOKEN": "offline-fake-token"}
            output = io.StringIO()
            with patch.object(monitoring.inspection, "pin_host_key", return_value=(Path(directory) / "known_hosts", fingerprint)), \
                 patch.object(monitoring.inspection, "prepare_key", return_value=(Path(directory) / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")), \
                 patch.object(monitoring.inspection, "wait_for_key"), \
                 patch.object(monitoring.inspection, "run_bounded", return_value=(code, json.dumps(result_fixture()).encode(), b"")) as remote, \
                 patch.object(monitoring.resource, "setrlimit"), contextlib.redirect_stdout(output):
                result = monitoring.main(["--inspect-existing-host-monitoring"], environ, FakeApi)
            self.assertNotIn("offline-fake-token", output.getvalue())
            state = json.loads(output.getvalue().splitlines()[-1].split("=", 1)[1])
            return result, state, remote

    def test_readonly_success_cleans_exact_key(self):
        result, state, remote = self.run_inspection()
        self.assertEqual(result, 0)
        self.assertEqual(remote.call_count, 1)
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        self.assertEqual([(m, p) for m, p, _ in FakeApi.instances[0].calls if m == "DELETE"],
            [("DELETE", "/servers/9069403/ssh-keys/800002"), ("DELETE", "/ssh-keys/800002")])

    def test_pin_mismatch_prevents_key_or_ssh(self):
        result, state, remote = self.run_inspection(fingerprint="SHA256:wrong")
        self.assertEqual(result, 1)
        self.assertEqual(state["error"], "PINNED_HOST_KEY_MISMATCH")
        self.assertFalse(remote.called)
        self.assertEqual([method for method, _, _ in FakeApi.instances[0].calls], ["GET"])

    def test_remote_failure_still_cleans_key(self):
        result, state, remote = self.run_inspection(code=1)
        self.assertEqual(result, 1)
        self.assertEqual(remote.call_count, 1)
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
