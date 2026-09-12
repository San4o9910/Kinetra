#!/usr/bin/env python3
"""Negative release-boundary tests; fixtures never access GitHub or Docker."""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def module(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


policy = module('upstream-disposition.py')
fixtures = module('test-scan-upstream-media.py')
scan = fixtures.scan
provenance = module('verify-launch-provenance.py')
NOW = datetime(2026, 9, 12, 18, tzinfo=timezone.utc)


class DispositionTests(unittest.TestCase):
    def setUp(self):
        self.source = fixtures.bom(policy.VERSIONS, input_bom=True)
        self.source['components'][1]['externalReferences'] = [{
            'type': 'distribution',
            'url': f'https://download.imagemagick.org/releases/ImageMagick-{policy.VERSION}.tar.xz',
            'hashes': [{'alg': 'SHA-256', 'content': policy.SOURCE_SHA256}]}]
        self.raw = json.dumps(self.source).encode()
        # Only a test-local hash substitutes the synthetic SBOM. Production
        # still pins the exact prior artifact, exercised by the real CI scan.
        self.hash_patch = patch.object(policy, 'SBOM_SHA256', hashlib.sha256(self.raw).hexdigest())
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)
        self.db = fixtures.status()
        self.report = fixtures.report(self.db)
        for identifier, severity in policy.ALLOWED.items():
            item = fixtures.finding('imagemagick', policy.VERSION, identifier, severity)
            item['vulnerability'].update(namespace='nvd:cpe',
                dataSource='https://nvd.nist.gov/vuln/detail/' + identifier,
                fix={'versions': [], 'state': ''})
            item['matchDetails'][0].update(
                searchedBy={'cpes': [policy.CPE], 'namespace': 'nvd:cpe',
                            'package': {'name': 'imagemagick', 'version': policy.VERSION}},
                found={'cpes': [policy.UNBOUNDED_CPE], 'versionConstraint': 'none (unknown)',
                       'vulnerabilityID': identifier})
            self.report['matches'].append(item)

    def evaluate(self):
        return policy.evaluate(self.report, self.raw, policy.APP_COMMIT, now=NOW)

    def artifacts(self):
        decision = self.evaluate()
        summary = {'production': {'findings': decision['raw_findings']},
                   **{key: decision[key] for key in ('raw_high_critical_findings',
                      'dispositioned_high_critical_findings', 'unresolved_high_critical_findings')}}
        return {'source-components.cdx.json': self.raw,
                'upstream-media/production.json': json.dumps(self.report).encode(),
                'upstream-media/disposition.json': json.dumps(decision).encode(),
                'upstream-media/summary.json': json.dumps(summary).encode()}

    def verify(self, files):
        with patch.object(provenance, 'load_disposition', return_value=policy):
            return provenance.verify_approved_disposition(files.__getitem__, policy.APP_COMMIT)

    def test_exact_two_records_pass_without_rewriting_input(self):
        before = copy.deepcopy(self.report)
        decision = self.evaluate()
        self.assertEqual(decision['result'], 'PASS')
        self.assertEqual(decision['raw_high_critical_findings'], 2)
        self.assertEqual(decision['dispositioned_high_critical_findings'], 2)
        self.assertEqual(decision['unresolved_high_critical_findings'], 0)
        self.assertEqual(self.report, before)
        self.assertEqual([x['severity'] for x in decision['raw_findings']], ['Critical', 'High'])

    def test_unknown_high_finding_still_blocks(self):
        self.report['matches'].append(fixtures.finding('ffmpeg', '9.0.1', 'CVE-2026-8461', 'High'))
        self.assertEqual(self.evaluate()['result'], 'FAIL')
        with patch.object(scan, 'load_disposition', return_value=policy):
            with self.assertRaisesRegex(scan.GateError, 'high-or-critical'):
                scan.validate_report(self.report, fixtures.bom(policy.VERSIONS), policy.VERSIONS, self.db,
                                     source_context=(self.raw, policy.APP_COMMIT))

    def test_wrong_app_and_changed_source_bytes_fail(self):
        for raw, app in ((self.raw, '0' * 40), (self.raw + b' ', policy.APP_COMMIT)):
            with self.subTest(app=app, changed=raw != self.raw):
                with self.assertRaises(policy.DispositionError):
                    policy.evaluate(self.report, raw, app, now=NOW)

    def test_wrong_archive_and_version_fail_even_with_fixture_hash_rebound(self):
        for mutate in (lambda s: s['components'][1].update(version='7.1.2-31'),
                       lambda s: s['components'][1]['externalReferences'][0]['hashes'][0].update(content='0' * 64)):
            source = copy.deepcopy(self.source)
            mutate(source)
            raw = json.dumps(source).encode()
            with patch.object(policy, 'SBOM_SHA256', hashlib.sha256(raw).hexdigest()):
                with self.assertRaises(policy.DispositionError):
                    policy.evaluate(self.report, raw, policy.APP_COMMIT, now=NOW)

    def test_expiry_start_boundary_and_naive_time_fail(self):
        for now in (datetime(2026, 9, 26, tzinfo=timezone.utc),
                    datetime(2026, 9, 11, 23, 59, tzinfo=timezone.utc),
                    datetime(2026, 9, 12)):
            with self.subTest(now=now):
                with self.assertRaisesRegex(policy.DispositionError, 'expired-or-not-yet-valid'):
                    policy.evaluate(self.report, self.raw, policy.APP_COMMIT, now=now)

    def test_changed_match_range_matcher_namespace_or_fix_is_not_exempt(self):
        baseline = copy.deepcopy(self.report)
        mutations = [
            lambda m: m['matchDetails'][0]['found'].update(versionConstraint='< 7.1.2-31'),
            lambda m: m['matchDetails'][0].update(matcher='apk-matcher'),
            lambda m: m['vulnerability'].update(namespace='alpine:3.24'),
            lambda m: m['vulnerability'].update(fix={'versions': ['7.1.2-31'], 'state': 'fixed'}),
            lambda m: m['matchDetails'][0]['found'].update(cpes=['cpe:2.3:a:other:other:*:*:*:*:*:*:*:*']),
            lambda m: m['matchDetails'].append(copy.deepcopy(m['matchDetails'][0])),
            lambda m: m['vulnerability'].update(severity='High'),
        ]
        for mutate in mutations:
            self.report = copy.deepcopy(baseline)
            mutate(self.report['matches'][0])
            self.assertEqual(self.evaluate()['unresolved_high_critical_findings'], 1)
            self.assertEqual(self.evaluate()['result'], 'FAIL')

    def test_duplicate_and_wrong_component_identity_fail(self):
        self.report['matches'].append(copy.deepcopy(self.report['matches'][0]))
        with self.assertRaisesRegex(policy.DispositionError, 'duplicate-finding'):
            self.evaluate()
        self.report['matches'].pop()
        self.report['matches'][0]['artifact']['version'] = '7.1.2-29'
        with self.assertRaisesRegex(policy.DispositionError, 'component-mismatch'):
            self.evaluate()

    def test_suppressed_or_filtered_report_cannot_receive_dispositions(self):
        baseline = copy.deepcopy(self.report)
        for key, value in (('ignore', [{'vulnerability': 'CVE-2014-9826'}]),
                           ('vex-documents', ['vex.json']), ('only-fixed', True),
                           ('match-upstream-kernel-headers', False), ('fail-on-severity', 'critical')):
            self.report = copy.deepcopy(baseline)
            self.report['descriptor']['configuration'][key] = value
            with self.assertRaises(policy.DispositionError):
                self.evaluate()
        self.report = baseline
        self.report['ignoredMatches'] = [self.report['matches'].pop()]
        with self.assertRaises(policy.DispositionError):
            self.evaluate()

    def test_positive_controls_cannot_use_production_exceptions(self):
        controls = fixtures.report(self.db)
        controls['matches'] = [fixtures.finding('imagemagick', '7.1.2-29', 'CVE-2014-9826', 'Critical')]
        with patch.object(scan, 'load_disposition', side_effect=AssertionError('controls must not load dispositions')):
            with self.assertRaisesRegex(scan.GateError, 'positive-control-coverage-missing'):
                scan.validate_report(controls, fixtures.bom(scan.CONTROL), scan.CONTROL, self.db,
                                     control=True, source_context=(self.raw, policy.APP_COMMIT))

    def test_both_gates_accept_identical_decision(self):
        with patch.object(scan, 'load_disposition', return_value=policy):
            rows = scan.validate_report(self.report, fixtures.bom(policy.VERSIONS), policy.VERSIONS, self.db,
                                        source_context=(self.raw, policy.APP_COMMIT))
        self.assertEqual(rows, self.verify(self.artifacts())['raw_findings'])

    def test_launch_recomputes_counts_findings_and_disposition(self):
        files = self.artifacts()
        for filename, mutate in (
            ('upstream-media/summary.json', lambda v: v.update(raw_high_critical_findings=0)),
            ('upstream-media/summary.json', lambda v: v.update(unresolved_high_critical_findings=False)),
            ('upstream-media/summary.json', lambda v: v['production']['findings'].pop()),
            ('upstream-media/disposition.json', lambda v: v.update(result='OVERRIDDEN')),
            ('upstream-media/disposition.json', lambda v: v.update(policy_sha256='0' * 64)),
            ('upstream-media/disposition.json', lambda v: v.update(expires_at='2030-01-01T00:00:00Z')),
        ):
            changed = dict(files)
            value = json.loads(changed[filename])
            mutate(value)
            changed[filename] = json.dumps(value).encode()
            with self.assertRaises(AssertionError):
                self.verify(changed)
        del files['upstream-media/disposition.json']
        with self.assertRaises(KeyError):
            self.verify(files)

    def test_launch_rejects_changed_raw_finding_and_duplicate_json(self):
        files = self.artifacts()
        value = json.loads(files['upstream-media/production.json'])
        value['matches'][0]['vulnerability']['id'] = 'CVE-2026-99999'
        files['upstream-media/production.json'] = json.dumps(value).encode()
        with self.assertRaises(AssertionError):
            self.verify(files)
        with self.assertRaisesRegex(policy.DispositionError, 'duplicate-json'):
            policy.strict_json('{"result":"PASS","result":"FAIL"}')

    def test_pinned_helper_loaders_reject_replacement(self):
        for caller in (scan, provenance):
            self.assertEqual(caller.load_disposition().POLICY_ID, policy.POLICY_ID)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'upstream-disposition.py').write_text('raise RuntimeError("must not execute")\n')
                with patch.object(caller, '__file__', str(root / 'caller.py')):
                    with self.assertRaisesRegex(ValueError, 'helper-mismatch'):
                        caller.load_disposition()


if __name__ == '__main__':
    unittest.main()
