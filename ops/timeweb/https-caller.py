#!/usr/bin/env python3
"""Authenticate a successful local handoff, then start prepared HTTPS only.

Separate GitHub-reader and Timeweb steps. Existing fixed server, pinned SSH,
unchanged guest assertions and invocation-owned key/temp cleanup. No mail,
payments, application/database restart, boot enablement or data deletion.
"""
from __future__ import annotations
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shlex
import signal
import stat
import sys
import tempfile
import time
import zipfile
import io

PINS = {'start-application-host.py': '654ae707445717a96b04c1a7b1f9e428e22ff06ccb04f40c68a2bf6b2ae11524', 'activate-application-host.py': '16c9ed2fc47534f86f35e4aa215d824ffbec84fd3c684d5d02157a7e944322c4', 'initialize-database-host.py': '041f415dedf6b0b6922484281926c8c98c87828506dcb2e1ac6fb324b00b05bb', 'prepare-database-host.py': '4621b1c0153ab56ae535e245fdb2de4ef2aff4a30ba5b592343a26795f0655ae', 'bootstrap-server.py': 'a19aca3ea953feecdcb9be6e9dcabdfc8b0e2b4f3938184391cdfb2ff3e87c9e', 'inspect-server.py': '567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0', 'prepare-api-host.py': '6b63573205b874c03d08e6147eec364928630ff094100848a7146382700740ea', 'activate-local-application-host.py': '54779ce7be566e633247d9338ef94d2ddebf43ff9169e429fd72cc6ffb9135e2', 'activate-https-host.py': 'f30c6026e238eb411b8591b1234c88f210efd15748c2888f15f87cf34198bc69', 'prepare-caddy.sh': 'a23d52b21f7c638f757a723048ee632d37e8f217ae796f97dd92ec3bbb990e2d'}
CALLER_SHA256 = "f5d31335b0c7667480d2da9938e5604d1d2cdda5c5ef6df3880c41b979c2038e"


def load_caller():
    path = Path(__file__).with_name('application-caller.py')
    if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != CALLER_SHA256:
        raise ValueError('HTTPS_CALLER_DEPENDENCY_MISMATCH')
    spec = importlib.util.spec_from_file_location('kinetra_https_application_caller', path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


caller = load_caller()
local = caller.load('activate-local-application-host.py')
inspection, stage, bootstrap = local.inspection, local.stage, local.bootstrap
Error, require = caller.CallerError, caller.require
canonical_hash = caller.digest
LOCAL_ENV = ('APPROVED_LOCAL_RUN', 'APPROVED_LOCAL_CONTROL_COMMIT', 'APPROVED_LOCAL_WORKFLOW_SHA256',
             'APPROVED_LOCAL_ARTIFACT_ID', 'APPROVED_LOCAL_ARTIFACT_SHA256')
WORKFLOW = '.github/workflows/timeweb-application-activation.yml'


def execution(env):
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == caller.REPOSITORY
            and env.get('GITHUB_REF') == caller.CONTROL_REF and env.get('GITHUB_RUN_ATTEMPT') == '1'
            and env.get('ACTIVATE_PREPARED_HTTPS') == 'APPROVED', 'EXPLICIT_HTTPS_RUN_REQUIRED')
    for name in (*caller.SOURCE_ENV, *LOCAL_ENV, 'GITHUB_SHA', 'GITHUB_RUN_ID'):
        value = env.get(name, '')
        require(value and value != 'REVIEW_REQUIRED', 'HTTPS_REVIEW_INPUT_REQUIRED')
        if name.endswith('SHA256'):
            require(re.fullmatch(r'[a-f0-9]{64}', value), 'HTTPS_REVIEW_HASH_INVALID')
        elif name.endswith('COMMIT') or name == 'GITHUB_SHA':
            require(re.fullmatch(r'[a-f0-9]{40}', value), 'HTTPS_REVIEW_COMMIT_INVALID')
        elif name.endswith(('_RUN', '_ID')):
            require(re.fullmatch(r'[1-9][0-9]{0,19}', value), 'HTTPS_REVIEW_RUN_INVALID')
    stage.metadata(env)


def folder(env, *, create=False):
    root = Path(env.get('RUNNER_TEMP', ''))
    require(root.is_absolute() and root.resolve() == root and root.is_dir(), 'HTTPS_RUNNER_TEMP_INVALID')
    path = root / ('kinetra-https-caller-' + env['GITHUB_RUN_ID'] + '-1')
    if create: path.mkdir(mode=0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700 and path.resolve() == path, 'HTTPS_CALLER_FOLDER_INVALID')
    return path


