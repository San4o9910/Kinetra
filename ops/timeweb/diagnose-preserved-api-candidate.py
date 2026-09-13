#!/usr/bin/env python3
"""Read the exact preserved candidate using frozen validators; never accept launch evidence."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys

ROOT = Path(__file__).resolve().parent
PINS = {
    'activate-application-host.py': '16c9ed2fc47534f86f35e4aa215d824ffbec84fd3c684d5d02157a7e944322c4',
    'prepare-database-host.py': '4621b1c0153ab56ae535e245fdb2de4ef2aff4a30ba5b592343a26795f0655ae',
    'inspect-host-monitoring.py': '3ffc667a66330c323836d1335e78f92940d6ebdc1877cf66048265d774bb3086',
    'inspect-server.py': '567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0',
}

def function(source, name):
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == name)
    return ast.get_source_segment(source, node)

def assignment(source, name):
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets))
    return ast.literal_eval(node.value)

GUEST_BEFORE = r'''
import fcntl, hashlib, json, os, pathlib, re, signal, stat, subprocess
from pathlib import Path
STAGE = Path('/srv/kinetra-stage')
FOLDER = STAGE / 'env/api-preparation-08115658b05bc897f6bdb8f7a7874938'
IMAGE = 'ghcr.io/san4o9910/kinetra-backend@sha256:9138a6408442b847ca771690053870880cee831769919aaf2a2dc858d52e8362'
class StageError(Exception): pass
Error = StageError
def require(value, category):
    if not value: raise StageError(category)
def safe_error(error):
    value = str(error)
    return value if re.fullmatch(r'[A-Z_]{1,90}', value) else 'DIAGNOSTIC_ERROR'
LAST_FAILURE = None
CURRENT_VALIDATOR = 0
CALLS = []
def record_failure(args, code, out, err):
    global LAST_FAILURE
    category = 'CHILD_FAILED'
    raw = (out or b'') + (err or b'')
    patterns = {
        b'operation not permitted': 'OPERATION_NOT_PERMITTED',
        b'permission denied': 'PERMISSION_DENIED',
        b'invalid mount': 'INVALID_MOUNT',
        b'no such file or directory': 'MISSING_PATH',
        b'Single-server configuration rejected': 'SINGLE_SERVER_VALIDATOR_REJECTED',
        b'FREE_BETA_RUNTIME_CONFIGURATION_REQUIRED': 'FREE_BETA_RUNTIME_REJECTED',
    }
    for pattern, label in patterns.items():
        if pattern.lower() in raw.lower(): category = label
    LAST_FAILURE = {'validator': CURRENT_VALIDATOR, 'operation': args[1] if args[1] in {'create','start','inspect','rm'} else 'other',
                    'exit_code': code, 'category': category}
def private_digest(path, expected):
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and not parent.is_symlink(), 'UNSAFE_PARENT')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'PRIVATE_FILE_IDENTITY_CHANGED')
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == expected, 'PRESERVED_FILE_CHANGED')
    return raw
'''

GUEST_AFTER = r'''
original_disposable = disposable_container
def disposable(options, image, arguments, **kwargs):
    global CURRENT_VALIDATOR
    CURRENT_VALIDATOR += 1
    CALLS.append((list(options), image, list(arguments)))
    return original_disposable(options, image, arguments, **kwargs)
state = {'schema':1,'result':'FAIL','error':None,'production_mutations':False,
         'frozen_validation':None,'child_failure':None,'specific_validation':None,
         'owned_container_cleanup':False,'preserved_hashes_unchanged':False}
lock = None
baseline = None
hashes = {
    STAGE/'env/api.env': '491d26791ac0c3d2074c51eb561c2a38885f0e4d5a160e4e7e80f879c9991f5e',
    FOLDER/'api.env': 'f83605434b89354008382d5b87f02aab48b6729e86b56bec419c0affd94c2688',
    FOLDER/'production.env': '4094b16bdb78990c7e011a4672df1e74f9da84c535bd498efa325cffff4afba4',
}
def guard():
    for path, digest in hashes.items(): private_digest(path, digest)
    require(not (FOLDER/'previous-api.env').exists(), 'INSTALLATION_STATE_CHANGED')
    require(not (STAGE/'evidence/application-env.json').exists(), 'APPLICATION_RECORD_CHANGED')
    attempt_path = STAGE/'evidence/application-env-attempt.json'
    info = attempt_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'ATTEMPT_UNSAFE')
    attempt = json.loads(attempt_path.read_bytes())
    require(attempt['candidate_directory'] == FOLDER.name and attempt['commit'] == '73b665065e00a5b375e90f701373b3e0856a0386'
        and attempt['images']['BACKEND_IMAGE'] == IMAGE and attempt['previous_api_sha256'] == hashes[STAGE/'env/api.env'], 'ATTEMPT_CHANGED')
    running = command(['/usr/bin/docker','ps','-a','--filter','label=com.docker.compose.project=kinetra-production',
        '--format','{{.Label "com.docker.compose.service"}}={{.State}}'], capture=True).strip()
    require(running == 'postgres=running', 'APPLICATION_STATE_CHANGED')
    revision = command(['/usr/bin/docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',IMAGE],capture=True).strip()
    require(revision == attempt['commit'], 'IMAGE_REVISION_CHANGED')
try:
    lock_path = Path('/run/kinetra-database-stage.lock')
    info = lock_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'LOCK_UNSAFE')
    lock = os.open(lock_path, os.O_RDONLY|os.O_NOFOLLOW)
    fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
    guard()
    baseline = set(command(['/usr/bin/docker','ps','-aq'],capture=True).split())
    try:
        validate_candidate(IMAGE, FOLDER/'production.env', FOLDER/'api.env')
        state['frozen_validation'] = 'PASS'
    except Exception as error:
        state['frozen_validation'] = safe_error(error)
        state['child_failure'] = LAST_FAILURE
    if state['frozen_validation'] != 'PASS' and CALLS and state['child_failure'] and state['child_failure']['operation'] == 'start':
        # Same frozen options, same mounts/capabilities; only catch errors as fixed nonsecret categories.
        options, image, arguments = CALLS[-1]
        if CURRENT_VALIDATOR == 1:
            script = 'const codes=' + json.dumps(ERROR_CODES) + ';try { const m=await import("file:///srv/kinetra-stage/source/deploy/postgres/validate-single-server.mjs");m.validateSingleServer("/srv/kinetra-stage/env/single-server.env",'+json.dumps(str(FOLDER/'production.env'))+');console.log("KINETRA_CONFIG_DIAG=PASS");} catch(e) {console.log("KINETRA_CONFIG_DIAG="+(codes[e.message]||(["EACCES","ENOENT","EPERM","ENOTDIR"].includes(e.code)?e.code:"UNCLASSIFIED")));}'
            output = original_disposable(options,image,['node','--input-type=module','-e',script],capture=True)
            marker = output.strip()
            allowed = set(ERROR_CODES.values()) | {'PASS','EACCES','ENOENT','EPERM','ENOTDIR','UNCLASSIFIED'}
            require(marker.startswith('KINETRA_CONFIG_DIAG=') and marker.split('=',1)[1] in allowed, 'DIAGNOSTIC_OUTPUT_REFUSED')
            state['specific_validation'] = marker.split('=',1)[1]
    guard()
    state['preserved_hashes_unchanged'] = True
    state['owned_container_cleanup'] = set(command(['/usr/bin/docker','ps','-aq'],capture=True).split()) == baseline
    require(state['owned_container_cleanup'], 'CONTAINER_CLEANUP_REQUIRES_RECONCILIATION')
    state['result'] = 'PASS_READ_ONLY_INSPECTION'
except BaseException as error:
    state['error'] = safe_error(error)
finally:
    if lock is not None: os.close(lock)
print(json.dumps(state, sort_keys=True))
'''

def build_guest(sources, single_source, production_source):
    api = sources['activate-application-host.py']
    db = assignment(sources['prepare-database-host.py'], 'GUEST_PREPARE')
    cmd = function(db, 'command')
    assert cmd.count('stderr=subprocess.DEVNULL') == 1 and cmd.count('output, _ =') == 1
    cmd = cmd.replace('stderr=subprocess.DEVNULL', 'stderr=subprocess.PIPE').replace('output, _ =', 'output, err =')
    original = "if child.returncode != 0: raise StageError('CHILD_COMMAND_FAILED')"
    assert cmd.count(original) == 1
    cmd = cmd.replace(original, "if child.returncode != 0:\n            record_failure(args, child.returncode, output, err)\n            raise StageError('CHILD_COMMAND_FAILED')")
    codes = {}
    for prefix, source, label in [('Invalid single-server configuration: ', single_source, 'SINGLE'),
                                   ('Invalid production configuration: ', production_source, 'PRODUCTION')]:
        reasons = sorted(set(re.findall(r"fail\('([^']+)'\)", source)))
        if label == 'PRODUCTION':
            reasons = sorted(set(reasons) | set(re.findall(r"['\"]([A-Z][A-Z0-9_]+)['\"]", source)))
        for index, reason in enumerate(reasons): codes[prefix+reason+'.'] = label+'_'+str(index).zfill(3)
    guest = '\n'.join([GUEST_BEFORE, cmd, function(db,'disposable_container'),
        'API_ENV_PROGRAM = '+repr(assignment(api,'API_ENV_PROGRAM')),
        function(api,'validate_candidate'), 'ERROR_CODES = '+repr(codes), GUEST_AFTER])
    compile(guest, '<preserved-candidate-diagnostic>', 'exec')
    return guest, codes

def validate(raw):
    value = json.loads(raw)
    expected = {'schema','result','error','production_mutations','frozen_validation','child_failure','specific_validation',
                'owned_container_cleanup','preserved_hashes_unchanged'}
    assert isinstance(value,dict) and set(value) == expected and value['schema'] == 1
    assert value['production_mutations'] is False and value['result'] in {'FAIL','PASS_READ_ONLY_INSPECTION'}
    for key in ('error','frozen_validation','specific_validation'):
        assert value[key] is None or isinstance(value[key],str) and re.fullmatch(r'[A-Z_0-9]{1,90}',value[key])
    child = value['child_failure']
    if child is not None:
        assert set(child) == {'validator','operation','exit_code','category'}
        assert child['validator'] in {1,2} and child['operation'] in {'create','start','inspect','rm','other'}
        assert type(child['exit_code']) is int and -128 <= child['exit_code'] <= 255
        assert child['category'] in {'CHILD_FAILED','OPERATION_NOT_PERMITTED','PERMISSION_DENIED','INVALID_MOUNT','MISSING_PATH','SINGLE_SERVER_VALIDATOR_REJECTED','FREE_BETA_RUNTIME_REJECTED'}
    if value['result'] == 'PASS_READ_ONLY_INSPECTION':
        assert value['error'] is None and value['owned_container_cleanup'] is True and value['preserved_hashes_unchanged'] is True
    return value

def main():
    sources = {}
    for name, digest in PINS.items():
        raw = (ROOT/name).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == digest
        sources[name] = raw.decode()
    app = Path('Kinetra')
    guest, codes = build_guest(sources, (app/'deploy/postgres/validate-single-server.mjs').read_text(), (app/'ops/validate-production-env.mjs').read_text())
    spec = importlib.util.spec_from_file_location('kinetra_candidate_diag',ROOT/'inspect-host-monitoring.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module.GUEST_PROGRAM = guest
    module.validate_result = validate
    signal.signal(signal.SIGTERM,module.inspection.interrupted)
    signal.signal(signal.SIGINT,module.inspection.interrupted)
    print('KINETRA_DIAGNOSTIC_CATEGORY_CATALOG='+json.dumps({v:k for k,v in codes.items()},sort_keys=True))
    return module.main(['--inspect-existing-host-monitoring'],os.environ,module.inspection.Api)

if __name__ == '__main__':
    raise SystemExit(main())
