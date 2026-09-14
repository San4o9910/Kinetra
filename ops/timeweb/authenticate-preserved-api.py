#!/usr/bin/env python3
"""Authenticate a successful API phase from the exact later-failed local attempt.

The failed overall run is never treated as accepted local startup. Independent
successful host inspection must prove no startup attempt or containers exist.
No host access, secret inputs, preparation, startup, or database writes occur here.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

CALLER_SHA='177b05d5e67f772a36976705a18114971dce9b860f88fcea98cec88f3eab792b'
RUN=34776089449
CONTROL='f0d2e6daa8395426bcfa7a6e461464f6b3316dfc'
WORKFLOW_SHA='75a5263d8a47fc171cfd308014401d38c02f686174eb0763740520d90dd6052c'
ARTIFACT=10324010735
ARTIFACT_SHA='42316ff964771c0aa766a2c2b9ddbdf5490d8268ba4c8355d61e4b0564275eb0'
INSPECTION_RUN=34776287669
INSPECTION_CONTROL='82109af279cc9ebdbdabb3bc255b0620f678331b'
INSPECTION_JOB=103774897052
WORKFLOW='.github/workflows/timeweb-application-activation.yml'

def load_caller():
    path=Path(__file__).with_name('application-caller.py')
    assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==CALLER_SHA
    spec=importlib.util.spec_from_file_location('kinetra_preserved_api_caller',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def verify_run(run,jobs,require):
    expected={'id':RUN,'head_sha':CONTROL,'head_branch':'ops/timeweb-hourly-preflight-20260909',
              'path':WORKFLOW,'event':'push','status':'completed','conclusion':'failure','run_attempt':1}
    require(all(run.get(k)==v for k,v in expected.items()) and run['repository']['id']==1339664626
            and run['repository']['full_name']=='San4o9910/Kinetra','EXACT_PARTIAL_RUN_REQUIRED')
    require(jobs['total_count']==1 and len(jobs['jobs'])==1,'EXACT_PARTIAL_JOB_REQUIRED')
    job=jobs['jobs'][0]
    require(job['id']==103774343436 and job['name']=='activate-local-application'
            and job['status']=='completed' and job['conclusion']=='failure','EXACT_PARTIAL_JOB_REQUIRED')
    steps={s['name']:s for s in job['steps']}
    for name in ('Verify reviewed caller and exact control checkout','Verify exact application checkout',
                 'Authenticate current source images and successful database handoff',
                 'Recover exact preserved API with only step-local auth provider inputs',
                 'Recheck current source images and database before local startup',
                 'Retain sanitized attempt observations for reconciliation'):
        require(steps[name]['status']=='completed' and steps[name]['conclusion']=='success','SUCCESSFUL_API_PHASE_REQUIRED')
    require(steps['Start and accept only local backend and frontend']['conclusion']=='failure'
            and steps['Retain sanitized accepted local handoff']['conclusion']=='skipped','FAILED_LOCAL_PHASE_NOT_ACCEPTED')

def verify_inspection(value,require):
    require(value['result']=='PASS_READ_ONLY_HOST_MONITORING_INSPECTION' and value['error'] is None
            and value['server_id']==9069403 and value['public_ipv4']=='80.68.156.131' and value['server_status']=='on'
            and value['host_key_fingerprint']=='SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0','PINNED_INSPECTION_REQUIRED')
    require(value['guest_key_cleanup']=='API_DELETE_CONFIRMED' and value['account_key_cleanup']=='API_DELETE_CONFIRMED'
            and value['local_key_cleanup']=='REMOVED','INSPECTION_CLEANUP_REQUIRED')
    state=value['inspection']
    require(state['result']=='PASS_READ_ONLY_INSPECTION' and state['mutations'] is False
            and state['application_record_exists'] is True and state['recovery_complete_exists'] is True
            and state['start_attempt_exists'] is False and state['start_result_exists'] is False
            and state['compose_services']==['postgres=running'],'NO_PRIOR_START_ATTEMPT_REQUIRED')
    require(state['data_root']==state['mounted_root'] and state['data_root']=={
        'device':2049,'inode':524370,'uid':999,'gid':999,'mode':'0o700','directory':True,'symlink':False},'REPAIRED_VOLUME_IDENTITY_REQUIRED')
    require(state['pgdata']=={'device':2049,'inode':547799,'uid':999,'gid':0,'mode':'0o700','directory':True,'symlink':False}
            and state['bootstrap_marker_exists'] is True and state['postgres_version_17'] is True
            and state['volume_bind_matches'] is True and state['volume_name']=='kinetra-production_postgres17_data','UNCHANGED_DATABASE_REQUIRED')

def authenticate(env,c,local,api,successful_run):
    path,_database=c.prior_database(env,local)
    run=api('/actions/runs/'+str(RUN))
    jobs=api('/actions/runs/'+str(RUN)+'/attempts/1/jobs?per_page=100')
    verify_run(run,jobs,c.require)
    source=api('/contents/'+WORKFLOW+'?ref='+CONTROL)
    c.require(source['type']=='file' and source['encoding']=='base64'
              and hashlib.sha256(base64.b64decode(source['content'])).hexdigest()==WORKFLOW_SHA,'PARTIAL_WORKFLOW_IDENTITY_REQUIRED')
    checked,inspection_jobs=successful_run(INSPECTION_RUN,'.github/workflows/kinetra-candidate-validation-diagnostic.yml',INSPECTION_CONTROL,'push')
    c.require(checked['head_branch']=='ops/timeweb-hourly-preflight-20260909'
              and len(inspection_jobs)==1 and inspection_jobs[0]['id']==INSPECTION_JOB,'EXACT_INSPECTION_REQUIRED')
    logs=api('/actions/jobs/'+str(INSPECTION_JOB)+'/logs',archive=True)
    c.require(len(logs)<=c.LIMIT,'INSPECTION_LOG_TOO_LARGE')
    marker='TIMEWEB_HOST_MONITORING_INSPECTION='
    observations=[c.strict_json(line.split(marker,1)[1]) for line in logs.decode('utf-8-sig').splitlines() if marker in line and line.split(marker,1)[1].startswith('{')]
    c.require(len(observations)==2,'EXACT_INSPECTION_OBSERVATIONS_REQUIRED')
    verify_inspection(observations[-1],c.require)
    artifact=api('/actions/artifacts/'+str(ARTIFACT))
    c.require(artifact['id']==ARTIFACT and artifact['expired'] is False and artifact['name']=='kinetra-local-attempt-'+str(RUN)+'-1'
              and artifact['workflow_run']['id']==RUN and artifact['workflow_run']['head_sha']==CONTROL
              and artifact['digest']=='sha256:'+ARTIFACT_SHA and 0<artifact['size_in_bytes']<=c.LIMIT,'EXACT_API_ARTIFACT_REQUIRED')
    raw=api('/actions/artifacts/'+str(ARTIFACT)+'/zip',archive=True)
    c.require(len(raw)<=c.LIMIT and hashlib.sha256(raw).hexdigest()==ARTIFACT_SHA,'API_ARTIFACT_DIGEST_REQUIRED')
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        c.require(set(zipped.namelist())=={'api-outer.json','api-outer.observations.jsonl','local-outer.observations.jsonl'}
                  and len(zipped.namelist())==3,'EXACT_API_ARTIFACT_MEMBERS_REQUIRED')
        info=zipped.getinfo('api-outer.json')
        c.require(not info.is_dir() and not info.flag_bits&1 and info.file_size<=c.LIMIT
                  and stat.S_IFMT(info.external_attr>>16) in {0,stat.S_IFREG},'API_ARTIFACT_MEMBER_REQUIRED')
        outer=c.strict_json(zipped.read(info))
    local.successful_outer(outer,api=True)
    metadata=c.source_metadata(local,env)
    local.prepare.validate_remote(json.dumps(outer['preparation']),metadata,outer['remote_directory'].rsplit('-',1)[1])
    c.write_json(path/'api-outer.json',outer)
    c.write_json(path/'preserved-api-authentication.json',{'schema':1,'original_run':RUN,'original_control':CONTROL,
        'artifact_id':ARTIFACT,'artifact_sha256':ARTIFACT_SHA,'inspection_run':INSPECTION_RUN,
        'api_outer_sha256':c.digest(outer),'accepted_phase':'API_ENVIRONMENT_PREPARED_ONLY','local_start_accepted':False})
    print('KINETRA_PRESERVED_API_AUTHENTICATED=PASS_API_ONLY_NO_PREVIOUS_START')

def main():
    c=load_caller()
    try:
        c.require(sys.argv[1:]==['--authenticate-preserved-api'],'EXPLICIT_PRESERVED_API_AUTH_REQUIRED')
        c.execution(os.environ);local=c.load('activate-local-application-host.py')
        c.require(not any(os.environ.get(name) for name in (*local.prepare.activation.PROVIDER_ENV_KEYS,'TIMEWEB_CLOUD_TOKEN')),
                  'AUTHENTICATION_STEP_MUST_HAVE_ONLY_GITHUB_TOKEN')
        api,successful_run=c.load('verify-launch-provenance.py').verify_source_and_images()
        authenticate(os.environ,c,local,api,successful_run)
        return 0
    except BaseException as error:
        category=str(error) if isinstance(error,c.CallerError) else 'PRESERVED_API_AUTHENTICATION_FAILED'
        print('KINETRA_PRESERVED_API_AUTHENTICATION=FAIL:'+category,file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