def validate_handoff(value, env):
    keys = {'schema', 'request_sha256', 'local_outer', 'approved', 'database_outer', 'api_outer', 'provenance'}
    require(isinstance(value, dict) and set(value) == keys and type(value['schema']) is int and value['schema'] == 1,
            'LOCAL_HANDOFF_SCHEMA_INVALID')
    request = {name: value[name] for name in ('schema', 'approved', 'database_outer', 'api_outer', 'provenance')}
    require(value['request_sha256'] == canonical_hash(request), 'LOCAL_HANDOFF_REQUEST_MISMATCH')
    provenance = request['provenance']
    require(provenance.get('control_commit') == env['APPROVED_LOCAL_CONTROL_COMMIT'], 'LOCAL_HANDOFF_CONTROL_MISMATCH')
    prior = dict(env, GITHUB_SHA=env['APPROVED_LOCAL_CONTROL_COMMIT'],
        APPROVED_DATABASE_OUTER_SHA256=canonical_hash(request['database_outer']),
        APPROVED_API_OUTER_SHA256=canonical_hash(request['api_outer']), APPROVED_PROVENANCE_SHA256=canonical_hash(provenance))
    local.validate_request(request, prior)
    caller.validate_local_outer(value['local_outer'], request, local)
    approved, accepted = value['approved'], value['local_outer']['activation']['start']
    checkpoint = dict(accepted, result='CHECKPOINT_ONLY', requires_matching_outer_success=True,
        checkpoint_kind='LOCAL_OBSERVATIONS_NOT_AN_ACTIVATION_HANDOFF', commit=approved['commit'], images=approved['images'],
        handoff_hashes=approved['handoff_hashes'], configuration_hashes=approved['configuration_hashes'])
    return {'schema': 1, 'server_id': 9069403, 'public_ipv4': '80.68.156.131', 'approved': approved,
            'local_outer': value['local_outer'], 'local_outer_sha256': canonical_hash(value['local_outer']),
            'local_checkpoint_sha256': hashlib.sha256((json.dumps(checkpoint, sort_keys=True) + '\n').encode()).hexdigest()}


def authenticate(env, api, successful_run):
    run, jobs = successful_run(env['APPROVED_LOCAL_RUN'], WORKFLOW, env['APPROVED_LOCAL_CONTROL_COMMIT'], 'push')
    require(run['head_branch'] == caller.CONTROL_REF.removeprefix('refs/heads/')
            and len(jobs) == 1 and jobs[0]['name'] == 'activate-local-application', 'LOCAL_RUN_IDENTITY_INVALID')
    source = api('/contents/' + WORKFLOW + '?ref=' + env['APPROVED_LOCAL_CONTROL_COMMIT'])
    require(source['type'] == 'file' and source['encoding'] == 'base64', 'LOCAL_WORKFLOW_INVALID')
    require(hashlib.sha256(base64.b64decode(source['content'])).hexdigest() == env['APPROVED_LOCAL_WORKFLOW_SHA256'],
            'LOCAL_WORKFLOW_HASH_MISMATCH')
    artifact = api('/actions/artifacts/' + env['APPROVED_LOCAL_ARTIFACT_ID'])
    require(artifact['id'] == int(env['APPROVED_LOCAL_ARTIFACT_ID']) and artifact['expired'] is False
            and artifact['name'] == 'kinetra-local-handoff-' + env['APPROVED_LOCAL_RUN'] + '-1'
            and artifact['workflow_run']['id'] == int(env['APPROVED_LOCAL_RUN'])
            and artifact['workflow_run']['head_sha'] == env['APPROVED_LOCAL_CONTROL_COMMIT']
            and artifact['digest'] == 'sha256:' + env['APPROVED_LOCAL_ARTIFACT_SHA256']
            and 0 < artifact['size_in_bytes'] <= caller.LIMIT, 'LOCAL_ARTIFACT_IDENTITY_INVALID')
    raw = api('/actions/artifacts/' + env['APPROVED_LOCAL_ARTIFACT_ID'] + '/zip', archive=True)
    require(len(raw) <= caller.LIMIT and hashlib.sha256(raw).hexdigest() == env['APPROVED_LOCAL_ARTIFACT_SHA256'],
            'LOCAL_ARTIFACT_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        require(archive.namelist() == ['accepted-local-handoff.json'], 'LOCAL_ARTIFACT_MEMBERS_INVALID')
        info = archive.getinfo('accepted-local-handoff.json')
        require(not info.is_dir() and not info.flag_bits & 1 and info.file_size <= caller.LIMIT, 'LOCAL_ARTIFACT_MEMBER_INVALID')
        value = caller.strict_json(archive.read(info))
    approved = validate_handoff(value, env)
    path = folder(env, create=True)
    caller.write_json(path / 'receipt.json', {'schema': 1, 'repository': caller.REPOSITORY,
        'control_commit': env['GITHUB_SHA'], 'run_id': env['GITHUB_RUN_ID'],
        'inputs': {name: env[name] for name in (*caller.SOURCE_ENV, *LOCAL_ENV)},
        'local_handoff': value, 'approved_sha256': canonical_hash(approved)})
    return approved


def approved_input(env):
    receipt = caller.read_json(folder(env) / 'receipt.json')
    require(set(receipt) == {'schema', 'repository', 'control_commit', 'run_id', 'inputs', 'local_handoff', 'approved_sha256'}
            and type(receipt['schema']) is int and receipt['schema'] == 1 and receipt['repository'] == caller.REPOSITORY
            and receipt['control_commit'] == env['GITHUB_SHA'] and receipt['run_id'] == env['GITHUB_RUN_ID']
            and receipt['inputs'] == {name: env[name] for name in (*caller.SOURCE_ENV, *LOCAL_ENV)}, 'HTTPS_RECEIPT_IDENTITY_MISMATCH')
    approved = validate_handoff(receipt['local_handoff'], env)
    require(receipt['approved_sha256'] == canonical_hash(approved), 'HTTPS_RECEIPT_INPUT_MISMATCH')
    return approved


def public_helpers():
    result = {}
    for name, digest in PINS.items():
        path = Path(__file__).with_name(name)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_mode & 0o022 == 0 and 0 < info.st_size <= 262144,
                'HTTPS_HELPER_FILE_INVALID')
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == digest, 'HTTPS_HELPER_HASH_MISMATCH')
        result[name] = base64.b64encode(raw).decode('ascii')
    return result


