#!/usr/bin/env python3
"""Dormant Actions caller: authenticated DB handoff -> API env -> local startup.

No HTTPS, boot-policy, worker, payment, delivery or resource-provisioning phase.
Authentication runs in a GitHub-token-only step. Auth provider credentials exist
only in the separate API preparation step and are consumed by its frozen wrapper.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import zipfile

REPOSITORY = "San4o9910/Kinetra"
CONTROL_REF = "refs/heads/ops/timeweb-hourly-preflight-20260909"
DATABASE_WORKFLOW = ".github/workflows/timeweb-database-initialization.yml"
PINS = {
    "activate-local-application-host.py": "ff830efde33df94ae08899c9b6199f4c3addffa595c03b823b7036d2bd4f38bb",
    "verify-launch-provenance.py": "465b7a22cf59d5b3a9e40fb203b45ffeee97e7780ba54a6e315f09f4cc9d3366",
}
SOURCE_ENV = ("APPROVED_APP_COMMIT", "APPROVED_BASE_COMMIT", "APPROVED_MERGE_COMMIT", "APPROVED_HEAD_RUN",
              "APPROVED_MERGE_RUN", "APPROVED_IMAGE_RUN", "APPROVED_IMAGE_CONTROL_COMMIT",
              "APPROVED_IMAGE_WORKFLOW_SHA256", "APPROVED_IMAGE_ARTIFACT_ID", "APPROVED_IMAGE_ARTIFACT_SHA256",
              "NODE_IMAGE", "NGINX_IMAGE", "BACKEND_IMAGE", "FRONTEND_IMAGE", "POSTGRES_IMAGE")
DATABASE_ENV = ("APPROVED_DATABASE_RUN", "APPROVED_DATABASE_CONTROL_COMMIT", "APPROVED_DATABASE_WORKFLOW_SHA256",
                "APPROVED_DATABASE_ARTIFACT_ID", "APPROVED_DATABASE_ARTIFACT_SHA256")
LIMIT = 131072


class CallerError(Exception):
    pass


def require(condition, category):
    if not condition:
        raise CallerError(category)


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "DUPLICATE_JSON_KEY")
            value[key] = item
        return value
    def nonfinite(_value):
        raise CallerError("NONFINITE_JSON_VALUE")
    require(isinstance(raw, (str, bytes)) and len(raw) <= LIMIT, "HANDOFF_SIZE_INVALID")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)


def load(name):
    path = Path(__file__).with_name(name)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022
            and 0 < info.st_size <= 262144 and hashlib.sha256(path.read_bytes()).hexdigest() == PINS[name],
            "PINNED_CALLER_DEPENDENCY_REQUIRED")
    spec = importlib.util.spec_from_file_location("kinetra_caller_" + name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def execution(environ, *, database=False):
    require(environ.get("GITHUB_ACTIONS") == "true" and environ.get("GITHUB_REPOSITORY") == REPOSITORY
            and environ.get("GITHUB_REF") == CONTROL_REF and environ.get("GITHUB_RUN_ATTEMPT") == "1",
            "EXACT_NEW_CONTROL_RUN_REQUIRED")
    require(re.fullmatch(r"[1-9][0-9]{0,19}", environ.get("GITHUB_RUN_ID", ""))
            and re.fullmatch(r"[a-f0-9]{40}", environ.get("GITHUB_SHA", "")), "CALLER_RUN_IDENTITY_INVALID")
    flag = "ACTIVATE_DATABASE_INITIALIZATION" if database else "ACTIVATE_LOCAL_APPLICATION"
    require(environ.get(flag) == "APPROVED", "EXPLICIT_ACTIVATION_INPUT_REQUIRED")
    require(all(environ.get(name) and environ[name] != "REVIEW_REQUIRED" for name in SOURCE_ENV), "SOURCE_REVIEW_INPUTS_REQUIRED")
    if not database:
        for name in DATABASE_ENV:
            pattern = r"[a-f0-9]{64}" if name.endswith("SHA256") else r"[a-f0-9]{40}" if name.endswith("COMMIT") else r"[1-9][0-9]{0,19}"
            require(re.fullmatch(pattern, environ.get(name, "")), "DATABASE_REVIEW_INPUTS_REQUIRED")


def folder(environ, *, create=False):
    root = Path(environ.get("RUNNER_TEMP", ""))
    require(root.is_absolute() and root.resolve() == root and root.is_dir(), "RUNNER_TEMP_INVALID")
    path = root / ("kinetra-launch-caller-" + environ["GITHUB_RUN_ID"] + "-1")
    if create:
        path.mkdir(mode=0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700
            and path.resolve() == path, "CALLER_FOLDER_IDENTITY_INVALID")
    return path


def write_json(path, value):
    raw = canonical_bytes(value)
    require(len(raw) <= LIMIT, "HANDOFF_SIZE_INVALID")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= LIMIT, "PRIVATE_HANDOFF_FILE_INVALID")
        return strict_json(stream.read(LIMIT + 1))


def source_metadata(local, environ):
    metadata = local.stage.metadata(environ)
    sources = local.stage.source_bundle(environ.get("APP_CHECKOUT", ""), metadata["commit"])
    return dict(metadata, source_hashes={name: item["sha256"] for name, item in sources.items()},
                migration_hashes=local.initialization.migration_hashes(environ.get("APP_CHECKOUT", ""), metadata["commit"]))


def validate_database_envelope(value, metadata, local, environ):
    keys = {"schema", "repository", "run_id", "run_attempt", "control_commit", "commit", "images",
            "source_hashes", "migration_hashes", "database_outer"}
    require(isinstance(value, dict) and set(value) == keys and type(value["schema"]) is int and value["schema"] == 1
            and value["repository"] == REPOSITORY and value["run_id"] == environ["APPROVED_DATABASE_RUN"]
            and type(value["run_attempt"]) is int and value["run_attempt"] == 1
            and value["control_commit"] == environ["APPROVED_DATABASE_CONTROL_COMMIT"], "DATABASE_ARTIFACT_IDENTITY_INVALID")
    require(all(value[key] == metadata[key] for key in metadata), "DATABASE_SOURCE_HANDOFF_MISMATCH")
    local.successful_outer(value["database_outer"], api=False)
    initialized = local.initialization.validate_initialization_result(json.dumps(value["database_outer"]["initialization"]))
    require(initialized["commit"] == metadata["commit"] and initialized["result"] == "DATABASE_INITIALIZED_ONLY",
            "SUCCESSFUL_DATABASE_HANDOFF_REQUIRED")
    return value


def verified_database(environ, local, api, successful_run):
    metadata = source_metadata(local, environ)
    run_id = environ["APPROVED_DATABASE_RUN"]
    run, jobs = successful_run(run_id, DATABASE_WORKFLOW, environ["APPROVED_DATABASE_CONTROL_COMMIT"], "push")
    require(run["head_branch"] == CONTROL_REF.removeprefix("refs/heads/") and len(jobs) == 1
            and jobs[0]["name"] == "initialize-database", "DATABASE_RUN_IDENTITY_INVALID")
    source = api("/contents/" + DATABASE_WORKFLOW + "?ref=" + environ["APPROVED_DATABASE_CONTROL_COMMIT"])
    require(source["type"] == "file" and source["encoding"] == "base64", "DATABASE_WORKFLOW_INVALID")
    workflow = base64.b64decode(source["content"])
    require(hashlib.sha256(workflow).hexdigest() == environ["APPROVED_DATABASE_WORKFLOW_SHA256"], "DATABASE_WORKFLOW_HASH_MISMATCH")
    artifact = api("/actions/artifacts/" + environ["APPROVED_DATABASE_ARTIFACT_ID"])
    require(artifact["id"] == int(environ["APPROVED_DATABASE_ARTIFACT_ID"]) and artifact["expired"] is False
            and artifact["name"] == "kinetra-database-handoff-" + run_id + "-1"
            and artifact["workflow_run"]["id"] == int(run_id)
            and artifact["workflow_run"]["head_sha"] == environ["APPROVED_DATABASE_CONTROL_COMMIT"]
            and artifact["digest"] == "sha256:" + environ["APPROVED_DATABASE_ARTIFACT_SHA256"]
            and 0 < artifact["size_in_bytes"] <= LIMIT, "DATABASE_ARTIFACT_PROVENANCE_INVALID")
    archive = api("/actions/artifacts/" + environ["APPROVED_DATABASE_ARTIFACT_ID"] + "/zip", archive=True)
    require(len(archive) <= LIMIT and hashlib.sha256(archive).hexdigest() == environ["APPROVED_DATABASE_ARTIFACT_SHA256"],
            "DATABASE_ARTIFACT_DIGEST_MISMATCH")
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        require(zipped.namelist() == ["database-handoff.json"], "DATABASE_ARTIFACT_MEMBERS_INVALID")
        member = zipped.getinfo("database-handoff.json")
        require(not member.is_dir() and not member.flag_bits & 1 and member.file_size <= LIMIT
                and stat.S_IFMT(member.external_attr >> 16) in {0, stat.S_IFREG}, "DATABASE_ARTIFACT_MEMBER_INVALID")
        value = validate_database_envelope(strict_json(zipped.read(member)), metadata, local, environ)
    return value


def authenticate_database(environ, local, api, successful_run):
    value = verified_database(environ, local, api, successful_run)
    path = folder(environ, create=True)
    write_json(path / "database-handoff.json", value)
    receipt = {"schema": 1, "caller_commit": environ["GITHUB_SHA"], "caller_run": environ["GITHUB_RUN_ID"],
               "inputs": {name: environ[name] for name in (*SOURCE_ENV, *DATABASE_ENV)}, "database_handoff_sha256": digest(value)}
    write_json(path / "database-authentication.json", receipt)
    print("KINETRA_DATABASE_HANDOFF_AUTHENTICATED=PASS")


def prior_database(environ, local):
    path = folder(environ)
    receipt = read_json(path / "database-authentication.json")
    value = read_json(path / "database-handoff.json")
    require(receipt == {"schema": 1, "caller_commit": environ["GITHUB_SHA"], "caller_run": environ["GITHUB_RUN_ID"],
                        "inputs": {name: environ[name] for name in (*SOURCE_ENV, *DATABASE_ENV)}, "database_handoff_sha256": digest(value)},
            "DATABASE_AUTHENTICATION_RECEIPT_CHANGED")
    validate_database_envelope(value, source_metadata(local, environ), local, environ)
    return path, value


def capture(callback, prefix, path):
    # Preserve every completed observation immediately. A later interruption
    # must not erase an already emitted key/container identity needed for cleanup.
    public_stdout = sys.stdout
    fd = os.open(path.with_suffix(".observations.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as observations:
        class Sink:
            pending, total, last = "", 0, None
            def write(self, text):
                self.total += len(text)
                require(self.total <= LIMIT, "WRAPPER_OUTPUT_TOO_LARGE")
                self.pending += text
                while "\n" in self.pending:
                    line, self.pending = self.pending.split("\n", 1)
                    require(line.startswith(prefix), "WRAPPER_OUTPUT_INVALID")
                    state = strict_json(line[len(prefix):])
                    require(isinstance(state, dict), "WRAPPER_OUTER_OBJECT_REQUIRED")
                    summary = progress(state)
                    observations.write(canonical_bytes(summary) + b"\n")
                    observations.flush()
                    os.fsync(observations.fileno())
                    self.last = state
                    print("KINETRA_CALLER_PROGRESS=" + json.dumps(summary, sort_keys=True), file=public_stdout, flush=True)
                return len(text)
            def flush(self):
                observations.flush()
        output = Sink()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = callback()
        require(output.last is not None and not output.pending, "WRAPPER_OUTPUT_INCOMPLETE")
    require(code == 0, "WRAPPER_FAILED_STATE_PRESERVED")
    return output.last


def progress(state):
    """Only fixed identities and explicit public state categories reach logs."""
    result = {"server_id": 9069403, "public_ipv4": "80.68.156.131"}
    outcomes = {"IN_PROGRESS", "FAIL", "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED",
                "API_ENVIRONMENT_PREPARED_ONLY", "APPLICATION_LOCAL_ACCEPTED_ONLY"}
    if isinstance(state.get("result"), str) and state["result"] in outcomes:
        result["result"] = state["result"]
    key_id = state.get("ssh_key_id")
    if type(key_id) is int and key_id > 0:
        result["ssh_key_id"] = key_id
    cleanup = {"NOT_NEEDED", "PENDING", "ATTACH_OUTCOME_UNKNOWN", "API_DELETE_CONFIRMED", "ALREADY_ABSENT",
               "REMOVED", "UNKNOWN_RECONCILE", "FAILED_RECONCILE", "FAILED", "DELETE_OUTCOME_UNKNOWN", "UNVERIFIED_KEY_RECONCILE"}
    for name in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup"):
        if isinstance(state.get(name), str) and state[name] in cleanup:
            result[name] = state[name]
    directory = state.get("remote_directory")
    if isinstance(directory, str) and re.fullmatch(r"/run/kinetra-(?:api-preparation|local-activation)-[a-f0-9]{32}", directory):
        result["remote_directory"] = directory
    initialization = state.get("initialization")
    if isinstance(initialization, dict):
        postgres_id = initialization.get("postgres_id")
        if isinstance(postgres_id, str) and re.fullmatch(r"[a-f0-9]{64}", postgres_id):
            result["postgres_id"] = postgres_id
    activation = state.get("activation")
    if isinstance(activation, dict) and isinstance(activation.get("start"), dict):
        owned = activation["start"].get("owned_containers")
        if isinstance(owned, dict) and set(owned) <= {"backend", "frontend"} and all(
                isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in owned.values()):
            result["owned_containers"] = owned
    return result


def initialize_database(environ, local):
    require(not any(environ.get(name) for name in (*local.prepare.activation.PROVIDER_ENV_KEYS, "GH_TOKEN", "GITHUB_TOKEN")),
            "PROVIDER_OR_REGISTRY_TOKEN_NOT_ALLOWED")
    metadata = source_metadata(local, environ)
    path = folder(environ, create=True)
    outer = capture(lambda: local.initialization.main(["--initialize-new-empty-database"], environ=environ),
                    "TIMEWEB_DATABASE_INITIALIZATION=", path / "database-outer.json")
    local.successful_outer(outer, api=False)
    local.initialization.validate_initialization_result(json.dumps(outer["initialization"]))
    require(outer["initialization"]["commit"] == metadata["commit"], "DATABASE_COMMIT_MISMATCH")
    write_json(path / "database-outer.json", outer)
    write_json(path / "database-handoff.json", {"schema": 1, "repository": REPOSITORY, "run_id": environ["GITHUB_RUN_ID"],
               "run_attempt": 1, "control_commit": environ["GITHUB_SHA"], **metadata, "database_outer": outer})
    print("KINETRA_DATABASE_HANDOFF_CAPTURED=PASS")


def prepare_api(environ, local):
    require(not environ.get("GH_TOKEN") and not environ.get("GITHUB_TOKEN"), "GITHUB_TOKEN_NOT_ALLOWED")
    path, _database = prior_database(environ, local)
    metadata = source_metadata(local, environ)
    outer = capture(lambda: local.prepare.main(["--prepare-api-environment", "--provider-env"], environ=environ),
                    "TIMEWEB_API_PREPARATION=", path / "api-outer.json")
    local.successful_outer(outer, api=True)
    local.prepare.validate_remote(json.dumps(outer["preparation"]), metadata, outer["remote_directory"].rsplit("-", 1)[1])
    write_json(path / "api-outer.json", outer)
    print("KINETRA_API_OUTER_CAPTURED=PASS")


def start_request(environ, local, database, api):
    local.successful_outer(database["database_outer"], api=False)
    local.successful_outer(api, api=True)
    metadata = source_metadata(local, environ)
    prepared = local.prepare.validate_remote(json.dumps(api["preparation"]), metadata, api["remote_directory"].rsplit("-", 1)[1])
    hashes = prepared["preparation"]
    approved = {"schema": 1, "server_id": 9069403, "public_ipv4": "80.68.156.131", **metadata,
                "handoff_hashes": hashes["handoff_hashes"], "configuration_hashes": hashes["configuration_hashes"]}
    environ["APPROVED_DATABASE_OUTER_SHA256"] = digest(database["database_outer"])
    environ["APPROVED_API_OUTER_SHA256"] = digest(api)
    provenance = {key: environ[name] for key, name in local.PROVENANCE_ENV.items()}
    provenance.update(repository=REPOSITORY, pr_number=21, head_ref="refs/heads/feature/onboarding-exploration-mode",
                      merge_ref="refs/pull/21/merge", billing="hourly", monthly_budget_rub=2000, approved_input_sha256=digest(approved))
    environ["APPROVED_PROVENANCE_SHA256"] = digest(provenance)
    request = {"schema": 1, "approved": approved, "provenance": provenance, "database_outer": database["database_outer"], "api_outer": api}
    local.validate_request(request, environ)
    return request


def validate_local_outer(result, request, local):
    keys = {"schema", "result", "server_id", "public_ipv4", "host_key_fingerprint", "server_status", "ssh_key_id",
            "remote_directory", "guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup",
            "activation", "activation_outcome", "error", "approved_input_sha256", "provenance_sha256", "caddy_started",
            "database_policy_changed", "provider_requests", "full_launch_accepted"}
    require(isinstance(result, dict) and set(result) == keys and type(result["schema"]) is int and result["schema"] == 1,
            "LOCAL_OUTER_SCHEMA_INVALID")
    require(result["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" and result["error"] is None
            and result["full_launch_accepted"] is False and result["caddy_started"] is False
            and result["database_policy_changed"] is False and type(result["provider_requests"]) is int
            and result["provider_requests"] == 0, "LOCAL_ONLY_APPLICATION_ACCEPTANCE_REQUIRED")
    require(type(result["server_id"]) is int and result["server_id"] == 9069403 and result["public_ipv4"] == "80.68.156.131"
            and result["server_status"] == "on" and result["host_key_fingerprint"] == local.stage.PINNED_FINGERPRINT
            and type(result["ssh_key_id"]) is int and result["ssh_key_id"] > 0, "LOCAL_OUTER_IDENTITY_INVALID")
    require(result["guest_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and result["account_key_cleanup"] in {"API_DELETE_CONFIRMED", "ALREADY_ABSENT"}
            and result["local_key_cleanup"] == "REMOVED" and result["guest_temp_cleanup"] == "REMOVED",
            "LOCAL_OUTER_COMPLETE_CLEANUP_REQUIRED")
    require(result["approved_input_sha256"] == digest(request["approved"])
            and result["provenance_sha256"] == digest(request["provenance"]), "LOCAL_OUTER_APPROVED_HASH_MISMATCH")
    directory = result["remote_directory"]
    require(isinstance(directory, str) and re.fullmatch(r"/run/kinetra-local-activation-[a-f0-9]{32}", directory),
            "LOCAL_OUTER_REMOTE_IDENTITY_INVALID")
    remote = local.validate_remote(json.dumps(result["activation"]), request["approved"], directory.rsplit("-", 1)[1])
    require(remote["result"] == "APPLICATION_LOCAL_ACCEPTED_ONLY" and result["activation_outcome"] == "ACCEPTED_OBSERVED"
            and remote["remote_directory"] == directory, "LOCAL_OUTER_REMOTE_ACCEPTANCE_REQUIRED")


def start_local(environ, local):
    require(not any(environ.get(name) for name in (*local.prepare.activation.PROVIDER_ENV_KEYS, "GH_TOKEN", "GITHUB_TOKEN")),
            "PROVIDER_OR_GITHUB_TOKEN_NOT_ALLOWED")
    path, database = prior_database(environ, local)
    request = start_request(environ, local, database, read_json(path / "api-outer.json"))
    private_input = path / "local-start-input.json"
    write_json(private_input, request)
    result = capture(lambda: local.main(["--activate-local-application", "--private-input", str(private_input)], environ=environ),
                     "TIMEWEB_LOCAL_APPLICATION=", path / "local-outer.json")
    validate_local_outer(result, request, local)
    write_json(path / "local-outer.json", result)
    write_json(path / "accepted-local-handoff.json", {"schema": 1, "request_sha256": digest(request), "local_outer": result,
               "approved": request["approved"], "database_outer": request["database_outer"], "api_outer": request["api_outer"],
               "provenance": request["provenance"]})
    print("KINETRA_APPLICATION_LOCAL_CALLER=PASS_LOCAL_ONLY")


def main(argv=None, environ=None):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    try:
        require(len(argv) == 1 and argv[0] in {"--authenticate-database", "--recheck-provenance", "--initialize-database", "--prepare-api", "--start-local"},
                "EXPLICIT_CALLER_PHASE_REQUIRED")
        execution(environ, database=argv[0] == "--initialize-database")
        local = load("activate-local-application-host.py")
        signal.signal(signal.SIGTERM, local.inspection.interrupted)
        if argv[0] in {"--authenticate-database", "--recheck-provenance"}:
            require(not any(environ.get(name) for name in (*local.prepare.activation.PROVIDER_ENV_KEYS, "TIMEWEB_CLOUD_TOKEN")),
                    "AUTHENTICATION_STEP_MUST_HAVE_ONLY_GITHUB_TOKEN")
            # Original complete image/source gate, followed by authenticated DB evidence.
            api, successful_run = load("verify-launch-provenance.py").verify_source_and_images()
            if argv[0] == "--authenticate-database":
                authenticate_database(environ, local, api, successful_run)
            else:
                _path, previous = prior_database(environ, local)
                require(verified_database(environ, local, api, successful_run) == previous, "DATABASE_PROVENANCE_RECHECK_CHANGED")
                print("KINETRA_CURRENT_LAUNCH_PROVENANCE_RECHECK=PASS")
        elif argv[0] == "--initialize-database":
            initialize_database(environ, local)
        elif argv[0] == "--prepare-api":
            prepare_api(environ, local)
        else:
            start_local(environ, local)
        return 0
    except BaseException as error:
        category = str(error) if isinstance(error, CallerError) and re.fullmatch(r"[A-Z_]{1,90}", str(error)) else "CALLER_FAILED_PRIVATE_STATE_PRESERVED"
        print("KINETRA_APPLICATION_CALLER=FAIL:" + category, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
