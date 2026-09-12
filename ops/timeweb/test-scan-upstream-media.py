#!/usr/bin/env python3
"""Evidence regressions: missing CPE coverage must never appear green."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("scan_upstream_media", Path(__file__).with_name("scan-upstream-media.py"))
scan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan)


def bom(versions, input_bom=False):
    return {"bomFormat": "CycloneDX", "specVersion": "1.6" if input_bom else "1.7", "version": 1,
            "metadata": {"tools": {"components": [{"name": "grype", "version": scan.VERSION}]}},
            "components": [{"name": name, "version": version,
                            "purl": f"pkg:generic/{name}@{version}", "cpe": scan.cpe(name, version)}
                           for name, version in versions.items()]}


def status():
    return {"valid": True, "schemaVersion": "v6.1.9", "built": datetime.now(timezone.utc).isoformat(),
            "path": "/cache/6/vulnerability.db", "from": "https://grype.anchore.io/databases/v6/test.tar.zst"}


def report(db):
    return {"matches": [], "descriptor": {"name": "grype", "version": scan.VERSION, "db": {"status": db, "providers": {}},
        "configuration": {"match": {"stock": {"using-cpes": True}}, "add-cpes-if-none": False,
            "match-upstream-kernel-headers": True,
            "only-fixed": False, "only-notfixed": False, "ignore": [], "exclude": [],
            "vex-documents": [], "vex-add": [], "ignore-wontfix": "", "fail-on-severity": "high",
            "db": {"auto-update": False, "validate-age": True, "validate-by-hash-on-start": True}}}}


def finding(name, version, identifier, severity):
    return {"artifact": {"name": name, "version": version, "purl": f"pkg:generic/{name}@{version}",
                          "cpes": [scan.cpe(name, version)]},
            "vulnerability": {"id": identifier, "severity": severity},
            "matchDetails": [{"type": "cpe-match", "matcher": "stock-matcher"}]}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.db = status()
        self.report = report(self.db)
        self.bom = bom(scan.EXPECTED)

    def validate(self):
        return scan.validate_report(self.report, self.bom, scan.EXPECTED, self.db)

    def test_zero_matches_requires_both_parsed_components(self):
        self.assertEqual(self.validate(), [])
        self.bom["components"].pop()
        with self.assertRaisesRegex(scan.GateError, "missing-component-coverage"):
            self.validate()

    def test_decoder_dropped_cpe_fails_even_with_zero_matches(self):
        del self.bom["components"][0]["cpe"]
        with self.assertRaisesRegex(scan.GateError, "component-cpe-mismatch"):
            self.validate()

    def test_known_clean_version_does_not_mask_wrong_inventory(self):
        self.bom["components"][0]["version"] = "5.1.9"
        with self.assertRaisesRegex(scan.GateError, "component-version-mismatch"):
            self.validate()

    def test_generic_purl_and_declared_cpe_both_required(self):
        self.bom["components"][0]["purl"] = "pkg:apk/ffmpeg@9.0.1-r0"
        with self.assertRaisesRegex(scan.GateError, "component-purl-mismatch"):
            self.validate()

    def test_malformed_bom_and_prepopulated_vulnerabilities_fail(self):
        source = bom(scan.EXPECTED, input_bom=True)
        source["vulnerabilities"] = [{"id": "CVE-2026-8461"}]
        with self.assertRaisesRegex(scan.GateError, "prepopulated-vulnerability-input"):
            scan.identities(source, scan.EXPECTED, input_bom=True)

    def test_disabled_cpe_matcher_fails(self):
        self.report["descriptor"]["configuration"]["match"]["stock"]["using-cpes"] = False
        with self.assertRaisesRegex(scan.GateError, "cpe-matching-disabled"):
            self.validate()

    def test_suppression_and_fix_filters_fail(self):
        for key, value in (("ignore", [{"vulnerability": "CVE-2026-8461"}]),
                           ("exclude", ["**"]), ("vex-documents", ["vex.json"]),
                           ("only-fixed", True), ("ignore-wontfix", "not-fixed")):
            with self.subTest(key=key):
                self.report = report(self.db)
                self.report["descriptor"]["configuration"][key] = value
                with self.assertRaises(scan.GateError):
                    self.validate()

    def test_implicit_kernel_header_suppression_is_disabled(self):
        self.report["descriptor"]["configuration"]["match-upstream-kernel-headers"] = False
        with self.assertRaisesRegex(scan.GateError, "implicit-kernel-ignore-rules-enabled"):
            self.validate()

    def test_stale_invalid_or_wrong_database_fails(self):
        for mutation in ({"valid": False}, {"error": "corrupt"}, {"schemaVersion": "5"},
                         {"built": (datetime.now(timezone.utc) - timedelta(days=6)).isoformat()},
                         {"from": "https://other.example/test"}, {"path": "/cache/../other.db"}):
            with self.subTest(mutation=mutation):
                self.report = report({**self.db, **mutation})
                with self.assertRaises(scan.GateError):
                    self.validate()

    def test_actual_grype_v6_schema_spelling_and_legacy_spelling(self):
        # Schema spelling observed in image run 34536263175, artifact 10178655505.
        # Keep dates fresh; this regression tests parsing, not expiry exceptions.
        for version in ("v6.1.9", "6.1.9", "v6", "6"):
            with self.subTest(version=version):
                self.db = {**status(), "schemaVersion": version}
                self.report = report(self.db)
                self.assertEqual(self.validate(), [])
                self.assertEqual(self.db["schemaVersion"], version)

    def test_other_or_malformed_schema_versions_fail(self):
        for version in ("v5.1.9", "v7.0.0", "16.1.9", "v6.1.9junk", "v6.1.9.1",
                        " v6.1.9", "v6.1.9\n", "vv6.1.9", "v6..9", 6, None, True):
            with self.subTest(version=version):
                with self.assertRaisesRegex(scan.GateError, "unexpected-database-schema"):
                    scan.validate_db({**status(), "schemaVersion": version})

    def test_different_valid_database_is_not_same_control_database(self):
        self.report = report({**self.db, "path": "/cache/6/different.db"})
        with self.assertRaisesRegex(scan.GateError, "scan-database-mismatch"):
            self.validate()

    def test_nested_database_status_is_required_and_checked(self):
        for database in (None, {}, self.db, {"status": None}, {"status": {**self.db, "valid": False}}):
            with self.subTest(database=database):
                self.report = report(self.db)
                self.report["descriptor"]["db"] = database
                with self.assertRaises(scan.GateError):
                    self.validate()

    def test_high_critical_production_findings_fail(self):
        for severity in ("High", "Critical"):
            self.report["matches"] = [finding("ffmpeg", "9.0.1", "CVE-2026-8461", severity)]
            with self.assertRaisesRegex(scan.GateError, "high-or-critical"):
                self.validate()

    def test_ignored_findings_cannot_be_green(self):
        self.report["ignoredMatches"] = [{"anything": "present"}]
        with self.assertRaisesRegex(scan.GateError, "ignored-findings-present"):
            self.validate()

    def test_positive_control_requires_all_three_cves_even_low_severity(self):
        self.report["matches"] = [finding("ffmpeg", "5.1.9", "CVE-2026-8461", "High"),
                                  finding("imagemagick", "7.1.2-29", "CVE-2026-86420", "Low"),
                                  finding("imagemagick", "7.1.2-29", "CVE-2026-86421", "Medium")]
        control_bom = bom(scan.CONTROL)
        self.assertEqual(len(scan.validate_report(self.report, control_bom, scan.CONTROL, self.db, control=True)), 3)
        self.report["matches"].pop()
        with self.assertRaisesRegex(scan.GateError, "positive-control-coverage-missing"):
            scan.validate_report(self.report, control_bom, scan.CONTROL, self.db, control=True)

    def test_control_findings_must_prove_stock_cpe_matching(self):
        item = finding("ffmpeg", "9.0.1", "CVE-2026-8461", "Low")
        item["matchDetails"] = [{"type": "exact-direct-match", "matcher": "apk-matcher"}]
        self.report["matches"] = [item]
        with self.assertRaisesRegex(scan.GateError, "upstream-cpe-match-not-proven"):
            self.validate()

    def test_symlink_and_invalid_json_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "bad.json").write_text("not json")
            with self.assertRaisesRegex(scan.GateError, "invalid-json-evidence"):
                scan.read_json(root / "bad.json")
            (root / "link.json").symlink_to(root / "bad.json")
            with self.assertRaisesRegex(scan.GateError, "missing-json-evidence"):
                scan.read_json(root / "link.json")

    def test_unpinned_or_unrelated_image_is_rejected(self):
        for image in ("anchore/grype:latest", "anchore/grype:v0.118.0", "other/grype@sha256:" + "a" * 64):
            with self.assertRaisesRegex(scan.GateError, "scanner-image-not-pinned"):
                scan.Scanner(image, Path("/unused"), Path("/unused"))

    def test_no_docker_host_socket_or_secrets_are_passed(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(scan.os.environ,
                {"TIMEWEB_CLOUD_TOKEN": "secret", "GH_TOKEN": "secret", "DATABASE_URL": "secret"}):
            root = Path(folder)
            scanner = scan.Scanner("anchore/grype@sha256:" + "a" * 64, root, root / "output")
            self.assertNotIn("TIMEWEB_CLOUD_TOKEN", scanner.env)
            self.assertNotIn("GH_TOKEN", scanner.env)
            self.assertNotIn("DATABASE_URL", scanner.env)

    def test_failed_update_preserves_reports_and_public_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "kinetra-image-evidence"
            evidence.mkdir()
            source = evidence / "source-components.cdx.json"
            scan.write_json(source, bom(scan.EXPECTED, input_bom=True))

            def fake_run(scanner, phase, arguments, network=False, timeout=300):
                if phase == "version":
                    scan.write_json(scanner.output / "version.stdout", {
                        "application": "grype", "version": scan.VERSION,
                        "gitCommit": scan.COMMIT, "platform": "linux/amd64"})
                    return 0
                self.assertEqual(phase, "db-update")
                self.assertTrue(network)
                (scanner.output / "db-update.stderr").write_text("update failed")
                return 1

            with patch.object(scan.Scanner, "inspect_image"), patch.object(scan.Scanner, "run", fake_run), \
                    patch.object(scan.shutil, "disk_usage", return_value=type("Disk", (), {"free": 20 * 1024**3})()), \
                    patch("builtins.print"):
                self.assertEqual(scan.execute(source, root, "anchore/grype@sha256:" + "a" * 64), 1)
            output = evidence / "upstream-media"
            summary = scan.read_json(output / "summary.json")
            self.assertEqual(summary["result"], "FAIL")
            self.assertEqual(summary["failure"], "database-update-failed")
            self.assertTrue((output / "db-update.stderr").is_file())
            self.assertTrue((output / "grype.yaml").is_file())
            self.assertTrue((output / "positive-control-input.cdx.json").is_file())
            self.assertFalse((output / "positive-control.cdx.json").exists())
            self.assertFalse((output / "production.json").exists())

    def test_hydration_failure_retains_database_peak_before_cleanup_and_uses_disk_temp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            work, output = root / "work", root / "output"
            work.mkdir()
            output.mkdir()
            scanner = scan.Scanner("anchore/grype@sha256:" + "a" * 64, work, output)
            database = scanner.cache / "grype-db-download-fixture" / "vulnerability.db"
            command = []

            class Process:
                returncode = 1

                def poll(self):
                    return 1

            def fake_start(arguments, **kwargs):
                command.extend(arguments)
                database.parent.mkdir()
                # Sparse, so the meaningful >2 GiB boundary does not allocate
                # gigabytes or require a scanner/database download in this test.
                with database.open("wb") as stream:
                    stream.truncate(3 * 1024**3)
                return Process()

            def fake_cleanup(*args):
                evidence = scan.read_json(output / "db-update.resources.json")
                self.assertEqual(evidence["disk_final"]["database_bytes"], 3 * 1024**3)
                database.unlink()

            with patch.object(scan.subprocess, "Popen", fake_start), patch.object(scanner, "cleanup", fake_cleanup):
                self.assertEqual(scanner.run("db-update", ["db", "update"], network=True), 1)
            self.assertIn("TMPDIR=/cache/tmp", command)
            self.assertIn("SQLITE_TMPDIR=/cache/tmp", command)
            self.assertIn("fsize=4294967296:4294967296", command)
            self.assertEqual((scanner.cache / "tmp").stat().st_mode & 0o777, 0o700)
            evidence = scan.read_json(output / "db-update.resources.json")
            self.assertEqual(evidence["disk_peak"]["database_bytes"], 3 * 1024**3)
            self.assertEqual(evidence["exit_code"], 1)
            self.assertFalse(database.exists())

    def test_budget_failure_still_records_sizes_and_cleans_own_container(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            work, output = root / "work", root / "output"
            work.mkdir()
            output.mkdir()
            scanner = scan.Scanner("anchore/grype@sha256:" + "a" * 64, work, output)
            (scanner.cache / "oversized").write_bytes(b"a" * 1024)

            class Process:
                returncode = 1

                def poll(self):
                    return 1

            with patch.object(scan.subprocess, "Popen", return_value=Process()), \
                    patch.object(scanner, "cleanup") as cleanup, patch.object(scan, "FILE_LIMIT", 512):
                with self.assertRaisesRegex(scan.GateError, "scanner-file-limit-exceeded"):
                    scanner.run("db-update", ["db", "update"], network=True)
            cleanup.assert_called_once()
            evidence = scan.read_json(output / "db-update.resources.json")
            self.assertGreaterEqual(evidence["disk_final"]["max_file_bytes"], 1024)

    def test_unlinked_temporary_consumption_cannot_escape_disk_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            work, output = root / "work", root / "output"
            work.mkdir()
            output.mkdir()
            scanner = scan.Scanner("anchore/grype@sha256:" + "a" * 64, work, output)
            scanner.initial_free = 20 * 1024**3
            call = {}
            with patch.object(scan.shutil, "disk_usage", return_value=type("Disk", (), {"free": 11 * 1024**3})()):
                with self.assertRaisesRegex(scan.GateError, "scanner-disk-budget-exceeded"):
                    scanner.observe_disk(call)
            self.assertEqual(call["disk_peak"]["filesystem_consumed_bytes"], 9 * 1024**3)
            self.assertLess(call["disk_final"]["cache_bytes"], 1024)


if __name__ == "__main__":
    unittest.main()