HTTPS_RESULT_VALIDATOR = r'''
def validate_https(value):
    keys = {'schema', 'result', 'phase', 'error', 'nonce', 'attempt_recorded', 'start_attempted',
            'owned_invocation', 'rollback', 'https', 'database_policy_changed', 'boot_enabled',
            'provider_requests', 'full_launch_accepted', 'remaining'}
    require(isinstance(value, dict) and set(value) == keys and type(value['schema']) is int and value['schema'] == 1,
            'HTTPS_GUEST_SCHEMA_INVALID')
    require(value['result'] in {'FAIL', 'HTTPS_ACCEPTED_ONLY'} and isinstance(value['phase'], str)
            and re.fullmatch(r'[A-Z_]{1,90}', value['phase']), 'HTTPS_GUEST_RESULT_INVALID')
    require(value['error'] is None or isinstance(value['error'], str) and re.fullmatch(r'[A-Z_]{1,90}', value['error']), 'HTTPS_GUEST_ERROR_INVALID')
    for key in ('nonce', 'owned_invocation'):
        require(value[key] is None or isinstance(value[key], str) and re.fullmatch(r'[a-f0-9]{32}', value[key]), 'HTTPS_GUEST_IDENTITY_INVALID')
    for key in ('attempt_recorded', 'start_attempted', 'database_policy_changed', 'boot_enabled', 'full_launch_accepted'):
        require(type(value[key]) is bool, 'HTTPS_GUEST_FLAG_INVALID')
    require(not value['database_policy_changed'] and not value['boot_enabled'] and not value['full_launch_accepted']
            and type(value['provider_requests']) is int and value['provider_requests'] == 0, 'HTTPS_GUEST_SCOPE_EXCEEDED')
    require(value['rollback'] in {'NOT_NEEDED', 'OWNED_CADDY_STOPPED', 'UNKNOWN_RECONCILE'}, 'HTTPS_GUEST_ROLLBACK_INVALID')
    require(not value['start_attempted'] or value['attempt_recorded'], 'HTTPS_GUEST_ATTEMPT_INVALID')
    require(not value['attempt_recorded'] or value['nonce'] is not None, 'HTTPS_GUEST_NONCE_MISSING')
    require(value['owned_invocation'] is None or value['start_attempted'], 'HTTPS_GUEST_OWNERSHIP_INVALID')
    require(value['rollback'] != 'OWNED_CADDY_STOPPED' or value['owned_invocation'] is not None, 'HTTPS_ROLLBACK_OWNERSHIP_MISSING')
    require(value['remaining'] == ['EXTERNAL_BROWSER_ACCEPTANCE', 'DATABASE_PERSISTENT_POLICY', 'BOOT_ENABLEMENT', 'BACKUP_AND_USER_LAUNCH'], 'HTTPS_REMAINING_SCOPE_INVALID')
    https = value['https']
    require(isinstance(https, dict), 'HTTPS_GUEST_EVIDENCE_INVALID')
    if https:
        require(set(https) == {'http', 'certificate', 'redirect_status'} and type(https['redirect_status']) is int
                and https['redirect_status'] == 308, 'HTTPS_REDIRECT_EVIDENCE_INVALID')
        cert = https['certificate']
        require(isinstance(cert, dict) and set(cert) == {'sha256', 'ip_san', 'not_before', 'not_after', 'trusted'}
                and cert['ip_san'] == '80.68.156.131' and cert['trusted'] is True
                and isinstance(cert['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', cert['sha256'])
                and type(cert['not_before']) is int and type(cert['not_after']) is int
                and 0 < cert['not_before'] < cert['not_after'], 'HTTPS_CERTIFICATE_EVIDENCE_INVALID')
        http = https['http']
        require(isinstance(http, dict) and 6 <= len(http) <= 16 and {'/', '/health', '/ready', '/api/v1/me'} <= set(http), 'HTTPS_HTTP_EVIDENCE_INVALID')
        for path, entry in http.items():
            require(path in {'/', '/health', '/ready', '/api/v1/me'} or isinstance(path, str) and len(path) <= 240
                    and re.fullmatch(r'/assets/[A-Za-z0-9_./-]+\.(?:js|css)', path) and '..' not in path, 'HTTPS_HTTP_PATH_INVALID')
            require(isinstance(entry, dict) and set(entry) == {'status', 'sha256'} and type(entry['status']) is int
                    and entry['status'] == {'/ready': 404, '/api/v1/me': 401}.get(path, 200)
                    and isinstance(entry['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', entry['sha256']), 'HTTPS_HTTP_ENTRY_INVALID')
        require(any(p.endswith('.js') for p in http) and any(p.endswith('.css') for p in http), 'HTTPS_ASSET_EVIDENCE_MISSING')
    if value['result'] == 'HTTPS_ACCEPTED_ONLY':
        require(value['error'] is None and value['phase'] == 'HTTPS_ACCEPTANCE_COMPLETE'
                and value['attempt_recorded'] and value['start_attempted'] and value['owned_invocation'] is not None
                and value['rollback'] == 'NOT_NEEDED' and https, 'HTTPS_SUCCESS_INCOMPLETE')
    else:
        require(value['error'] is not None, 'HTTPS_FAILURE_INCOMPLETE')
    return value
'''
exec(compile(HTTPS_RESULT_VALIDATOR, '<https-result-validator>', 'exec'))


