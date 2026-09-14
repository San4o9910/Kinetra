#!/usr/bin/env python3
"""Apply the dormant proposal only in a temporary tree; no Docker/network access.

Mount permutations come from the real read-only host evidence. Other dictionary
values in boundary tests are explicitly synthetic. The historical failing pair
was not recorded and is not invented by these tests.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent
MANIFEST = json.loads((ROOT / 'database-order-policy-proposal-20260914.json').read_text())
EVIDENCE = json.loads((ROOT / 'database-order-inspection-20260914.json').read_text())
SHA = lambda value: hashlib.sha256(value).hexdigest()


class Rejected(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Rejected(reason)


def function(source, name):
    return next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)


def isolated_normalizer(source):
    node = function(source, 'stable_database_observation')
    scope = {'json': json, 'require': require}
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<pure-database-proposal>', 'exec'), scope)
    return scope['stable_database_observation']


class DatabaseOrderProposal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = {name: (ROOT / name).read_text() for name in MANIFEST['files']}
        if 'def stable_database_observation(' in cls.before['start-application-host.py']:
            # Reconstruct exact frozen proposal inputs only inside this test.
            pins = json.loads((ROOT / 'database-order-implementation-pins.json').read_text())
            normalized = {}
            for name, source in cls.before.items():
                for before_hash, after_hash in pins.items():
                    source = source.replace(after_hash, before_hash)
                normalized[name] = source
            with tempfile.TemporaryDirectory() as folder:
                destination = Path(folder) / 'ops/timeweb'
                destination.mkdir(parents=True)
                for name, source in normalized.items():
                    (destination / name).write_text(source)
                subprocess.run(['git', 'apply', '--reverse', str((ROOT / 'database-order-policy-fix-20260914.patch').resolve())],
                               cwd=folder, check=True, capture_output=True)
                cls.before = {name: (destination / name).read_text() for name in normalized}
            for name, source in cls.before.items():
                if SHA(source.encode()) != MANIFEST['files'][name]['before_sha256']:
                    raise AssertionError('Frozen proposal base changed: ' + name)
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'ops/timeweb'
            destination.mkdir(parents=True)
            for name, content in cls.before.items():
                (destination / name).write_text(content)
            patch = str((ROOT / 'database-order-policy-fix-20260914.patch').resolve())
            subprocess.run(['git', 'apply', '--check', patch], cwd=folder, check=True, capture_output=True)
            subprocess.run(['git', 'apply', patch], cwd=folder, check=True, capture_output=True)
            cls.after = {name: (destination / name).read_text() for name in cls.before}
        cls.normalizers = {name: isolated_normalizer(source) for name, source in cls.after.items()
                           if name != 'activate-https-host.py'}
        cls.variants = EVIDENCE['inspection']['database_comparison']['variants']['mounts']

    def info(self, mounts=None):
        return {'id': 'fixture-container', 'image': 'fixture-image', 'image_id': 'fixture-image-id',
                'user': 'fixture-user', 'project': 'fixture-project', 'service': 'postgres',
                'readonly': True, 'cap_drop': ['ALL'], 'cap_add': None,
                'security': ['no-new-privileges:true'], 'ports': {'5432/tcp': None},
                'networks': {'fixture-private': {'NetworkID': 'fixture-network-id'}},
                'mounts': copy.deepcopy(self.variants[0] if mounts is None else mounts),
                'restart': 'no', 'running': True, 'health': 'healthy',
                'unknown_future_field': {'must': 'also be retained'}}

    def accept_local(self, name, before, after):
        node = next(n for n in ast.walk(function(self.after[name], 'activate'))
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'require'
                    and any(isinstance(arg, ast.Constant) and arg.value == 'DATABASE_ISOLATION_CHANGED' for arg in n.args))
        normalizer = self.normalizers[name]
        scope = {'require': require, 'database_before': normalizer(before), 'database': normalizer(after)}
        module = ast.fix_missing_locations(ast.Module(body=[ast.Expr(value=node)], type_ignores=[]))
        exec(compile(module, '<original-database-assertion>', 'exec'), scope)

    def test_01_exact_patch_bindings(self):
        self.assertEqual(SHA((ROOT / 'database-order-policy-fix-20260914.patch').read_bytes()), MANIFEST['patch_sha256'])
        for name, binding in MANIFEST['files'].items():
            self.assertEqual(SHA(self.before[name].encode()), binding['before_sha256'])
            self.assertEqual(SHA(self.after[name].encode()), binding['proposed_sha256_before_dependency_pin_updates'])

    def test_02_all_other_code_and_pins_unchanged(self):
        class RemoveNormalizer(ast.NodeTransformer):
            def visit_Call(self, node):
                node = self.generic_visit(node)
                if ((isinstance(node.func, ast.Name) and node.func.id == 'stable_database_observation')
                    or (isinstance(node.func, ast.Attribute) and node.func.attr == 'stable_database_observation'
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == 'local')):
                    if len(node.args) != 1 or node.keywords:
                        raise AssertionError('Unexpected normalization signature')
                    return node.args[0]
                return node
        for name in self.before:
            restored = ast.parse(self.after[name])
            restored.body = [n for n in restored.body if not (isinstance(n, ast.FunctionDef) and n.name == 'stable_database_observation')]
            self.assertEqual(ast.dump(RemoveNormalizer().visit(restored)), ast.dump(ast.parse(self.before[name])))

    def test_03_all_original_acceptance_assertions_unchanged(self):
        def assertions(source):
            return [ast.dump(n) for n in ast.walk(ast.parse(source))
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'require']
        for name in self.before:
            after_tree = ast.parse(self.after[name])
            after_tree.body = [n for n in after_tree.body if not (isinstance(n, ast.FunctionDef) and n.name == 'stable_database_observation')]
            self.assertEqual(assertions(self.before[name]), assertions(ast.unparse(after_tree)))

    def test_04_raw_inspect_and_records_and_rollback_unchanged(self):
        for name in self.normalizers:
            for function_name in ('inspect_container', 'rollback', 'main'):
                self.assertEqual(ast.dump(function(self.before[name], function_name)), ast.dump(function(self.after[name], function_name)))

    def test_05_read_only_evidence_and_cleanup(self):
        self.assertEqual(EVIDENCE['provenance']['run_id'], 34816826708)
        self.assertEqual(EVIDENCE['result'], 'PASS_READ_ONLY_HOST_MONITORING_INSPECTION')
        self.assertFalse(EVIDENCE['inspection']['mutations'])
        self.assertEqual(EVIDENCE['account_key_cleanup'], 'API_DELETE_CONFIRMED')
        self.assertEqual(EVIDENCE['guest_key_cleanup'], 'API_DELETE_CONFIRMED')
        self.assertEqual(EVIDENCE['local_key_cleanup'], 'REMOVED')
        comparison = EVIDENCE['inspection']['database_comparison']
        self.assertEqual(comparison['snapshot_count'], 12)
        self.assertEqual(comparison['changed_fields'], ['mounts'])
        self.assertTrue(comparison['all_equal_after_mount_order_normalization'])

    def test_06_real_mount_variants_reproduce_strict_equality_failure(self):
        self.assertGreater(len(self.variants), 1)
        self.assertTrue(any(self.variants[0] != variant for variant in self.variants[1:]))
        for normalizer in self.normalizers.values():
            expected = normalizer(self.info())
            for variant in self.variants:
                self.assertEqual(normalizer(self.info(variant)), expected)

    def test_07_original_local_guard_accepts_only_reordering(self):
        for name in self.normalizers:
            for variant in self.variants:
                self.accept_local(name, self.info(), self.info(variant))

    def test_08_changed_mount_fields_still_rejected(self):
        mutations = {'Destination': '/different', 'Source': '/different', 'RW': False,
                     'Type': 'bind', 'Driver': 'different', 'Name': 'different',
                     'Mode': 'ro', 'Propagation': 'rshared', 'new_field': 'different'}
        for name in self.normalizers:
            for key, value in mutations.items():
                with self.subTest(helper=name, field=key):
                    before = self.info()
                    after = copy.deepcopy(before)
                    volume = next(m for m in after['mounts'] if m['Type'] == 'volume')
                    self.assertNotEqual(volume.get(key), value)
                    volume[key] = value
                    with self.assertRaisesRegex(Rejected, 'DATABASE_ISOLATION_CHANGED'):
                        self.accept_local(name, before, after)

    def test_09_added_and_removed_mounts_still_rejected(self):
        for name in self.normalizers:
            for action in ('add', 'remove'):
                after = self.info()
                if action == 'add':
                    after['mounts'].append({'Destination': '/new', 'Source': '/new', 'Type': 'bind', 'RW': False})
                else:
                    after['mounts'].pop()
                with self.assertRaisesRegex(Rejected, 'DATABASE_ISOLATION_CHANGED'):
                    self.accept_local(name, self.info(), after)

    def test_10_duplicate_destination_is_rejected_not_deduplicated(self):
        for normalizer in self.normalizers.values():
            info = self.info()
            info['mounts'].append(copy.deepcopy(info['mounts'][0]))
            with self.assertRaisesRegex(Rejected, 'DATABASE_MOUNT_DESTINATIONS_INVALID'):
                normalizer(info)

    def test_11_malformed_mounts_rejected(self):
        for normalizer in self.normalizers.values():
            for mounts in (None, [], {}, [None], [3], ['mount'], [{}], [{'Destination': None}], [{'Destination': 12}], [{'Destination': 'relative'}]):
                info = self.info()
                info['mounts'] = mounts
                with self.assertRaises(Rejected):
                    normalizer(info)
            for info in (None, [], 'database'):
                with self.assertRaisesRegex(Rejected, 'DATABASE_OBSERVATION_REQUIRED'):
                    normalizer(info)

    def test_12_inputs_and_every_mount_field_retained(self):
        for normalizer in self.normalizers.values():
            info = self.info()
            original = copy.deepcopy(info)
            result = normalizer(info)
            self.assertEqual(info, original)
            self.assertIsNot(info, result)
            self.assertEqual({k:v for k,v in result.items() if k != 'mounts'}, {k:v for k,v in info.items() if k != 'mounts'})
            self.assertEqual(sorted(json.dumps(m, sort_keys=True) for m in result['mounts']), sorted(json.dumps(m, sort_keys=True) for m in info['mounts']))

    def test_13_every_other_original_isolation_field_still_rejected(self):
        changes = {'id': 'changed', 'image': 'changed', 'image_id': 'changed', 'user': '0',
                   'project': 'changed', 'service': 'changed', 'readonly': False,
                   'cap_drop': [], 'cap_add': ['SYS_ADMIN'], 'security': [],
                   'ports': {'5432/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '5432'}]},
                   'networks': {'public': {'NetworkID': 'changed'}}, 'restart': 'always'}
        for name in self.normalizers:
            for key, value in changes.items():
                with self.subTest(helper=name, field=key):
                    after = self.info()
                    after[key] = value
                    with self.assertRaisesRegex(Rejected, 'DATABASE_ISOLATION_CHANGED'):
                        self.accept_local(name, self.info(), after)

    def test_14_https_retains_full_dictionary_comparison(self):
        check = function(self.after['activate-https-host.py'], 'check_application')
        self.assertEqual(ast.unparse(check.body[-1]), 'return local.stable_database_observation(database)')
        old_calls = [ast.dump(n) for n in ast.walk(ast.parse(self.before['activate-https-host.py'])) if isinstance(n, ast.Call)]
        new_calls = [ast.dump(n) for n in ast.walk(ast.parse(self.after['activate-https-host.py'])) if isinstance(n, ast.Call)
                     and not (isinstance(n.func, ast.Attribute) and n.func.attr == 'stable_database_observation')]
        self.assertEqual(old_calls, new_calls)
        for normalizer in self.normalizers.values():
            before = self.info()
            after = self.info(self.variants[-1])
            self.assertEqual(normalizer(before), normalizer(after))
            for key in ('running', 'health', 'unknown_future_field'):
                changed = copy.deepcopy(after)
                changed[key] = 'changed'
                self.assertNotEqual(normalizer(before), normalizer(changed))

    def test_15_normalizer_only_at_database_snapshot_boundaries(self):
        for name in self.normalizers:
            activation = function(self.after[name], 'activate')
            calls = [n for n in ast.walk(activation) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Name) and n.func.id == 'stable_database_observation']
            self.assertEqual(len(calls), 2)
            for call in calls:
                self.assertEqual(ast.unparse(call), 'stable_database_observation(inspect_container(postgres_id))')
        self.assertEqual(ast.dump(function(self.after['start-application-host.py'], 'stable_database_observation')),
                         ast.dump(function(self.after['resume-stopped-application-host.py'], 'stable_database_observation')))

    def test_16_real_asset_success_does_not_become_successful_handoff(self):
        result = EVIDENCE['inspection']['records']['assets_result']
        self.assertEqual(result['result'], 'CHECKPOINT_ONLY')
        self.assertEqual(result['error'], 'DATABASE_ISOLATION_CHANGED')
        self.assertEqual(result['rollback'], {'backend':'STOPPED', 'frontend':'STOPPED'})
        self.assertEqual(result['uncertain_start_services'], [])
        http = result['local_http']
        self.assertEqual(http['/']['status'], 200)
        self.assertEqual(http['/api/v1/me']['status'], 401)
        self.assertEqual(http['/theme-init.js']['sha256'], 'd9988fba5a56d7bd81528b74156f5ce65a8d07f649b9eef77104e81ae768788b')


if __name__ == '__main__':
    unittest.main(verbosity=2)
