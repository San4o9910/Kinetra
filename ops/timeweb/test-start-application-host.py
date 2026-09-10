#!/usr/bin/env python3
"""Offline private fixtures only. Every Docker/systemctl/HTTP boundary is mocked."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("start_application", Path(__file__).with_name("start-application-host.py"))
start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(start)
COMMIT = "a" * 40
PG, BACKEND, FRONTEND = "b" * 64, "c" * 64, "d" * 64
NETWORK, DB_NETWORK = "e" * 64, "f" * 64
IMAGES = {
    "NODE_IMAGE": "node@sha256:" + "1" * 64,
    "NGINX_IMAGE": "nginxinc/nginx-unprivileged@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64,
    "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64,
}


class LocalActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir(mode=0o700)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(start, "STAGE", self.stage))
        self.stack.enter_context(patch.object(start.preparation, "STAGE", self.stage))
        self.stack.enter_context(patch.object(start, "LOCK", self.root / "lock"))
        self.stack.enter_context(patch.object(start.resource, "setrlimit"))
        self.stack.enter_context(patch.object(start.os, "umask"))
        def fixture_parent(path):
            path = Path(path)
            if not path.is_dir() or path.resolve() != path or self.root not in (path, *path.parents):
                raise start.Error("UNSAFE_FIXTURE_PARENT")
        self.stack.enter_context(patch.object(start, "safe_parent", fixture_parent))
        self.stack.enter_context(patch.object(start.preparation, "safe_parent", fixture_parent))
        self.stack.enter_context(patch.dict(start.preparation.shared, {"safe_parent": fixture_parent}))
        self.command = self.stack.enter_context(patch.object(start, "command", side_effect=AssertionError("offline host command forbidden")))
        self.stack.enter_context(patch.object(start.preparation, "command", side_effect=AssertionError("offline preparation command forbidden")))
        self.stack.enter_context(patch.dict(start.preparation.shared, {"command": Mock(side_effect=AssertionError("offline container command forbidden"))}))
        self.stack.enter_context(patch.dict(start.preparation.helpers, {"command": Mock(side_effect=AssertionError("offline database command forbidden"))}))
        self.stack.enter_context(patch.object(start.http.client, "HTTPConnection", side_effect=AssertionError("offline HTTP forbidden")))
        self.write(self.root / "lock", b"")
        self.data = {"schema": 1, "server_id": 9069403, "public_ipv4": "80.68.156.131", "commit": COMMIT, "images": dict(IMAGES),
                     "source_hashes": {}, "migration_hashes": {name: "6" * 64 for name in start.initialization.MIGRATIONS},
                     "handoff_hashes": {}, "configuration_hashes": {}}
        self.fixture_handoff()

    def write(self, path, value, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(value)
        path.chmod(mode)

    def json_write(self, path, value):
        self.write(path, (json.dumps(value) + "\n").encode())

    def fixture_handoff(self):
        for name in start.stage.SOURCE_PATHS:
            raw = (name + "\n").encode()
            self.write(self.stage / "source" / name, raw, 0o644)
            self.data["source_hashes"][name] = start.sha256(raw)
        main = {key: IMAGES[key] for key in ("NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE")}
        main.update(VCS_REF=COMMIT, VITE_API_URL="https://80.68.156.131", VITE_PRIVATE_MEDIA_ORIGIN="",
                    KINETRA_API_ENV_FILE=str(self.stage / "env/api.env"), KINETRA_VIDEO_SCRATCH_DIR="")
        self.write(self.stage / "env/production.env", start.preparation.env_bytes(main))
        self.write(self.stage / "env/single-server.env", b"POSTGRES_IMAGE=" + IMAGES["POSTGRES_IMAGE"].encode() + b"\n")
        api = b"NODE_ENV=production\nCHAT_ENABLED=false\nCHAT_PHOTO_UPLOADS_ENABLED=false\nTRAINER_VIDEO_UPLOADS_ENABLED=false\n"
        self.write(self.stage / "env/api.env", api)
        self.write(self.stage / "env/jobs/migrate.env", b"NODE_ENV=production\n")
        self.write(self.stage / "edge/nginx-real-ip.conf", b"set_real_ip_from 172.19.0.1/32;\n", 0o644)
        self.folder = "api-preparation-" + "7" * 32
        self.write(self.stage / "env" / self.folder / "api.env", api)
        previous = b"NODE_ENV=production\n"
        self.write(self.stage / "env" / self.folder / "previous-api.env", previous)
        staged = {"schema": 1, "result": "STAGED_ONLY", "stage": "STAGING_COMPLETE", "error": None, "commit": COMMIT,
                  "observed_peer": "172.19.0.1", "network_id": NETWORK, "registry_config_cleanup": "REMOVED",
                  "database_initialized": False, "application_started": False, "images": dict(IMAGES), "source_hashes": self.data["source_hashes"]}
        initialized = {"schema": 1, "result": "DATABASE_INITIALIZED_ONLY", "stage": "INITIALIZATION_COMPLETE", "error": None,
                       "commit": COMMIT, "postgres_id": PG, "database_initialized": True, "application_started": False,
                       "migrations": 13, "content_seed": True, "runtime_grants": True, "readonly_acceptance": True,
                       "images": dict(IMAGES), "migration_hashes": self.data["migration_hashes"]}
        prepared = {"schema": 1, "result": "API_ENVIRONMENT_PREPARED_ONLY", "phase": "API_ENVIRONMENT_PREPARATION_COMPLETE", "error": None,
                    "api_environment_installed": True, "application_started": False, "caddy_started": False, "provider_requests": 0,
                    "candidate_directory": self.folder, "commit": COMMIT, "images": dict(IMAGES), "source_hashes": self.data["source_hashes"],
                    "migration_hashes": self.data["migration_hashes"], "api_sha256": start.sha256(api)}
        attempt = {"schema": 1, "commit": COMMIT, "images": dict(IMAGES), "previous_api_sha256": start.sha256(previous), "candidate_directory": self.folder}
        for name, record in zip(start.EVIDENCE_FILES, (staged, initialized, attempt, prepared)):
            self.json_write(self.stage / "evidence" / name, record)
        self.refresh_hashes()

    def refresh_hashes(self):
        self.data["handoff_hashes"] = {name: start.sha256((self.stage / "evidence" / name).read_bytes()) for name in start.EVIDENCE_FILES}
        self.data["configuration_hashes"] = {name: start.sha256((self.stage / name).read_bytes()) for name in start.CONFIG_FILES}

    def run_main(self, data=None):
        path = self.root / "input.json"
        self.json_write(path, self.data if data is None else data)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = start.main(["--start-validated-local-application", "--private-input", str(path)])
        return code, json.loads(output.getvalue())

    def fake_runtime(self):
        self.containers = {PG: {"networks": {start.PROJECT + "_database": {"NetworkID": DB_NETWORK}}, "running": True, "health": "healthy", "restart": "no"}}
        self.stopped = []
        def inspect(identifier): return copy.deepcopy(self.containers[identifier])
        def command(arguments, **options):
            if arguments[1:3] == ["image", "inspect"]: return "sha256:" + arguments[-1].split("sha256:")[1] + "\n"
            if arguments[1:3] == ["container", "ls"]: return "\n".join(self.containers) + "\n"
            if arguments[1] == "start":
                self.containers[arguments[-1]]["running"] = True
                self.containers[arguments[-1]]["status"] = "running"
                return arguments[-1] + "\n"
            if arguments[1] == "stop":
                identifier = arguments[-1]
                self.stopped.append(identifier)
                self.containers[identifier]["running"] = False
                return identifier + "\n"
            if arguments[0] == "/usr/bin/systemctl": return "inactive\n" if "--property=ActiveState" in arguments else "disabled\n"
            if arguments[0] == "/usr/bin/ss": return "LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*\n"
            if arguments[1] == "exec" and arguments[-2:] == ["nginx", "-t"]: return ""
            raise AssertionError("unreviewed offline command")
        self.command.side_effect = command
        def create(arguments, override, **options):
            if arguments == ["config", "--quiet"]: return ""
            service = arguments[-1]
            if arguments[:-1] != ["up", "--no-start", "--no-deps", "--no-build", "--pull", "never"]: raise AssertionError("wrong Compose mutation")
            nonce = json.loads(override.read_text())["services"][service]["labels"][start.SERVICE_LABEL]
            identifier = BACKEND if service == "backend" else FRONTEND
            networks = {start.PROJECT + "_backend": {"NetworkID": NETWORK}}
            if service == "backend": networks[start.PROJECT + "_database"] = {"NetworkID": DB_NETWORK}
            mount = (str(self.stage / "tls/issued/public/ca.crt"), "/run/kinetra/postgres-ca.crt") if service == "backend" else (str(self.stage / "edge"), "/etc/nginx/kinetra-edge")
            self.containers[identifier] = {"id": identifier, "project": start.PROJECT, "service": service, "nonce": nonce,
                "image": IMAGES[service.upper() + "_IMAGE"], "image_id": "sha256:" + IMAGES[service.upper() + "_IMAGE"].split("sha256:")[1],
                "user": "1000:1000" if service == "backend" else "101:101", "readonly": True, "cap_drop": ["ALL"], "cap_add": None,
                "security": ["no-new-privileges:true"], "restart": "unless-stopped", "networks": networks,
                "ports": {} if service == "backend" else {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
                "mounts": [{"Type": "bind", "Source": mount[0], "Destination": mount[1], "RW": False}], "running": False,
                "health": "healthy" if service == "backend" else None, "status": "created"}
        def ids(service, nonce):
            return [key for key, value in self.containers.items() if value.get("service") == service and value.get("nonce") == nonce]
        self.stack.enter_context(patch.object(start.preparation, "check_live_identity"))
        self.stack.enter_context(patch.object(start.preparation, "validate_candidate"))
        self.stack.enter_context(patch.object(start, "database_readonly_handoff"))
        self.stack.enter_context(patch.object(start, "backend_ready"))
        self.stack.enter_context(patch.object(start, "wait_for_frontend_listener"))
        self.stack.enter_context(patch.object(start, "inspect_container", side_effect=inspect))
        self.stack.enter_context(patch.object(start, "candidate_ids", side_effect=ids))
        self.compose = self.stack.enter_context(patch.object(start, "compose", side_effect=create))
        self.create = create
        self.stack.enter_context(patch.object(start, "local_get", side_effect=self.http))

    @staticmethod
    def http(path):
        if path == "/":
            return 200, {"content-type": "text/html", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
                         "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}, b'<script src="/assets/index-123.js"></script><link rel="stylesheet" href="/assets/index-123.css">'
        if path.startswith("/assets/"): return 200, {"content-type": "text/css" if path.endswith("css") else "application/javascript"}, b"fixture asset"
        if path == "/health": return 200, {}, b'{"status":"ok"}'
        if path == "/ready": return 404, {}, b"not found"
        if path == "/api/v1/me": return 401, {"cache-control": "no-store"}, b'{"error":"authentication required"}'
        raise AssertionError("unreviewed HTTP path")

    def test_fixed_target_and_incomplete_hash_sets_reject_before_commands(self):
        for field, value in (("server_id", 123), ("public_ipv4", "127.0.0.1"), ("handoff_hashes", {})):
            with self.subTest(field=field):
                data = copy.deepcopy(self.data)
                data[field] = value
                code, state = self.run_main(data)
                self.assertEqual(code, 1)
                self.assertFalse(state["attempt_recorded"])
                self.command.assert_not_called()

    def test_missing_database_handoff_performs_no_host_command_or_start_mutation(self):
        (self.stage / "evidence/initialization.json").unlink()
        code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertFalse(state["attempt_recorded"])
        self.assertFalse((self.stage / "evidence/application-start-attempt.json").exists())
        self.command.assert_not_called()

    def test_skipped_readonly_initialization_or_unprepared_environment_rejects_even_with_matching_hash(self):
        for name, key, value in (("initialization.json", "readonly_acceptance", False), ("application-env.json", "result", "FAIL")):
            with self.subTest(name=name):
                self.fixture_handoff()
                path = self.stage / "evidence" / name
                record = json.loads(path.read_text())
                record[key] = value
                self.json_write(path, record)
                self.refresh_hashes()
                code, state = self.run_main()
                self.assertEqual(code, 1)
                self.assertFalse(state["attempt_recorded"])
                self.command.assert_not_called()

    def test_source_and_environment_drift_are_rejected_without_mutation(self):
        for path in (self.stage / "source/deploy/compose.production.yml", self.stage / "env/api.env"):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(original + b"# drift\n")
                code, state = self.run_main()
                self.assertEqual(code, 1)
                self.assertFalse(state["attempt_recorded"])
                self.command.assert_not_called()
                path.write_bytes(original)

    def test_existing_attempt_is_preserved_and_not_retried(self):
        sentinel = self.stage / "evidence/application-start-attempt.json"
        self.write(sentinel, b"previous attempt retained\n")
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "EXISTING_ACTIVATION_ATTEMPT_PRESERVED"))
        self.assertEqual(sentinel.read_bytes(), b"previous attempt retained\n")
        self.command.assert_not_called()

    def test_success_is_only_local_acceptance_without_https_or_database_policy_claim(self):
        self.fake_runtime()
        code, state = self.run_main()
        self.assertEqual((code, state["result"]), (0, "APPLICATION_LOCAL_ACCEPTED_ONLY"))
        self.assertEqual(state["attempted_services"], ["backend", "frontend"])
        self.assertFalse(state["caddy_started"])
        self.assertFalse(state["database_policy_changed"])
        self.assertIn("BROWSER_ACCEPTANCE", state["remaining"])
        self.assertEqual(self.containers[PG]["restart"], "no")
        self.assertEqual(self.stopped, [])
        self.assertEqual(set(state["local_http"]), {"/", "/assets/index-123.js", "/assets/index-123.css", "/health", "/ready", "/api/v1/me"})

    def test_compose_timeout_after_create_preserves_stopped_owned_container(self):
        self.fake_runtime()
        def create_then_timeout(arguments, override, **options):
            self.create(arguments, override, **options)
            if arguments[-1] == "backend": raise start.Error("CHILD_DEADLINE_EXCEEDED_PARTIAL_STATE")
        self.compose.side_effect = create_then_timeout
        code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(state["rollback"], {"backend": "CREATED_NOT_STARTED"})
        self.assertEqual(self.stopped, [])
        self.assertFalse(self.containers[BACKEND]["running"])
        self.assertTrue(self.containers[PG]["running"])
        self.assertNotIn(FRONTEND, self.containers)

    def test_http_failure_stops_owned_frontend_then_backend_without_deleting_containers(self):
        self.fake_runtime()
        with patch.object(start, "local_acceptance", side_effect=start.Error("LOCAL_CSP_REJECTED")):
            code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.stopped, [FRONTEND, BACKEND])
        self.assertEqual(set(self.containers), {PG, BACKEND, FRONTEND})
        self.assertEqual(state["rollback"], {"frontend": "STOPPED", "backend": "STOPPED"})

    def test_rollback_never_stops_changed_identity(self):
        self.fake_runtime()
        def fail_acceptance():
            self.containers[FRONTEND]["project"] = "another-project"
            raise start.Error("LOCAL_API_BOUNDARY_FAILED")
        with patch.object(start, "local_acceptance", side_effect=fail_acceptance): code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.stopped, [BACKEND])
        self.assertEqual(state["rollback"]["frontend"], "UNCONFIRMED_REQUIRES_REVIEW")
        self.assertTrue(self.containers[FRONTEND]["running"])

    def test_backend_health_timeout_is_bounded_and_truthful(self):
        with patch.object(start, "inspect_container", return_value={"status": "running", "running": True, "health": "starting"}), \
             patch.object(start.time, "monotonic", side_effect=[0, 0, 151]), patch.object(start.time, "sleep"):
            with self.assertRaisesRegex(start.Error, "BACKEND_HEALTH_DEADLINE"): start.wait_for_backend(BACKEND)

    def test_nondurable_result_is_failure_and_rolls_back_owned_services(self):
        self.fake_runtime()
        original_write = start.write_new
        def fail_result(path, value, **options):
            if path.name == "application-start-result.json": raise OSError("offline disk full fixture")
            return original_write(path, value, **options)
        with patch.object(start, "write_new", side_effect=fail_result): code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "ACTIVATION_RESULT_NOT_DURABLE"))
        self.assertEqual(self.stopped, [FRONTEND, BACKEND])

    def test_fsync_failure_after_result_write_cannot_leave_authoritative_acceptance(self):
        self.fake_runtime()
        original_sync = start.sync_directory
        def fail_after_write(path):
            if (self.stage / "evidence/application-start-result.json").exists(): raise OSError("offline fsync fixture")
            return original_sync(path)
        with patch.object(start, "sync_directory", side_effect=fail_after_write): code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "ACTIVATION_RESULT_NOT_DURABLE"))
        record = json.loads((self.stage / "evidence/application-start-result.json").read_text())
        self.assertEqual(record["result"], "CHECKPOINT_ONLY")
        self.assertTrue(record["requires_matching_outer_success"])
        self.assertEqual(self.stopped, [FRONTEND, BACKEND])

    def test_docker_start_timeout_reports_uncertainty_even_after_stop(self):
        self.fake_runtime()
        normal_command = self.command.side_effect
        def start_then_timeout(arguments, **options):
            result = normal_command(arguments, **options)
            if arguments[1] == "start": raise start.Error("CHILD_DEADLINE_EXCEEDED_PARTIAL_STATE")
            return result
        self.command.side_effect = start_then_timeout
        code, state = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(state["uncertain_start_services"], ["backend"])
        self.assertEqual(self.stopped, [BACKEND])
        self.assertEqual(state["rollback"]["backend"], "UNCONFIRMED_REQUIRES_REVIEW")

    def test_extra_writable_bind_and_unexpected_tmpfs_are_rejected(self):
        self.fake_runtime()
        code, state = self.run_main()
        self.assertEqual(code, 0)
        for extra in ({"Type": "bind", "Source": "/unreviewed", "Destination": "/unreviewed", "RW": True},
                      {"Type": "tmpfs", "Destination": "/var/run"}):
            with self.subTest(extra=extra):
                info = copy.deepcopy(self.containers[BACKEND])
                info["mounts"].append(extra)
                with self.assertRaisesRegex(start.Error, "APPLICATION_MOUNTS_MISMATCH"):
                    start.check_runtime(info, "backend", self.data, state["nonce"], NETWORK, DB_NETWORK)

    def test_listener_wait_retries_only_expected_transport_failures(self):
        first, second = Mock(), Mock()
        first.connect.side_effect = ConnectionRefusedError()
        with patch.object(start.http.client, "HTTPConnection", side_effect=[first, second]), \
             patch.object(start.time, "monotonic", side_effect=[0, 0, 1]), patch.object(start.time, "sleep"):
            start.wait_for_frontend_listener()
        first.close.assert_called_once()
        second.close.assert_called_once()
        bad = Mock()
        bad.connect.side_effect = PermissionError("fixture")
        with patch.object(start.http.client, "HTTPConnection", return_value=bad):
            with self.assertRaises(PermissionError): start.wait_for_frontend_listener()

    def test_local_acceptance_rejects_external_assets_and_missing_api_no_store(self):
        def external(path):
            status, headers, body = self.http(path)
            return status, headers, body.replace(b"/assets/index-123.js", b"https://foreign.invalid/tracker.js")
        with patch.object(start, "local_get", side_effect=external):
            with self.assertRaisesRegex(start.Error, "UNREVIEWED_ASSET_ORIGIN"): start.local_acceptance()
        def uncached(path):
            status, headers, body = self.http(path)
            return status, {} if path == "/api/v1/me" else headers, body
        with patch.object(start, "local_get", side_effect=uncached):
            with self.assertRaisesRegex(start.Error, "API_NO_STORE_REQUIRED"): start.local_acceptance()

    def test_readonly_ledger_uses_existing_pg_container_without_jobs_or_credentials(self):
        self.command.side_effect = None
        self.command.return_value = json.dumps({"version": 170010, "migrations": self.data["migration_hashes"]})
        start.database_readonly_handoff(PG, self.data["migration_hashes"])
        arguments = self.command.call_args.args[0]
        self.assertEqual(arguments[:5], ["/usr/bin/docker", "exec", "--user", "999:999", PG])
        self.assertIn("BEGIN READ ONLY;", arguments[-1])
        self.assertIn("statement_timeout='5s'", arguments[-1])
        self.assertIn("--no-psqlrc", arguments)
        self.assertNotIn("migrate", arguments)
        self.assertNotIn("run", arguments)
        self.command.return_value = json.dumps({"version": 170010, "migrations": {}})
        with self.assertRaisesRegex(start.Error, "READONLY_MIGRATION_HANDOFF_MISMATCH"):
            start.database_readonly_handoff(PG, self.data["migration_hashes"])

    def test_unexpected_public_listener_prevents_local_acceptance(self):
        self.fake_runtime()
        normal_command = self.command.side_effect
        def exposed(arguments, **options):
            if arguments[0] == "/usr/bin/ss": return "LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*\n"
            return normal_command(arguments, **options)
        self.command.side_effect = exposed
        code, state = self.run_main()
        self.assertEqual((code, state["error"]), (1, "UNEXPECTED_PUBLIC_APP_OR_DATABASE_LISTENER"))
        self.assertEqual(self.stopped, [FRONTEND, BACKEND])


if __name__ == "__main__":
    unittest.main()
