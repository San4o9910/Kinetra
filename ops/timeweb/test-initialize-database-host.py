#!/usr/bin/env python3
"""Offline contract tests; never call Docker, SSH, APIs or a database."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("initialize", Path(__file__).with_name("initialize-database-host.py"))
initialize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(initialize)
stage = initialize.stage
inspection = initialize.inspection
guest = {"__name__": "offline_initialization_tests"}
exec(compile(initialize.GUEST_INITIALIZE, "<guest-initialize>", "exec"), guest)
COMMIT = "a" * 40
CID = "c" * 64
NETWORK_ID = "b" * 64
IMAGES = {
    "NODE_IMAGE": "node:22-alpine3.24@sha256:" + "1" * 64,
    "NGINX_IMAGE": "nginxinc/nginx-unprivileged:1.30.4-alpine-slim@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64,
    "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64,
}
TIMEWEB_SECRET = "offline-timeweb-secret"
REGISTRY_SECRET = "offline-registry-secret"


def payload():
    body = b"reviewed source fixture\n"
    return {"commit": COMMIT, "images": dict(IMAGES),
        "files": {name: {"sha256": hashlib.sha256(body).hexdigest(), "base64": base64.b64encode(body).decode()} for name in stage.SOURCE_PATHS},
        "migrations": {name: "d" * 64 for name in initialize.MIGRATIONS}}


def successful_initialization():
    return {"schema": 1, "result": "DATABASE_INITIALIZED_ONLY", "stage": "INITIALIZATION_COMPLETE", "error": None,
        "commit": COMMIT, "postgres_id": CID, "database_initialized": True, "application_started": False,
        "migrations": 13, "content_seed": True, "runtime_grants": True, "readonly_acceptance": True}


def inspected_guest():
    return {"schema": 1, "cloud_init": "PASS", "bootstrap_marker": True,
        "password_auth_disabled": True, "keyboard_interactive_disabled": True, "root_login_key_only": True,
        "os_id": "ubuntu", "os_version": "24.04", "cpu_count": 2, "ram_bytes": 4 * 1024**3,
        "root_total_bytes": 50 * 1024**3, "root_free_bytes": 45 * 1024**3, "docker_available": True,
        "selected_listener_ports": [22], "listeners_verified": True}


class FakeApi:
    instances = []
    wrong_key_identity = False
    fail_delete = False

    def __init__(self, token, server_id, deadline):
        self.token, self.server_id, self.deadline = token, server_id, deadline
        self.key_id, self.server_verified, self.key_post_attempted = None, False, False
        self.calls = []
        self.__class__.instances.append(self)

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET":
            return {"server": {"id": inspection.SERVER_ID, "name": inspection.SERVER_NAME, "status": "on",
                "networks": [{"type": "public", "ips": [{"type": "ipv4", "is_main": True, "ip": inspection.PUBLIC_IPV4}]}]}}
        if method == "POST" and path == "/ssh-keys":
            self.key_post_attempted = True
            result = {"id": 800003, **body}
            if self.wrong_key_identity: result.update(id=999999, name="unrelated-key")
            return {"ssh_key": result}
        if method == "DELETE" and self.fail_delete: raise initialize.Error("API_CONNECTION_FAILED")
        return {}


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        FakeApi.instances = []
        FakeApi.wrong_key_identity = FakeApi.fail_delete = False
        self.environ = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000001", "RUNNER_TEMP": self.temporary.name,
            "TIMEWEB_CLOUD_TOKEN": TIMEWEB_SECRET, "GITHUB_TOKEN": REGISTRY_SECRET,
            "APPROVED_APP_COMMIT": COMMIT, "APP_CHECKOUT": self.temporary.name, **IMAGES}

    def run_initialization(self, *, fingerprint=stage.PINNED_FINGERPRINT, remote=None, inspected=None):
        output = io.StringIO()
        remote = (0, json.dumps(successful_initialization()).encode(), b"") if remote is None else remote
        inspected = inspected_guest() if inspected is None else inspected
        with patch.object(stage, "source_bundle", return_value=payload()["files"]), \
             patch.object(initialize, "migration_hashes", return_value=payload()["migrations"]), \
             patch.object(inspection, "pin_host_key", return_value=(Path(self.temporary.name) / "known_hosts", fingerprint)), \
             patch.object(inspection, "prepare_key", return_value=(Path(self.temporary.name) / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key"), \
             patch.object(inspection, "run_bounded", return_value=(0, json.dumps(inspected).encode(), b"")) as inspect, \
             patch.object(stage, "run_with_input", return_value=remote) as ssh, \
             patch.object(initialize.resource, "setrlimit"), contextlib.redirect_stdout(output):
            code = initialize.main(["--initialize-new-empty-database"], self.environ, FakeApi)
        states = [json.loads(line.split("=", 1)[1]) for line in output.getvalue().splitlines()]
        self.assertNotIn(TIMEWEB_SECRET, output.getvalue())
        self.assertNotIn(REGISTRY_SECRET, output.getvalue())
        return code, states[-1], key, inspect, ssh

    def test_only_initialization_payload_crosses_stdin_and_key_is_cleaned(self):
        code, state, _, _, ssh = self.run_initialization()
        self.assertEqual(code, 0)
        self.assertEqual(state["result"], "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED")
        self.assertFalse(state["initialization"]["application_started"])
        self.assertEqual(state["application_readiness"], "BLOCKED_MISSING_PROVIDER_INPUTS")
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        api = FakeApi.instances[0]
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"], [
            ("DELETE", "/servers/9069403/ssh-keys/800003"), ("DELETE", "/ssh-keys/800003")])
        arguments, wire, _ = ssh.call_args.args
        self.assertEqual(set(json.loads(wire)), {"commit", "images", "files", "migrations"})
        self.assertNotIn(REGISTRY_SECRET.encode(), wire)
        self.assertNotIn(TIMEWEB_SECRET.encode(), wire)
        self.assertNotIn(TIMEWEB_SECRET, " ".join(arguments))
        self.assertNotIn("TIMEWEB_CLOUD_TOKEN", self.environ)
        self.assertNotIn("GITHUB_TOKEN", self.environ)
        self.assertEqual(api.token, "")

    def test_wrong_pin_prevents_key_creation_and_remote_mutation(self):
        code, state, key, inspect, ssh = self.run_initialization(fingerprint="SHA256:wrong")
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "PINNED_HOST_KEY_MISMATCH")
        self.assertFalse(key.called or inspect.called or ssh.called)

    def test_unverified_key_is_never_deleted(self):
        FakeApi.wrong_key_identity = True
        code, state, _, _, ssh = self.run_initialization()
        self.assertEqual(code, 1)
        self.assertEqual(state["account_key_cleanup"], "UNVERIFIED_KEY_RECONCILE")
        self.assertFalse(ssh.called)
        self.assertFalse(any(m == "DELETE" for m, _, _ in FakeApi.instances[0].calls))

    def test_failed_partial_initialization_is_not_retried(self):
        result = successful_initialization()
        result.update(result="FAIL", stage="MIGRATIONS", error="INITIALIZATION_JOB_FAILED_DATA_PRESERVED", migrations=0,
            content_seed=False, runtime_grants=False, readonly_acceptance=False)
        code, state, _, _, ssh = self.run_initialization(remote=(1, json.dumps(result).encode(), b""))
        self.assertEqual(code, 1)
        self.assertEqual(ssh.call_count, 1)
        self.assertTrue(state["initialization"]["database_initialized"])
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_wrong_remote_commit_and_cleanup_failure_each_prevent_success(self):
        result = successful_initialization()
        result["commit"] = "f" * 40
        code, state, *_ = self.run_initialization(remote=(0, json.dumps(result).encode(), b""))
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "REMOTE_SOURCE_COMMIT_MISMATCH")

    def test_missing_mandatory_readonly_evidence_cannot_be_green(self):
        result = successful_initialization()
        result["readonly_acceptance"] = False
        code, state, *_ = self.run_initialization(remote=(0, json.dumps(result).encode(), b""))
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "REMOTE_PASS_EVIDENCE_INCOMPLETE")

    def test_key_cleanup_failure_is_not_green(self):
        FakeApi.fail_delete = True
        code, state, *_ = self.run_initialization()
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "KEY_CLEANUP_REQUIRES_RECONCILIATION")

    def test_new_application_listener_blocks_initialization(self):
        inspected = inspected_guest()
        inspected["selected_listener_ports"] = [22, 443]
        code, _, _, _, ssh = self.run_initialization(inspected=inspected)
        self.assertEqual(code, 1)
        self.assertFalse(ssh.called)


class GuestContracts(unittest.TestCase):
    def test_guest_compiles_without_running_a_remote_operation(self):
        self.assertIsNotNone(guest["validate_existing_stage"])
        guest["validate_input"](payload())

    def test_payload_rejects_secret_extra_source_image_scope_and_missing_migration(self):
        for mutate in (
            lambda d: d.update(registry_token=REGISTRY_SECRET),
            lambda d: d["images"].update(BACKEND_IMAGE="ghcr.io/other/app@sha256:" + "3" * 64),
            lambda d: d["files"].update({"../other": d["files"][stage.SOURCE_PATHS[0]]}),
            lambda d: d["migrations"].pop(initialize.MIGRATIONS[-1]),
            lambda d: d["files"][stage.SOURCE_PATHS[0]].update(base64=base64.b64encode(b"tampered").decode()),
        ):
            data = payload()
            mutate(data)
            with self.assertRaises(guest["Error"]): guest["validate_input"](data)

    def test_compose_clears_environment_and_does_not_enable_other_services(self):
        with patch.dict(guest, {"command": lambda args, **kwargs: args}):
            args = guest["compose"](["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "postgres"])
        self.assertEqual(args[:2], ["/usr/bin/env", "-i"])
        self.assertEqual(args[-7:], ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "postgres"])
        self.assertNotIn("backend", args)
        self.assertNotIn("frontend", args)

    def test_job_timeout_removes_only_verified_owned_container_and_anonymous_volumes(self):
        commands = []
        def command(args, **kwargs):
            commands.append(args)
            if args[1] == "wait": raise guest["Error"]("CHILD_COMMAND_TIMEOUT")
            return ""
        with patch.dict(guest, {"compose": lambda *a, **kw: CID,
            "owned_job_identity": lambda *a: CID, "command": command}):
            with self.assertRaisesRegex(guest["Error"], "CHILD_COMMAND_TIMEOUT"):
                guest["run_job"]([], IMAGES["BACKEND_IMAGE"])
        self.assertEqual(commands[-1], ["/usr/bin/docker", "rm", "--force", "--volumes", CID])

    def test_unverified_job_is_never_removed(self):
        commands = []
        def identity(*args): raise guest["Error"]("INITIALIZATION_JOB_IDENTITY_MISMATCH")
        with patch.dict(guest, {"compose": lambda *a, **kw: CID, "owned_job_identity": identity,
            "command": lambda args, **kw: commands.append(args)}):
            with self.assertRaisesRegex(guest["Error"], "INITIALIZATION_JOB_IDENTITY_MISMATCH"):
                guest["run_job"]([], IMAGES["BACKEND_IMAGE"])
        self.assertEqual(commands, [])

    def test_uncertain_create_reconciles_only_exact_name_nonce_and_image(self):
        commands = []
        def create(*args, **kwargs): raise guest["Error"]("CHILD_COMMAND_TIMEOUT")
        with patch.dict(guest, {"compose": create, "owned_job_identity": lambda *a: CID,
            "command": lambda args, **kw: commands.append(args)}):
            with self.assertRaisesRegex(guest["Error"], "CHILD_COMMAND_TIMEOUT"):
                guest["run_job"]([], IMAGES["BACKEND_IMAGE"])
        self.assertEqual(commands, [["/usr/bin/docker", "rm", "--force", "--volumes", CID]])

    def test_final_isolation_uses_full_ids_and_refuses_public_database_port(self):
        commands = []
        def command(args, **kwargs):
            commands.append(args)
            if args[1:3] == ["container", "ls"]: return CID + "\n"
            if args[1] == "port": return "5432/tcp -> 0.0.0.0:5432\n"
            self.fail("Unexpected additional Docker command")
        with patch.dict(guest, {"command": command}):
            with self.assertRaisesRegex(guest["Error"], "POSTGRES_PORT_PUBLICATION_REFUSED"):
                guest["final_isolation"](CID, IMAGES["POSTGRES_IMAGE"], NETWORK_ID)
        self.assertIn("--no-trunc", commands[0])

    def test_readonly_result_rejects_extra_fields_error_data_and_bool_migration_count(self):
        for key, value in (("migrations", True), ("application_started", True), ("error", "postgres://secret"),
            ("unreviewed", True), ("schema", True)):
            data = successful_initialization()
            data[key] = value
            with self.assertRaises(initialize.Error):
                initialize.validate_initialization_result(json.dumps(data))

    def test_generated_grants_javascript_parses_real_sql_and_keeps_transaction(self):
        captured = []
        with patch.dict(guest, {"run_job": lambda args, *a, **kw: captured.append(args) or "KINETRA_INITIALIZATION_JOB=PASS"}):
            guest["runtime_grants"](IMAGES["BACKEND_IMAGE"])
        program = captured[0][-1]
        body = program[len(guest["NODE_PREAMBLE"]):-len(guest["NODE_END"])]
        repository = Path(os.environ.get("APP_CHECKOUT", str(Path(__file__).resolve().parents[2])))
        sql_path = repository / "deploy/postgres/runtime-grants.sql"
        self.assertTrue(sql_path.is_file(), "Set APP_CHECKOUT to the approved application checkout for the real grants-parser fixture")
        sql = sql_path.read_text()
        # Run only the extracted parser body with an in-memory fake pg client.
        # No pg import, no network, no real database or Docker subprocess.
        fixture = "import assert from 'node:assert/strict';\nconst rawFixture = " + json.dumps(sql) + ";\n"
        fixture += "const readFileSync = () => rawFixture;\nlet executed;\n"
        fixture += "const client = {query: async sql => {if(sql === 'SELECT current_user AS role') return {rows:[{role:'kinetra_migrate'}]}; executed=sql; return {};}};\n"
        fixture += body + "\nassert.ok(executed.includes('BEGIN;')); assert.ok(executed.includes('COMMIT;')); assert.equal(executed.includes('\\\\set'), false);\n"
        result = subprocess.run(["node", "--input-type=module", "-e", fixture], capture_output=True, text=True, timeout=10, env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_migration_hashes_reject_additional_sql_before_reading_blobs(self):
        expected = ["apps/backend/migrations/" + name for name in initialize.MIGRATIONS]
        with patch.object(inspection, "run_bounded", return_value=(0, ("\n".join(expected + ["apps/backend/migrations/014_extra.sql"]) + "\n").encode(), b"")) as run:
            with self.assertRaisesRegex(initialize.Error, "EXACT_MIGRATION_SET_REQUIRED"):
                initialize.migration_hashes("/checkout", COMMIT)
        self.assertEqual(run.call_count, 1)



class StagedFilesystemContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "stage"
        self.root.mkdir(mode=0o700)
        self.data = payload()
        self.evidence = {"schema": 1, "result": "STAGED_ONLY", "stage": "STAGING_COMPLETE", "error": None,
            "commit": COMMIT, "observed_peer": "172.19.0.1", "network_id": NETWORK_ID,
            "registry_config_cleanup": "REMOVED", "database_initialized": False, "application_started": False,
            "images": IMAGES, "source_hashes": {name: item["sha256"] for name, item in self.data["files"].items()}}
        for name, item in self.data["files"].items():
            self.write("source/" + name, base64.b64decode(item["base64"]), 0o644)
        self.write("evidence/stage.json", json.dumps(self.evidence).encode())
        main = {key: IMAGES[key] for key in ("NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE")}
        main.update(VCS_REF=COMMIT, VITE_API_URL="https://80.68.156.131", VITE_PRIVATE_MEDIA_ORIGIN="",
            KINETRA_API_ENV_FILE=str(self.root / "env/api.env"), KINETRA_VIDEO_SCRATCH_DIR="")
        single = {"POSTGRES_IMAGE": IMAGES["POSTGRES_IMAGE"], "KINETRA_POSTGRES_DATA_DIR": str(self.root / "postgres/data"),
            "KINETRA_POSTGRES_CA_FILE": str(self.root / "tls/issued/public/ca.crt"),
            "KINETRA_POSTGRES_CERT_FILE": str(self.root / "tls/issued/public/server.crt"),
            "KINETRA_POSTGRES_KEY_FILE": str(self.root / "tls/issued/server-private/server.key"),
            "KINETRA_POSTGRES_SECRETS_DIR": str(self.root / "postgres/secrets"), "KINETRA_EDGE_CONFIG_DIR": str(self.root / "edge")}
        for name, mapping in (("production", main), ("single-server", single)):
            self.write("env/" + name + ".env", "".join(key + "=" + value + "\n" for key, value in mapping.items()).encode())
        self.write("env/api.env", b"NODE_ENV=production\n")
        self.write("edge/nginx-real-ip.conf", b"set_real_ip_from 172.19.0.1/32;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n", 0o644)
        (self.root / "postgres/data").mkdir(parents=True, mode=0o700)
        # Ownership is modeled below so this offline fixture also runs without
        # host-root privileges. File contents, modes and empty-directory checks
        # use real temporary files.
        self.commands = []

    def write(self, name, content, mode=0o600):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)

    def validate(self):
        def command(args, **kwargs):
            self.commands.append(args)
            if args[1:4] == ["network", "ls", "--format"]:
                return "bridge\nhost\nnone\n" + guest["NETWORK"] + "\n"
            if args[1:3] == ["image", "inspect"]:
                return COMMIT if "revision" in " ".join(args) else "sha256:" + "8" * 64
            return ""
        original_lstat = Path.lstat
        def lstat(path):
            values = list(original_lstat(path))
            values[4] = 999 if path == self.root / "postgres/data" else 0
            return os.stat_result(values)
        with patch.dict(guest, {"STAGE": self.root, "safe_parent": lambda path: None, "command": command}), \
             patch.dict(guest["shared"], {"validate_network": lambda network: None, "validate_stage": lambda image: None}), \
             patch.object(Path, "lstat", lstat), patch.object(os, "geteuid", return_value=0):
            return guest["validate_existing_stage"](self.data)

    def test_exact_empty_stage_is_accepted_without_starting_containers(self):
        self.assertEqual(self.validate()["commit"], COMMIT)
        self.assertFalse(any("up" in args or "run" in args for args in self.commands))

    def test_existing_data_is_preserved_and_rejected_before_image_or_compose_call(self):
        sentinel = self.root / "postgres/data/keep-existing-data"
        sentinel.write_bytes(b"preserve")
        with self.assertRaisesRegex(guest["Error"], "EXISTING_OR_PARTIAL_DATABASE_PRESERVED"):
            self.validate()
        self.assertEqual(sentinel.read_bytes(), b"preserve")
        self.assertFalse(any(args[1:3] == ["image", "inspect"] for args in self.commands))

    def test_attempt_marker_prevents_reinitialization_even_when_data_is_empty(self):
        self.write("evidence/initialization-attempt.json", b"preserved attempt\n")
        with self.assertRaisesRegex(guest["Error"], "EXISTING_INITIALIZATION_EVIDENCE_PRESERVED"):
            self.validate()
        self.assertEqual((self.root / "evidence/initialization-attempt.json").read_bytes(), b"preserved attempt\n")

    def test_changed_staged_source_refuses_before_any_docker_call(self):
        self.write("source/" + stage.SOURCE_PATHS[0], b"tampered", 0o644)
        with self.assertRaisesRegex(guest["Error"], "STAGED_SOURCE_HASH_MISMATCH"):
            self.validate()
        self.assertEqual(self.commands, [])

    def test_populated_api_environment_refuses_database_only_scope(self):
        self.write("env/api.env", b"NODE_ENV=production\nDATABASE_URL=unexpected\n")
        with self.assertRaisesRegex(guest["Error"], "API_MUST_REMAIN_EXPLICITLY_INCOMPLETE"):
            self.validate()
        self.assertEqual(self.commands, [])


if __name__ == "__main__":
    unittest.main()
