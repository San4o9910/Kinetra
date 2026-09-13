#!/usr/bin/env python3
import base64,copy,importlib.util,json,pathlib,tempfile,unittest
HERE=pathlib.Path(__file__).resolve().parent
def load(name,path=None):
    s=importlib.util.spec_from_file_location(name,path or HERE/(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
p=load('authenticate-preserved-api')
FIXTURE=json.loads((HERE/'api-resume-evidence-20260913.json').read_bytes())
def require(condition,category):
    if not condition:raise ValueError(category)
class AuthTests(unittest.TestCase):
    def test_actual_successful_api_phase_and_no_start_evidence(self):
        p.verify_run(FIXTURE['run'],FIXTURE['jobs'],require)
        p.verify_inspection(FIXTURE['inspection'],require)
    def test_successful_whole_run_cannot_substitute_for_exact_partial_case(self):
        changed=copy.deepcopy(FIXTURE['run']);changed['conclusion']='success'
        with self.assertRaises(ValueError):p.verify_run(changed,FIXTURE['jobs'],require)
    def test_api_phase_failure_or_skip_is_never_accepted(self):
        for outcome in ('failure','skipped'):
            jobs=copy.deepcopy(FIXTURE['jobs'])
            step=next(s for s in jobs['jobs'][0]['steps'] if s['name'].startswith('Recover exact preserved API'))
            step['conclusion']=outcome
            with self.assertRaises(ValueError):p.verify_run(FIXTURE['run'],jobs,require)
    def test_different_attempt_commit_or_job_refused(self):
        for key,value in [('run_attempt',2),('head_sha','a'*40),('id',123)]:
            run={**FIXTURE['run'],key:value}
            with self.assertRaises(ValueError):p.verify_run(run,FIXTURE['jobs'],require)
        jobs=copy.deepcopy(FIXTURE['jobs']);jobs['jobs'][0]['id']=123
        with self.assertRaises(ValueError):p.verify_run(FIXTURE['run'],jobs,require)
    def test_any_prior_start_state_stops_continuation(self):
        for key,value in [('start_attempt_exists',True),('start_result_exists',True),('compose_services',['postgres=running','backend=created'])]:
            obs=copy.deepcopy(FIXTURE['inspection']);obs['inspection'][key]=value
            with self.assertRaises(ValueError):p.verify_inspection(obs,require)
    def test_cleanup_or_pin_mismatch_is_never_accepted(self):
        for key,value in [('guest_key_cleanup','PENDING'),('local_key_cleanup','PENDING'),('host_key_fingerprint','different')]:
            with self.assertRaises(ValueError):p.verify_inspection({**FIXTURE['inspection'],key:value},require)
    def test_changed_database_directory_refused(self):
        obs=copy.deepcopy(FIXTURE['inspection']);obs['inspection']['data_root']['mode']='0o1777'
        with self.assertRaises(ValueError):p.verify_inspection(obs,require)
    def test_isolated_local_and_https_transitive_imports(self):
        for wrapper,guest in [('activate-local-application-host','start-application-host.py'),('https-caller','activate-https-host.py')]:
            m=load(wrapper)
            with tempfile.TemporaryDirectory(prefix='kinetra-helper-contract-') as folder:
                for name,body in m.public_helpers().items():
                    path=pathlib.Path(folder,name);path.write_bytes(base64.b64decode(body));path.chmod(0o644)
                load('guest_import_'+wrapper,pathlib.Path(folder,guest))
                pathlib.Path(folder,'inspect-host-monitoring.py').unlink()
                with self.assertRaises(FileNotFoundError):load('missing_'+wrapper,pathlib.Path(folder,guest))
if __name__=='__main__':unittest.main()
