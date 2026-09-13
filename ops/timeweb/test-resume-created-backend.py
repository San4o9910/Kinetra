#!/usr/bin/env python3
"""Bounded continuation regression tests; no network, Docker or production writes."""
import ast,copy,hashlib,importlib.util,json,os,shutil,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

SOURCE=Path(__file__).parent

def load(path):
    spec=importlib.util.spec_from_file_location('test_'+path.stem,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class ResumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files=tempfile.TemporaryDirectory()
        root=Path(cls.files.name)
        for path in SOURCE.glob('*.py'):shutil.copyfile(path,root/path.name)
        # These are root-only guest helpers. CI runs this test under sudo; no
        # guest permissions or ownership rules are changed for the fixtures.
        cls.guest=load(root/'resume-created-application-host.py')
        cls.auth=load(root/'authenticate-created-backend.py')
    @classmethod
    def tearDownClass(cls):cls.files.cleanup()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='kinetra-resume-test-',dir='/root');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'evidence').mkdir(mode=0o700)
        self.g=self.guest
        self.stage_patch=patch.object(self.g,'STAGE',self.root);self.stage_patch.start();self.addCleanup(self.stage_patch.stop)
        self.data={'schema':1,'server_id':9069403,'public_ipv4':'80.68.156.131',
            'commit':'73b665065e00a5b375e90f701373b3e0856a0386','images':{'BACKEND_IMAGE':self.g.BACKEND_REF},
            'source_hashes':{},'migration_hashes':{},'handoff_hashes':{},'configuration_hashes':{}}
        self.failed={'result':'CHECKPOINT_ONLY','requires_matching_outer_success':True,'phase':'START_BACKEND',
            'error':'CHILD_COMMAND_FAILED','nonce':self.g.OLD_NONCE,'attempt_recorded':True,
            'attempted_services':['backend'],'start_attempted_services':[],'uncertain_start_services':[],
            'owned_containers':{},'rollback':{'backend':'UNCONFIRMED_REQUIRES_REVIEW'},
            **{k:self.data[k] for k in ('commit','images','handoff_hashes','configuration_hashes')}}
        self.raw=(json.dumps(self.failed,sort_keys=True)+'\n').encode()
        self.attempt=(json.dumps(dict(self.data,nonce=self.g.OLD_NONCE,phase='START_BACKEND'),sort_keys=True)+'\n').encode()
        self.write('application-start-result.json',self.raw)
        self.write('application-start-attempt.json',self.attempt)
        self.hash_patch=patch.object(self.g,'FAILED_CHECKPOINT_SHA',hashlib.sha256(self.raw).hexdigest())
        self.hash_patch.start();self.addCleanup(self.hash_patch.stop)
    def write(self,name,raw):
        p=self.root/'evidence'/name;p.write_bytes(raw);p.chmod(0o600)
    def test_exact_production_scope(self):
        self.assertEqual(self.g.BACKEND_ID,'460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a')
        self.assertEqual(self.g.OLD_NONCE,'9128e22668c33a1552f912415c800939')
        self.assertIn('ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a',(SOURCE/'resume-created-application-host.py').read_text())
    def test_original_acceptance_functions_identical(self):
        def functions(path):return {n.name:ast.dump(n) for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef)}
        old=functions(SOURCE/'start-application-host.py');new=functions(SOURCE/'resume-created-application-host.py')
        for name in set(old)-{'main','activate','read_handoff'}:self.assertEqual(new[name],old[name],name)
        marker='    state["phase"] = "LOCAL_ACCEPTANCE"'
        for path in ('start-application-host.py','resume-created-application-host.py'):
            text=(SOURCE/path).read_text();tail=text.split(marker,1)[1].split('\n\ndef main(',1)[0]
            if path.startswith('start-'):before=tail
            else:self.assertEqual(tail,before)
    def test_resume_transport_includes_all_helpers_and_explicit_entrypoint(self):
        wrapper=load(Path(self.files.name)/'resume-local-application-host.py')
        self.assertEqual(set(wrapper.public_helpers()),set(wrapper.PINS))
        self.assertIn('resume-created-application-host.py',wrapper.PINS)
        self.assertIn('inspect-host-monitoring.py',wrapper.PINS)
        self.assertIn("str(folder / 'resume-created-application-host.py')",wrapper.GUEST_LAUNCHER)
        self.assertIn('--resume-exact-created-application',wrapper.GUEST_LAUNCHER)
        compile(wrapper.GUEST_LAUNCHER,'<reviewed-resume-launcher>','exec')
        with self.assertRaises(wrapper.Error):wrapper.private_input(['--activate-local-application','--private-input','/root/unread'])
    def test_fresh_start_still_refuses_previous_attempt(self):
        self.assertIn('EXISTING_ACTIVATION_ATTEMPT_PRESERVED',(SOURCE/'start-application-host.py').read_text())
    def test_complete_bound_records_accepted(self):
        with patch.object(self.g,'verify_created_backend') as verify:
            self.assertEqual(self.g.validate_resume_records(self.data),(self.raw,self.attempt));verify.assert_called_once()
    def test_changed_checkpoint_stops_before_docker(self):
        self.write('application-start-result.json',self.raw+b' ')
        with patch.object(self.g,'verify_created_backend') as verify:
            with self.assertRaisesRegex(self.g.Error,'EXACT_FAILED_CHECKPOINT_REQUIRED'):self.g.validate_resume_records(self.data)
            verify.assert_not_called()
    def test_changed_original_attempt_rejected(self):
        value=json.loads(self.attempt);value['nonce']='1'*32;self.write('application-start-attempt.json',json.dumps(value).encode())
        with patch.object(self.g,'verify_created_backend'):
            with self.assertRaisesRegex(self.g.Error,'ORIGINAL_START_ATTEMPT_CHANGED'):self.g.validate_resume_records(self.data)
    def test_any_previous_continuation_or_https_refused(self):
        for name in (self.g.RESUME_ATTEMPT,self.g.RESUME_RESULT,'application-continuation-other.json','https-start-attempt.json'):
            self.write(name,b'{}')
            with self.assertRaises(self.g.Error):self.g.validate_resume_records(self.data)
            (self.root/'evidence'/name).unlink() # disposable test fixture only
    def test_symlink_record_refused(self):
        target=self.root/'evidence'/self.g.RESUME_ATTEMPT;target.symlink_to(self.root/'absent')
        with self.assertRaises(self.g.Error):self.g.validate_resume_records(self.data)
    def test_archives_durable_and_retry_refused(self):
        state={'attempt_recorded':False}
        with patch.object(self.g,'verify_created_backend'):
            self.g.record_continuation(self.data,state)
            self.assertTrue(state['attempt_recorded'])
            for name in ('application-start-result.json',self.g.FAILED_ARCHIVE):
                self.assertEqual((self.root/'evidence'/name).read_bytes(),self.raw)
            for name in ('application-start-attempt.json',self.g.ATTEMPT_ARCHIVE):
                self.assertEqual((self.root/'evidence'/name).read_bytes(),self.attempt)
            with self.assertRaises(self.g.Error):self.g.record_continuation(self.data,{})
    def test_failed_resume_cannot_replace_old_checkpoint(self):
        with patch.object(self.g,'verify_created_backend'):self.g.record_continuation(self.data,{})
        self.g.persist_continuation_checkpoint({'result':'FAIL'},self.data)
        self.assertEqual((self.root/'evidence/application-start-result.json').read_bytes(),self.raw)
        self.assertTrue((self.root/'evidence'/self.g.RESUME_RESULT).exists())
    def test_success_installs_checkpoint_and_preserves_both_original_records(self):
        with patch.object(self.g,'verify_created_backend'):self.g.record_continuation(self.data,{})
        self.g.persist_continuation_checkpoint({'result':'APPLICATION_LOCAL_ACCEPTED_ONLY','nonce':self.g.OLD_NONCE},self.data)
        current=json.loads((self.root/'evidence/application-start-result.json').read_bytes())
        self.assertEqual(current['result'],'CHECKPOINT_ONLY');self.assertIs(current['requires_matching_outer_success'],True)
        self.assertEqual((self.root/'evidence'/self.g.FAILED_ARCHIVE).read_bytes(),self.raw)
        self.assertEqual((self.root/'evidence/application-start-attempt.json').read_bytes(),self.attempt)
    def test_missing_archive_cannot_install_success(self):
        with self.assertRaises(Exception):self.g.persist_continuation_checkpoint({'result':'APPLICATION_LOCAL_ACCEPTED_ONLY'},self.data)
        self.assertEqual((self.root/'evidence/application-start-result.json').read_bytes(),self.raw)
    def test_backend_reconciliation_refuses_changed_identity_or_started_state(self):
        info={'id':self.g.BACKEND_ID,'image':self.g.BACKEND_REF,'project':self.g.PROJECT,'service':'backend',
              'nonce':self.g.OLD_NONCE,'running':False,'status':'created','health':None}
        with patch.object(self.g,'inspect_container',return_value=info),patch.object(self.g,'command',return_value=json.dumps({'started':'0001-01-01T00:00:00Z','restarts':0})):
            self.assertEqual(self.g.verify_created_backend(),info)
        for key,value in [('id','a'*64),('image','changed'),('nonce','1'*32),('running',True),('status','exited')]:
            changed=dict(info,**{key:value})
            with patch.object(self.g,'inspect_container',return_value=changed),patch.object(self.g,'command') as command:
                with self.assertRaises(self.g.Error):self.g.verify_created_backend()
                command.assert_not_called()
        with patch.object(self.g,'inspect_container',return_value=info),patch.object(self.g,'command',return_value=json.dumps({'started':'2026-09-13T19:16:20Z','restarts':0})):
            with self.assertRaisesRegex(self.g.Error,'BACKEND_START_HISTORY_CHANGED'):self.g.verify_created_backend()
    def test_extra_container_refused_before_other_checks(self):
        with patch.object(self.g,'command',return_value='postgres\n'+self.g.BACKEND_ID+'\nunknown\n'),patch.object(self.g,'verify_created_backend') as verify:
            with self.assertRaisesRegex(self.g.Error,'UNEXPECTED_RETAINED_CONTAINER'):self.g.resumed_final_isolation('postgres','image','network')
            verify.assert_not_called()
    def test_backend_is_never_recreated_and_archive_precedes_start(self):
        node=next(n for n in ast.parse((SOURCE/'resume-created-application-host.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='activate')
        text=ast.unparse(node)
        self.assertLess(text.index('record_continuation(data, state)'),text.index("['/usr/bin/docker', 'start'"))
        branch=next(n for n in ast.walk(node) if isinstance(n,ast.If) and ast.unparse(n.test)=="service == 'backend'" and any(isinstance(x,ast.Expr) and 'verify_created_backend' in ast.unparse(x) for x in n.body))
        self.assertEqual(ast.unparse(branch.body[0]),'verify_created_backend()')
        self.assertIn("'--no-start'",ast.unparse(branch.orelse[0]))
    def test_actual_inspection_accepted_and_mutations_rejected(self):
        fixture=json.loads((SOURCE/'created-backend-inspection-20260913.json').read_bytes())
        require=lambda c,e: self.g.require(c,e)
        self.auth.verify_inspection(fixture,require)
        cases=[('server_id',0),('guest_key_cleanup','PENDING')]
        for key,value in cases:
            changed=copy.deepcopy(fixture);changed[key]=value
            with self.assertRaises(self.g.Error):self.auth.verify_inspection(changed,require)
        for key,value in [('compose_services',['backend=running','postgres=running']),('start_attempt_exists',False),('mutations',True)]:
            changed=copy.deepcopy(fixture);changed['inspection'][key]=value
            with self.assertRaises(self.g.Error):self.auth.verify_inspection(changed,require)
        changed=copy.deepcopy(fixture);changed['inspection']['created_backend']['id']='a'*64
        with self.assertRaises(self.g.Error):self.auth.verify_inspection(changed,require)

if __name__=='__main__':unittest.main()
