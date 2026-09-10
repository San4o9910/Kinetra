#!/usr/bin/env python3
"""Offline caller contract tests; all GitHub and host operations are fixtures."""
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
import textwrap
import unittest
from unittest.mock import Mock, patch
import zipfile


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


caller = module("application-caller.py")
fixtures = module("test-activate-local-application-host.py")
local = fixtures.module


class CallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.request = fixtures.request()
        provenance = self.request["provenance"]
        self.env = {name: provenance[key] for key, name in local.PROVENANCE_ENV.items()}
        self.env.update(fixtures.IMAGES)
        self.env.update(GITHUB_ACTIONS="true", GITHUB_REPOSITORY=caller.REPOSITORY, GITHUB_REF=caller.CONTROL_REF,
            GITHUB_SHA=provenance["control_commit"], GITHUB_RUN_ID="34500001000", GITHUB_RUN_ATTEMPT="1",
            ACTIVATE_LOCAL_APPLICATION="APPROVED", ACTIVATE_DATABASE_INITIALIZATION="APPROVED",
            APPROVED_DATABASE_RUN="34500000004", APPROVED_DATABASE_CONTROL_COMMIT="f" * 40,
            APPROVED_DATABASE_ARTIFACT_ID="12345679", APP_CHECKOUT=str(self.root / "checkout"), RUNNER_TEMP=str(self.root))
        self.workflow = b"# reviewed database producer fixture\n"
        self.env["APPROVED_DATABASE_WORKFLOW_SHA256"] = hashlib.sha256(self.workflow).hexdigest()
        self.envelope = {"schema": 1, "repository": caller.REPOSITORY, "run_id": self.env["APPROVED_DATABASE_RUN"],
            "run_attempt": 1, "control_commit": self.env["APPROVED_DATABASE_CONTROL_COMMIT"],
            **{key: self.request["approved"][key] for key in ("commit", "images", "source_hashes", "migration_hashes")},
            "database_outer": self.request["database_outer"]}
        self.set_archive(self.envelope)
        self.successful_run = Mock(return_value=({"head_branch": caller.CONTROL_REF.removeprefix("refs/heads/")}, [{"name": "initialize-database"}]))
        self.calls = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(local.stage, "source_bundle", return_value=fixtures.SOURCES))
        self.stack.enter_context(patch.object(local.initialization, "migration_hashes", return_value=fixtures.MIGRATIONS))
        self.host = self.stack.enter_context(patch.object(local.inspection, "Api", side_effect=AssertionError("live Timeweb forbidden")))

    def set_archive(self, envelope, *, member="database-handoff.json", extra=False):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr(member, caller.canonical_bytes(envelope))
            if extra:
                zipped.writestr("unrequested.json", b"{}")
        self.archive = buffer.getvalue()
        self.env["APPROVED_DATABASE_ARTIFACT_SHA256"] = hashlib.sha256(self.archive).hexdigest()
        self.artifact = {"id": int(self.env["APPROVED_DATABASE_ARTIFACT_ID"]), "expired": False,
            "name": "kinetra-database-handoff-" + self.env["APPROVED_DATABASE_RUN"] + "-1",
            "workflow_run": {"id": int(self.env["APPROVED_DATABASE_RUN"]), "head_sha": self.env["APPROVED_DATABASE_CONTROL_COMMIT"]},
            "digest": "sha256:" + self.env["APPROVED_DATABASE_ARTIFACT_SHA256"], "size_in_bytes": len(self.archive)}

    def api(self, path, *, archive=False):
        self.calls.append((path, archive))
        if path.startswith("/contents/"):
            return {"type": "file", "encoding": "base64", "content": base64.b64encode(self.workflow).decode()}
        if path.endswith("/zip"):
            self.assertTrue(archive)
            return self.archive
        self.assertEqual(path, "/actions/artifacts/" + self.env["APPROVED_DATABASE_ARTIFACT_ID"])
        return copy.deepcopy(self.artifact)

    def authenticate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            caller.authenticate_database(self.env, local, self.api, self.successful_run)

    def test_original_immutable_gate_is_preserved_byte_for_byte(self):
        source = Path(__file__).with_name("verify-launch-provenance.py").read_text()
        body = textwrap.dedent(source.split("def verify_source_and_images():\n", 1)[1].split("\n    return api, successful_run", 1)[0])
        self.assertEqual(hashlib.sha256(body.encode()).hexdigest(), "338cbbb5e3068f4f3e2ca917ef4dc57166be0e7438d7635304b0ad78ac748f7c")

    def test_verified_database_run_and_exact_artifact_create_private_receipt(self):
        self.authenticate()
        self.successful_run.assert_called_once_with(self.env["APPROVED_DATABASE_RUN"], caller.DATABASE_WORKFLOW,
            self.env["APPROVED_DATABASE_CONTROL_COMMIT"], "push")
        path, value = caller.prior_database(self.env, local)
        self.assertEqual(value, self.envelope)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for file in path.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.host.assert_not_called()

    def test_failed_prior_gate_and_wrong_run_identity_prevent_handoff(self):
        for result in (None, ({"head_branch": "another-project"}, [{"name": "initialize-database"}]),
                       ({"head_branch": caller.CONTROL_REF.removeprefix("refs/heads/")}, [{"name": "different-job"}])):
            with self.subTest(result=result):
                check = Mock(side_effect=AssertionError("red or skipped prior gate")) if result is None else Mock(return_value=result)
                with self.assertRaises((AssertionError, caller.CallerError)):
                    caller.authenticate_database(self.env, local, self.api, check)
                self.assertEqual(list(self.root.iterdir()), [])

    def test_expired_foreign_or_changed_artifact_and_workflow_are_rejected(self):
        changes = (lambda: self.artifact.update(expired=True), lambda: self.artifact.update(id=1),
            lambda: self.artifact.update(name="unrelated"), lambda: self.artifact["workflow_run"].update(id=1),
            lambda: self.artifact["workflow_run"].update(head_sha="1" * 40),
            lambda: self.artifact.update(digest="sha256:" + "1" * 64), lambda: self.artifact.update(size_in_bytes=caller.LIMIT + 1),
            lambda: setattr(self, "archive", self.archive + b"changed"), lambda: setattr(self, "workflow", self.workflow + b"changed"))
        for change in changes:
            with self.subTest(change=change):
                original_artifact, original_archive, original_workflow = copy.deepcopy(self.artifact), self.archive, self.workflow
                change()
                with self.assertRaises(caller.CallerError):
                    self.authenticate()
                self.assertEqual(list(self.root.iterdir()), [])
                self.artifact, self.archive, self.workflow = original_artifact, original_archive, original_workflow

    def test_archive_member_and_complete_database_outer_cannot_be_substituted(self):
        variants = [(self.envelope, {"member": "../database-handoff.json"}), (self.envelope, {"extra": True})]
        for field, value in (("run_id", "99"), ("control_commit", "2" * 40), ("commit", "2" * 40)):
            changed = copy.deepcopy(self.envelope)
            changed[field] = value
            variants.append((changed, {}))
        for key, value in (("guest_key_cleanup", "NOT_NEEDED"), ("error", "FAILED")):
            changed = copy.deepcopy(self.envelope)
            changed["database_outer"][key] = value
            variants.append((changed, {}))
        for envelope, options in variants:
            with self.subTest(options=options, envelope=envelope):
                self.set_archive(envelope, **options)
                with self.assertRaises((caller.CallerError, local.Error)):
                    self.authenticate()
                self.assertEqual(list(self.root.iterdir()), [])

    def test_duplicate_json_and_nonfinite_values_are_refused(self):
        for raw in ('{"schema":1,"schema":1}', '{"value":NaN}', '{"value":Infinity}'):
            with self.assertRaises(caller.CallerError):
                caller.strict_json(raw)

    def test_receipt_source_drift_and_untrusted_local_json_cannot_prepare_api(self):
        self.authenticate()
        path = caller.folder(self.env)
        with patch.object(local.prepare, "main") as prepare:
            self.env["APPROVED_IMAGE_RUN"] = "123"
            with self.assertRaises(caller.CallerError):
                caller.prepare_api(self.env, local)
            prepare.assert_not_called()
        self.env["APPROVED_IMAGE_RUN"] = self.request["provenance"]["image_run"]
        os.chmod(path / "database-handoff.json", 0o644)
        with self.assertRaises(caller.CallerError):
            caller.prior_database(self.env, local)
        os.chmod(path / "database-handoff.json", 0o600)
        os.rename(path / "database-handoff.json", path / "real.json")
        (path / "database-handoff.json").symlink_to(path / "real.json")
        with self.assertRaises(OSError):
            caller.prior_database(self.env, local)

    def test_api_capture_start_input_uses_real_nine_hashes_and_no_provider_step_leak(self):
        self.authenticate()
        api = self.request["api_outer"]
        secrets = {name: "offline-provider-secret" for name in local.prepare.activation.PROVIDERS}
        self.env.update(secrets)
        self.env["TIMEWEB_CLOUD_TOKEN"] = "offline-timeweb-secret"
        def prepare(argv, *, environ):
            self.assertEqual(argv, ["--prepare-api-environment", "--provider-env"])
            self.assertTrue(all(environ.pop(name) == value for name, value in secrets.items()))
            environ.pop("TIMEWEB_CLOUD_TOKEN")
            print("TIMEWEB_API_PREPARATION=" + json.dumps(api))
            return 0
        with patch.object(local.prepare, "main", side_effect=prepare), contextlib.redirect_stdout(io.StringIO()) as output:
            caller.prepare_api(self.env, local)
        self.assertNotIn("offline-provider-secret", output.getvalue())
        path, database = caller.prior_database(self.env, local)
        request = caller.start_request(self.env, local, database, caller.read_json(path / "api-outer.json"))
        local.validate_request(request, self.env)
        self.assertEqual(request["approved"]["handoff_hashes"], self.request["approved"]["handoff_hashes"])
        self.assertEqual(request["approved"]["configuration_hashes"], self.request["approved"]["configuration_hashes"])
        self.assertEqual(len(request["approved"]["handoff_hashes"]) + len(request["approved"]["configuration_hashes"]), 9)
        self.env["AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET"] = "must-not-reach-start"
        with patch.object(local, "main") as start, self.assertRaises(caller.CallerError):
            caller.start_local(self.env, local)
        start.assert_not_called()

    def test_failed_wrapper_state_is_preserved_without_success_or_unvalidated_output(self):
        path = caller.folder(self.env, create=True)
        def failed():
            print('TIMEWEB_API_PREPARATION={"result":"FAIL","error":"UNKNOWN_RECONCILE"}')
            return 1
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(caller.CallerError):
            caller.capture(failed, "TIMEWEB_API_PREPARATION=", path / "failed.json")
        self.assertIn('"result": "FAIL"', output.getvalue())
        self.assertNotIn("UNKNOWN_RECONCILE", output.getvalue())
        self.assertFalse((path / "failed.json").exists())
        observation = caller.strict_json((path / "failed.observations.jsonl").read_bytes())
        self.assertEqual(observation["result"], "FAIL")
        self.assertNotIn("error", observation)
        def unexpected():
            print("unexpected-sensitive-output")
            return 0
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(caller.CallerError):
            caller.capture(unexpected, "TIMEWEB_API_PREPARATION=", path / "unsafe.json")
        self.assertEqual(output.getvalue(), "")
        self.assertFalse((path / "unsafe.json").exists())

    def test_interruption_preserves_already_emitted_cleanup_identity_and_no_extra_fields(self):
        path = caller.folder(self.env, create=True)
        def interrupted():
            print('TIMEWEB_API_PREPARATION={"result":"IN_PROGRESS","ssh_key_id":812345,"guest_key_cleanup":"ATTACH_OUTCOME_UNKNOWN","private_field":"never-in-log"}', flush=True)
            raise RuntimeError("fixture interruption")
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(RuntimeError):
            caller.capture(interrupted, "TIMEWEB_API_PREPARATION=", path / "interrupted.json")
        self.assertIn('"ssh_key_id": 812345', output.getvalue())
        self.assertNotIn("never-in-log", output.getvalue())
        observation = path / "interrupted.observations.jsonl"
        self.assertEqual(stat.S_IMODE(observation.stat().st_mode), 0o600)
        self.assertEqual(caller.strict_json(observation.read_bytes())["ssh_key_id"], 812345)
        self.assertNotIn("never-in-log", observation.read_text())
        self.assertNotIn("private_field", observation.read_text())
        self.assertFalse((path / "interrupted.json").exists())
        self.assertNotIn("ssh_key_id", caller.progress({"ssh_key_id": True, "result": "unexpected-secret"}))
        self.assertNotIn("result", caller.progress({"result": "unexpected-secret"}))
        self.assertEqual(caller.progress({"result": {"unexpected": "value"}, "guest_key_cleanup": []}),
                         {"server_id": 9069403, "public_ipv4": "80.68.156.131"})
        owned = {"backend": "a" * 64, "frontend": "b" * 64}
        self.assertEqual(caller.progress({"activation": {"start": {"owned_containers": owned}}})["owned_containers"], owned)
        self.assertEqual(caller.progress({"initialization": {"postgres_id": "c" * 64}})["postgres_id"], "c" * 64)
        self.assertNotIn("postgres_id", caller.progress({"initialization": {"postgres_id": "arbitrary-sensitive-output"}}))

    def test_database_producer_requires_complete_success_and_captures_exact_run(self):
        self.env["TIMEWEB_CLOUD_TOKEN"] = "offline-timeweb-secret"
        def initialize(argv, *, environ):
            self.assertEqual(argv, ["--initialize-new-empty-database"])
            self.assertEqual(environ.pop("TIMEWEB_CLOUD_TOKEN"), "offline-timeweb-secret")
            print("TIMEWEB_DATABASE_INITIALIZATION=" + json.dumps(self.request["database_outer"]))
            return 0
        with patch.object(local.initialization, "main", side_effect=initialize), contextlib.redirect_stdout(io.StringIO()):
            caller.initialize_database(self.env, local)
        path = caller.folder(self.env)
        value = caller.read_json(path / "database-handoff.json")
        self.assertEqual(value["run_id"], self.env["GITHUB_RUN_ID"])
        self.assertEqual(value["control_commit"], self.env["GITHUB_SHA"])
        self.assertEqual(value["database_outer"], self.request["database_outer"])
        self.assertEqual(value["source_hashes"], self.envelope["source_hashes"])
        self.assertNotIn("offline-timeweb-secret", (path / "database-handoff.json").read_text())

    def test_local_call_receives_private_bound_input_and_only_timeweb_credentials(self):
        self.authenticate()
        path = caller.folder(self.env)
        caller.write_json(path / "api-outer.json", self.request["api_outer"])
        self.env["TIMEWEB_CLOUD_TOKEN"] = "offline-timeweb-secret"
        result = {"schema": 1, "result": "APPLICATION_LOCAL_ACCEPTED_ONLY", "error": None,
            "server_id": 9069403, "public_ipv4": "80.68.156.131", "host_key_fingerprint": local.stage.PINNED_FINGERPRINT,
            "server_status": "on", "ssh_key_id": 812346, "guest_key_cleanup": "API_DELETE_CONFIRMED",
            "account_key_cleanup": "API_DELETE_CONFIRMED", "local_key_cleanup": "REMOVED", "guest_temp_cleanup": "REMOVED",
            "remote_directory": "/run/kinetra-local-activation-" + fixtures.NONCE, "activation_outcome": "ACCEPTED_OBSERVED",
            "activation": fixtures.successful_remote(), "full_launch_accepted": False, "caddy_started": False,
            "database_policy_changed": False, "provider_requests": 0}
        def start(argv, *, environ):
            self.assertEqual(argv[:2], ["--activate-local-application", "--private-input"])
            supplied = caller.read_json(Path(argv[2]))
            local.validate_request(supplied, environ)
            result.update(approved_input_sha256=caller.digest(supplied["approved"]), provenance_sha256=caller.digest(supplied["provenance"]))
            self.assertFalse(any(environ.get(name) for name in local.prepare.activation.PROVIDER_ENV_KEYS))
            self.assertEqual(environ.pop("TIMEWEB_CLOUD_TOKEN"), "offline-timeweb-secret")
            print("TIMEWEB_LOCAL_APPLICATION=" + json.dumps(result))
            return 0
        with patch.object(local, "main", side_effect=start), contextlib.redirect_stdout(io.StringIO()):
            caller.start_local(self.env, local)
        self.assertEqual(stat.S_IMODE((path / "local-start-input.json").stat().st_mode), 0o600)
        accepted = caller.read_json(path / "accepted-local-handoff.json")
        self.assertEqual(accepted["local_outer"], result)
        self.assertEqual(accepted["request_sha256"], caller.digest(caller.read_json(path / "local-start-input.json")))
        self.assertEqual(accepted["approved"], self.request["approved"])
        self.assertEqual(caller.digest(accepted["approved"]), result["approved_input_sha256"])
        request = caller.read_json(path / "local-start-input.json")
        for key, invalid in (("approved_input_sha256", "0" * 64), ("provenance_sha256", "0" * 64),
                             ("guest_key_cleanup", "PENDING"), ("extra", "must-not-be-uploaded")):
            with self.subTest(key=key), self.assertRaises(caller.CallerError):
                caller.validate_local_outer(dict(result, **{key: invalid}), request, local)

    def test_activation_requires_exact_current_run_and_reviewed_inputs(self):
        caller.execution(self.env)
        for key, value in (("GITHUB_REPOSITORY", "other/project"), ("GITHUB_RUN_ATTEMPT", "2"),
                           ("GITHUB_REF", "refs/heads/main"), ("ACTIVATE_LOCAL_APPLICATION", "REVIEW_REQUIRED"),
                           ("APPROVED_DATABASE_ARTIFACT_SHA256", "REVIEW_REQUIRED"), ("APPROVED_APP_COMMIT", "REVIEW_REQUIRED")):
            changed = dict(self.env, **{key: value})
            with self.subTest(key=key), self.assertRaises(caller.CallerError):
                caller.execution(changed)


if __name__ == "__main__":
    unittest.main()