GUEST_LAUNCHER = "PINS = " + repr(PINS) + "\n" + r'''
import base64, hashlib, json, os, pathlib, re, resource, signal, stat, subprocess, sys
sys.dont_write_bytecode = True
class Error(Exception): pass
def require(condition, category):
    if not condition: raise Error(category)
def interrupted(_signum, _frame): raise Error('HTTPS_LAUNCHER_INTERRUPTED')
def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()
''' + HTTPS_RESULT_VALIDATOR + r'''

def write_new(path, raw, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())

def cleanup_owned(folder, identity):
    info = folder.lstat()
    require(not folder.is_symlink() and (info.st_dev, info.st_ino) == identity
            and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'TEMP_DIRECTORY_IDENTITY_CHANGED')
    paths = list(folder.iterdir())
    for path in paths:
        entry = path.lstat()
        require(path.name in set(PINS) | {'private-input.json'} and stat.S_ISREG(entry.st_mode)
                and entry.st_uid == 0, 'TEMP_DIRECTORY_CONTENT_CHANGED')
    for path in paths: path.unlink()
    folder.rmdir()

def main():
    state = {'schema': 1, 'result': 'FAIL', 'error': None, 'approved_input_sha256': None, 'commit': None, 'images': None,
             'start': None, 'activation_outcome': 'NOT_ATTEMPTED', 'guest_temp_cleanup': 'NOT_NEEDED', 'remote_directory': None}
    folder, identity, child = None, None, None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.umask(0o077)
        require(os.geteuid() == 0, 'ROOT_REQUIRED')
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, 'HTTPS_TRANSPORT_INPUT_TOO_LARGE')
        data = json.loads(raw)
        require(isinstance(data, dict) and set(data) == {'schema', 'nonce', 'approved', 'helpers'}
                and type(data['schema']) is int and data['schema'] == 1, 'HTTPS_TRANSPORT_INPUT_INVALID')
        require(isinstance(data['nonce'], str) and re.fullmatch(r'[a-f0-9]{32}', data['nonce']), 'HTTPS_TRANSPORT_NONCE_INVALID')
        require(isinstance(data['helpers'], dict) and set(data['helpers']) == set(PINS), 'PUBLIC_HELPER_SET_INVALID')
        files = {}
        for name, digest in PINS.items():
            body = base64.b64decode(data['helpers'][name], validate=True)
            require(0 < len(body) <= 262144 and hashlib.sha256(body).hexdigest() == digest, 'PUBLIC_HELPER_HASH_MISMATCH')
            files[name] = body
        approved = data['approved']
        require(isinstance(approved, dict) and set(approved) == {'schema', 'server_id', 'public_ipv4',
                'approved', 'local_outer', 'local_outer_sha256', 'local_checkpoint_sha256'}, 'HTTPS_APPROVED_INPUT_INVALID')
        require(type(approved['server_id']) is int and approved['server_id'] == 9069403
                and approved['public_ipv4'] == '80.68.156.131', 'FIXED_SERVER_REQUIRED')
        run = pathlib.Path('/run')
        info = run.lstat()
        require(stat.S_ISDIR(info.st_mode) and run.resolve() == run and info.st_uid == 0
                and info.st_mode & 0o022 == 0, 'PRIVATE_RUNTIME_PARENT_INVALID')
        proposed = run / ('kinetra-https-activation-' + data['nonce'])
        proposed.mkdir(mode=0o700)
        folder = proposed
        info = folder.lstat()
        identity = (info.st_dev, info.st_ino)
        state.update(guest_temp_cleanup='PENDING', remote_directory=str(folder))
        for name, body in files.items(): write_new(folder / name, body, 0o644)
        private = folder / 'private-input.json'
        write_new(private, (json.dumps(approved, allow_nan=False) + '\n').encode(), 0o600)
        # Record uncertainty BEFORE process creation: spawn itself may have an
        # indeterminate outcome. Never report an application as stopped by guess.
        state.update(activation_outcome='UNKNOWN_RECONCILE', approved_input_sha256=canonical_hash(approved),
                     commit=approved['approved']['commit'], images=approved['approved']['images'])
        child = subprocess.Popen(['/usr/bin/python3', '-B', str(folder / 'activate-https-host.py'),
            '--activate-prepared-https', '--private-input', str(private)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, start_new_session=True)
        output, _ = child.communicate(timeout=1200)
        require(len(output) <= 65536, 'HTTPS_GUEST_OUTPUT_TOO_LARGE')
        result = validate_https(json.loads(output))
        state.update(start=result, activation_outcome='ACCEPTED_OBSERVED' if result['result'] == 'HTTPS_ACCEPTED_ONLY' else 'FAILED_OBSERVED')
        require(child.returncode == 0 and result['result'] == 'HTTPS_ACCEPTED_ONLY', 'HTTPS_ACTIVATION_FAILED_STATE_PRESERVED')
        state['result'] = 'HTTPS_ACCEPTED_ONLY'
    except Error as error:
        state['error'] = str(error) if re.fullmatch(r'[A-Z_]{1,90}', str(error)) else 'HTTPS_LAUNCHER_VALIDATION_FAILED'
    except BaseException:
        state['error'] = 'HTTPS_LAUNCHER_FAILED_STATE_PRESERVED'
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                # Allow the guest's bounded, invocation-owned Caddy rollback.
                child.wait(timeout=600)
            except BaseException:
                try:
                    if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except BaseException:
                    state['error'] = 'HTTPS_CHILD_EXIT_REQUIRES_RECONCILIATION'
        if child is not None and child.stdout is not None: child.stdout.close()
        if folder is not None:
            try:
                require(child is None or child.poll() is not None, 'HTTPS_CHILD_STILL_RUNNING')
                cleanup_owned(folder, identity)
                state['guest_temp_cleanup'] = 'REMOVED'
            except BaseException:
                state['guest_temp_cleanup'] = 'FAILED_RECONCILE'
                state['error'] = state['error'] or 'GUEST_TEMP_CLEANUP_REQUIRES_RECONCILIATION'
        if state['error'] is not None: state['result'] = 'FAIL'
        print(json.dumps(state, sort_keys=True, allow_nan=False), flush=True)
    return 0 if state['result'] == 'HTTPS_ACCEPTED_ONLY' else 1

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
'''



