#!/usr/bin/env python3
"""Offline partial-state recovery tests; no host/network/provider commands."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
r=load('recover-api-candidate-host')
t=load('test-activate-application-host')

class RecoveryTests(unittest.TestCase):
    write=t.PreparationTests.write
    json_write=t.PreparationTests.json_write
    handoff=t.PreparationTests.handoff
    @classmethod
    def setUpClass(cls):
        t.PreparationTests.setUpClass();cls.vapid=t.PreparationTests.vapid
    def setUp(self):
        t.PreparationTests.setUp(self)
        self.stack.enter_context(patch.object(r,'a',t.activate))
        self.stack.enter_context(patch.object(r,'require',t.activate.require))
        self.stack.enter_context(patch.object(r,'STAGE',self.stage))
        self.stack.enter_context(patch.object(r,'APP',t.COMMIT))
        self.data['providers']=dict(t.SMTP_PROVIDERS)
        self.handoff()
        self.candidate=self.stage/'env'/r.CANDIDATE
        self.candidate.mkdir(mode=0o700)
        self.api=t.activate.env_bytes(t.activate.api_values(self.data,self.vapid))
        self.write(self.candidate/'api.env',self.api)
        main=t.activate.env_bytes(dict(self.main,KINETRA_API_ENV_FILE=str(self.candidate/'api.env')))
        self.write(self.candidate/'production.env',main)
        self.old_sha=t.activate.sha256(t.OLD_API)
        self.stack.enter_context(patch.object(r,'OLD_SHA',self.old_sha))
        self.stack.enter_context(patch.object(r,'API_SHA',t.activate.sha256(self.api)))
        self.stack.enter_context(patch.object(r,'MAIN_SHA',t.activate.sha256(main)))
        self.json_write(self.stage/'evidence/application-env-attempt.json',{
            'schema':1,'commit':t.COMMIT,'images':t.IMAGES,'previous_api_sha256':self.old_sha,'candidate_directory':r.CANDIDATE})
        self.data_root=self.stage/'postgres/data'
        os.chmod(self.data_root,0o1777)
        self.pgdata=self.data_root/'pgdata';self.pgdata.mkdir(mode=0o700)
        self.write(self.pgdata/'PG_VERSION',b'17\n')
        self.write(self.pgdata/'.kinetra-bootstrap-complete',b'')
        self.stack.enter_context(patch.object(r,'ROOT_IDENTITY',r.directory_identity(self.data_root)))
        self.stack.enter_context(patch.object(r,'PGDATA_IDENTITY',r.directory_identity(self.pgdata)))
        self.private=self.root/'private.json';self.json_write(self.private,self.data)
        self.live=self.stack.enter_context(patch.object(t.activate,'check_live_identity'))
        self.validator=self.stack.enter_context(patch.object(t.activate,'validate_candidate'))
        self.generate=self.stack.enter_context(patch.object(t.activate,'generate_vapid',side_effect=AssertionError('no key regeneration')))
    def run_recovery(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            code=r.main(['--recover-exact-preserved-api-candidate','--private-input',str(self.private)])
        text=out.getvalue()
        for value in (*t.SMTP_PROVIDERS.values(),self.vapid['private'],t.DB_PASSWORD):
            self.assertNotIn(value,text)
        return code,json.loads(text)
    def assert_untouched(self):
        self.assertEqual((self.stage/'env/api.env').read_bytes(),t.OLD_API)
        self.assertEqual((self.candidate/'api.env').read_bytes(),self.api)
        self.assertEqual((self.data_root/'preserve-sentinel').read_bytes(),b'existing initialized database\n')
        self.assertFalse(self.generate.called)
    def test_success_keeps_secrets_and_database_and_complete_handoff(self):
        code,state=self.run_recovery();self.assertEqual(code,0)
        self.assertEqual(state['result'],'API_ENVIRONMENT_PREPARED_ONLY')
        self.assertEqual((self.stage/'env/api.env').read_bytes(),self.api)
        self.assertEqual((self.candidate/'previous-api.env').read_bytes(),t.OLD_API)
        self.assertEqual(r.directory_identity(self.data_root),(*r.ROOT_IDENTITY[:4],0o700))
        self.assertEqual(r.directory_identity(self.pgdata),r.PGDATA_IDENTITY)
        self.assertEqual(self.validator.call_count,2);self.assertEqual(self.live.call_count,3)
        self.assertFalse(self.generate.called)
        for name,digest in state['handoff_hashes'].items():
            self.assertEqual(t.activate.sha256((self.stage/'evidence'/name).read_bytes()),digest)
        for name,digest in state['configuration_hashes'].items():
            self.assertEqual(t.activate.sha256((self.stage/name).read_bytes()),digest)
        self.assertEqual((self.data_root/'preserve-sentinel').read_bytes(),b'existing initialized database\n')
        self.assertFalse(state['application_started']);self.assertEqual(state['provider_requests'],0)
    def test_candidate_change_stops_before_mode_write(self):
        self.write(self.candidate/'api.env',self.api+b'CHANGED=true\n')
        code,state=self.run_recovery();self.assertEqual(code,1)
        self.assertEqual(state['error'],'EXACT_CANDIDATE_HASHES_REQUIRED')
        self.assertEqual(r.directory_identity(self.data_root),r.ROOT_IDENTITY)
        self.assertFalse((self.stage/'evidence'/r.RECOVERY_ATTEMPT).exists())
    def test_source_change_stops_before_mode_write(self):
        name=next(iter(self.data['source_hashes']))
        self.write(self.stage/'source'/name,b'changed',0o644)
        code,state=self.run_recovery();self.assertEqual(code,1);self.assertEqual(state['error'],'STAGED_SOURCE_CHANGED')
        self.assertEqual(r.directory_identity(self.data_root),r.ROOT_IDENTITY);self.assert_untouched()
    def test_wrong_directory_identity_stops(self):
        with patch.object(r,'ROOT_IDENTITY',(2049,123456,999,999,0o1777)):
            code,state=self.run_recovery()
        self.assertEqual(code,1);self.assertEqual(state['error'],'INSPECTED_VOLUME_ROOT_CHANGED');self.assert_untouched()
    def test_existing_recovery_receipt_prevents_retry(self):
        self.json_write(self.stage/'evidence'/r.RECOVERY_ATTEMPT,{'previous':'preserved'})
        code,state=self.run_recovery();self.assertEqual(code,1)
        self.assertEqual(state['error'],'EXISTING_RECOVERY_OR_START_PRESERVED');self.assert_untouched()
    def test_validator_failure_preserves_partial_recovery(self):
        self.validator.side_effect=t.activate.Error('CHILD_COMMAND_FAILED')
        code,state=self.run_recovery();self.assertEqual(code,1);self.assertEqual(state['phase'],'VALIDATE_CANDIDATE')
        self.assertEqual(r.directory_identity(self.data_root),(*r.ROOT_IDENTITY[:4],0o700))
        self.assertTrue((self.stage/'evidence'/r.RECOVERY_ATTEMPT).is_file())
        self.assertFalse((self.stage/'evidence/application-env.json').exists());self.assert_untouched()
        code,state=self.run_recovery();self.assertEqual(code,1)
        self.assertEqual(state['error'],'EXISTING_RECOVERY_OR_START_PRESERVED')
    def test_failed_live_precheck_does_not_change_permissions(self):
        self.live.side_effect=t.activate.Error('INITIALIZED_DATABASE_MUST_BE_HEALTHY')
        code,state=self.run_recovery();self.assertEqual(code,1)
        self.assertEqual(r.directory_identity(self.data_root),r.ROOT_IDENTITY);self.assert_untouched()
    def test_changed_provider_stops_before_repair(self):
        self.data['providers']['AUTH_TOKEN_DELIVERY_SMTP_PASSWORD']='DifferentValidPassword'
        self.json_write(self.private,self.data)
        code,state=self.run_recovery();self.assertEqual(code,1)
        self.assertEqual(state['error'],'PRESERVED_PROVIDER_INPUT_CHANGED')
        self.assertEqual(r.directory_identity(self.data_root),r.ROOT_IDENTITY);self.assert_untouched()
    def test_directory_symlink_refused(self):
        link=self.root/'linked';link.symlink_to(self.data_root,target_is_directory=True)
        with self.assertRaises(t.activate.Error):r.directory_identity(link)
    def test_missing_explicit_recovery_flag_refused(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):code=r.main(['--prepare-validated-api-environment','--private-input',str(self.private)])
        self.assertEqual(code,1);self.assert_untouched()

if __name__=='__main__':unittest.main()
