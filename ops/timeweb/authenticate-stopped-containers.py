#!/usr/bin/env python3
"""Authenticate exact failed startup and successful preserved-backend inspection.

GitHub-only step. No host or provider credentials and no activation. The original
API phase is authenticated independently; failed local runs never become PASS.
"""
import base64,hashlib,importlib.util,io,json,os,stat,sys,zipfile
from pathlib import Path

API_READER_SHA='a7808d0ff583eadae94ab74afa9e93b7b71f69e3de607f18a2c250b614b567de'
FAILED_RUN=34779526000
FAILED_CONTROL='1940f0b72edfdc8dbc286789086cec00163a2d3b'
FAILED_WORKFLOW_SHA='a5d8308c30ba7cffd40849ec0738c6f84ee31ffaac3616eaf268fa0bfd8de5b4'
ARTIFACT=10324610731
ARTIFACT_SHA='3a482c172c4f54ec82667e4c541f51c94db8e0b21e9cabd4a597099492b590bc'
INSPECTION_RUN=34815492692
INSPECTION_CONTROL='865ab9f2a3f64b9e8938f8333d9e2cd3a8f6181e'
INSPECTION_JOB=103885177890
BACKEND_ID='460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a'
FRONTEND_ID='c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206'
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
    require(job['id']==103783858959 and job['name']=='activate-local-application'
            and job['status']=='completed' and job['conclusion']=='failure','EXACT_FAILED_START_JOB_REQUIRED')
    steps={s['name']:s for s in job['steps']}
    for name in ('Verify reviewed caller and exact control checkout','Verify exact application checkout',
                 'Authenticate current source images and successful database handoff',
                 'Authenticate preserved API and exact failed startup with fresh backend inspection',
                 'Recheck current source images and database before local startup',
                 'Retain sanitized attempt observations for reconciliation'):
        require(steps[name]['status']=='completed' and steps[name]['conclusion']=='success','SUCCESSFUL_PRIOR_GATES_REQUIRED')
    require(steps['Start and accept only local backend and frontend']['conclusion']=='failure'
            and steps['Retain sanitized accepted local handoff']['conclusion']=='skipped','FAILED_START_NOT_ACCEPTED')

def verify_inspection(value,require):
    # Exact sanitized live state, including every original record, file hash,
    # stopped-container StartedAt and complete temporary-object cleanup.
    require(hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()=="82f446a7c10d095b4cdf838249812e79ad95dbf73f20434c13a56997158d121c",
            'EXACT_SUCCESSFUL_STOPPED_INSPECTION_REQUIRED')


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
    expected={'server_id':9069403,'public_ipv4':'80.68.156.131','result':'FAIL','ssh_key_id':772577,
        'remote_directory':'/run/kinetra-local-activation-501744680610025ad48e220a0ecb0f13',
        'guest_key_cleanup':'API_DELETE_CONFIRMED','account_key_cleanup':'API_DELETE_CONFIRMED',
        'local_key_cleanup':'REMOVED','guest_temp_cleanup':'REMOVED','owned_containers':{'backend':BACKEND_ID,'frontend':FRONTEND_ID}}
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
    c.write_json(path/'stopped-containers-authentication.json',{'schema':1,'result':'EXACT_STOPPED_CONTAINERS_AUTHENTICATED',
        'current_control':env['GITHUB_SHA'],'current_run':env['GITHUB_RUN_ID'],'failed_run':FAILED_RUN,
        'inspection_run':INSPECTION_RUN,'backend_id':BACKEND_ID,'frontend_id':FRONTEND_ID,'checkpoint_sha256':CHECKPOINT_SHA,
        'api_outer_sha256':c.digest(c.read_json(path/'api-outer.json'))})
    print('KINETRA_STOPPED_CONTAINERS_AUTHENTICATED=PASS_EXACT_FAILED_STATE_ONLY')

def main():
    p=Path(__file__).with_name('authenticate-preserved-api.py')
    assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==API_READER_SHA
    spec=importlib.util.spec_from_file_location('kinetra_historical_api_phase',p)
    preserved=importlib.util.module_from_spec(spec);spec.loader.exec_module(preserved)
    c=preserved.load_caller()
    try:
        c.require(sys.argv[1:]==['--authenticate-stopped-containers'],'EXPLICIT_CREATED_BACKEND_AUTH_REQUIRED')
        c.execution(os.environ);local=c.load('activate-local-application-host.py')
        c.require(not any(os.environ.get(n) for n in (*local.prepare.activation.PROVIDER_ENV_KEYS,'TIMEWEB_CLOUD_TOKEN')),
            'AUTHENTICATION_STEP_MUST_HAVE_ONLY_GITHUB_TOKEN')
        api,successful_run=c.load('verify-launch-provenance.py').verify_source_and_images()
        authenticate(os.environ,c,local,api,successful_run,preserved)
        return 0
    except BaseException as error:
        category=str(error) if isinstance(error,c.CallerError) else 'CREATED_BACKEND_AUTHENTICATION_FAILED'
        print('KINETRA_STOPPED_CONTAINERS_AUTHENTICATION=FAIL:'+category,file=sys.stderr);return 1

if __name__=='__main__':raise SystemExit(main())
