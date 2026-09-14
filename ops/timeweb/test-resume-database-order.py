#!/usr/bin/env python3
"""Exact stopped-container continuation boundaries; offline root-owned fixtures only."""
import ast,copy,hashlib,importlib.util,json,os,shutil,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
def load(path):
    spec=importlib.util.spec_from_file_location('test_'+path.stem,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def sha(raw):return hashlib.sha256(raw).hexdigest()

class StoppedContinuationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files=tempfile.TemporaryDirectory();folder=Path(cls.files.name)
        for p in ROOT.glob('*.py'):shutil.copyfile(p,folder/p.name)
        cls.guest=load(folder/'resume-database-order-application-host.py')
        cls.auth=load(folder/'authenticate-database-order.py')
    @classmethod
    def tearDownClass(cls):cls.files.cleanup()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='kinetra-stopped-test-',dir='/root');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'evidence').mkdir(mode=0o700);self.g=self.guest
        self.patches=[];self.patch('STAGE',self.root);self.patch('OWNER_APPROVAL','a'*40)
        self.data={'schema':1,'server_id':9069403,'public_ipv4':'80.68.156.131','commit':'73b665065e00a5b375e90f701373b3e0856a0386',
            'images':{'BACKEND_IMAGE':self.g.BACKEND_REF,'FRONTEND_IMAGE':self.g.FRONTEND_REF},
            'source_hashes':{},'migration_hashes':{},'handoff_hashes':{},'configuration_hashes':{}}
        self.raw=b'{"fixture":"original failed checkpoint"}\n'
        self.attempt=self.encode(dict(self.data,nonce=self.g.OLD_NONCE,phase='START_BACKEND'))
        self.oldattempt=self.encode({'approved':self.data})
        self.oldresult=self.encode({'result':'CHECKPOINT_ONLY','requires_matching_outer_success':True,'phase':'LOCAL_ACCEPTANCE',
            'error':'UNREVIEWED_ASSET_ORIGIN','nonce':self.g.OLD_NONCE,'attempt_recorded':True,
            'attempted_services':['backend','frontend'],'start_attempted_services':['backend','frontend'],
            'uncertain_start_services':[],'owned_containers':self.g.PRESERVED_IDS,'rollback':{'backend':'STOPPED','frontend':'STOPPED'},
            **{k:self.data[k] for k in ('commit','images','handoff_hashes','configuration_hashes')}})
        self.records={'application-start-result.json':self.raw,'application-start-attempt.json':self.attempt,
            self.g.FAILED_ARCHIVE:self.raw,self.g.ATTEMPT_ARCHIVE:self.attempt,
            self.g.OLD_CONTINUATION_ATTEMPT:self.oldattempt,self.g.OLD_CONTINUATION_RESULT:self.oldresult}
        self.assetsattempt=self.encode({'approved':self.data})
        self.assetsresult=self.encode(dict(json.loads(self.oldresult),error='DATABASE_ISOLATION_CHANGED'))
        self.records.update({self.g.OLD_ASSETS_ATTEMPT:self.assetsattempt,self.g.OLD_ASSETS_RESULT:self.assetsresult})
        self.patch('OLD_ASSETS_ATTEMPT_SHA',sha(self.assetsattempt));self.patch('OLD_ASSETS_RESULT_SHA',sha(self.assetsresult))
        for name,raw in self.records.items():self.write(name,raw)
        self.patch('FAILED_CHECKPOINT_SHA',sha(self.raw));self.patch('OLD_ATTEMPT_SHA',sha(self.oldattempt));self.patch('OLD_RESULT_SHA',sha(self.oldresult))
    def encode(self,v):return (json.dumps(v,sort_keys=True)+'\n').encode()
    def patch(self,name,v):
        p=patch.object(self.g,name,v);p.start();self.addCleanup(p.stop)
    def write(self,name,raw):
        p=self.root/'evidence'/name;p.write_bytes(raw);p.chmod(0o600)
    def test_exact_scope_and_unchanged_acceptance(self):
        self.assertEqual(self.g.OWNER_APPROVAL,'a'*40)
        self.assertEqual(self.g.BACKEND_ID,'460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a')
        self.assertEqual(self.g.FRONTEND_ID,'c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206')
        def f(path):return {n.name:ast.dump(n) for n in ast.parse(path.read_text()).body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        old=f(ROOT/'start-application-host.py');new=f(ROOT/'resume-database-order-application-host.py')
        for name in set(old)-{'main','activate','read_handoff'}:self.assertEqual(new[name],old[name],name)
        for path in ['start-application-host.py','resume-database-order-application-host.py']:
            tail=(ROOT/path).read_text().split('    state["phase"] = "LOCAL_ACCEPTANCE"',1)[1].split('\n\ndef main(',1)[0]
            if path.startswith('start'):before=tail
            else:self.assertEqual(tail,before)
    def test_complete_old_records_accepted(self):
        with patch.object(self.g,'verify_stopped_container') as v:
            self.assertEqual(self.g.validate_resume_records(self.data),self.records);self.assertEqual(v.call_count,2)
    def test_each_old_record_change_refused(self):
        for name,raw in self.records.items():
            with self.subTest(name=name):
                self.write(name,raw+b' ')
                with self.assertRaises(self.g.Error):self.g.preserved_records(self.data)
                self.write(name,raw)
    def test_symlink_and_foreign_attempts_refused(self):
        for name in [self.g.RESUME_ATTEMPT,self.g.RESUME_RESULT,'application-assets-other.json','application-database-order-other.json','application-continuation-other.json','https-start-attempt.json']:
            p=self.root/'evidence'/name;p.symlink_to(self.root/'absent')
            with self.assertRaises(self.g.Error):self.g.validate_resume_records(self.data)
            p.unlink()
    def test_uncertain_or_unconfirmed_previous_rollback_refused(self):
        for k,v in [('rollback',{'backend':'STOPPED','frontend':'UNCONFIRMED_REQUIRES_REVIEW'}),('uncertain_start_services',['backend'])]:
            value=json.loads(self.oldresult);value[k]=v;raw=self.encode(value);self.write(self.g.OLD_CONTINUATION_RESULT,raw)
            with patch.object(self.g,'OLD_RESULT_SHA',sha(raw)),self.assertRaisesRegex(self.g.Error,'CONFIRMED_PREVIOUS_ROLLBACK_REQUIRED'):self.g.preserved_records(self.data)
    def test_exclusive_attempt_and_all_records_preserved(self):
        state={}
        with patch.object(self.g,'verify_stopped_container'):
            self.g.record_continuation(self.data,state);self.assertTrue(state['attempt_recorded'])
            with self.assertRaises(self.g.Error):self.g.record_continuation(self.data,{})
        for name,raw in self.records.items():self.assertEqual((self.root/'evidence'/name).read_bytes(),raw)
    def test_failed_attempt_cannot_install_success(self):
        with patch.object(self.g,'verify_stopped_container'):self.g.record_continuation(self.data,{})
        self.g.persist_continuation_checkpoint({'result':'FAIL'},self.data)
        for name,raw in self.records.items():self.assertEqual((self.root/'evidence'/name).read_bytes(),raw)
    def test_success_keeps_failed_history_and_requires_outer_success(self):
        with patch.object(self.g,'verify_stopped_container'):self.g.record_continuation(self.data,{})
        self.g.persist_continuation_checkpoint({'result':'APPLICATION_LOCAL_ACCEPTED_ONLY','nonce':self.g.OLD_NONCE},self.data)
        for name,raw in self.records.items():
            if name!='application-start-result.json':self.assertEqual((self.root/'evidence'/name).read_bytes(),raw)
        value=json.loads((self.root/'evidence/application-start-result.json').read_bytes())
        self.assertEqual(value['result'],'CHECKPOINT_ONLY');self.assertTrue(value['requires_matching_outer_success'])
    def test_missing_or_changed_attempt_cannot_install_success(self):
        with patch.object(self.g,'verify_stopped_container'):self.g.record_continuation(self.data,{})
        self.write(self.g.RESUME_ATTEMPT,b'{}')
        with self.assertRaisesRegex(self.g.Error,'EXACT_DURABLE_DATABASE_ORDER_ATTEMPT_REQUIRED'):
            self.g.persist_continuation_checkpoint({'result':'APPLICATION_LOCAL_ACCEPTED_ONLY'},self.data)
        self.assertEqual((self.root/'evidence/application-start-result.json').read_bytes(),self.raw)
    def test_stopped_identity_history_and_configured_ports(self):
        for service in ['backend','frontend']:
            info={'id':self.g.PRESERVED_IDS[service],'image':self.data['images'][service.upper()+'_IMAGE'],
                'project':self.g.PROJECT,'service':service,'nonce':self.g.OLD_NONCE,'running':False,'status':'exited'}
            extra={'started':self.g.STARTED_AT[service],'ports':None if service=='backend' else {'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]}}
            with patch.object(self.g,'inspect_container',return_value=info),patch.object(self.g,'command',return_value=json.dumps(extra)):
                self.assertEqual(self.g.verify_stopped_container(service),(info,extra))
            for k,v in [('id','f'*64),('running',True),('status','created'),('nonce','a'*32),('image','wrong')]:
                with patch.object(self.g,'inspect_container',return_value=dict(info,**{k:v})),self.assertRaises(self.g.Error):self.g.verify_stopped_container(service)
            for value in [dict(extra,started='0001-01-01T00:00:00Z'),dict(extra,ports={'8080/tcp':[{'HostIp':'0.0.0.0','HostPort':'8080'}]})]:
                with patch.object(self.g,'inspect_container',return_value=info),patch.object(self.g,'command',return_value=json.dumps(value)),self.assertRaises(self.g.Error):self.g.verify_stopped_container(service)
    def test_unknown_inventory_stops_before_validation(self):
        with patch.object(self.g,'command',return_value='unknown\n'),patch.object(self.g,'verify_stopped_container') as verify:
            with self.assertRaisesRegex(self.g.Error,'UNEXPECTED_RETAINED_CONTAINER'):self.g.resumed_final_isolation('postgres','image','net')
            verify.assert_not_called()
    def test_no_app_create_and_attempt_before_start(self):
        node=next(n for n in ast.parse((ROOT/'resume-database-order-application-host.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='activate')
        text=ast.unparse(node)
        self.assertNotIn("'up'",text);self.assertNotIn("'create'",text);self.assertNotIn("'rm'",text)
        self.assertLess(text.index('record_continuation(data, state)'),text.index("['/usr/bin/docker', 'start'"))
        self.assertLess(text.index('verify_stopped_runtime('),text.index('record_continuation(data, state)'))
    def test_wrapper_pins_and_explicit_entrypoint(self):
        wrapper=load(Path(self.files.name)/'resume-database-order-local-host.py')
        self.assertEqual(set(wrapper.public_helpers()),set(wrapper.PINS));self.assertIn('resume-database-order-application-host.py',wrapper.PINS)
        self.assertIn('--resume-database-order-application',wrapper.GUEST_LAUNCHER)
        compile(wrapper.GUEST_LAUNCHER,'<stopped-launcher>','exec')
        with self.assertRaises(wrapper.Error):wrapper.private_input(['--activate-local-application','--private-input','/root/unread'])
    def test_current_binding_and_exact_inspection_fingerprint(self):
        receipt=json.loads((ROOT/'database-order-current-inspection-20260914.json').read_text())
        self.assertEqual(self.auth.INSPECTION_SHA256,receipt['canonical_output_sha256'])
        self.assertEqual((self.auth.INSPECTION_RUN,self.auth.INSPECTION_JOB,self.auth.INSPECTION_CONTROL),
                         (receipt['run_id'],receipt['job_id'],receipt['control']))
        # Previously published observation used only as an explicit offline fixture.
        value=json.loads((ROOT/'database-order-inspection-20260914.json').read_text());value.pop('provenance')
        binding=patch.object(self.auth,'INSPECTION_SHA256',sha(json.dumps(value,sort_keys=True,separators=(',',':')).encode()))
        binding.start();self.addCleanup(binding.stop)
        self.auth.verify_inspection(value,self.g.require)
        for k,v in [('result','FAIL'),('guest_key_cleanup','PENDING'),('ssh_key_id',1)]:
            with self.assertRaises(self.g.Error):self.auth.verify_inspection(dict(value,**{k:v}),self.g.require)
        changed=copy.deepcopy(value);changed['inspection']['containers'][0]['running']=True
        with self.assertRaises(self.g.Error):self.auth.verify_inspection(changed,self.g.require)
    def test_partial_start_failure_stops_only_owned_container(self):
        state={'nonce':self.g.OLD_NONCE,'attempted_services':['backend'],'start_attempted_services':['backend'],
            'uncertain_start_services':[],'owned_containers':{'backend':self.g.BACKEND_ID},'rollback':{}}
        info={'id':self.g.BACKEND_ID,'project':self.g.PROJECT,'service':'backend','nonce':self.g.OLD_NONCE,
            'image':self.g.BACKEND_REF,'running':True}
        with patch.object(self.g,'candidate_ids',return_value=[self.g.BACKEND_ID]),patch.object(self.g,'inspect_container',side_effect=[info,dict(info,running=False)]),patch.object(self.g,'command') as command:
            self.g.rollback(self.data,state);command.assert_called_once_with(['/usr/bin/docker','stop','--time','35',self.g.BACKEND_ID],timeout=45)
        self.assertEqual(state['rollback'],{'backend':'STOPPED'})

    def test_pending_approval_cannot_record_or_start(self):
        with patch.object(self.g,'OWNER_APPROVAL','REVIEW_REQUIRED'),patch.object(self.g,'verify_stopped_container') as verify:
            with self.assertRaisesRegex(self.g.Error,'OWNER_APPROVAL_REQUIRED'):
                self.g.record_continuation(self.data,{})
            verify.assert_not_called()
        self.assertFalse((self.root/'evidence'/self.g.RESUME_ATTEMPT).exists())

    def test_new_rollback_uncertainty_refused(self):
        for key,value in [('uncertain_start_services',['backend']),('rollback',{'backend':'UNCONFIRMED_REQUIRES_REVIEW','frontend':'STOPPED'}),('error','OTHER_ERROR')]:
            changed=json.loads(self.assetsresult);changed[key]=value;raw=self.encode(changed)
            self.write(self.g.OLD_ASSETS_RESULT,raw)
            with patch.object(self.g,'OLD_ASSETS_RESULT_SHA',sha(raw)),self.assertRaisesRegex(self.g.Error,'CONFIRMED_ASSETS_ROLLBACK_REQUIRED'):
                self.g.preserved_records(self.data)

    def test_real_diagnostic_order_preserves_all_fields(self):
        evidence=json.loads((ROOT/'database-order-inspection-20260914.json').read_text())
        variants=evidence['inspection']['database_comparison']['variants']['mounts']
        expected=self.g.stable_database_observation({'mounts':variants[0],'id':'same'})
        for mounts in variants:
            self.assertEqual(self.g.stable_database_observation({'mounts':mounts,'id':'same'}),expected)
            changed=copy.deepcopy(mounts);changed[0]['Source']='/changed'
            self.assertNotEqual(self.g.stable_database_observation({'mounts':changed,'id':'same'}),expected)

    def test_authentication_is_bound_to_the_actual_latest_failed_job(self):
        saved=json.loads((ROOT/'stopped-container-result-20260914.json').read_text())
        # Run envelope is an API fixture; jobs and steps are saved execution evidence.
        run={'id':saved['run_id'],'head_sha':saved['control'],
             'head_branch':'ops/timeweb-hourly-preflight-20260909','path':saved['workflow'],
             'event':'push','status':'completed','conclusion':'failure','run_attempt':1,
             'repository':{'id':1339664626,'full_name':'San4o9910/Kinetra'}}
        jobs={'total_count':1,'jobs':saved['jobs']}
        self.auth.verify_failed_run(run,jobs,self.g.require)
        for key,value in [('head_sha','f'*40),('run_attempt',2),('conclusion','success')]:
            with self.assertRaises(self.g.Error):
                self.auth.verify_failed_run(dict(run,**{key:value}),jobs,self.g.require)
        for step in saved['jobs'][0]['steps']:
            if step['name'].startswith(('Authenticate ','Recheck current','Verify reviewed','Verify exact','Retain sanitized attempt')):
                changed=copy.deepcopy(jobs)
                next(s for s in changed['jobs'][0]['steps'] if s['name']==step['name'])['conclusion']='skipped'
                with self.assertRaises(self.g.Error):
                    self.auth.verify_failed_run(run,changed,self.g.require)

if __name__=='__main__':unittest.main()

