#!/usr/bin/env python3
"""Explicit approved continuation, using original provenance and acceptance validators."""
import hashlib,importlib.util,os,signal,sys
from pathlib import Path

CALLER_SHA="177b05d5e67f772a36976705a18114971dce9b860f88fcea98cec88f3eab792b"
WRAPPER_SHA="2f5ab436874d81fc90f03ed4af809ab017d55cdbf42742aa76e7738b89a8fb80"
BACKEND_ID="460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a"
CHECKPOINT_SHA="ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a"
def load(name,pin):
    path=Path(__file__).with_name(name)
    assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==pin
    spec=importlib.util.spec_from_file_location('kinetra_bound_'+name,path)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod

def main():
    c=load('application-caller.py',CALLER_SHA)
    try:
        c.require(sys.argv[1:]==['--resume-database-order-containers'],'EXPLICIT_PRESERVED_BACKEND_RESUME_REQUIRED')
        env=os.environ;c.execution(env)
        local=load('resume-database-order-local-host.py',WRAPPER_SHA)
        signal.signal(signal.SIGTERM,local.inspection.interrupted)
        c.require(not any(env.get(k) for k in (*local.prepare.activation.PROVIDER_ENV_KEYS,'GH_TOKEN','GITHUB_TOKEN')),
                  'PROVIDER_OR_GITHUB_TOKEN_NOT_ALLOWED')
        path,database=c.prior_database(env,local)
        api=c.read_json(path/'api-outer.json')
        evidence=c.read_json(path/'database-order-authentication.json')
        c.require(evidence=={'schema':1,'result':'EXACT_DATABASE_ORDER_CONTINUATION_AUTHENTICATED','current_control':env['GITHUB_SHA'],
            'current_run':env['GITHUB_RUN_ID'],'failed_run':34816449431,'inspection_run':34831545942,
            'backend_id':BACKEND_ID,'frontend_id':'c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206','checkpoint_sha256':CHECKPOINT_SHA,'api_outer_sha256':c.digest(api)},
            'AUTHENTICATED_EXACT_CONTINUATION_REQUIRED')
        request=c.start_request(env,local,database,api)
        private_input=path/'local-start-input.json';c.write_json(private_input,request)
        result=c.capture(lambda:local.main(['--resume-database-order-local-application','--private-input',str(private_input)],environ=env),
                         'TIMEWEB_LOCAL_APPLICATION=',path/'local-outer.json')
        c.validate_local_outer(result,request,local)
        c.write_json(path/'local-outer.json',result)
        c.write_json(path/'accepted-local-handoff.json',{'schema':1,'request_sha256':c.digest(request),'local_outer':result,
            'approved':request['approved'],'database_outer':request['database_outer'],'api_outer':request['api_outer'],
            'provenance':request['provenance']})
        print('KINETRA_DATABASE_ORDER_CONTINUATION=PASS_LOCAL_ONLY')
        return 0
    except BaseException as error:
        category=str(error) if isinstance(error,c.CallerError) else 'CONTINUATION_FAILED_PRIVATE_STATE_PRESERVED'
        print('KINETRA_DATABASE_ORDER_CONTINUATION=FAIL:'+category,file=sys.stderr);return 1

if __name__=='__main__':raise SystemExit(main())
