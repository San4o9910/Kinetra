#!/usr/bin/env python3
"""One reconciliation of the inspected candidate; no initialization or service startup.

Frozen helper files and validation functions remain unchanged. This separate entry
point accepts only the exact observed partial state instead of an absent attempt.
It restores mode0700 on the single proven volume root, adopts existing credentials,
and executes original candidate, live identity, install and handoff checks.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import stat
import sys

FROZEN_SHA = '16c9ed2fc47534f86f35e4aa215d824ffbec84fd3c684d5d02157a7e944322c4'
path = Path(__file__).with_name('activate-application-host.py')
assert hashlib.sha256(path.read_bytes()).hexdigest() == FROZEN_SHA
spec = importlib.util.spec_from_file_location('kinetra_frozen_api', path)
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
require = a.require
STAGE = a.STAGE
CANDIDATE = 'api-preparation-08115658b05bc897f6bdb8f7a7874938'
OLD_SHA = '491d26791ac0c3d2074c51eb561c2a38885f0e4d5a160e4e7e80f879c9991f5e'
API_SHA = 'f83605434b89354008382d5b87f02aab48b6729e86b56bec419c0affd94c2688'
MAIN_SHA = '4094b16bdb78990c7e011a4672df1e74f9da84c535bd498efa325cffff4afba4'
APP = '73b665065e00a5b375e90f701373b3e0856a0386'
ROOT_IDENTITY = (2049, 524370, 999, 999, 0o1777)
PGDATA_IDENTITY = (2049, 547799, 999, 0, 0o700)
RECOVERY_ATTEMPT = 'application-env-recovery-attempt.json'

def directory_identity(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink(), 'RECOVERY_DIRECTORY_UNSAFE')
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))

def read_recovery_handoff(data):
    # Original pre-candidate handoff/source/metadata checks, with an explicit
    # positive identity check for the inspected attempt at the end.
    a.safe_parent(STAGE)
    require(stat.S_IMODE(STAGE.stat().st_mode) == 0o700, 'STAGE_PRIVACY_INVALID')
    fixed_evidence = {name:a.private_read(STAGE/'evidence'/name) for name in a.EVIDENCE_FILES[:2]}
    fixed_configuration = {name:a.public_source(STAGE/name) if name.startswith('edge/') else a.private_read(STAGE/name)
                           for name in a.CONFIG_FILES if name != 'env/api.env'}
    staged = json.loads(fixed_evidence['stage.json'])
    stage_core = {key:value for key,value in staged.items() if key not in {'images','source_hashes'}}
    a.stage.validate_stage_result(json.dumps(stage_core))
    require(staged['result']=='STAGED_ONLY' and staged['images']==data['images']
            and staged['source_hashes']==data['source_hashes'] and staged['commit']==data['commit'], 'STAGE_IDENTITY_MISMATCH')
    initialized = json.loads(fixed_evidence['initialization.json'])
    init_core = {key:value for key,value in initialized.items() if key not in {'images','migration_hashes'}}
    a.initialization.validate_initialization_result(json.dumps(init_core))
    require(initialized['result']=='DATABASE_INITIALIZED_ONLY' and initialized['images']==data['images']
            and initialized['migration_hashes']==data['migration_hashes'] and initialized['commit']==data['commit'], 'INITIALIZATION_IDENTITY_MISMATCH')
    for name,digest in data['source_hashes'].items():
        require(a.sha256(a.public_source(STAGE/'source'/name))==digest, 'STAGED_SOURCE_CHANGED')
    old_api = a.private_read(STAGE/'env/api.env')
    require(a.parse_env(old_api)=={'NODE_ENV':'production'}, 'EXISTING_API_CREDENTIALS_PRESERVED')
    main = a.parse_env(fixed_configuration['env/production.env'])
    expected = {key:data['images'][key] for key in ('NODE_IMAGE','NGINX_IMAGE','BACKEND_IMAGE','FRONTEND_IMAGE')}
    expected.update(VCS_REF=data['commit'],VITE_API_URL=a.ORIGIN,VITE_PRIVATE_MEDIA_ORIGIN='',
                    KINETRA_API_ENV_FILE=str(STAGE/'env/api.env'),KINETRA_VIDEO_SCRATCH_DIR='')
    require(main==expected, 'PUBLIC_METADATA_CHANGED')
    handoff={'staged':staged,'initialized':initialized,'main':main,'old_api':old_api,
             'fixed_evidence':fixed_evidence,'fixed_configuration':fixed_configuration}
    verify_preserved(data,handoff)
    return handoff

def verify_preserved(data,handoff):
    require(data['commit']==APP and a.sha256(handoff['old_api'])==OLD_SHA, 'EXACT_RECOVERY_IDENTITY_REQUIRED')
    folder=STAGE/'env'/CANDIDATE
    a.safe_parent(folder)
    require(stat.S_IMODE(folder.stat().st_mode)==0o700, 'CANDIDATE_PRIVACY_CHANGED')
    require({p.name for p in folder.iterdir()}=={'api.env','production.env'}, 'CANDIDATE_CONTENT_CHANGED')
    for name in ('application-env.json',RECOVERY_ATTEMPT,'application-env-recovery-complete.json','application-start-attempt.json'):
        path=STAGE/'evidence'/name
        require(not path.exists() and not path.is_symlink(), 'EXISTING_RECOVERY_OR_START_PRESERVED')
    attempt_raw=a.private_read(STAGE/'evidence/application-env-attempt.json')
    expected={'schema':1,'commit':data['commit'],'images':data['images'],'previous_api_sha256':OLD_SHA,'candidate_directory':CANDIDATE}
    require(json.loads(attempt_raw)==expected, 'EXACT_ATTEMPT_REQUIRED')
    candidate=a.private_read(folder/'api.env')
    candidate_main=a.private_read(folder/'production.env')
    require(a.sha256(candidate)==API_SHA and a.sha256(candidate_main)==MAIN_SHA, 'EXACT_CANDIDATE_HASHES_REQUIRED')
    require(a.parse_env(candidate_main)==dict(handoff['main'],KINETRA_API_ENV_FILE=str(folder/'api.env')), 'CANDIDATE_METADATA_CHANGED')
    api=a.parse_env(candidate)
    require(all(api.get(k)==v for k,v in data['providers'].items()), 'PRESERVED_PROVIDER_INPUT_CHANGED')
    require(directory_identity(STAGE/'postgres/data')==ROOT_IDENTITY, 'INSPECTED_VOLUME_ROOT_CHANGED')
    require(directory_identity(STAGE/'postgres/data/pgdata')==PGDATA_IDENTITY, 'INSPECTED_PGDATA_CHANGED')
    require((STAGE/'postgres/data/pgdata/PG_VERSION').read_bytes()==b'17\n'
            and (STAGE/'postgres/data/pgdata/.kinetra-bootstrap-complete').is_file(), 'INITIALIZED_CLUSTER_REQUIRED')
    return attempt_raw,candidate

def restore_root_mode():
    path=STAGE/'postgres/data'
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(descriptor)
        actual=(info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))
        require(actual==ROOT_IDENTITY, 'VOLUME_ROOT_CHANGED_BEFORE_REPAIR')
        os.fchmod(descriptor,0o700)
        os.fsync(descriptor)
        require(directory_identity(path)==(*ROOT_IDENTITY[:4],0o700), 'VOLUME_ROOT_REPAIR_UNCONFIRMED')
        require(directory_identity(path/'pgdata')==PGDATA_IDENTITY, 'PGDATA_METADATA_CHANGED')
    finally:
        os.close(descriptor)

def recover(data,state):
    handoff=read_recovery_handoff(data)
    a.check_live_identity(data,handoff)
    attempt_bytes,candidate_bytes=verify_preserved(data,handoff)
    folder=STAGE/'env'/CANDIDATE
    state.update(candidate_directory=CANDIDATE,phase='RESTORE_INSPECTED_VOLUME_ROOT_MODE')
    receipt={'schema':1,'application':APP,'candidate':CANDIDATE,'candidate_sha256':API_SHA,
             'original_attempt_sha256':a.sha256(attempt_bytes),'root_before':ROOT_IDENTITY,'root_after':(*ROOT_IDENTITY[:4],0o700),
             'pgdata_identity':PGDATA_IDENTITY,'diagnostic_run':34775387238,'metadata_run':34775554137,
             'scope':'NONRECURSIVE_VOLUME_ROOT_CHMOD_ONLY_NO_DATABASE_REINITIALIZATION'}
    a.write_new(STAGE/'evidence'/RECOVERY_ATTEMPT,(json.dumps(receipt,sort_keys=True)+'\n').encode())
    a.sync_directory(STAGE/'evidence')
    restore_root_mode()
    state['phase']='VALIDATE_CANDIDATE'
    a.validate_candidate(data['images']['BACKEND_IMAGE'],folder/'production.env',folder/'api.env')
    a.check_live_identity(data,handoff)
    state['phase']='INSTALL_VALIDATED_ENVIRONMENT'
    a.install_preserving_previous(folder/'api.env',folder/'previous-api.env',handoff['old_api'],state)
    state['phase']='VERIFY_INSTALLED_ENVIRONMENT'
    require(a.private_read(STAGE/'env/api.env')==candidate_bytes, 'INSTALLED_API_ENV_MISMATCH')
    a.validate_candidate(data['images']['BACKEND_IMAGE'],STAGE/'env/production.env',STAGE/'env/api.env')
    a.check_live_identity(data,handoff)
    require(directory_identity(STAGE/'postgres/data')==(*ROOT_IDENTITY[:4],0o700), 'VOLUME_ROOT_REPAIR_UNCONFIRMED')
    require(directory_identity(STAGE/'postgres/data/pgdata')==PGDATA_IDENTITY, 'PGDATA_METADATA_CHANGED')
    state.update(result='API_ENVIRONMENT_PREPARED_ONLY',phase='API_ENVIRONMENT_PREPARATION_COMPLETE')
    record=dict({key:value for key,value in state.items() if key not in a.HASH_FIELDS},schema=1,
                commit=data['commit'],images=data['images'],source_hashes=data['source_hashes'],
                migration_hashes=data['migration_hashes'],api_sha256=a.sha256(candidate_bytes))
    record_bytes=(json.dumps(record,sort_keys=True)+'\n').encode()
    a.write_new(STAGE/'evidence/application-env.json',record_bytes)
    a.sync_directory(STAGE/'evidence')
    state.update(a.collect_handoff_hashes(
        dict(handoff['fixed_evidence'],**{'application-env-attempt.json':attempt_bytes,'application-env.json':record_bytes}),
        dict(handoff['fixed_configuration'],**{'env/api.env':candidate_bytes})))
    a.write_new(STAGE/'evidence/application-env-recovery-complete.json',
        (json.dumps({'schema':1,'result':'RECOVERY_COMPLETE','recovery_attempt_sha256':a.sha256((json.dumps(receipt,sort_keys=True)+'\n').encode()),
                     'handoff_hashes':state['handoff_hashes'],'configuration_hashes':state['configuration_hashes']},sort_keys=True)+'\n').encode())
    a.sync_directory(STAGE/'evidence')

def main(argv=None):
    argv=sys.argv[1:] if argv is None else argv
    state={'result':'FAIL','phase':'VALIDATE_PRIVATE_INPUT','error':None,'api_environment_installed':False,
           'application_started':False,'caddy_started':False,'provider_requests':0,'candidate_directory':None,
           'handoff_hashes':None,'configuration_hashes':None}
    lock=None
    try:
        require(len(argv)==3 and argv[:2]==['--recover-exact-preserved-api-candidate','--private-input'], 'EXPLICIT_RECOVERY_ARGUMENTS_REQUIRED')
        data=a.validate_input(json.loads(a.private_read(Path(argv[2]))))
        require(os.geteuid()==0,'ROOT_REQUIRED')
        resource.setrlimit(resource.RLIMIT_CORE,(0,0)); os.umask(0o077)
        a.private_read(a.LOCK)
        lock=os.open(a.LOCK,os.O_RDWR|os.O_NOFOLLOW); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state['phase']='VERIFY_EXACT_PRESERVED_HANDOFF'
        recover(data,state)
    except (a.Error,a.stage.Error) as error:
        category=str(error)
        state.update(result='FAIL',error=category if re.fullmatch(r'[A-Z_]{1,90}',category) else 'RECOVERY_VALIDATION_FAILED')
    except BaseException:
        state.update(result='FAIL',error='UNEXPECTED_RECOVERY_ERROR_STATE_PRESERVED')
    finally:
        if lock is not None: os.close(lock)
        print(json.dumps(state,sort_keys=True),flush=True)
    return 0 if state['result']=='API_ENVIRONMENT_PREPARED_ONLY' else 1

if __name__=='__main__':
    raise SystemExit(main())
