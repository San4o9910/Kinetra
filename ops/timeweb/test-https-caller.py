#!/usr/bin/env python3
"""HTTPS handoff, transport and cleanup boundaries; all network calls mocked."""
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
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile


def load(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


module = load('https-caller.py')
fixtures = load('test-activate-local-application-host.py')
NONCE = fixtures.NONCE


def local_handoff():
    request = fixtures.request()
    outer = {'schema': 1, 'result': 'APPLICATION_LOCAL_ACCEPTED_ONLY', 'error': None,
        'server_id': 9069403, 'public_ipv4': '80.68.156.131', 'host_key_fingerprint': module.stage.PINNED_FINGERPRINT,
        'server_status': 'on', 'ssh_key_id': 812346, 'guest_key_cleanup': 'API_DELETE_CONFIRMED',
        'account_key_cleanup': 'API_DELETE_CONFIRMED', 'local_key_cleanup': 'REMOVED', 'guest_temp_cleanup': 'REMOVED',
        'remote_directory': '/run/kinetra-local-activation-' + NONCE, 'activation_outcome': 'ACCEPTED_OBSERVED',
        'activation': fixtures.successful_remote(), 'full_launch_accepted': False, 'caddy_started': False,
        'database_policy_changed': False, 'provider_requests': 0,
        'approved_input_sha256': module.canonical_hash(request['approved']),
        'provenance_sha256': module.canonical_hash(request['provenance'])}
    return {**request, 'local_outer': outer, 'request_sha256': module.canonical_hash(request)}


def successful_https():
    return {'schema': 1, 'result': 'HTTPS_ACCEPTED_ONLY', 'phase': 'HTTPS_ACCEPTANCE_COMPLETE',
        'error': None, 'nonce': 'c' * 32, 'attempt_recorded': True, 'start_attempted': True,
        'owned_invocation': 'e' * 32, 'rollback': 'NOT_NEEDED',
        'https': {'http': fixtures.successful_start()['local_http'], 'redirect_status': 308,
                  'certificate': {'sha256': 'f' * 64, 'ip_san': '80.68.156.131', 'trusted': True,
                                  'not_before': 1, 'not_after': 4_000_000_000}},
        'database_policy_changed': False, 'boot_enabled': False, 'provider_requests': 0,
        'full_launch_accepted': False,
        'remaining': ['EXTERNAL_BROWSER_ACCEPTANCE', 'DATABASE_PERSISTENT_POLICY', 'BOOT_ENABLEMENT', 'BACKUP_AND_USER_LAUNCH']}


class HttpsCallerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.value = local_handoff()
        self.env = {env: self.value['provenance'][name] for name, env in module.local.PROVENANCE_ENV.items()}
        self.env.update(fixtures.IMAGES)
        self.env.update(GITHUB_ACTIONS='true', GITHUB_REPOSITORY=module.caller.REPOSITORY,
            GITHUB_REF=module.caller.CONTROL_REF, GITHUB_SHA='9' * 40, GITHUB_RUN_ID='34723300009',
            GITHUB_RUN_ATTEMPT='1', ACTIVATE_PREPARED_HTTPS='APPROVED', RUNNER_TEMP=str(self.root),
            APP_CHECKOUT=str(self.root / 'checkout'), APPROVED_LOCAL_RUN='34723300008',
            APPROVED_LOCAL_CONTROL_COMMIT=self.value['provenance']['control_commit'],
            APPROVED_LOCAL_ARTIFACT_ID='12345678')
        self.workflow = b'# reviewed local activation workflow fixture\n'
        self.env['APPROVED_LOCAL_WORKFLOW_SHA256'] = hashlib.sha256(self.workflow).hexdigest()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(module.stage, 'source_bundle', return_value=fixtures.SOURCES))
        self.stack.enter_context(patch.object(module.local.initialization, 'migration_hashes', return_value=fixtures.MIGRATIONS))
        self.verified = Mock(return_value=({'head_branch': module.caller.CONTROL_REF.removeprefix('refs/heads/')},
                                          [{'name': 'activate-local-application'}]))
        self.archive()
        fixtures.FakeApi.instances = []
        fixtures.FakeApi.wrong_server = fixtures.FakeApi.wrong_key = fixtures.FakeApi.fail_delete = False

    def archive(self, *, extra=False):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('accepted-local-handoff.json', json.dumps(self.value))
            if extra: archive.writestr('extra.json', '{}')
        self.raw = buffer.getvalue()
        self.env['APPROVED_LOCAL_ARTIFACT_SHA256'] = hashlib.sha256(self.raw).hexdigest()
        self.artifact = {'id': int(self.env['APPROVED_LOCAL_ARTIFACT_ID']), 'expired': False,
            'name': 'kinetra-local-handoff-' + self.env['APPROVED_LOCAL_RUN'] + '-1',
            'workflow_run': {'id': int(self.env['APPROVED_LOCAL_RUN']), 'head_sha': self.env['APPROVED_LOCAL_CONTROL_COMMIT']},
            'digest': 'sha256:' + self.env['APPROVED_LOCAL_ARTIFACT_SHA256'], 'size_in_bytes': len(self.raw)}

    def api(self, path, *, archive=False):
        if path.startswith('/contents/'):
            return {'type': 'file', 'encoding': 'base64', 'content': base64.b64encode(self.workflow).decode()}
        return self.raw if archive else self.artifact

    def test_exact_successful_local_run_creates_same_run_private_receipt(self):
        module.execution(self.env)
        approved = module.authenticate(self.env, self.api, self.verified)
        self.assertEqual(approved, module.approved_input(self.env))
        self.assertEqual(stat.S_IMODE((module.folder(self.env) / 'receipt.json').stat().st_mode), 0o600)
        self.verified.assert_called_once_with(self.env['APPROVED_LOCAL_RUN'], module.WORKFLOW,
                                             self.env['APPROVED_LOCAL_CONTROL_COMMIT'], 'push')
        self.assertEqual(fixtures.FakeApi.instances, [])

    def test_changed_run_artifact_workflow_or_members_fail_before_host(self):
        for mutate in (lambda: self.artifact.update(expired=True),
                       lambda: self.artifact['workflow_run'].update(head_sha='0' * 40),
                       lambda: self.artifact.update(digest='sha256:' + '0' * 64),
                       lambda: self.artifact.update(name='kinetra-local-handoff-unrelated-1')):
            self.archive()
            mutate()
            with self.assertRaises(module.Error):
                module.authenticate(self.env, self.api, self.verified)
        self.archive(extra=True)
        with self.assertRaises(module.Error):
            module.authenticate(self.env, self.api, self.verified)
        self.archive()
        self.workflow += b'# changed'
        with self.assertRaises(module.Error):
            module.authenticate(self.env, self.api, self.verified)
        self.assertEqual(fixtures.FakeApi.instances, [])

    def test_same_commit_different_local_attempt_or_failed_cleanup_is_rejected(self):
        baseline = copy.deepcopy(self.value)
        for mutate in (lambda v: v['local_outer'].update(account_key_cleanup='PENDING'),
                       lambda v: v['local_outer']['activation']['start'].update(nonce='0' * 32),
                       lambda v: v['local_outer'].update(provenance_sha256='0' * 64),
                       lambda v: v['provenance'].update(control_commit='0' * 40)):
            self.value = copy.deepcopy(baseline)
            mutate(self.value)
            if self.value['local_outer']['activation']['start']['nonce'] == '0' * 32:
                # A valid different local attempt still changes the computed
                # checkpoint binding that the frozen guest checks on disk.
                before = module.validate_handoff(baseline, self.env)
                after = module.validate_handoff(self.value, self.env)
                self.assertNotEqual(before['local_checkpoint_sha256'], after['local_checkpoint_sha256'])
            else:
                with self.assertRaises((module.Error, module.local.Error)):
                    module.validate_handoff(self.value, self.env)

    def test_receipt_cannot_move_between_runs_or_change_images(self):
        module.authenticate(self.env, self.api, self.verified)
        for key in ('APPROVED_IMAGE_ARTIFACT_SHA256', 'BACKEND_IMAGE', 'GITHUB_SHA'):
            env = dict(self.env)
            env[key] += 'changed'
            with self.assertRaises(module.Error):
                module.approved_input(env)

    def test_missing_authorization_or_receipt_starts_nothing(self):
        for mutate in (lambda e: e.pop('ACTIVATE_PREPARED_HTTPS'),
                       lambda e: e.update(GITHUB_REF='refs/heads/main'),
                       lambda e: e.update(APPROVED_LOCAL_CONTROL_COMMIT='REVIEW_REQUIRED'),
                       lambda e: e.update(GH_TOKEN='offline-unrelated-secret')):
            env = dict(self.env, TIMEWEB_CLOUD_TOKEN=fixtures.TOKEN)
            mutate(env)
            with patch.object(module, 'host') as host, contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(module.main(['--activate-https'], env), 1)
            host.assert_not_called()
            self.assertNotIn(fixtures.TOKEN, out.getvalue())

    def remote(self, approved):
        return {'schema': 1, 'result': 'HTTPS_ACCEPTED_ONLY', 'error': None,
            'approved_input_sha256': module.canonical_hash(approved), 'commit': approved['approved']['commit'],
            'images': approved['approved']['images'], 'start': successful_https(),
            'activation_outcome': 'ACCEPTED_OBSERVED', 'guest_temp_cleanup': 'REMOVED',
            'remote_directory': '/run/kinetra-https-activation-' + NONCE}

    def run_host(self, *, transport_error=None, fingerprint=None, remote=None, guest=None):
        approved = module.validate_handoff(self.value, self.env)
        remote = self.remote(approved) if remote is None else remote
        guest = dict(fixtures.inspected_guest(), selected_listener_ports=[22, 8080]) if guest is None else guest
        env = dict(self.env, TIMEWEB_CLOUD_TOKEN=fixtures.TOKEN)
        with patch.object(module.inspection, 'pin_host_key', return_value=(self.root / 'known_hosts', fingerprint or module.stage.PINNED_FINGERPRINT)), \
             patch.object(module.inspection, 'prepare_key', return_value=(self.root / 'private', 'ssh-ed25519 MOCK kinetra-inspect-ephemeral')) as key, \
             patch.object(module.inspection, 'wait_for_key'), \
             patch.object(module.inspection, 'run_bounded', return_value=(0, json.dumps(guest).encode(), b'')), \
             patch.object(module.stage, 'run_with_input', return_value=(0, json.dumps(remote).encode(), b''), side_effect=transport_error) as ssh, \
             patch.object(module.secrets, 'token_hex', return_value=NONCE), \
             patch.object(module.resource, 'setrlimit'), contextlib.redirect_stdout(io.StringIO()) as output:
            code = module.host(approved, env, fixtures.FakeApi)
        state = json.loads(output.getvalue().splitlines()[-1].split('=', 1)[1])
        self.assertNotIn(fixtures.TOKEN, output.getvalue())
        self.assertNotIn('TIMEWEB_CLOUD_TOKEN', env)
        return code, state, key, ssh

    def test_host_uses_private_stdin_and_confirms_owned_cleanup(self):
        code, state, _, ssh = self.run_host()
        self.assertEqual((code, state['result']), (0, 'HTTPS_ACCEPTED_ONLY'))
        self.assertTrue(state['caddy_started'])
        self.assertEqual(state['guest_key_cleanup'], 'API_DELETE_CONFIRMED')
        self.assertEqual(state['account_key_cleanup'], 'API_DELETE_CONFIRMED')
        self.assertEqual(state['local_key_cleanup'], 'REMOVED')
        args, payload, _ = ssh.call_args.args
        self.assertNotIn(fixtures.TOKEN, ' '.join(args))
        self.assertNotIn(fixtures.TOKEN.encode(), payload)
        self.assertEqual(json.loads(payload)['approved'], module.validate_handoff(self.value, self.env))

    def test_pin_mismatch_prevents_key_creation(self):
        code, _, key, ssh = self.run_host(fingerprint='SHA256:unrelated')
        self.assertEqual(code, 1)
        key.assert_not_called()
        ssh.assert_not_called()

    def test_expected_running_app_is_required_and_unexpected_ports_prevent_activation(self):
        for ports in ([22], [22, 80, 8080], [22, 443, 8080], [22, 5432, 8080], [22, 6379, 8080], [22, 8000, 8080]):
            with self.subTest(ports=ports):
                guest = dict(fixtures.inspected_guest(), selected_listener_ports=ports)
                code, state, _, ssh = self.run_host(guest=guest)
                self.assertEqual((code, state['error']), (1, 'PRE_HTTPS_GUEST_PRECONDITION_FAILED'))
                ssh.assert_not_called()
                self.assertEqual(state['account_key_cleanup'], 'API_DELETE_CONFIRMED')
        for flag in ('password_auth_disabled', 'keyboard_interactive_disabled', 'root_login_key_only', 'listeners_verified', 'docker_available'):
            guest = dict(fixtures.inspected_guest(), selected_listener_ports=[22, 8080])
            guest[flag] = False
            code, _, _, ssh = self.run_host(guest=guest)
            self.assertEqual(code, 1)
            ssh.assert_not_called()

    def test_activate_cli_retains_only_complete_successful_handoff(self):
        module.authenticate(self.env, self.api, self.verified)
        approved = module.approved_input(self.env)
        outer = {'result': 'HTTPS_ACCEPTED_ONLY', 'error': None,
                 'approved_input_sha256': module.canonical_hash(approved),
                 'local_outer_sha256': approved['local_outer_sha256'],
                 'guest_key_cleanup': 'API_DELETE_CONFIRMED', 'account_key_cleanup': 'API_DELETE_CONFIRMED',
                 'local_key_cleanup': 'REMOVED', 'guest_temp_cleanup': 'REMOVED'}
        def accepted(_approved, _env):
            module.emit(outer)
            return 0
        with patch.object(module, 'host', side_effect=accepted) as host, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(['--activate-https'], dict(self.env, TIMEWEB_CLOUD_TOKEN=fixtures.TOKEN)), 0)
        host.assert_called_once()
        result = module.caller.read_json(module.folder(self.env) / 'accepted-https-handoff.json')
        self.assertEqual(result['https_outer'], outer)
        self.assertEqual(result['approved'], approved)
        self.assertIs(result['full_launch_accepted'], False)

    def test_lost_response_preserves_uncertainty_and_cleans_owned_keys(self):
        code, state, _, _ = self.run_host(transport_error=TimeoutError('offline lost response'))
        self.assertEqual(code, 1)
        self.assertEqual(state['activation_outcome'], 'UNKNOWN_RECONCILE')
        self.assertIsNone(state['caddy_started'])
        self.assertEqual(state['account_key_cleanup'], 'API_DELETE_CONFIRMED')

    def test_cleanup_failure_never_becomes_success(self):
        fixtures.FakeApi.fail_delete = True
        code, state, _, _ = self.run_host()
        self.assertEqual(code, 1)
        self.assertEqual(state['activation_outcome'], 'ACCEPTED_OBSERVED')
        self.assertTrue(state['caddy_started'])

    def test_untrusted_cert_scope_and_http_output_fail(self):
        for mutate in (lambda v: v['https']['certificate'].update(trusted=False),
                       lambda v: v['https']['certificate'].update(ip_san='127.0.0.1'),
                       lambda v: v.update(boot_enabled=True),
                       lambda v: v.update(provider_requests=1),
                       lambda v: v.update(owned_invocation=None),
                       lambda v: v['https']['http'].update({'/private?token=secret': {'status': 200, 'sha256': 'f' * 64}})):
            value = successful_https()
            mutate(value)
            with self.assertRaises(module.Error):
                module.validate_https(value)
        approved = module.validate_handoff(self.value, self.env)
        remote = self.remote(approved)
        remote['start']['https']['http']['/']['sha256'] = '0' * 64
        with self.assertRaisesRegex(module.Error, 'LOCAL_RESPONSE_MISMATCH'):
            module.validate_remote(json.dumps(remote), approved, NONCE)

    def test_failed_capture_keeps_cleanup_and_https_invocation_identity(self):
        state = {'result': 'FAIL', 'remote_directory': '/run/kinetra-https-activation-' + NONCE,
                 'ssh_key_id': 800004, 'activation_outcome': 'FAILED_OBSERVED',
                 'account_key_cleanup': 'API_DELETE_CONFIRMED', 'error': 'HTTPS_RESULT_NOT_DURABLE',
                 'activation': {'start': {'nonce': 'c' * 32, 'owned_invocation': 'e' * 32}},
                 'untrusted': 'offline-secret'}
        def callback():
            print('TIMEWEB_HTTPS_ACTIVATION=' + json.dumps(state))
            return 1
        with contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(module.Error):
                module.capture_https(callback, 'TIMEWEB_HTTPS_ACTIVATION=', self.root / 'attempt.json')
        raw = (self.root / 'attempt.observations.jsonl').read_text()
        self.assertNotIn('offline-secret', raw + output.getvalue())
        record = json.loads(raw)
        self.assertEqual(record['owned_invocation'], 'e' * 32)
        self.assertEqual(record['remote_directory'], state['remote_directory'])
        self.assertEqual(record['account_key_cleanup'], 'API_DELETE_CONFIRMED')