def validate_remote(raw, approved, nonce):
    value = json.loads(raw)
    keys = {"schema", "result", "error", "approved_input_sha256", "commit", "images", "start", "activation_outcome", "guest_temp_cleanup", "remote_directory"}
    require(isinstance(value, dict) and set(value) == keys and type(value["schema"]) is int and value["schema"] == 1, "REMOTE_HTTPS_RESULT_SCHEMA_INVALID")
    require(value["result"] in {"FAIL", "HTTPS_ACCEPTED_ONLY"}
            and (value["error"] is None or isinstance(value["error"], str) and re.fullmatch(r"[A-Z_]{1,90}", value["error"])), "REMOTE_HTTPS_RESULT_INVALID")
    require(value["guest_temp_cleanup"] in {"NOT_NEEDED", "REMOVED", "FAILED_RECONCILE"}
            and value["remote_directory"] in {None, "/run/kinetra-https-activation-" + nonce}, "REMOTE_TEMP_IDENTITY_INVALID")
    require((value["remote_directory"] is None) == (value["guest_temp_cleanup"] == "NOT_NEEDED"), "REMOTE_TEMP_EVIDENCE_INVALID")
    outcome = value["activation_outcome"]
    require(outcome in {"NOT_ATTEMPTED", "UNKNOWN_RECONCILE", "FAILED_OBSERVED", "ACCEPTED_OBSERVED"}, "REMOTE_OUTCOME_INVALID")
    if outcome != "NOT_ATTEMPTED":
        require(value["approved_input_sha256"] == canonical_hash(approved) and value["commit"] == approved["approved"]["commit"]
                and value["images"] == approved["approved"]["images"] and value["remote_directory"] is not None, "REMOTE_APPROVED_IDENTITY_MISMATCH")
    else:
        require(all(value[key] is None for key in ("approved_input_sha256", "commit", "images", "start")), "REMOTE_NOT_ATTEMPTED_INVALID")
    if value["start"] is not None:
        validate_https(value["start"])
        require(outcome == ("ACCEPTED_OBSERVED" if value["start"]["result"] == "HTTPS_ACCEPTED_ONLY" else "FAILED_OBSERVED"), "REMOTE_OBSERVED_OUTCOME_INVALID")
    else:
        require(outcome in {"NOT_ATTEMPTED", "UNKNOWN_RECONCILE"}, "REMOTE_MISSING_GUEST_RESULT")
    if value["result"] == "HTTPS_ACCEPTED_ONLY":
        require(value["error"] is None and outcome == "ACCEPTED_OBSERVED" and value["guest_temp_cleanup"] == "REMOVED", "REMOTE_HTTPS_PASS_INCOMPLETE")
        require(value["start"]["https"]["http"] == approved["local_outer"]["activation"]["start"]["local_http"], "HTTPS_LOCAL_RESPONSE_MISMATCH")
    else:
        require(value["error"] is not None, "REMOTE_HTTPS_FAILURE_INCOMPLETE")
    return value


