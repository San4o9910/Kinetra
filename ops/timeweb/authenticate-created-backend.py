#!/usr/bin/env python3
"""Authenticate exact failed startup and successful preserved-backend inspection.

GitHub-only step. No host or provider credentials and no activation. The original
API phase is authenticated independently; failed local runs never become PASS.
"""
import base64,hashlib,importlib.util,io,json,os,stat,sys,zipfile
from pathlib import Path

API_READER_SHA='9e40c2c3de2bea16147df4d0af0ffde7912c5bfe7d87914a51aae08049b29240'
FAILED_RUN=34777104737
FAILED_CONTROL='5da9479b63dd7884d6e5484fe33b8dd1f9fff3dc'
FAILED_WORKFLOW_SHA='3b0160bb78f2d3fff688bbab9d466672666a9d36d25aaf43919ab5cc689d1a53'
ARTIFACT=10323746979
ARTIFACT_SHA='8163808721d83b8a57f434961438ab3343a6efb85a5a88e3953db5d8d4845e55'
INSPECTION_RUN=34778863835
INSPECTION_CONTROL='99511c096a6842dc8902794211157718d7e5d59f'
INSPECTION_JOB=103782050733
BACKEND_ID='460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a'
NONCE='9128e22668c33a1552f912415c800939'
CHECKPOINT_SHA='ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a'
WORKFLOW='.github/workflows/timeweb-application-activation.yml'

def verify_failed_run(run,jobs,require):
    expected={'id':FAILED_RUN,'head_sha':FAILED_CONTROL,'head_branch':'ops/timeweb-hourly-preflight-20260909',
        'path':WORKFLOW,'event':'push','status':'completed','conclusion':'failure','run_attempt':1}
    require(all(run.get(k)==v for k,v in expected.items()) and run['repository']['id']==1339664626
            and run['repository']['full_name']=='San4o9910/Kinetra','EXACT_FAILED_START_RUN_REQUIRED')
    require(jobs['total_count']==1 and len(jobs['jobs'])==1,'EXACT_FAILED_START_JOB_REQUIRED')
    job=jobs['jobs'][0]
    require(job['id']==103777116383 and job['name']=='activate-local-application'
            and job['status']=='completed' and job['conclusion']=='failure','EXACT_FAILED_START_JOB_REQUIRED')
    steps={s['name']:s for s in job['steps']}
    for name in ('Verify reviewed caller and exact control checkout','Verify exact application checkout',
                 'Authenticate current source images and successful database handoff',
                 'Authenticate successful preserved API phase and independently verified absence of startup',
                 'Recheck current source images and database before local startup',
                 'Retain sanitized attempt observations for reconciliation'):
        require(steps[name]['status']=='completed' and steps[name]['conclusion']=='success','SUCCESSFUL_PRIOR_GATES_REQUIRED')
    require(steps['Start and accept only local backend and frontend']['conclusion']=='failure'
            and steps['Retain sanitized accepted local handoff']['conclusion']=='skipped','FAILED_START_NOT_ACCEPTED')

