#!/usr/bin/env python3
"""Offline contracts only: no API, SSH, Docker, database or image gates."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("stage", Path(__file__).with_name("prepare-database-host.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
inspection = stage.inspection
guest = {"__name__": "offline_guest_contracts"}
exec(compile(stage.GUEST_PREPARE, "<guest-prepare>", "exec"), guest)

IMAGES = {
    "NODE_IMAGE": "docker.io/library/node:22-bookworm-slim@sha256:" + "1" * 64,
    "NGINX_IMAGE": "docker.io/nginxinc/nginx-unprivileged:1.30.4-alpine-slim@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64,
    "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64,
}
COMMIT = "a" * 40
REGISTRY_SECRET = "offline-registry-secret"
TIMEWEB_SECRET = "offline-timeweb-secret"


def payload():
    body = b"reviewed source fixture\n"
    return {"commit": COMMIT, "images": dict(IMAGES), "registry_token": REGISTRY_SECRET,
        "files": {name: {"sha256": hashlib.sha256(body).hexdigest(),
                         "base64": base64.b64encode(body).decode()} for name in stage.SOURCE_PATHS}}


def successful_stage():
    return {"schema": 1, "result": "STAGED_ONLY", "stage": "STAGING_COMPLETE", "error": None,
        "commit": COMMIT, "observed_peer": "172.19.0.1", "network_id": "b" * 64,
        "registry_config_cleanup": "REMOVED", "database_initialized": False, "application_started": False}


def inspected_guest():
    return {"schema": 1, "cloud_init": "PASS", "bootstrap_marker": True,
        "password_auth_disabled": True, "keyboard_interactive_disabled": True, "root_login_key_only": True,
        "os_id": "ubuntu", "os_version": "24.04", "cpu_count": 2, "ram_bytes": 4 * 1024**3,
        "root_total_bytes": 50 * 1024**3, "root_free_bytes": 45 * 1024**3, "docker_available": True,
        "selected_listener_ports": [22], "listeners_verified": True}


class FakeApi:
    instances = []
    fail_attach = False
    fail_delete = False
    wrong_key_identity = False

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
            result = {"id": 800002, **body}
            if self.wrong_key_identity: result.update(id=999999, name="unrelated-key")
            return {"ssh_key": result}
        if method == "POST" and self.fail_attach:
            raise stage.Error("API_CONNECTION_FAILED")
        if method == "DELETE" and self.fail_delete:
            raise stage.Error("API_CONNECTION_FAILED")
        return {}


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        FakeApi.instances = []
        FakeApi.fail_attach = FakeApi.fail_delete = FakeApi.wrong_key_identity = False
        self.environ = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": inspection.REPOSITORY,
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "34500000001", "RUNNER_TEMP": self.temporary.name,
            "TIMEWEB_CLOUD_TOKEN": TIMEWEB_SECRET, "GITHUB_TOKEN": REGISTRY_SECRET,
            "APPROVED_APP_COMMIT": COMMIT, "APP_CHECKOUT": self.temporary.name, **IMAGES}

    def run_stage(self, *, fingerprint=stage.PINNED_FINGERPRINT, remote=None, inspected=None):
        output = io.StringIO()
        remote = (0, json.dumps(successful_stage()).encode(), b"") if remote is None else remote
        inspected = inspected_guest() if inspected is None else inspected
        with patch.object(stage, "source_bundle", return_value=payload()["files"]), \
             patch.object(inspection, "pin_host_key", return_value=(Path(self.temporary.name) / "known_hosts", fingerprint)), \
             patch.object(inspection, "prepare_key", return_value=(Path(self.temporary.name) / "private", "ssh-ed25519 MOCK kinetra-inspect-ephemeral")) as key, \
             patch.object(inspection, "wait_for_key"), \
             patch.object(inspection, "run_bounded", return_value=(0, json.dumps(inspected).encode(), b"")) as inspect, \
             patch.object(stage, "run_with_input", return_value=remote) as ssh, \
             patch.object(stage.resource, "setrlimit"), contextlib.redirect_stdout(output):
            code = stage.main(["--stage-new-empty-database-host"], self.environ, FakeApi)
        states = [json.loads(line.split("=", 1)[1]) for line in output.getvalue().splitlines()]
        self.assertNotIn(TIMEWEB_SECRET, output.getvalue())
        self.assertNotIn(REGISTRY_SECRET, output.getvalue())
        return code, states[-1], key, inspect, ssh

    def test_success_only_stages_and_reconciles_ephemeral_keys(self):
        code, state, _, _, ssh = self.run_stage()
        self.assertEqual(code, 0)
        self.assertEqual(state["result"], "PASS_STAGING_ONLY_DATABASE_NOT_STARTED")
        self.assertFalse(state["staging"]["database_initialized"])
        self.assertFalse(state["staging"]["application_started"])
        self.assertEqual(state["local_key_cleanup"], "REMOVED")
        api = FakeApi.instances[0]
        self.assertEqual([(m, p) for m, p, _ in api.calls if m == "DELETE"], [
            ("DELETE", "/servers/9069403/ssh-keys/800002"), ("DELETE", "/ssh-keys/800002")])
        self.assertEqual(api.token, "")
        self.assertNotIn("TIMEWEB_CLOUD_TOKEN", self.environ)
        self.assertNotIn("GITHUB_TOKEN", self.environ)
        arguments, wire, _ = ssh.call_args.args
        self.assertNotIn(REGISTRY_SECRET, " ".join(arguments))
        self.assertNotIn(TIMEWEB_SECRET.encode(), wire)
        self.assertEqual(json.loads(wire)["registry_token"], REGISTRY_SECRET)

    def test_wrong_host_pin_blocks_key_creation_and_ssh(self):
        code, state, key, inspect, ssh = self.run_stage(fingerprint="SHA256:wrong")
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "PINNED_HOST_KEY_MISMATCH")
        self.assertFalse(key.called or inspect.called or ssh.called)
        self.assertEqual([m for m, _, _ in FakeApi.instances[0].calls], ["GET"])

    def test_wrong_server_is_refused_before_api(self):
        self.environ["ROOT_SUPPLIED_SERVER_ID"] = "12345"
        code, state, *_ = self.run_stage()
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        self.assertFalse(FakeApi.instances)

    def test_other_project_image_is_refused_before_api(self):
        self.environ["BACKEND_IMAGE"] = "ghcr.io/other/project@sha256:" + "3" * 64
        code, state, *_ = self.run_stage()
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "APPROVED_IMAGE_REFERENCE_INVALID")
        self.assertFalse(FakeApi.instances)


    def test_unverified_key_identity_never_authorizes_deletion(self):
        FakeApi.wrong_key_identity = True
        code, state, _, _, ssh = self.run_stage()
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "CREATED_KEY_IDENTITY_MISMATCH")
        self.assertEqual(state["account_key_cleanup"], "UNVERIFIED_KEY_RECONCILE")
        self.assertFalse(ssh.called)
        self.assertIsNone(FakeApi.instances[0].key_id)
        self.assertFalse(any(method == "DELETE" for method, _, _ in FakeApi.instances[0].calls))

    def test_unknown_attach_outcome_still_removes_only_created_key(self):
        FakeApi.fail_attach = True
        code, state, _, _, ssh = self.run_stage()
        self.assertEqual(code, 1)
        self.assertFalse(ssh.called)
        self.assertEqual(state["guest_key_cleanup"], "API_DELETE_CONFIRMED")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_existing_public_app_blocks_remote_mutation(self):
        inspected = inspected_guest()
        inspected["selected_listener_ports"] = [22, 443]
        code, _, _, _, ssh = self.run_stage(inspected=inspected)
        self.assertEqual(code, 1)
        self.assertFalse(ssh.called)

    def test_partial_stage_is_reported_without_retry(self):
        result = successful_stage()
        result.update(result="FAIL", stage="DATABASE_SECRETS_AND_TLS", error="CHILD_COMMAND_FAILED")
        code, state, _, _, ssh = self.run_stage(remote=(1, json.dumps(result).encode(), b""))
        self.assertEqual(code, 1)
        self.assertEqual(ssh.call_count, 1)
        self.assertEqual(state["staging"]["stage"], "DATABASE_SECRETS_AND_TLS")
        self.assertEqual(state["account_key_cleanup"], "API_DELETE_CONFIRMED")

    def test_key_cleanup_failure_prevents_success(self):
        FakeApi.fail_delete = True
        code, state, *_ = self.run_stage()
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "KEY_CLEANUP_REQUIRES_RECONCILIATION")

    def test_returned_wrong_commit_cannot_pass(self):
        result = successful_stage()
        result["commit"] = "c" * 40
        code, state, *_ = self.run_stage(remote=(0, json.dumps(result).encode(), b""))
        self.assertEqual(code, 1)
        self.assertEqual(state["error"], "REMOTE_SOURCE_COMMIT_MISMATCH")


class ContractTests(unittest.TestCase):
    def test_canonical_repo_digests_preserve_exact_reference_on_both_sides(self):
        references = {
            "NODE_IMAGE": ("node", "docker.io/library/node"),
            "NGINX_IMAGE": ("nginxinc/nginx-unprivileged", "docker.io/nginxinc/nginx-unprivileged"),
            "POSTGRES_IMAGE": ("postgres", "docker.io/library/postgres", "postgres:17.6-bookworm"),
        }
        for key, repositories in references.items():
            for repository in repositories:
                with self.subTest(image=repository):
                    data = payload()
                    data["images"][key] = repository + "@sha256:" + "6" * 64
                    self.assertEqual(stage.metadata({"APPROVED_APP_COMMIT": COMMIT, **data["images"]})["images"], data["images"])
                    guest["validate_payload"](data)

    def test_repo_digest_allowlist_rejects_wrong_repository_tag_and_digest(self):
        references = {
            "NODE_IMAGE": ("node:latest", "node:24-alpine3.24", "node:22-alpine3.23", "someone/node", "dockerXio/library/node", "docker.io/other/node"),
            "NGINX_IMAGE": ("nginx", "someone/nginx-unprivileged", "nginxinc/nginx-unprivileged:latest", "nginxinc/nginx-unprivileged:1.30.4-alpine", "dockerXio/nginxinc/nginx-unprivileged"),
            "POSTGRES_IMAGE": ("postgres:16-bookworm", "postgres:17-alpine", "postgres:latest", "someone/postgres", "dockerXio/library/postgres"),
            "BACKEND_IMAGE": ("ghcrXio/san4o9910/kinetra-backend", "ghcr.io/someone/kinetra-backend", "ghcr.io/san4o9910/kinetra-backend:latest"),
            "FRONTEND_IMAGE": ("ghcrXio/san4o9910/kinetra-frontend", "ghcr.io/someone/kinetra-frontend", "ghcr.io/san4o9910/kinetra-frontend:latest"),
        }
        for key, repositories in references.items():
            for repository in repositories:
                with self.subTest(image=repository):
                    data = payload()
                    data["images"][key] = repository + "@sha256:" + "6" * 64
                    with self.assertRaises(stage.Error): stage.metadata({"APPROVED_APP_COMMIT": COMMIT, **data["images"]})
                    with self.assertRaises(guest["StageError"]): guest["validate_payload"](data)
        for image in ("node", "node@sha256:" + "6" * 63, "node@sha256:" + "G" * 64,
                      "node@sha512:" + "6" * 64, "node@sha256:" + "6" * 64 + "/extra"):
            with self.subTest(image=image):
                data = payload()
                data["images"]["NODE_IMAGE"] = image
                with self.assertRaises(stage.Error): stage.metadata({"APPROVED_APP_COMMIT": COMMIT, **data["images"]})
                with self.assertRaises(guest["StageError"]): guest["validate_payload"](data)

    def test_reviewed_alpine_tags_match_outer_and_guest_allowlists(self):
        for variant in ("22-bookworm-slim", "22-alpine3.24"):
            data = payload()
            data["images"]["NODE_IMAGE"] = "node:" + variant + "@sha256:" + "1" * 64
            self.assertEqual(stage.metadata({"APPROVED_APP_COMMIT": COMMIT, **data["images"]})["images"], data["images"])
            guest["validate_payload"](data)
        for image in ("nginxinc/nginx-unprivileged:1.30.4@sha256:" + "2" * 64,
                      "nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:" + "2" * 64,
                      "nginxinc/nginx-unprivileged:latest@sha256:" + "2" * 64):
            data = payload()
            data["images"]["NGINX_IMAGE"] = image
            with self.assertRaises(stage.Error):
                stage.metadata({"APPROVED_APP_COMMIT": COMMIT, **data["images"]})
            with self.assertRaises(guest["StageError"]):
                guest["validate_payload"](data)

    def test_compose_supports_verified_ubuntu_suffix_without_accepting_unsupported_versions(self):
        for version in ('2.40.3+ds1-0ubuntu1~24.04.1', 'v2.30.0', '2.40.3'):
            guest['validate_compose_version'](version)
        for version in ('2.29.9+ds1', '1.40.3', '3.40.3', 'vv2.40.3', '2.40.3 arbitrary', '2.40.3;echo'):
            with self.assertRaises(guest['StageError']): guest['validate_compose_version'](version)

    def test_exact_source_sets_and_image_contracts_match_both_sides(self):
        self.assertEqual(stage.SOURCE_PATHS, guest["SOURCE_PATHS"])
        self.assertEqual(stage.IMAGE_PATTERNS, guest["IMAGE_PATTERNS"])
        self.assertEqual(set(guest["validate_payload"](payload())), set(stage.SOURCE_PATHS))

    def test_payload_refuses_extra_path_changed_hash_and_mutable_image(self):
        for mutate in (
                lambda p: p["files"].update({"../../etc/passwd": p["files"][stage.SOURCE_PATHS[0]]}),
                lambda p: p["files"][stage.SOURCE_PATHS[0]].update(sha256="0" * 64),
                lambda p: p["images"].update(POSTGRES_IMAGE="postgres:17-bookworm"),
                lambda p: p.update(registry_token="invalid token")):
            data = payload()
            mutate(data)
            with self.assertRaises(guest["StageError"]): guest["validate_payload"](data)

    def test_source_bundle_reads_regular_committed_blob_not_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(args, *rest, **kwargs):
                if "rev-parse" in args: return 0, (COMMIT + "\n").encode(), b""
                if "ls-tree" in args: return 0, ("100644 blob " + "f" * 40 + "\t" + args[-1] + "\n").encode(), b""
                return 0, b"committed fixture\n", b""
            with patch.object(inspection, "run_bounded", side_effect=git) as calls:
                result = stage.source_bundle(directory, COMMIT)
            self.assertEqual(set(result), set(stage.SOURCE_PATHS))
            self.assertEqual(base64.b64decode(result[stage.SOURCE_PATHS[0]]["base64"]), b"committed fixture\n")
            self.assertTrue(all(COMMIT in " ".join(call.args[0]) for call in calls.call_args_list[1:]))

    def test_source_bundle_refuses_symlink_blob(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(inspection, "run_bounded", side_effect=[
                (0, (COMMIT + "\n").encode(), b""),
                (0, ("120000 blob " + "f" * 40 + "\t" + stage.SOURCE_PATHS[0] + "\n").encode(), b"")]):
                with self.assertRaisesRegex(stage.Error, "SOURCE_NOT_REGULAR"):
                    stage.source_bundle(directory, COMMIT)

    def test_output_rejects_secrets_or_false_application_success(self):
        for key, value in (("error", "secret must never echo"), ("application_started", True),
                           ("database_initialized", True), ("registry_config_cleanup", "PENDING")):
            data = successful_stage()
            data[key] = value
            with self.assertRaises(stage.Error): stage.validate_stage_result(json.dumps(data))

    def test_stdin_transport_never_inherits_cloud_tokens(self):
        with patch.dict(os.environ, {"TIMEWEB_CLOUD_TOKEN": TIMEWEB_SECRET, "GITHUB_TOKEN": REGISTRY_SECRET}):
            code, output, error = stage.run_with_input([sys.executable, "-c",
                "import os,sys; data=sys.stdin.buffer.read(); print(len(data)); print('TIMEWEB_CLOUD_TOKEN' in os.environ); print('GITHUB_TOKEN' in os.environ)"],
                b"synthetic-private-input", 5)
        self.assertEqual(code, 0)
        self.assertEqual(output, b"23\nFalse\nFalse\n")
        self.assertEqual(error, b"")

    def test_eight_secrets_are_distinct_restricted_and_api_remains_incomplete(self):
        writes = []
        values = ["a" * 42 + str(i) for i in range(8)]
        with patch.dict(guest, {
            "write_new": lambda path, body, mode=0o600, uid=0: writes.append((str(path), body, mode, uid)),
            "command": lambda *a, **kw: "",
        }), patch.object(guest["secrets"], "token_urlsafe", side_effect=values), \
             patch.object(guest["os"], "chown"), patch.object(guest["os"], "chmod"):
            guest["create_database_secrets"]()
        private = [w for w in writes if "/postgres/secrets/" in w[0]]
        self.assertEqual(len(private), 8)
        self.assertEqual(len({w[1] for w in private}), 8)
        self.assertTrue(all(w[2:] == (0o600, 999) for w in private))
        migrate = next(w for w in writes if w[0].endswith("/jobs/migrate.env"))
        self.assertEqual(migrate[2:], (0o600, 0))
        self.assertEqual(migrate[1].decode().splitlines(), [
            "NODE_ENV=production",
            "DATABASE_URL=postgresql://kinetra_migrate:" + values[1] + "@postgres:5432/kinetra?sslmode=verify-full"])
        api = next(w for w in writes if w[0].endswith("/api.env"))
        self.assertIn(b"INCOMPLETE", api[1])
        self.assertNotIn(b"YUKASSA", api[1])
        self.assertNotIn(b"DATABASE_URL", api[1])

    def test_registry_token_stdin_and_temp_config_are_cleaned_after_failure(self):
        directories = []
        calls = []
        def command(args, **kwargs):
            calls.append((args, kwargs))
            if "login" in args:
                directory = Path(args[2])
                directories.append(directory)
                (directory / "config.json").write_text(REGISTRY_SECRET)
                self.assertEqual(kwargs["input_data"], REGISTRY_SECRET.encode())
                self.assertNotIn(REGISTRY_SECRET, " ".join(args))
                return ""
            if "pull" in args: raise guest["StageError"]("CHILD_COMMAND_FAILED")
            return ""
        with tempfile.TemporaryDirectory() as temporary:
            real_temporary = tempfile.TemporaryDirectory
            with patch.dict(guest, {"command": command}), \
                 patch.object(guest["tempfile"], "TemporaryDirectory", side_effect=lambda **kw: real_temporary(prefix=kw["prefix"], dir=temporary)):
                state = {"registry_config_cleanup": "PENDING"}
                with self.assertRaises(guest["StageError"]): guest["pull_images"](payload(), state)
                self.assertEqual(state["registry_config_cleanup"], "REMOVED")
        self.assertTrue(directories)
        self.assertTrue(all(not p.exists() for p in directories))
        self.assertEqual(sum("pull" in args for args, _ in calls), 1)

    def test_tagless_postgres_still_requires_actual_major_17_and_uid_999(self):
        for version, uid, error in (("postgres (PostgreSQL) 17.6", "999", None),
                                    ("postgres (PostgreSQL) 16.9", "999", "POSTGRES_MAJOR_MISMATCH"),
                                    ("postgres (PostgreSQL) 17.6", "70", "POSTGRES_IMAGE_UID_MISMATCH")):
            with self.subTest(version=version, uid=uid), tempfile.TemporaryDirectory() as temporary:
                data = payload()
                data["images"]["POSTGRES_IMAGE"] = "postgres@sha256:" + "5" * 64
                calls = []
                def command(args, **kwargs):
                    calls.append(args)
                    return COMMIT if "inspect" in args else ""
                def container(options, image, arguments, **kwargs):
                    self.assertEqual(image, data["images"]["POSTGRES_IMAGE"])
                    self.assertIn("none", options)
                    return version if arguments == ["--version"] else uid
                real_temporary = tempfile.TemporaryDirectory
                with patch.dict(guest, {"command": command, "disposable_container": container}), \
                     patch.object(guest["tempfile"], "TemporaryDirectory", side_effect=lambda **kw: real_temporary(prefix=kw["prefix"], dir=temporary)):
                    state = {"registry_config_cleanup": "PENDING"}
                    if error:
                        with self.assertRaisesRegex(guest["StageError"], error): guest["pull_images"](data, state)
                    else: guest["pull_images"](data, state)
                self.assertEqual(state["registry_config_cleanup"], "REMOVED")
                self.assertTrue(any("pull" in args and data["images"]["POSTGRES_IMAGE"] in args for args in calls))

    def test_validator_mounts_exclude_ca_signing_key_and_use_migrate_guard(self):
        calls = []
        def container(options, image, arguments, **kwargs):
            self.assertEqual(image, IMAGES["BACKEND_IMAGE"])
            calls.append([*options, image, *arguments])
            return "KINETRA_SINGLE_SERVER_CONFIG=VALIDATED_LOCAL (no service or required infrastructure gate executed)\n"
        with patch.dict(guest, {"disposable_container": container}):
            guest["validate_stage"](IMAGES["BACKEND_IMAGE"])
        args = calls[0]
        self.assertIn("none", args)
        self.assertIn("DAC_READ_SEARCH", args)
        self.assertEqual(args[-2], "migrate")
        mounts = [args[i + 1] for i, v in enumerate(args) if v == "--mount"]
        self.assertTrue(all(m.endswith(",readonly") for m in mounts))
        self.assertFalse(any("ca-private" in m for m in mounts))
        self.assertFalse(any(m.startswith("type=bind,source=/srv/kinetra-stage,") for m in mounts))
        self.assertFalse(any(m.startswith("type=bind,source=/srv/kinetra-stage/tls/issued,") for m in mounts))


    def test_disposable_container_timeout_removes_captured_identity(self):
        calls = []
        identifier = "d" * 64
        def command(args, **kwargs):
            calls.append(args)
            if "create" in args: return identifier + "\n"
            if "start" in args: raise guest["StageError"]("CHILD_DEADLINE_EXCEEDED_PARTIAL_STATE")
            return ""
        with patch.dict(guest, {"command": command}):
            with self.assertRaises(guest["StageError"]):
                guest["disposable_container"](["--network", "none"], IMAGES["BACKEND_IMAGE"], ["node", "-e", "0"])
        self.assertEqual(calls[-1], ["/usr/bin/docker", "rm", "--force", "--volumes", identifier])
        self.assertFalse(any("prune" in args for args in calls))


    def test_owned_anonymous_volume_cleanup_preserves_unrelated_volume(self):
        identifier = "e" * 64
        volumes = {"unrelated-volume"}
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if "create" in args:
                volumes.add(identifier + "-anonymous")
                return identifier
            if "inspect" in args: return "0 false"
            if "rm" in args:
                self.assertEqual(args[-1], identifier)
                if "--volumes" in args: volumes.remove(identifier + "-anonymous")
            return ""
        with patch.dict(guest, {"command": command}):
            guest["disposable_container"](["--network", "none"], IMAGES["POSTGRES_IMAGE"], ["--version"])
        self.assertEqual(volumes, {"unrelated-volume"})
        self.assertFalse(any("prune" in args for args in calls))

    def test_registry_cleanup_failure_is_not_reported_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            registry = Path(temporary) / "registry"
            class FailedCleanup:
                def __enter__(self):
                    registry.mkdir()
                    return str(registry)
                def __exit__(self, *args):
                    raise OSError("synthetic cleanup failure")
            state = {"registry_config_cleanup": "PENDING"}
            with patch.dict(guest, {"command": lambda *a, **kw: ""}), \
                 patch.object(guest["tempfile"], "TemporaryDirectory", return_value=FailedCleanup()):
                with self.assertRaises(OSError): guest["pull_images"](payload(), state)
            self.assertEqual(state["registry_config_cleanup"], "FAILED")
            self.assertTrue(registry.exists())

    def test_retained_network_requires_exact_identity_no_attachments_and_valid_ipam(self):
        network = {"Id": "b" * 64, "Name": "kinetra-production_backend", "Driver": "bridge",
            "Internal": False, "EnableIPv6": False, "Containers": {},
            "Labels": {"com.docker.compose.project": "kinetra-production", "com.docker.compose.network": "backend"},
            "IPAM": {"Driver": "default", "Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]}}
        with patch.dict(guest, {"command": lambda *a, **kw: json.dumps(network)}):
            guest["validate_network"]("b" * 64)
            for key, value in (("Id", "c" * 64), ("Containers", {"unrelated": {}}),
                               ("Internal", True), ("Labels", {})):
                modified = dict(network)
                modified[key] = value
                with patch.dict(guest, {"command": lambda *a, **kw: json.dumps(modified)}):
                    with self.assertRaises(guest["StageError"]):
                        guest["validate_network"]("b" * 64)

    def test_existing_stage_refused_before_any_docker_call(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            with patch.dict(guest, {"STAGE": Path(temporary), "safe_parent": lambda path: None,
                                   "command": lambda *a, **kw: calls.append(a)}), patch.object(guest["os"], "geteuid", return_value=0):
                with self.assertRaisesRegex(guest["StageError"], "EXISTING_STAGE"):
                    guest["preconditions"]()
            self.assertFalse(calls)

    def test_existing_file_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing"
            path.write_bytes(b"preserve")
            with patch.dict(guest, {"safe_parent": lambda path: None}):
                with self.assertRaises(FileExistsError): guest["write_new"](path, b"replacement")
            self.assertEqual(path.read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main()