class HttpsLauncherTests(unittest.TestCase):
    def setUp(self):
        self.ns = {"__name__": "offline_launcher"}
        exec(compile(module.GUEST_LAUNCHER, "<offline-launcher>", "exec"), self.ns)
        self.body = b"# offline public helper fixture\n"
        self.ns["PINS"] = {"activate-https-host.py": hashlib.sha256(self.body).hexdigest()}
        self.data = {"schema": 1, "nonce": NONCE, "approved": {'schema': 1, 'server_id': 9069403, 'public_ipv4': '80.68.156.131', 'approved': fixtures.approved(), 'local_outer': {}, 'local_outer_sha256': '0' * 64, 'local_checkpoint_sha256': '0' * 64},
            "helpers": {"activate-https-host.py": base64.b64encode(self.body).decode()}}
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.root.chmod(0o700)

    def invoke(self, *, child_timeout=False, extra_file=False, bad_hash=False):
        if bad_hash: self.data["helpers"]["activate-https-host.py"] = base64.b64encode(b"tampered").decode()
        output, observed = io.StringIO(), {}
        fake = SimpleNamespace(returncode=None, pid=12345, stdout=io.BytesIO(), running=True)

        def spawn(args, **kwargs):
            observed.update(args=args, kwargs=kwargs)
            path = self.root / ("kinetra-https-activation-" + NONCE)
            observed["private"] = json.loads((path / "private-input.json").read_text())
            observed["mode"] = stat.S_IMODE((path / "private-input.json").stat().st_mode)
            if extra_file: (path / "unexpected").write_text("preserve me")
            return fake

        def communicate(timeout):
            observed["communicate_timeout"] = timeout
            if child_timeout: raise subprocess.TimeoutExpired("offline", timeout)
            fake.returncode, fake.running = 0, False
            return json.dumps(successful_https()).encode(), b""

        def wait(timeout):
            observed["wait_timeout"] = timeout
            # A slow but legally bounded first/second rollback needs >120s.
            self.assertGreaterEqual(timeout, 540)
            fake.returncode, fake.running = 1, False
            return 1

        fake.communicate, fake.poll, fake.wait = communicate, lambda: None if fake.running else fake.returncode, wait
        actual_path = Path
        actual_lstat = Path.lstat
        def root_lstat(path):
            info = actual_lstat(path)
            return os.stat_result((*info[:4], 0, *info[5:]))
        with patch.object(self.ns["pathlib"], "Path", side_effect=lambda path: self.root if path == "/run" else actual_path(path)), \
             patch.object(actual_path, "lstat", root_lstat), \
             patch.object(self.ns["os"], "geteuid", return_value=0), \
             patch.object(self.ns["sys"], "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(self.data).encode()))), \
             patch.object(self.ns["subprocess"], "Popen", side_effect=spawn) as popen, \
             patch.object(self.ns["os"], "killpg") as killpg, \
             patch.object(self.ns["resource"], "setrlimit"), contextlib.redirect_stdout(output):
            code = self.ns["main"]()
        return code, json.loads(output.getvalue()), observed, popen, killpg

    def test_launcher_stdin_privacy_and_owned_temp_cleanup(self):
        code, result, observed, _, _ = self.invoke()
        self.assertEqual((code, result["result"]), (0, "HTTPS_ACCEPTED_ONLY"))
        self.assertEqual(result["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(observed["private"], self.data["approved"])
        self.assertEqual(observed["mode"], 0o600)
        self.assertEqual(observed["kwargs"]["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        self.assertIn("--activate-prepared-https", observed["args"])
        self.assertNotIn("approved", " ".join(observed["args"]))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_timeout_allows_rollback_grace_but_remains_unknown(self):
        code, result, observed, _, killpg = self.invoke(child_timeout=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "UNKNOWN_RECONCILE")
        self.assertIsNone(result["start"])
        self.assertEqual(result["guest_temp_cleanup"], "REMOVED")
        self.assertEqual(observed["wait_timeout"], 600)
        killpg.assert_called_once_with(12345, module.signal.SIGTERM)

    def test_unexpected_temp_file_prevents_any_unlink_and_pass(self):
        code, result, _, _, _ = self.invoke(extra_file=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "ACCEPTED_OBSERVED")
        self.assertEqual(result["guest_temp_cleanup"], "FAILED_RECONCILE")
        folder = self.root / ("kinetra-https-activation-" + NONCE)
        self.assertEqual({path.name for path in folder.iterdir()}, {"activate-https-host.py", "private-input.json", "unexpected"})

    def test_public_pin_mismatch_starts_nothing_and_creates_no_temp(self):
        code, result, _, popen, _ = self.invoke(bad_hash=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["activation_outcome"], "NOT_ATTEMPTED")
        self.assertFalse(popen.called)
        self.assertEqual(list(self.root.iterdir()), [])



if __name__ == '__main__':
    unittest.main()