def verify_inspection(value,require):
    require(value['result']=='PASS_READ_ONLY_HOST_MONITORING_INSPECTION' and value['error'] is None
            and value['server_id']==9069403 and value['public_ipv4']=='80.68.156.131' and value['server_status']=='on'
            and value['host_key_fingerprint']=='SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0','PINNED_RESUME_INSPECTION_REQUIRED')
    require(value['ssh_key_id']==772571 and value['guest_key_cleanup']=='API_DELETE_CONFIRMED'
            and value['account_key_cleanup']=='API_DELETE_CONFIRMED' and value['local_key_cleanup']=='REMOVED','RESUME_INSPECTION_CLEANUP_REQUIRED')
    s=value['inspection']
    require(s['result']=='PASS_READ_ONLY_INSPECTION' and s['mutations'] is False
        and s['application_record_exists'] is True and s['recovery_complete_exists'] is True
        and s['start_attempt_exists'] is True and s['start_result_exists'] is True
        and s['compose_services']==['backend=created','postgres=running'],'EXACT_PRESERVED_CONTAINER_SET_REQUIRED')
    require(s['created_backend']=={'id':BACKEND_ID,'nonce':NONCE,'status':'created','never_started':True,
        'original_inspect_returncode':1,'original_inspect_error':'HEALTH_FIELD_ABSENT'},'EXACT_NEVER_STARTED_BACKEND_REQUIRED')
    require(s['start_checkpoint']=={'attempt_recorded':True,'attempted_services':['backend'],
        'start_attempted_services':[],'uncertain_start_services':[],'owned_containers':{},
        'error':'CHILD_COMMAND_FAILED','nonce':NONCE,'phase':'START_BACKEND',
        'rollback':{'backend':'UNCONFIRMED_REQUIRES_REVIEW'},'sha256':CHECKPOINT_SHA},'EXACT_FAILED_CHECKPOINT_REQUIRED')
    require(s['data_root']==s['mounted_root']=={'device':2049,'inode':524370,'uid':999,'gid':999,
        'mode':'0o700','directory':True,'symlink':False},'UNCHANGED_DATA_ROOT_REQUIRED')
    require(s['pgdata']=={'device':2049,'inode':547799,'uid':999,'gid':0,'mode':'0o700','directory':True,'symlink':False}
        and s['bootstrap_marker_exists'] is True and s['postgres_version_17'] is True and s['volume_bind_matches'] is True
        and s['volume_name']=='kinetra-production_postgres17_data','UNCHANGED_POSTGRES_REQUIRED')
    require(s['query_validation']=={'created_backend':'PASS_NULL_HEALTH','running_postgres':'PASS_HEALTHY',
        'mutations':False,'persistent_helper_changed':False},'PROPOSED_QUERY_ACTUALLY_VERIFIED_REQUIRED')

