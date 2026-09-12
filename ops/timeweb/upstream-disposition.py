#!/usr/bin/env python3
"""Owner-approved, expiring dispositions; never alters scanner reports or inputs.

Approval: owner's affirmative reply to the 2026-09-12 proposal at control
78fa8589401e9c8e308b3c554d6fd2fc42856034. Scope and evidence limitations are
retained in upstream-cpe-review-proposal-20260912.json. This module is SHA-pinned
by both the image qualification and downstream launch verifier.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


POLICY_ID = "kinetra-imagemagick-two-cpe-20260912"
APP_COMMIT = "73b665065e00a5b375e90f701373b3e0856a0386"
SOURCE_COMMIT = "344e9056f43764bfdf82456faf3bc2feee98a6fe"
SOURCE_SHA256 = "5711b1ae793e23e0540299faa81eb9b15fa5bfe24b0aeb2d37cf0a20151d2ed4"
SBOM_SHA256 = "ebb69ea87b5ec9aa929c590bf6ceab0bc6239c38bfb3040e198e6a7bfa925dd7"
STARTS = "2026-09-12T00:00:00Z"
EXPIRES = "2026-09-26T00:00:00Z"
VERSIONS = {"ffmpeg": "9.0.1", "imagemagick": "7.1.2-30"}
ALLOWED = {"CVE-2014-9826": "Critical", "CVE-2017-5506": "High"}
VERSION = VERSIONS["imagemagick"]
CPE = f"cpe:2.3:a:imagemagick:imagemagick:{VERSION}:*:*:*:*:*:*:*"
UNBOUNDED_CPE = "cpe:2.3:a:imagemagick:imagemagick:*:*:*:*:*:*:*:*"


class DispositionError(ValueError):
    pass


def require(condition, category):
    if not condition:
        raise DispositionError(category)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "disposition-duplicate-json-key")
            result[key] = value
        return result
    def constant(value):
        raise DispositionError("disposition-nonfinite-json")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def source_identity(sbom_raw, app_commit, now):
    require(app_commit == APP_COMMIT, "disposition-application-mismatch")
    require(now.tzinfo is not None and
            datetime.fromisoformat(STARTS.replace("Z", "+00:00")) <= now <
            datetime.fromisoformat(EXPIRES.replace("Z", "+00:00")),
            "disposition-expired-or-not-yet-valid")
    require(isinstance(sbom_raw, bytes) and len(sbom_raw) <= 32768 and
            hashlib.sha256(sbom_raw).hexdigest() == SBOM_SHA256,
            "disposition-source-sbom-mismatch")
    bom = strict_json(sbom_raw)
    require(bom.get("bomFormat") == "CycloneDX" and bom.get("specVersion") == "1.6"
            and not bom.get("vulnerabilities"), "disposition-source-bom-invalid")
    components = bom.get("components", [])
    require(len(components) == 2 and
            {item.get("name"): item.get("version") for item in components} == VERSIONS,
            "disposition-source-components-mismatch")
    component = next(item for item in components if item["name"] == "imagemagick")
    require(component.get("purl") == f"pkg:generic/imagemagick@{VERSION}"
            and component.get("cpe", "").replace("\\-", "-") == CPE,
            "disposition-source-identity-mismatch")
    distribution = [item for item in component.get("externalReferences", [])
                    if item.get("type") == "distribution"]
    require(distribution == [{"type": "distribution",
        "url": f"https://download.imagemagick.org/releases/ImageMagick-{VERSION}.tar.xz",
        "hashes": [{"alg": "SHA-256", "content": SOURCE_SHA256}]}],
        "disposition-source-archive-mismatch")


def eligible(match):
    artifact, vuln = match["artifact"], match["vulnerability"]
    identifier = vuln["id"]
    if (identifier not in ALLOWED or vuln["severity"] != ALLOWED[identifier]
            or artifact["name"] != "imagemagick" or artifact["version"] != VERSION
            or artifact.get("purl") != f"pkg:generic/imagemagick@{VERSION}"
            or vuln.get("namespace") != "nvd:cpe"
            or vuln.get("dataSource") != "https://nvd.nist.gov/vuln/detail/" + identifier
            or vuln.get("fix") != {"versions": [], "state": ""}):
        return False
    details = match.get("matchDetails")
    if not isinstance(details, list) or len(details) != 1:
        return False
    detail = details[0]
    expected = {"type": "cpe-match", "matcher": "stock-matcher",
        "searchedBy": {"cpes": [CPE], "namespace": "nvd:cpe",
                       "package": {"name": "imagemagick", "version": VERSION}},
        "found": {"cpes": [UNBOUNDED_CPE], "versionConstraint": "none (unknown)",
                  "vulnerabilityID": identifier}}
    # Normalize only the documented literal-hyphen escaping of a CPE string.
    normalized = strict_json(json.dumps(detail).replace("\\\\-", "-"))
    return normalized == expected


def evaluate(report, sbom_raw, app_commit, *, now=None):
    source_identity(sbom_raw, app_commit, now or datetime.now(timezone.utc))
    require(isinstance(report, dict) and not report.get("ignoredMatches"),
            "disposition-ignored-findings-present")
    descriptor = report.get("descriptor", {})
    require(descriptor.get("name") == "grype" and descriptor.get("version") == "0.118.0",
            "disposition-scanner-identity-mismatch")
    cfg = descriptor.get("configuration", {})
    for key in ("ignore", "exclude", "vex-documents", "vex-add", "ignore-wontfix"):
        require(key in cfg and not cfg[key], "disposition-scanner-suppression")
    require(cfg.get("only-fixed") is False and cfg.get("only-notfixed") is False
            and cfg.get("fail-on-severity") == "high"
            and cfg.get("match", {}).get("stock", {}).get("using-cpes") is True
            and cfg.get("add-cpes-if-none") is False
            and cfg.get("match-upstream-kernel-headers") is True,
            "disposition-scanner-policy-mismatch")
    matches = report.get("matches")
    require(isinstance(matches, list), "disposition-matches-missing")
    raw, accepted, unresolved, seen = [], [], [], set()
    for match in matches:
        require(isinstance(match, dict), "disposition-invalid-match")
        artifact, vuln = match.get("artifact", {}), match.get("vulnerability", {})
        name, version, identifier, severity = (artifact.get("name"), artifact.get("version"),
                                             vuln.get("id"), vuln.get("severity"))
        require(name in VERSIONS and version == VERSIONS[name]
                and artifact.get("purl") == f"pkg:generic/{name}@{version}",
                "disposition-matched-component-mismatch")
        cpes = artifact.get("cpes")
        require(isinstance(cpes, list) and
                f"cpe:2.3:a:{name}:{name}:{version}:*:*:*:*:*:*:*" in
                [value.replace("\\-", "-") for value in cpes if isinstance(value, str)],
                "disposition-matched-cpe-missing")
        require(isinstance(identifier, str) and identifier.startswith("CVE-") and
                severity in ("Unknown", "Negligible", "Low", "Medium", "High", "Critical"),
                "disposition-invalid-vulnerability")
        identity = (name, version, identifier)
        require(identity not in seen, "disposition-duplicate-finding")
        seen.add(identity)
        row = {"component": name, "version": version, "id": identifier, "severity": severity}
        raw.append(row)
        if severity in ("High", "Critical"):
            (accepted if eligible(match) else unresolved).append(row)
    return {"policy_id": POLICY_ID, "policy_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "application_commit": app_commit, "source_commit": SOURCE_COMMIT,
            "source_sha256": SOURCE_SHA256, "source_sbom_sha256": SBOM_SHA256,
            "expires_at": EXPIRES, "raw_findings": raw, "dispositions": accepted,
            "unresolved": unresolved, "raw_high_critical_findings": len(accepted) + len(unresolved),
            "dispositioned_high_critical_findings": len(accepted),
            "unresolved_high_critical_findings": len(unresolved),
            "result": "FAIL" if unresolved else "PASS"}