def emit(state):
    print("TIMEWEB_HTTPS_ACTIVATION=" + json.dumps(state, sort_keys=True, allow_nan=False), flush=True)


def require_prepared_guest(raw):
    guest = inspection.validate_guest(raw)
    require(guest['cloud_init'] == 'PASS' and all(guest[key] for key in (
        'bootstrap_marker', 'password_auth_disabled', 'keyboard_interactive_disabled',
        'root_login_key_only', 'listeners_verified', 'docker_available',
    )) and guest['selected_listener_ports'] == [22, 8080], 'PRE_HTTPS_GUEST_PRECONDITION_FAILED')
    # The frozen HTTPS guest independently proves 8080 binds only to loopback,
    # exact live container identities, private PostgreSQL and inactive Caddy.
    return guest


def host(approved, environ, api_factory=inspection.Api):
    state = {"schema": 1, "result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "host_key_fingerprint": None, "server_status": "UNKNOWN", "ssh_key_id": None, "remote_directory": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "guest_temp_cleanup": "NOT_NEEDED", "activation": None, "activation_outcome": "NOT_ATTEMPTED", "error": None,
        "approved_input_sha256": None, "local_outer_sha256": None, "caddy_started": None, "database_policy_changed": False,
        "provider_requests": 0, "full_launch_accepted": False}
    api, folder, payload, request = None, None, b"", None
    token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
    try:
        data = approved
        require(not any(environ.get(key) for key in (*local.prepare.activation.PROVIDER_ENV_KEYS, "GITHUB_TOKEN", "GH_TOKEN")), "HTTPS_UNRELATED_SECRETS_FORBIDDEN")
        require(environ.get("GITHUB_ACTIONS") == "true" and environ.get("GITHUB_REPOSITORY") == inspection.REPOSITORY
                and environ.get("GITHUB_RUN_ATTEMPT") == "1", "AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "SUPPLIED_RUN_ID_INVALID")
        require(environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) == str(inspection.SERVER_ID)
                and environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) == inspection.PUBLIC_IPV4, "CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        require(runtime_temp.is_absolute() and runtime_temp.resolve() == runtime_temp and runtime_temp.is_dir(), "RUNNER_TEMP_INVALID")
        require(token and len(token) <= 16384 and not any(character.isspace() for character in token), "TIMEWEB_SECRET_MISSING_OR_INVALID")
        local.validate_approved(data["approved"])
        public = public_helpers()
        state.update(approved_input_sha256=canonical_hash(data), local_outer_sha256=data["local_outer_sha256"])
        nonce = secrets.token_hex(16)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + 3600
        api = api_factory(token, inspection.SERVER_ID, deadline)
        token = ""
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        require(state["server_status"] == "on", "EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-https-activate-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        require(fingerprint == stage.PINNED_FINGERPRINT, "PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-https-activate-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        require(key.get("name") == name and key.get("body") == public_key and key.get("is_default") is False, "CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state.update(account_key_cleanup="PENDING", guest_key_cleanup="ATTACH_OUTCOME_UNKNOWN")
        emit(state)
        api.request("POST", f"/servers/{inspection.SERVER_ID}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        require(state["server_status"] == "on", "SERVER_NO_LONGER_ON")
        arguments = inspection.ssh_arguments(inspection.PUBLIC_IPV4, private, known_hosts)
        inspection.wait_for_key(arguments, deadline)
        code, output, _ = inspection.run_bounded(arguments + ["/usr/bin/python3 -c " + shlex.quote(inspection.GUEST_PROGRAM)], 215)
        require(code == 0, "PRE_HTTPS_ACTIVATION_INSPECTION_FAILED")
        require_prepared_guest(output)
        require(deadline - time.monotonic() >= 1800 + 870, "INSUFFICIENT_ACTIVATION_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=630s " + str(1800) + "s /usr/bin/python3 -B -c " + shlex.quote(GUEST_LAUNCHER)
        payload = json.dumps({"schema": 1, "nonce": nonce, "approved": data, "helpers": public}, allow_nan=False).encode()
        state.update(activation_outcome="UNKNOWN_RECONCILE", guest_temp_cleanup="UNKNOWN_RECONCILE", remote_directory="/run/kinetra-https-activation-" + nonce)
        code, output, _ = stage.run_with_input(arguments + [command], payload, 1800 + 690)
        payload = b""
        remote = validate_remote(output, data, nonce)
        state.update(activation=remote, guest_temp_cleanup=remote["guest_temp_cleanup"], activation_outcome=remote["activation_outcome"], remote_directory=remote["remote_directory"])
        require(code == 0 and remote["result"] == "HTTPS_ACCEPTED_ONLY", "REMOTE_HTTPS_ACTIVATION_FAILED_STATE_PRESERVED")
        state["result"] = "HTTPS_ACCEPTED_ONLY"
        state["caddy_started"] = True
    except (Error, local.Error, local.prepare.activation.Error) as error:
        category = str(error)
        state["result"], state["error"] = "FAIL", category if re.fullmatch(r"[A-Z_]{1,90}", category) else "HTTPS_ACTIVATION_VALIDATION_FAILED"
    except BaseException:
        state["result"], state["error"] = "FAIL", "UNEXPECTED_HTTPS_ACTIVATION_ERROR_STATE_PRESERVED"
    finally:
        token, payload, request = "", b"", None
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"}
               for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup", "guest_temp_cleanup")):
            state["result"], state["error"] = "FAIL", state["error"] or "CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "HTTPS_ACCEPTED_ONLY" else 1


def https_progress(state):
    result = caller.progress(state)
    if state.get('result') == 'HTTPS_ACCEPTED_ONLY': result['result'] = 'HTTPS_ACCEPTED_ONLY'
    directory = state.get('remote_directory')
    if isinstance(directory, str) and re.fullmatch(r'/run/kinetra-https-activation-[a-f0-9]{32}', directory):
        result['remote_directory'] = directory
    error = state.get('error')
    if isinstance(error, str) and re.fullmatch(r'[A-Z_]{1,90}', error): result['error'] = error
    if state.get('activation_outcome') in {'NOT_ATTEMPTED', 'UNKNOWN_RECONCILE', 'FAILED_OBSERVED', 'ACCEPTED_OBSERVED'}:
        result['activation_outcome'] = state['activation_outcome']
    if type(state.get('caddy_started')) is bool: result['caddy_started'] = state['caddy_started']
    activation = state.get('activation')
    if isinstance(activation, dict) and isinstance(activation.get('start'), dict):
        for key in ('nonce', 'owned_invocation'):
            value = activation['start'].get(key)
            if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value): result[key] = value
    return result


def capture_https(callback, prefix, path):
    # Preserve every completed observation immediately. A later interruption
    # must not erase an already emitted key/container identity needed for cleanup.
    public_stdout = sys.stdout
    fd = os.open(path.with_suffix(".observations.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as observations:
        class Sink:
            pending, total, last = "", 0, None
            def write(self, text):
                self.total += len(text)
                require(self.total <= caller.LIMIT, "WRAPPER_OUTPUT_TOO_LARGE")
                self.pending += text
                while "\n" in self.pending:
                    line, self.pending = self.pending.split("\n", 1)
                    require(line.startswith(prefix), "WRAPPER_OUTPUT_INVALID")
                    state = caller.strict_json(line[len(prefix):])
                    require(isinstance(state, dict), "WRAPPER_OUTER_OBJECT_REQUIRED")
                    summary = https_progress(state)
                    observations.write(caller.canonical_bytes(summary) + b"\n")
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


def main(argv=None, env=None):
    argv = sys.argv[1:] if argv is None else argv
    env = os.environ if env is None else env
    try:
        require(argv in (['--authenticate-local'], ['--activate-https']), 'EXPLICIT_HTTPS_PHASE_REQUIRED')
        execution(env)
        if argv == ['--authenticate-local']:
            require(env.get('GH_TOKEN') and not env.get('TIMEWEB_CLOUD_TOKEN'), 'HTTPS_READER_CREDENTIAL_SCOPE_INVALID')
            api, successful_run = caller.load('verify-launch-provenance.py').verify_source_and_images()
            authenticate(env, api, successful_run)
            print('KINETRA_HTTPS_LOCAL_HANDOFF_AUTHENTICATED=PASS')
        else:
            require(not any(env.get(name) for name in (*local.prepare.activation.PROVIDER_ENV_KEYS, 'GH_TOKEN', 'GITHUB_TOKEN')),
                    'HTTPS_UNRELATED_SECRETS_FORBIDDEN')
            approved = approved_input(env)
            path = folder(env)
            result = capture_https(lambda: host(approved, env), 'TIMEWEB_HTTPS_ACTIVATION=', path / 'https-outer.json')
            require(result['result'] == 'HTTPS_ACCEPTED_ONLY' and result['error'] is None
                    and result['approved_input_sha256'] == canonical_hash(approved)
                    and result['local_outer_sha256'] == approved['local_outer_sha256'], 'HTTPS_OUTER_ACCEPTANCE_INVALID')
            for name in ('guest_key_cleanup', 'account_key_cleanup'):
                require(result[name] in {'API_DELETE_CONFIRMED', 'ALREADY_ABSENT'}, 'HTTPS_KEY_CLEANUP_INCOMPLETE')
            require(result['local_key_cleanup'] == result['guest_temp_cleanup'] == 'REMOVED', 'HTTPS_TEMP_CLEANUP_INCOMPLETE')
            caller.write_json(path / 'https-outer.json', result)
            caller.write_json(path / 'accepted-https-handoff.json', {'schema': 1, 'repository': caller.REPOSITORY,
                'control_commit': env['GITHUB_SHA'], 'run_id': env['GITHUB_RUN_ID'],
                'approved': approved, 'https_outer': result, 'full_launch_accepted': False})
            print('KINETRA_HTTPS_CALLER=PASS_HTTPS_ONLY')
        return 0
    except (caller.CallerError, local.Error, local.prepare.activation.Error) as error:
        category = str(error)
        print('KINETRA_HTTPS_CALLER=FAIL:' + (category if re.fullmatch(r'[A-Z_]{1,90}', category) else 'VALIDATION_FAILED'))
    except BaseException:
        print('KINETRA_HTTPS_CALLER=FAIL:PRIVATE_STATE_PRESERVED')
    return 1


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    raise SystemExit(main())