def authenticate(env,c,local,api,successful_run,preserved):
    # Authenticate the earlier successful API phase including its original historical
    # no-start inspection. The additional current-state gate below is indispensable.
    preserved.authenticate(env,c,local,api,successful_run)
    path,_database=c.prior_database(env,local)
    verify_failed_run(api('/actions/runs/'+str(FAILED_RUN)),
        api('/actions/runs/'+str(FAILED_RUN)+'/attempts/1/jobs?per_page=100'),c.require)
    source=api('/contents/'+WORKFLOW+'?ref='+FAILED_CONTROL)
    c.require(source['type']=='file' and source['encoding']=='base64'
        and hashlib.sha256(base64.b64decode(source['content'])).hexdigest()==FAILED_WORKFLOW_SHA,'EXACT_FAILED_START_WORKFLOW_REQUIRED')
    artifact=api('/actions/artifacts/'+str(ARTIFACT))
    c.require(artifact['id']==ARTIFACT and artifact['expired'] is False
        and artifact['name']=='kinetra-local-attempt-'+str(FAILED_RUN)+'-1'
        and artifact['workflow_run']['id']==FAILED_RUN and artifact['workflow_run']['head_sha']==FAILED_CONTROL
        and artifact['digest']=='sha256:'+ARTIFACT_SHA and 0<artifact['size_in_bytes']<=c.LIMIT,'EXACT_FAILED_START_ARTIFACT_REQUIRED')
    raw=api('/actions/artifacts/'+str(ARTIFACT)+'/zip',archive=True)
    c.require(len(raw)<=c.LIMIT and hashlib.sha256(raw).hexdigest()==ARTIFACT_SHA,'FAILED_START_ARTIFACT_DIGEST_REQUIRED')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names=z.namelist()
        c.require(len(names)==len(set(names)) and {'api-outer.json','local-outer.observations.jsonl'}<=set(names)
            and set(names)<={'api-outer.json','local-outer.json','api-outer.observations.jsonl','local-outer.observations.jsonl'},
            'FAILED_START_ARTIFACT_MEMBERS_REQUIRED')
        for info in z.infolist():
            c.require(not info.is_dir() and not info.flag_bits&1 and info.file_size<=c.LIMIT
                and stat.S_IFMT(info.external_attr>>16) in {0,stat.S_IFREG},'FAILED_START_ARTIFACT_MEMBER_REQUIRED')
        c.require(c.strict_json(z.read('api-outer.json'))==c.read_json(path/'api-outer.json'),'UNCHANGED_SUCCESSFUL_API_OUTER_REQUIRED')
        observations=[c.strict_json(line) for line in z.read('local-outer.observations.jsonl').splitlines()]
    c.require(2<=len(observations)<=8,'FAILED_START_OBSERVATIONS_REQUIRED')
    final=observations[-1]
    expected={'server_id':9069403,'public_ipv4':'80.68.156.131','result':'FAIL','ssh_key_id':772527,
        'remote_directory':'/run/kinetra-local-activation-0893847f726e6bd0e8d510dd8cd429b4',
        'guest_key_cleanup':'API_DELETE_CONFIRMED','account_key_cleanup':'API_DELETE_CONFIRMED',
        'local_key_cleanup':'REMOVED','guest_temp_cleanup':'REMOVED','owned_containers':{}}
    c.require(final==expected,'FAILED_START_COMPLETE_CLEANUP_REQUIRED')
    checked,jobs=successful_run(INSPECTION_RUN,'.github/workflows/kinetra-candidate-validation-diagnostic.yml',INSPECTION_CONTROL,'push')
    c.require(checked['head_branch']=='ops/timeweb-hourly-preflight-20260909'
        and len(jobs)==1 and jobs[0]['id']==INSPECTION_JOB,'EXACT_CURRENT_INSPECTION_REQUIRED')
    raw=api('/actions/jobs/'+str(INSPECTION_JOB)+'/logs',archive=True)
    c.require(len(raw)<=c.LIMIT,'INSPECTION_LOG_TOO_LARGE')
    marker='TIMEWEB_HOST_MONITORING_INSPECTION='
    observations=[c.strict_json(line.split(marker,1)[1]) for line in raw.decode('utf-8-sig').splitlines()
        if marker in line and line.split(marker,1)[1].startswith('{')]
    c.require(len(observations)==2,'EXACT_INSPECTION_OBSERVATIONS_REQUIRED')
    verify_inspection(observations[-1],c.require)
    c.write_json(path/'created-backend-authentication.json',{'schema':1,'result':'EXACT_CREATED_BACKEND_AUTHENTICATED',
        'current_control':env['GITHUB_SHA'],'current_run':env['GITHUB_RUN_ID'],'failed_run':FAILED_RUN,
        'inspection_run':INSPECTION_RUN,'backend_id':BACKEND_ID,'checkpoint_sha256':CHECKPOINT_SHA,
        'api_outer_sha256':c.digest(c.read_json(path/'api-outer.json'))})
    print('KINETRA_CREATED_BACKEND_AUTHENTICATED=PASS_EXACT_FAILED_STATE_ONLY')

def main():
    p=Path(__file__).with_name('authenticate-preserved-api.py')
    assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==API_READER_SHA
    spec=importlib.util.spec_from_file_location('kinetra_historical_api_phase',p)
    preserved=importlib.util.module_from_spec(spec);spec.loader.exec_module(preserved)
    c=preserved.load_caller()
    try:
        c.require(sys.argv[1:]==['--authenticate-created-backend'],'EXPLICIT_CREATED_BACKEND_AUTH_REQUIRED')
        c.execution(os.environ);local=c.load('activate-local-application-host.py')
        c.require(not any(os.environ.get(n) for n in (*local.prepare.activation.PROVIDER_ENV_KEYS,'TIMEWEB_CLOUD_TOKEN')),
            'AUTHENTICATION_STEP_MUST_HAVE_ONLY_GITHUB_TOKEN')
        api,successful_run=c.load('verify-launch-provenance.py').verify_source_and_images()
        authenticate(os.environ,c,local,api,successful_run,preserved)
        return 0
    except BaseException as error:
        category=str(error) if isinstance(error,c.CallerError) else 'CREATED_BACKEND_AUTHENTICATION_FAILED'
        print('KINETRA_CREATED_BACKEND_AUTHENTICATION=FAIL:'+category,file=sys.stderr);return 1

if __name__=='__main__':raise SystemExit(main())
