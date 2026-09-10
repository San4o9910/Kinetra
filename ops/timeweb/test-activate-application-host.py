#!/usr/bin/env python3
"""Offline tests: private fixtures only, no Docker/SSH/provider/database calls.

The one Node contract test imports the approved checkout's pure env validator.
Set KINETRA_APPROVED_APP_CHECKOUT when it is not the sibling Kinetra checkout.
"""
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("activate", Path(__file__).with_name("activate-application-host.py"))
activate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activate)
COMMIT = "a" * 40
CID = "b" * 64
NETWORK_ID = "c" * 64
IMAGES = {
    "NODE_IMAGE": "node@sha256:" + "1" * 64,
    "NGINX_IMAGE": "nginxinc/nginx-unprivileged@sha256:" + "2" * 64,
    "BACKEND_IMAGE": "ghcr.io/san4o9910/kinetra-backend@sha256:" + "3" * 64,
    "FRONTEND_IMAGE": "ghcr.io/san4o9910/kinetra-frontend@sha256:" + "4" * 64,
    "POSTGRES_IMAGE": "postgres:17-bookworm@sha256:" + "5" * 64,
}
# Synthetic fixtures, never production inputs or a provider request.
PROVIDERS = {"AUTH_TOKEN_DELIVERY_WEBHOOK_URL": "https://delivery.kinetra.ru/token",
    "AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET": "offline-delivery-key-" + "c" * 32}
DB_PASSWORD = "d" * 64
OLD_API = b"# Explicitly incomplete first-deployment state\nNODE_ENV=production\n"
STRICT_MARKER = "KINETRA_SINGLE_SERVER_CONFIG=VALIDATED_LOCAL (no service or required infrastructure gate executed)"


def payload():
    return {"schema": 1, "server_id": 9069403, "public_ipv4": "80.68.156.131", "commit": COMMIT,
        "images": dict(IMAGES), "providers": dict(PROVIDERS),
        "source_hashes": {name: activate.sha256((name + "\n").encode()) for name in activate.stage.SOURCE_PATHS},
        "migration_hashes": {name: "e" * 64 for name in activate.initialization.MIGRATIONS}}


class PreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if cls.node is None:
            raise RuntimeError("Node is required for the offline crypto/validator contract tests")
        run = subprocess.run([cls.node, "-e", activate.KEY_PROGRAM], capture_output=True, text=True, timeout=10, check=True)
        cls.vapid = json.loads(run.stdout)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir(mode=0o700)
        self.data = payload()
        self.fixture_uids = {}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(activate, "STAGE", self.stage))
        self.stack.enter_context(patch.object(activate, "LOCK", self.root / "lock"))
        # /tmp's world-writable ancestor is not a production-safe parent. Test
        # only private fixtures, while keeping no-follow/mode/UID file checks.
        def fixture_parent(path):
            path = Path(path)
            if path.resolve() != path or not path.is_dir() or self.root not in (path, *path.parents):
                raise activate.Error("UNSAFE_FIXTURE_PARENT")
        self.stack.enter_context(patch.object(activate, "safe_parent", fixture_parent))
        self.stack.enter_context(patch.dict(activate.shared, {"safe_parent": fixture_parent}))
        self.stack.enter_context(patch.object(activate.resource, "setrlimit"))
        self.stack.enter_context(patch.object(activate.os, "umask"))
        # The local user namespace does not map UID999. Model that UID on
        # fixture fstat results; keep actual file type, mode and size checks.
        real_fstat = os.fstat
        def fixture_fstat(descriptor):
            info = real_fstat(descriptor)
            path = Path(os.readlink("/proc/self/fd/" + str(descriptor)))
            if path in self.fixture_uids:
                fields = list(info)
                fields[4] = self.fixture_uids[path]
                return os.stat_result(fields)
            return info
        self.stack.enter_context(patch.object(activate.os, "fstat", side_effect=fixture_fstat))
        # Fail loudly if a test accidentally attempts a real host command.
        self.host_command = self.stack.enter_context(patch.object(activate, "command", side_effect=AssertionError("offline host command forbidden")))
        self.stack.enter_context(patch.dict(activate.shared, {"command": Mock(side_effect=AssertionError("offline container command forbidden"))}))
        self.stack.enter_context(patch.dict(activate.helpers, {"command": Mock(side_effect=AssertionError("offline isolation command forbidden"))}))
        self.write(self.root / "lock", b"")

    def write(self, path, raw, mode=0o600, uid=0):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(raw)
        os.chmod(path, mode)
        self.fixture_uids[path] = uid

    def json_write(self, path, data):
        self.write(path, (json.dumps(data) + "\n").encode())

    def handoff(self):
        staged = {"schema": 1, "result": "STAGED_ONLY", "stage": "STAGING_COMPLETE", "error": None,
            "commit": COMMIT, "observed_peer": "172.19.0.1", "network_id": NETWORK_ID,
            "registry_config_cleanup": "REMOVED", "database_initialized": False, "application_started": False,
            "images": dict(IMAGES), "source_hashes": self.data["source_hashes"]}
        initialized = {"schema": 1, "result": "DATABASE_INITIALIZED_ONLY", "stage": "INITIALIZATION_COMPLETE", "error": None,
            "commit": COMMIT, "postgres_id": CID, "database_initialized": True, "application_started": False,
            "migrations": 13, "content_seed": True, "runtime_grants": True, "readonly_acceptance": True,
            "images": dict(IMAGES), "migration_hashes": self.data["migration_hashes"]}
        self.json_write(self.stage / "evidence/stage.json", staged)
        self.json_write(self.stage / "evidence/initialization.json", initialized)
        for name in self.data["source_hashes"]:
            self.write(self.stage / "source" / name, (name + "\n").encode(), 0o644)
        self.main = {key: IMAGES[key] for key in ("NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE")}
        self.main.update(VCS_REF=COMMIT, VITE_API_URL=activate.ORIGIN, VITE_PRIVATE_MEDIA_ORIGIN="",
            KINETRA_API_ENV_FILE=str(self.stage / "env/api.env"), KINETRA_VIDEO_SCRATCH_DIR="")
        self.write(self.stage / "env/api.env", OLD_API)
        self.write(self.stage / "env/production.env", activate.env_bytes(self.main))
        self.write(self.stage / "env/single-server.env", b"KINETRA_POSTGRES_DATA_DIR=/private/data\n")
        self.write(self.stage / "env/jobs/migrate.env", b"NODE_ENV=production\n")
        self.write(self.stage / "edge/nginx-real-ip.conf", b"set_real_ip_from 172.19.0.1;\n", 0o644)
        self.write(self.stage / "postgres/secrets/api_password", (DB_PASSWORD + "\n").encode(), uid=999)
        self.write(self.stage / "postgres/data/preserve-sentinel", b"existing initialized database\n", uid=999)
        return staged, initialized

    def run_main(self, data=None, *, validator=None, live=None):
        path = self.root / "private-input.json"
        self.json_write(path, self.data if data is None else data)
        output = io.StringIO()
        with patch.object(activate, "check_live_identity", side_effect=live) as identity, \
             patch.object(activate, "generate_vapid", return_value=dict(self.vapid)) as generate, \
             patch.object(activate, "validate_candidate", side_effect=validator) as validate, contextlib.redirect_stdout(output):
            code = activate.main(["--prepare-validated-api-environment", "--private-input", str(path)])
        text = output.getvalue()
        for secret in (*PROVIDERS.values(), DB_PASSWORD, self.vapid["private"]):
            self.assertNotIn(secret, text)
        return code, json.loads(text), identity, generate, validate

    def test_each_missing_provider_stops_before_locks_commands_or_writes(self):
        for key in activate.PROVIDERS:
            with self.subTest(key=key):
                data = payload()
                del data["providers"][key]
                with patch.object(activate.fcntl, "flock") as lock, patch.object(activate, "write_new") as write:
                    code, state, identity, generate, validate = self.run_main(data)
                self.assertEqual((code, state["error"]), (1, "REQUIRED_PROVIDER_INPUTS_MISSING"))
                self.assertFalse(any(mock.called for mock in (lock, write, identity, generate, validate, self.host_command)))
                self.assertEqual(list(self.stage.iterdir()), [])

    def test_unsafe_provider_values_and_bad_ports_refuse_before_mutation(self):
        for key, value in (
            ("AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET", "replace_me"), ("AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET", "secret$HOME"),
            ("AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET", "123\nHOST=other"), ("AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET", "short"),
            *(('AUTH_TOKEN_DELIVERY_WEBHOOK_URL', value) for value in (
                "http://delivery.kinetra.ru/token", "https://127.0.0.1/token", "https://localhost/token",
                "https://delivery.kinetra.ru:bad/token", "https://delivery.kinetra.ru:65536/token", "https://delivery.kinetra.ru:0/token",
                "https://user:pass@delivery.kinetra.ru/token", "https://delivery.kinetra.ru/token?token=secret")),
        ):
            with self.subTest(key=key, value=value):
                data = payload()
                data["providers"][key] = value
                code, state, identity, generate, validate = self.run_main(data)
                self.assertEqual(code, 1)
                self.assertFalse(identity.called or generate.called or validate.called)
                self.assertEqual(list(self.stage.iterdir()), [])

    def test_payment_provider_inputs_are_rejected_even_if_empty_before_mutation(self):
        for key in activate.PAYMENT_PROVIDER_KEYS:
            for value in ("", "offline-payment-value"):
                with self.subTest(key=key, value=value):
                    data = payload()
                    data["providers"][key] = value
                    with patch.object(activate.fcntl, "flock") as lock, patch.object(activate, "write_new") as write:
                        code, state, identity, generate, validate = self.run_main(data)
                    self.assertEqual((code, state["error"]), (1, "REQUIRED_PROVIDER_INPUTS_MISSING"))
                    self.assertFalse(any(mock.called for mock in (lock, write, identity, generate, validate, self.host_command)))
                    self.assertEqual(list(self.stage.iterdir()), [])

    def test_identity_scope_and_required_tagged_postgres_fail_closed(self):
        for mutate in (
            lambda d: d.update(server_id=9069404), lambda d: d.update(public_ipv4="80.68.156.132"),
            lambda d: d.update(registry_token="not-allowed"), lambda d: d.update(commit="main"),
            lambda d: d["images"].update(BACKEND_IMAGE="ghcr.io/other/app@sha256:" + "3" * 64),
            lambda d: d["images"].update(POSTGRES_IMAGE="postgres@sha256:" + "5" * 64),
            lambda d: d["source_hashes"].pop(activate.stage.SOURCE_PATHS[0]),
            lambda d: d["migration_hashes"].pop(activate.initialization.MIGRATIONS[0]),
        ):
            data = payload()
            mutate(data)
            with self.assertRaises((activate.Error, activate.stage.Error)):
                activate.validate_input(data)

    def test_private_input_mode_symlink_and_duplicate_env_are_rejected(self):
        target = self.root / "private.json"
        self.json_write(target, payload())
        os.chmod(target, 0o644)
        with self.assertRaisesRegex(activate.Error, "PRIVATE_FILE_IDENTITY_INVALID"):
            activate.private_read(target)
        os.chmod(target, 0o600)
        self.fixture_uids[target] = 1000
        with self.assertRaisesRegex(activate.Error, "PRIVATE_FILE_IDENTITY_INVALID"):
            activate.private_read(target)
        self.fixture_uids[target] = 0
        link = self.root / "link.json"
        link.symlink_to(target)
        with self.assertRaises(OSError):
            activate.private_read(link)
        for raw in (b"NODE_ENV=production\nNODE_ENV=production\n", b"A=$HOME\n", b"A='secret'\n"):
            with self.assertRaises(activate.Error):
                activate.parse_env(raw)

    def test_exact_handoff_accepts_all_source_hashes_and_readonly_initialization(self):
        self.handoff()
        result = activate.read_handoff(self.data)
        self.assertEqual(result["old_api"], OLD_API)
        self.assertTrue(result["initialized"]["readonly_acceptance"])

    def test_changed_source_or_initialization_evidence_cannot_generate_keys(self):
        _, initialized = self.handoff()
        target = self.stage / "source" / activate.stage.SOURCE_PATHS[0]
        self.write(target, b"changed\n", 0o644)
        code, state, identity, generate, _ = self.run_main()
        self.assertEqual((code, state["error"]), (1, "STAGED_SOURCE_CHANGED"))
        self.assertFalse(identity.called or generate.called)
        self.write(target, (activate.stage.SOURCE_PATHS[0] + "\n").encode(), 0o644)
        initialized["readonly_acceptance"] = False
        self.json_write(self.stage / "evidence/initialization.json", initialized)
        code, _, identity, generate, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertFalse(identity.called or generate.called)

    def test_existing_credentials_or_previous_attempt_are_preserved(self):
        self.handoff()
        target = self.stage / "env/api.env"
        existing = b"NODE_ENV=production\nJWT_ACCESS_SECRET=existing-session-secret\n"
        self.write(target, existing)
        code, state, _, generate, _ = self.run_main()
        self.assertEqual((code, state["error"]), (1, "EXISTING_API_CREDENTIALS_PRESERVED"))
        self.assertFalse(generate.called)
        self.assertEqual(target.read_bytes(), existing)
        self.write(target, OLD_API)
        self.write(self.stage / "evidence/application-env-attempt.json", b"retained attempt\n")
        code, state, _, generate, _ = self.run_main()
        self.assertEqual((code, state["error"]), (1, "EXISTING_PREPARATION_PRESERVED"))
        self.assertFalse(generate.called)

    def test_live_identity_requires_fixed_address_inactive_caddy_and_healthy_pg(self):
        self.handoff()
        handoff = activate.read_handoff(self.data)
        def run(*, running=True, health="healthy", address="80.68.156.131", caddy="inactive", revision=COMMIT):
            def command(args, **kwargs):
                if args[0] == "/fixture/ip": return "2: eth0 inet " + address + "/24 scope global eth0\n"
                if args[0].endswith("systemctl"): return caddy if "--property=ActiveState" in args else "disabled"
                if "{{json .State}}" in args: return json.dumps({"Running": running, "Health": {"Status": health}})
                return revision
            with patch.object(activate, "command", side_effect=command), \
                 patch.object(activate.shutil, "which", return_value="/fixture/ip"), \
                 patch.dict(activate.helpers, {"final_isolation": Mock()}) as helpers:
                activate.check_live_identity(self.data, handoff)
                helpers["final_isolation"].assert_called_once_with(CID, IMAGES["POSTGRES_IMAGE"], NETWORK_ID)
        run()
        for kwargs in ({"running": False}, {"health": "starting"}, {"address": "80.68.156.132"}, {"caddy": "active"}, {"revision": "f" * 40}):
            with self.subTest(kwargs=kwargs), self.assertRaises(activate.Error):
                run(**kwargs)

    def test_vapid_generation_is_real_matching_p256_and_isolated(self):
        with patch.object(activate, "disposable", return_value=json.dumps(self.vapid)) as call:
            pair = activate.generate_vapid(IMAGES["BACKEND_IMAGE"])
        options, image, args = call.call_args.args
        self.assertEqual(image, IMAGES["BACKEND_IMAGE"])
        self.assertEqual(options[options.index("--network") + 1], "none")
        self.assertEqual(options[options.index("--log-driver") + 1], "none")
        self.assertEqual(options[options.index("--user") + 1], "1000:1000")
        program = "const c=require('node:crypto'),f=require('node:fs');const k=JSON.parse(f.readFileSync(0));const p=c.createECDH('prime256v1');p.setPrivateKey(Buffer.from(k.private,'base64url'));if(p.getPublicKey().toString('base64url')!==k.public)process.exit(1);console.log('MATCH');"
        result = subprocess.run([self.node, "-e", program], input=json.dumps(pair), text=True, capture_output=True, timeout=10)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "MATCH"))
        with patch.object(activate, "disposable", return_value=json.dumps({"public": "A" * 87, "private": "B" * 43})):
            with self.assertRaisesRegex(activate.Error, "VAPID_GENERATION_FAILED"):
                activate.generate_vapid(IMAGES["BACKEND_IMAGE"])

    def test_generated_environment_passes_actual_pure_production_validator(self):
        self.handoff()
        values = activate.api_values(self.data, self.vapid)
        self.assertEqual(activate.parse_env(activate.env_bytes(values)), values)
        checkout = Path(os.environ.get("KINETRA_APPROVED_APP_CHECKOUT", Path(__file__).resolve().parents[3] / "Kinetra"))
        validator = checkout / "ops/validate-production-env.mjs"
        self.assertTrue(validator.is_file())
        program = "import {readFileSync} from 'node:fs';const v=await import(process.argv[1]);const d=JSON.parse(readFileSync(0,'utf8'));v.validateApi(d.api,d.main);console.log('VALID');"
        result = subprocess.run([self.node, "--input-type=module", "-e", program, validator.as_uri()],
            input=json.dumps({"api": values, "main": self.main}), capture_output=True, text=True, timeout=10)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "VALID"), result.stderr)
        self.assertGreaterEqual(len(base64.urlsafe_b64decode(values["JWT_ACCESS_SECRET"])), 48)
        self.assertEqual(values["PAYMENTS_ENABLED"], "false")
        self.assertEqual(values["FREE_BETA_ENABLED"], "true")
        for key in activate.PAYMENT_PROVIDER_KEYS:
            self.assertEqual(values[key], "")
        for key in ("CHAT_ENABLED", "CHAT_PHOTO_UPLOADS_ENABLED", "TRAINER_VIDEO_UPLOADS_ENABLED"):
            self.assertEqual(values[key], "false")
        for key in ("S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"):
            self.assertEqual(values[key], "")

    def test_compiled_environment_assertion_rejects_missing_or_wrong_launch_flags(self):
        fixture = self.root / "runtime-env.mjs"
        program = activate.API_ENV_PROGRAM.replace("'./apps/backend/dist/config/env.js'", "process.argv[1]")
        valid = {"paymentsEnabled": False, "freeBetaEnabled": True, "yookassa": None}
        variants = [valid, {}, {**valid, "paymentsEnabled": True}, {**valid, "freeBetaEnabled": False},
            {**valid, "paymentsEnabled": "false"}, {**valid, "freeBetaEnabled": "true"},
            {**valid, "yookassa": {"shopId": "offline-shop"}}]
        for values in variants:
            with self.subTest(values=values):
                fixture.write_text("export const env=" + json.dumps(values) + ";\n")
                result = subprocess.run([self.node, "--input-type=module", "-e", program, fixture.as_uri()],
                    capture_output=True, text=True, timeout=10)
                if values == valid:
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, "KINETRA_API_RUNTIME_ENV=PASS"), result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertIn("FREE_BETA_RUNTIME_CONFIGURATION_REQUIRED", result.stderr)

    def test_validators_have_only_readonly_narrow_mounts_and_no_jobs_or_server(self):
        with patch.object(activate, "disposable", side_effect=[STRICT_MARKER, "KINETRA_API_RUNTIME_ENV=PASS"]) as call:
            activate.validate_candidate(IMAGES["BACKEND_IMAGE"], self.stage / "env/production.env", self.stage / "env/api.env")
        self.assertEqual(call.call_count, 2)
        for entry in call.call_args_list:
            options, image, args = entry.args
            self.assertEqual(image, IMAGES["BACKEND_IMAGE"])
            self.assertEqual(options[options.index("--network") + 1], "none")
            self.assertEqual(options[options.index("--log-driver") + 1], "none")
            self.assertIn("--read-only", options)
            self.assertEqual(options[options.index("--cap-drop") + 1], "ALL")
            self.assertNotIn("server.js", " ".join(args))
            self.assertNotIn("migrate", " ".join(args))
            self.assertNotIn("seed", " ".join(args))
            for index, option in enumerate(options):
                if option == "--mount":
                    mount = options[index + 1]
                    self.assertTrue(mount.endswith(",readonly"))
                    self.assertNotIn("signing", mount)
                    self.assertNotIn("source=" + str(self.stage) + ",", mount)
        first, second = [entry.args for entry in call.call_args_list]
        self.assertIn("DAC_READ_SEARCH", first[0])
        self.assertNotIn("--cap-add", second[0])
        self.assertIn("./apps/backend/dist/config/env.js", second[2][-1])
        self.assertEqual(second[2][-1], activate.API_ENV_PROGRAM)
        for outputs in (["unexpected", "KINETRA_API_RUNTIME_ENV=PASS"], [STRICT_MARKER, ""]):
            with patch.object(activate, "disposable", side_effect=outputs), self.assertRaises(activate.Error):
                activate.validate_candidate(IMAGES["BACKEND_IMAGE"], self.stage / "env/production.env", self.stage / "env/api.env")

    def test_success_atomically_installs_and_preserves_old_credentials_and_database(self):
        self.handoff()
        code, state, identity, generate, validate = self.run_main()
        self.assertEqual((code, state["result"]), (0, "API_ENVIRONMENT_PREPARED_ONLY"))
        self.assertTrue(state["api_environment_installed"])
        self.assertFalse(state["application_started"] or state["caddy_started"])
        self.assertEqual(state["provider_requests"], 0)
        self.assertEqual((identity.call_count, generate.call_count, validate.call_count), (3, 1, 2))
        folder = self.stage / "env" / state["candidate_directory"]
        self.assertEqual((folder / "previous-api.env").read_bytes(), OLD_API)
        self.assertEqual((folder / "api.env").read_bytes(), (self.stage / "env/api.env").read_bytes())
        for path in (folder / "api.env", folder / "previous-api.env", self.stage / "env/api.env"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        record = json.loads((self.stage / "evidence/application-env.json").read_bytes())
        self.assertEqual(record["api_sha256"], activate.sha256((folder / "api.env").read_bytes()))
        self.assertFalse(set(activate.HASH_FIELDS) & set(record))
        self.assertEqual(state["handoff_hashes"], {name: activate.sha256((self.stage / "evidence" / name).read_bytes())
                                                  for name in activate.EVIDENCE_FILES})
        self.assertEqual(state["configuration_hashes"], {name: activate.sha256((self.stage / name).read_bytes())
                                                        for name in activate.CONFIG_FILES})
        self.assertEqual((self.stage / "postgres/data/preserve-sentinel").read_bytes(), b"existing initialized database\n")
        self.assertFalse(self.host_command.called)

    def test_hash_collection_refuses_each_changed_missing_symlink_owner_mode_or_oversized_file(self):
        self.handoff()
        code, state, *_ = self.run_main()
        self.assertEqual(code, 0)
        evidence = {name: (self.stage / "evidence" / name).read_bytes() for name in activate.EVIDENCE_FILES}
        configuration = {name: (self.stage / name).read_bytes() for name in activate.CONFIG_FILES}
        fixed = {**{"evidence/" + name: raw for name, raw in evidence.items()}, **configuration}
        for name, original in fixed.items():
            path = self.stage / name
            mode = 0o644 if name.startswith("edge/") else 0o600
            for failure in ("changed", "missing", "symlink", "owner", "mode", "oversized"):
                with self.subTest(name=name, failure=failure):
                    path.unlink()
                    if failure == "symlink":
                        path.symlink_to(self.stage / "env/production.env")
                    elif failure != "missing":
                        raw = original + b"corrupt" if failure == "changed" else b"x" * 262145 if failure == "oversized" else original
                        self.write(path, raw, 0o666 if failure == "mode" else mode, uid=1000 if failure == "owner" else 0)
                    with self.assertRaises((activate.Error, OSError)):
                        activate.collect_handoff_hashes(evidence, configuration)
                    if path.exists() or path.is_symlink():
                        path.unlink()
                    self.write(path, original, mode)
        self.assertEqual(activate.collect_handoff_hashes(evidence, configuration),
                         {field: state[field] for field in activate.HASH_FIELDS})
        self.assertFalse(self.host_command.called)

    def test_hash_collection_rejects_unlisted_and_partial_file_sets(self):
        evidence = {name: b"fixture" for name in activate.EVIDENCE_FILES}
        configuration = {name: b"fixture" for name in activate.CONFIG_FILES}
        for field, name in ((evidence, "stage.json"), (configuration, "env/api.env")):
            original = field.pop(name)
            with self.assertRaisesRegex(activate.Error, "FIXED_HANDOFF_FILE_SET_REQUIRED"):
                activate.collect_handoff_hashes(evidence, configuration)
            field[name] = original
            field["../unlisted.env"] = b"fixture"
            with self.assertRaisesRegex(activate.Error, "FIXED_HANDOFF_FILE_SET_REQUIRED"):
                activate.collect_handoff_hashes(evidence, configuration)
            del field["../unlisted.env"]

    def test_changed_configuration_after_validation_cannot_emit_successful_hashes(self):
        self.handoff()
        original = activate.collect_handoff_hashes
        def changed(*args):
            self.write(self.stage / "env/single-server.env", b"KINETRA_POSTGRES_DATA_DIR=/changed/data\n")
            return original(*args)
        with patch.object(activate, "collect_handoff_hashes", side_effect=changed):
            code, state, *_ = self.run_main()
        self.assertEqual((code, state["error"]), (1, "PREPARED_CONFIGURATION_CHANGED"))
        self.assertTrue(state["api_environment_installed"])
        self.assertTrue(all(state[field] is None for field in activate.HASH_FIELDS))
        self.assertTrue((self.stage / "evidence/application-env.json").exists())
        self.assertEqual((self.stage / "env" / state["candidate_directory"] / "previous-api.env").read_bytes(), OLD_API)

    def test_candidate_rejection_preserves_original_and_new_private_candidate(self):
        self.handoff()
        code, state, _, _, validate = self.run_main(validator=activate.Error("STRICT_API_VALIDATION_FAILED"))
        self.assertEqual((code, state["error"]), (1, "STRICT_API_VALIDATION_FAILED"))
        self.assertFalse(state["api_environment_installed"])
        self.assertEqual(validate.call_count, 1)
        self.assertEqual((self.stage / "env/api.env").read_bytes(), OLD_API)
        folder = self.stage / "env" / state["candidate_directory"]
        self.assertIn("JWT_ACCESS_SECRET", activate.parse_env((folder / "api.env").read_bytes()))
        self.assertTrue((self.stage / "evidence/application-env-attempt.json").is_file())
        self.assertFalse((self.stage / "evidence/application-env.json").exists())

    def test_postinstall_validation_failure_reports_installed_without_discarding_either_set(self):
        self.handoff()
        code, state, _, _, validate = self.run_main(validator=[None, activate.Error("COMPILED_API_ENV_REJECTED")])
        self.assertEqual((code, state["error"]), (1, "COMPILED_API_ENV_REJECTED"))
        self.assertTrue(state["api_environment_installed"])
        folder = self.stage / "env" / state["candidate_directory"]
        self.assertEqual((folder / "previous-api.env").read_bytes(), OLD_API)
        self.assertEqual((self.stage / "env/api.env").read_bytes(), (folder / "api.env").read_bytes())
        self.assertFalse((self.stage / "evidence/application-env.json").exists())

    def test_postreplace_fsync_failure_keeps_truthful_installed_state(self):
        self.handoff()
        real_sync = activate.sync_directory
        calls = []
        def sync(path):
            calls.append(path)
            if path == self.stage / "env":
                raise OSError("fixture disk sync failure")
            real_sync(path)
        with patch.object(activate, "sync_directory", side_effect=sync):
            code, state, *_ = self.run_main()
        self.assertEqual(code, 1)
        self.assertTrue(state["api_environment_installed"])
        folder = self.stage / "env" / state["candidate_directory"]
        self.assertLess(calls.index(folder), calls.index(self.stage / "env"))
        self.assertEqual((folder / "previous-api.env").read_bytes(), OLD_API)
        self.assertEqual((self.stage / "env/api.env").read_bytes(), (folder / "api.env").read_bytes())

    def test_concurrent_config_change_refuses_replacement(self):
        self.handoff()
        changed = b"NODE_ENV=production\nJWT_ACCESS_SECRET=owner-change\n"
        def validator(*args):
            self.write(self.stage / "env/api.env", changed)
        code, state, *_ = self.run_main(validator=validator)
        self.assertEqual((code, state["error"]), (1, "API_ENV_CHANGED_BEFORE_INSTALL"))
        self.assertFalse(state["api_environment_installed"])
        self.assertEqual((self.stage / "env/api.env").read_bytes(), changed)

    def test_active_lock_and_secret_bearing_exception_never_leak_or_claim_success(self):
        self.handoff()
        descriptor = os.open(activate.LOCK, os.O_RDWR)
        try:
            activate.fcntl.flock(descriptor, activate.fcntl.LOCK_EX | activate.fcntl.LOCK_NB)
            code, state, identity, generate, _ = self.run_main()
            self.assertEqual(code, 1)
            self.assertFalse(identity.called or generate.called)
        finally:
            os.close(descriptor)
        code, state, *_ = self.run_main(live=RuntimeError(PROVIDERS["AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET"]))
        self.assertEqual((code, state["error"]), (1, "UNEXPECTED_ERROR_PRIVATE_STATE_PRESERVED"))
        self.assertEqual((self.stage / "env/api.env").read_bytes(), OLD_API)


if __name__ == "__main__":
    unittest.main()
