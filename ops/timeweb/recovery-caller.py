#!/usr/bin/env python3
"""Reconcile exactly the inspected API candidate between original launch gates."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys

PINS={
    'application-caller.py':'f251b3fe84b818c831d539bac3b0c489d694159489661c1329a7ec9df2b39495',
    'recover-api-preparation.py':'0a1ec78c18632cb03630902c27060a930ec038086711614cac59601b236fdac2',
}
def load(name):
    path=Path(__file__).with_name(name)
    assert path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==PINS[name]
    spec=importlib.util.spec_from_file_location('kinetra_recovery_'+name.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def main(argv=None,environ=None):
    argv=sys.argv[1:] if argv is None else argv
    environ=os.environ if environ is None else environ
    c=load('application-caller.py')
    try:
        c.require(argv==['--recover-api'],'EXPLICIT_RECOVERY_CALLER_PHASE_REQUIRED')
        c.execution(environ)
        local=c.load('activate-local-application-host.py')
        signal.signal(signal.SIGTERM,local.inspection.interrupted)
        c.require(not environ.get('GH_TOKEN') and not environ.get('GITHUB_TOKEN'),'GITHUB_TOKEN_NOT_ALLOWED')
        path,_database=c.prior_database(environ,local)
        metadata=c.source_metadata(local,environ)
        recovery=load('recover-api-preparation.py')
        original_progress=c.progress
        def progress(state):
            result=original_progress(state)
            remote=state.get('preparation')
            if isinstance(remote,dict) and isinstance(remote.get('preparation'),dict):
                prepared=recovery.validate_preparation(remote['preparation'])
                result['api_phase']=prepared['phase']
                result['api_error']=prepared['error']
                result['api_environment_installed']=prepared['api_environment_installed']
            return result
        c.progress=progress
        outer=c.capture(lambda:recovery.main(['--recover-preserved-api-environment','--provider-env'],environ=environ),
                        'TIMEWEB_API_PREPARATION=',path/'api-outer.json')
        local.successful_outer(outer,api=True)
        # The original, unmodified downstream result and source/hash validators
        # accept the real recovered outcome; no fabricated prior handoff.
        local.prepare.validate_remote(json.dumps(outer['preparation']),metadata,outer['remote_directory'].rsplit('-',1)[1])
        c.write_json(path/'api-outer.json',outer)
        print('KINETRA_API_RECOVERY_OUTER_CAPTURED=PASS')
        return 0
    except BaseException as error:
        category=str(error) if isinstance(error,c.CallerError) and re.fullmatch(r'[A-Z_]{1,90}',str(error)) else 'RECOVERY_CALLER_FAILED_STATE_PRESERVED'
        print('KINETRA_API_RECOVERY_CALLER=FAIL:'+category,file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
