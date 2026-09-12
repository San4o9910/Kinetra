#!/usr/bin/env python3
"""Supplement image scanning with explicit upstream CPE coverage.

Only the database update has network access. Positive-control and production
SBOM scans use the same database offline. No image/registry publication occurs.
The caller first verifies the embedded source SBOM against the built binaries.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone


VERSION = "0.118.0"
COMMIT = "756eb9a24f7beeafb6871a24e943e8a3ae210695"
EXPECTED = {"ffmpeg": "9.0.1", "imagemagick": "7.1.2-30"}
CONTROL = {"ffmpeg": "5.1.9", "imagemagick": "7.1.2-29"}
CONTROL_CVES = {
    "ffmpeg": {"CVE-2026-8461"},
    "imagemagick": {"CVE-2026-86420", "CVE-2026-86421"},
}
IMAGE_PATTERN = re.compile(
    r"(?:docker\.io/)?anchore/grype@sha256:[a-f0-9]{64}$"
    r"|ghcr\.io/anchore/grype@sha256:[a-f0-9]{64}$"
)
MAX_JSON = 64 * 1024 * 1024
DISK_BUDGET = 8 * 1024**3
DISK_RESERVE = 2 * 1024**3
FILE_LIMIT = 4 * 1024**3
LABEL = "io.kinetra.upstream-scan"


class GateError(Exception):
    """Fixed nonsecret failure category suitable for a CI summary."""


def require(condition, category):
    if not condition:
        raise GateError(category)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "missing-json-evidence")
    require(0 < path.stat().st_size <= MAX_JSON, "invalid-json-evidence-size")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise GateError("invalid-json-evidence") from None


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def cpe(name, version):
    return f"cpe:2.3:a:{name}:{name}:{version}:*:*:*:*:*:*:*"


def same_cpe(value, name, version):
    # CPE formatted-string serialization may escape a literal version hyphen.
    return isinstance(value, str) and value.replace("\\-", "-") == cpe(name, version)


def identities(bom, expected, input_bom=False):
    require(isinstance(bom, dict) and bom.get("bomFormat") == "CycloneDX", "invalid-bom-format")
    require(bom.get("specVersion") == ("1.6" if input_bom else "1.7"), "invalid-bom-version")
    components = bom.get("components")
    require(isinstance(components, list) and len(components) == len(expected), "missing-component-coverage")
    seen = set()
    for component in components:
        require(isinstance(component, dict), "invalid-component")
        name = component.get("name")
        require(name in expected and name not in seen, "unexpected-component")
        version = expected[name]
        require(component.get("version") == version, "component-version-mismatch")
        require(component.get("purl") == f"pkg:generic/{name}@{version}", "component-purl-mismatch")
        require(same_cpe(component.get("cpe"), name, version), "component-cpe-mismatch")
        require(not component.get("components"), "unexpected-nested-components")
        seen.add(name)
    require(seen == set(expected), "missing-component-coverage")
    if input_bom:
        require(not bom.get("vulnerabilities"), "prepopulated-vulnerability-input")


def validate_db(status, now=None):
    require(isinstance(status, dict) and status.get("valid") is True, "invalid-database-status")
    require(not status.get("error"), "database-status-error")
    # Grype v0.118.0 serializes SchemaVer.String() with a leading "v".
    # Preserve the reported spelling for exact database identity comparisons.
    require(isinstance(status.get("schemaVersion"), str)
            and re.fullmatch(r"v?6(?:\.\d+){0,2}", status["schemaVersion"]), "unexpected-database-schema")
    require(isinstance(status.get("from"), str)
            and status["from"].startswith("https://grype.anchore.io/"), "unexpected-database-source")
    try:
        built = datetime.fromisoformat(status["built"].replace("Z", "+00:00"))
        require(built.tzinfo is not None, "invalid-database-timestamp")
        age = ((now or datetime.now(timezone.utc)) - built).total_seconds()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise GateError("invalid-database-timestamp") from None
    require(-300 <= age <= 120 * 3600, "stale-or-future-database")
    path = status.get("path")
    require(isinstance(path, str) and path.startswith("/cache/")
            and ".." not in Path(path).parts, "unexpected-database-path")


def validate_report(report, bom, expected, status, control=False):
    require(isinstance(report, dict), "invalid-scan-report")
    descriptor = report.get("descriptor", {})
    require(descriptor.get("name") == "grype" and descriptor.get("version") == VERSION,
            "unexpected-scanner-version")
    cfg = descriptor.get("configuration")
    require(isinstance(cfg, dict), "missing-scan-configuration")
    require(cfg.get("match", {}).get("stock", {}).get("using-cpes") is True, "cpe-matching-disabled")
    require(cfg.get("add-cpes-if-none") is False, "undeclared-cpe-generation")
    require(cfg.get("only-fixed") is False and cfg.get("only-notfixed") is False, "fix-state-filter-enabled")
    require(cfg.get("match-upstream-kernel-headers") is True, "implicit-kernel-ignore-rules-enabled")
    for key in ("ignore", "exclude", "vex-documents", "vex-add", "ignore-wontfix"):
        require(key in cfg and not cfg[key], "result-suppression-enabled-or-unknown")
    require(cfg.get("fail-on-severity") == "high", "severity-threshold-changed")
    db_cfg = cfg.get("db", {})
    require(db_cfg.get("auto-update") is False and db_cfg.get("validate-age") is True
            and db_cfg.get("validate-by-hash-on-start") is True, "database-validation-disabled")
    reported_db = descriptor.get("db")
    validate_db(reported_db)
    require(all(reported_db.get(key) == status.get(key) for key in
                ("schemaVersion", "from", "built", "path")), "scan-database-mismatch")
    require(not report.get("ignoredMatches"), "ignored-findings-present")
    identities(bom, expected)
    tools = bom.get("metadata", {}).get("tools", {}).get("components", [])
    require(any(t.get("name") == "grype" and t.get("version") == VERSION for t in tools),
            "missing-scanner-bom-identity")
    matches = report.get("matches")
    require(isinstance(matches, list), "missing-matches-array")
    found = {name: set() for name in expected}
    sanitized = []
    for match in matches:
        require(isinstance(match, dict), "invalid-match")
        artifact, vuln = match.get("artifact", {}), match.get("vulnerability", {})
        name = artifact.get("name")
        require(name in expected, "unexpected-matched-component")
        version = expected[name]
        require(artifact.get("version") == version
                and artifact.get("purl") == f"pkg:generic/{name}@{version}", "matched-identity-mismatch")
        require(isinstance(artifact.get("cpes"), list)
                and any(same_cpe(value, name, version) for value in artifact["cpes"]), "matched-cpe-missing")
        require(any(d.get("type") == "cpe-match" and d.get("matcher") == "stock-matcher"
                    for d in match.get("matchDetails", [])), "upstream-cpe-match-not-proven")
        identifier, severity = vuln.get("id"), vuln.get("severity")
        require(isinstance(identifier, str) and re.fullmatch(r"CVE-\d{4}-\d{4,}", identifier), "unexpected-vulnerability-id")
        require(severity in ("Unknown", "Negligible", "Low", "Medium", "High", "Critical"), "invalid-severity")
        found[name].add(identifier)
        sanitized.append({"component": name, "version": version, "id": identifier, "severity": severity})
    if control:
        require(all(CONTROL_CVES[name] <= found[name] for name in CONTROL_CVES), "positive-control-coverage-missing")
        require(any(row["severity"] in ("High", "Critical") for row in sanitized), "positive-control-threshold-not-triggered")
    else:
        require(not any(row["severity"] in ("High", "Critical") for row in sanitized), "high-or-critical-upstream-findings")
    return sanitized


def measure_disk(work, output, initial_free):
    measured = {"logical_bytes": 0, "allocated_bytes": 0, "accounted_bytes": 0,
                "cache_bytes": 0, "cache_tmp_bytes": 0, "database_bytes": 0,
                "max_file_bytes": 0, "database_files": []}
    cache = work / "cache"
    count = 0
    for root in (work, output):
        for path in root.rglob("*"):
            count += 1
            require(count < 100000, "scanner-file-count-limit")
            try:
                item = path.lstat()
            except FileNotFoundError:
                # The updater legitimately removes completed download files.
                continue
            require(not stat.S_ISLNK(item.st_mode), "scanner-created-symlink")
            if not stat.S_ISREG(item.st_mode):
                continue
            logical, allocated = item.st_size, item.st_blocks * 512
            accounted = max(logical, allocated)
            measured["logical_bytes"] += logical
            measured["allocated_bytes"] += allocated
            measured["accounted_bytes"] += accounted
            measured["max_file_bytes"] = max(measured["max_file_bytes"], logical)
            if path.is_relative_to(cache):
                measured["cache_bytes"] += accounted
                if path.is_relative_to(cache / "tmp"):
                    measured["cache_tmp_bytes"] += accounted
                if path.name == "vulnerability.db":
                    measured["database_bytes"] += logical
                    measured["database_files"].append({"path": path.relative_to(cache).as_posix(),
                                                        "logical_bytes": logical, "allocated_bytes": allocated})
    measured["free_bytes"] = shutil.disk_usage(work).free
    # SQLite can unlink temporary files while keeping their descriptors open.
    # Also bound filesystem consumption so those writes cannot evade the scan
    # directory accounting. Concurrent runner disk growth fails conservatively.
    measured["filesystem_consumed_bytes"] = max(0, initial_free - measured["free_bytes"])
    measured["bounded_bytes"] = max(measured["accounted_bytes"], measured["filesystem_consumed_bytes"])
    return measured


class Scanner:
    def __init__(self, image, work, output):
        require(IMAGE_PATTERN.fullmatch(image) is not None, "scanner-image-not-pinned")
        self.image, self.work, self.output = image, work, output
        self.cache, self.inputs = work / "cache", work / "input"
        for path in (self.cache, self.inputs):
            path.mkdir(mode=0o700)
        (self.cache / "tmp").mkdir(mode=0o700)
        self.initial_free = shutil.disk_usage(work).free
        self.uid, self.gid = os.getuid(), os.getgid()
        self.env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        self.env["TMPDIR"] = str(work)
        self.image_id = None
        self.calls = []

    def observe_disk(self, call, enforce=True):
        measured = measure_disk(self.work, self.output, self.initial_free)
        call["disk_final"] = measured
        peaks = call.setdefault("disk_peak", {})
        for key, value in measured.items():
            if key.endswith("_bytes") and key != "free_bytes":
                peaks[key] = max(peaks.get(key, 0), value)
        call["minimum_free_bytes"] = min(call.get("minimum_free_bytes", measured["free_bytes"]), measured["free_bytes"])
        call["disk_samples"] = call.get("disk_samples", 0) + 1
        files = call.setdefault("database_file_peaks", {})
        for item in measured["database_files"]:
            previous = files.setdefault(item["path"], {"logical_bytes": 0, "allocated_bytes": 0})
            for key in ("logical_bytes", "allocated_bytes"):
                previous[key] = max(previous[key], item[key])
        if enforce:
            require(measured["bounded_bytes"] <= DISK_BUDGET, "scanner-disk-budget-exceeded")
            require(measured["max_file_bytes"] <= FILE_LIMIT, "scanner-file-limit-exceeded")
            require(measured["free_bytes"] >= DISK_RESERVE, "scanner-disk-reserve-exhausted")

    def docker(self, arguments, timeout=30):
        result = subprocess.run(["docker", *arguments], env=self.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(len(result.stdout) <= MAX_JSON and len(result.stderr) <= MAX_JSON, "docker-response-too-large")
        return result

    def inspect_image(self):
        result = self.docker(["image", "inspect", self.image])
        require(result.returncode == 0, "scanner-image-not-present")
        data = json.loads(result.stdout)
        require(isinstance(data, list) and len(data) == 1, "invalid-scanner-image-inspect")
        image = data[0]
        labels = image.get("Config", {}).get("Labels", {})
        require(labels.get("org.opencontainers.image.revision") == COMMIT
                and labels.get("org.opencontainers.image.version") == VERSION,
                "scanner-image-release-mismatch")
        require(labels.get("org.opencontainers.image.source") in (
            "https://github.com/anchore/grype", "https://github.com/anchore/grype.git"),
            "scanner-image-source-mismatch")
        require(image.get("Architecture") == "amd64" and image.get("Os") == "linux", "scanner-platform-mismatch")
        self.image_id = image.get("Id")
        require(isinstance(self.image_id, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", self.image_id), "scanner-image-id-missing")
        write_json(self.output / "scanner-image.json", image)

    def cleanup(self, name, nonce, cid_path):
        listed = self.docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", f"name=^/{name}$"])
        require(listed.returncode == 0, "scanner-cleanup-inspection-failed")
        ids = listed.stdout.decode().split()
        if not ids:
            return
        require(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{64}", ids[0]), "scanner-cleanup-identity-mismatch")
        inspected = self.docker(["container", "inspect", ids[0]])
        require(inspected.returncode == 0, "scanner-cleanup-inspection-failed")
        data = json.loads(inspected.stdout)
        require(len(data) == 1, "scanner-cleanup-identity-mismatch")
        item = data[0]
        require(item.get("Name") == "/" + name and item.get("Image") == self.image_id
                and item.get("Config", {}).get("Labels", {}).get(LABEL) == nonce,
                "scanner-cleanup-identity-mismatch")
        if cid_path.exists():
            require(cid_path.read_text().strip() == ids[0], "scanner-cleanup-cid-mismatch")
        removed = self.docker(["container", "rm", "--force", "--volumes", ids[0]])
        require(removed.returncode == 0, "scanner-container-cleanup-failed")
        verify = self.docker(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", f"name=^/{name}$"])
        require(verify.returncode == 0 and not verify.stdout.strip(), "scanner-container-cleanup-unconfirmed")

    def run(self, phase, arguments, network=False, timeout=300):
        nonce = uuid.uuid4().hex
        name = "kinetra-upstream-" + nonce
        cid_path = self.work / (phase + ".cid")
        command = ["docker", "run", "--pull", "never", "--name", name, "--cidfile", str(cid_path),
                   "--label", LABEL + "=" + nonce, "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges", "--user", f"{self.uid}:{self.gid}",
                   "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
                   "--ulimit", f"fsize={FILE_LIMIT}:{FILE_LIMIT}",
                   "--env", "TMPDIR=/cache/tmp", "--env", "SQLITE_TMPDIR=/cache/tmp",
                   "--network", "bridge" if network else "none", "--entrypoint", "/grype",
                   "--tmpfs", f"/tmp:rw,nosuid,nodev,noexec,size=256m,uid={self.uid},gid={self.gid},mode=0700",
                   "--mount", f"type=bind,source={self.cache},target=/cache",
                   "--mount", f"type=bind,source={self.inputs},target=/input,readonly",
                   "--mount", f"type=bind,source={self.output},target=/output",
                   self.image, *arguments]
        process = None
        started = time.monotonic()
        call = {"phase": phase, "exit_code": None, "network": network}
        self.calls.append(call)
        try:
            with (self.output / (phase + ".stdout")).open("xb") as out, (self.output / (phase + ".stderr")).open("xb") as err:
                process = subprocess.Popen(command, env=self.env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
                while process.poll() is None:
                    require(time.monotonic() - started <= timeout, "scanner-phase-timeout")
                    self.observe_disk(call)
                    time.sleep(1)
                code = process.returncode
                call["exit_code"] = code
                self.observe_disk(call)
                return code
        finally:
            # Remove only the inspected container from this exact operation.
            # On timeout, stopping the Docker client alone would leave it running.
            try:
                # Capture the state before our own container cleanup, even on
                # failed hydration. Updater-internal cleanup may already have
                # removed the DB, so retain sampled per-file peaks as well.
                try:
                    self.observe_disk(call, enforce=False)
                finally:
                    write_json(self.output / (phase + ".resources.json"), call)
            finally:
                try:
                    self.cleanup(name, nonce, cid_path)
                finally:
                    if process is not None and process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=10)


def execute(sbom_path, runner, image):
    require(IMAGE_PATTERN.fullmatch(image) is not None, "scanner-image-not-pinned")
    require(runner.is_dir() and runner.is_absolute(), "invalid-runner-temp")
    runner = runner.resolve(strict=True)
    require(sbom_path.is_file() and not sbom_path.is_symlink(), "invalid-source-sbom")
    bom = read_json(sbom_path)
    identities(bom, EXPECTED, input_bom=True)
    evidence = runner / "kinetra-image-evidence"
    require(evidence.is_dir() and not evidence.is_symlink(), "missing-image-evidence-directory")
    output = evidence / "upstream-media"
    output.mkdir(mode=0o700)
    work = runner / ("kinetra-upstream-work-" + uuid.uuid4().hex)
    work.mkdir(mode=0o700)
    summary = {"result": "FAIL", "scanner": VERSION, "scanner_image": image,
               "source_sbom_sha256": digest(sbom_path), "components": EXPECTED}
    # The preceding hydration failure was SQLITE_IOERR_WRITE (778). EFBIG from
    # the previous 2 GiB RLIMIT_FSIZE is a working hypothesis, not a proven cause:
    # that run did not capture file sizes. These bounded resources and measured
    # peaks make a subsequent failure diagnosable without changing scan policy.
    summary["resource_limits"] = {"disk_budget_bytes": DISK_BUDGET, "disk_reserve_bytes": DISK_RESERVE,
                                  "file_limit_bytes": FILE_LIMIT, "memory_bytes": 2 * 1024**3,
                                  "tmpfs_bytes": 256 * 1024**2, "temp_directory": "/cache/tmp"}
    scanner = None
    try:
        require(shutil.disk_usage(work).free >= DISK_BUDGET + DISK_RESERVE, "insufficient-scanner-disk")
        scanner = Scanner(image, work, output)
        write_json(scanner.inputs / "source-components.cdx.json", bom)
        controls = {"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1, "components": [
            {"type": "application", "name": name, "version": version,
             "bom-ref": f"pkg:generic/{name}@{version}", "purl": f"pkg:generic/{name}@{version}",
             "cpe": cpe(name, version)} for name, version in CONTROL.items()]}
        write_json(scanner.inputs / "positive-control.cdx.json", controls)
        config = {"check-for-app-update": False, "add-cpes-if-none": False,
                  # Grype otherwise appends four kernel-header ignore rules even
                  # when ignore=[]; request all matches and retain zero ignores.
                  "match-upstream-kernel-headers": True,
                  "match": {"stock": {"using-cpes": True}},
                  "ignore": [], "exclude": [], "vex-documents": [], "vex-add": [],
                  "only-fixed": False, "only-notfixed": False, "ignore-wontfix": "",
                  "db": {"cache-dir": "/cache", "auto-update": False,
                         "validate-by-hash-on-start": True, "validate-age": True,
                         "max-allowed-built-age": "120h", "require-update-check": True,
                         "update-download-timeout": "10m"}}
        # JSON is a YAML subset accepted by the explicit Grype config loader.
        write_json(scanner.inputs / "grype.yaml", config)
        # These inputs contain only public component identities and scanner
        # settings. Preserve them alongside reports in the uploaded artifact.
        for source_name, artifact_name in (
            ("source-components.cdx.json", "source-components.cdx.json"),
            ("positive-control.cdx.json", "positive-control-input.cdx.json"),
            ("grype.yaml", "grype.yaml"),
        ):
            shutil.copyfile(scanner.inputs / source_name, output / artifact_name)
        scanner.inspect_image()
        require(scanner.run("version", ["version", "-o", "json"], timeout=60) == 0, "scanner-version-failed")
        version = read_json(output / "version.stdout")
        require(version.get("application") == "grype" and version.get("version") == VERSION
                and version.get("gitCommit") == COMMIT and version.get("platform") == "linux/amd64",
                "scanner-binary-release-mismatch")
        common = ["--config", "/input/grype.yaml"]
        require(scanner.run("db-update", [*common, "db", "update"], network=True, timeout=900) == 0,
                "database-update-failed")
        require(scanner.run("db-status", [*common, "db", "status", "-o", "json"], timeout=120) == 0,
                "database-status-failed")
        status = read_json(output / "db-status.stdout")
        validate_db(status)
        db = scanner.cache / Path(status["path"]).relative_to("/cache")
        require(db.is_file() and not db.is_symlink() and db.resolve().is_relative_to(scanner.cache), "database-file-missing")
        database_hash = digest(db)
        summary["database"] = {key: status[key] for key in ("schemaVersion", "built", "from")}
        summary["database"]["sha256"] = database_hash
        for phase, filename, expected, code in (
            ("positive-control", "positive-control.cdx.json", CONTROL, 2),
            ("production", "source-components.cdx.json", EXPECTED, 0),
        ):
            result = scanner.run(phase, [*common, "sbom:/input/" + filename, "--fail-on", "high",
                                 "-o", f"json=/output/{phase}.json",
                                 "-o", f"cyclonedx-json=/output/{phase}.cdx.json"], timeout=600)
            require(digest(db) == database_hash, "database-changed-during-scan")
            findings = validate_report(read_json(output / (phase + ".json")),
                                       read_json(output / (phase + ".cdx.json")), expected, status,
                                       control=phase == "positive-control")
            require(result == code, "unexpected-scan-exit-code")
            summary[phase] = {"result": "PASS", "exit_code": result, "findings": findings,
                              "coverage": expected, "database_sha256": database_hash,
                              "network": "none"}
        summary["high_critical_findings"] = 0
        summary["result"] = "PASS"
    except GateError as error:
        summary["failure"] = str(error)
    except Exception:
        summary["failure"] = "unexpected-scanner-or-evidence-error"
    finally:
        if scanner is not None:
            summary["calls"] = scanner.calls
        summary["retained_work_directory"] = work.name
        write_json(output / "summary.json", summary)
    # Preserve all input/config/cache/report evidence, including on failure.
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["result"] == "PASS" else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sbom", required=True, type=Path)
    args = parser.parse_args()
    try:
        return execute(args.sbom, Path(os.environ.get("RUNNER_TEMP", "")), os.environ.get("GRYPE_IMAGE", ""))
    except Exception:
        print('{"result":"FAIL","failure":"scanner-precondition-failed"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
