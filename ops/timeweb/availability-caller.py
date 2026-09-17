"""Fixed-host, pinned-SSH transport; ephemeral key lifecycle inherited unchanged."""
import hashlib,importlib.util,json,os,pathlib,re,resource,shlex,subprocess,sys,tempfile,time
ROOT=pathlib.Path(__file__).parent
p=ROOT/'inspect-server.py'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='567d892221925bb438ece6a893360a891ffd4228f8af0a18252b8ba365a682c0'
spec=importlib.util.spec_from_file_location('inspection',p); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def main():
 state={'result':'FAIL','guest_key_cleanup':'NOT_NEEDED','account_key_cleanup':'NOT_NEEDED','local_key_cleanup':'NOT_NEEDED','ssh_key_id':None,'error':None}
 api=folder=None
 try:
  assert sys.argv[1:]==['--inspect-availability']
  assert os.environ['GITHUB_ACTIONS']=='true' and os.environ['GITHUB_REPOSITORY']==m.REPOSITORY and os.environ['GITHUB_REF']=='refs/heads/ops/timeweb-hourly-preflight-20260909' and os.environ['GITHUB_RUN_ATTEMPT']=='1'
  assert not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN')
  resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
  token=os.environ.pop('TIMEWEB_CLOUD_TOKEN','');assert token and not any(c.isspace() for c in token)
  deadline=time.monotonic()+600;api=m.Api(token,m.SERVER_ID,deadline);token=''
  checked=m.validate_server(api.request('GET',f'/servers/{m.SERVER_ID}'),m.SERVER_ID,m.PUBLIC_IPV4);assert checked['server_status']=='on';api.server_verified=True
  folder=pathlib.Path(tempfile.mkdtemp(prefix='kinetra-coaching-',dir=os.environ['RUNNER_TEMP']));state['local_key_cleanup']='PENDING'
  known,fingerprint=m.pin_host_key(m.PUBLIC_IPV4,folder,deadline);assert fingerprint=='SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0'
  private,public=m.prepare_key(folder,deadline)
  name='kinetra-coaching-'+os.environ['GITHUB_RUN_ID']
  key=m.ssh_key_object(api.request('POST','/ssh-keys',{'name':name,'body':public,'is_default':False}))
  api.key_id=m.positive_id(key['id']);state['ssh_key_id']=api.key_id
  assert key['name']==name and key['body']==public and key['is_default'] is False
  state.update(account_key_cleanup='PENDING',guest_key_cleanup='ATTACH_OUTCOME_UNKNOWN')
  print('KINETRA_TRANSPORT='+json.dumps(state),flush=True)
  api.request('POST',f'/servers/{m.SERVER_ID}/ssh-keys',{'ssh_key_ids':[api.key_id]});state['guest_key_cleanup']='PENDING'
  args=m.ssh_arguments(m.PUBLIC_IPV4,private,known);m.wait_for_key(args,deadline)
  script=(ROOT/'availability-host-inspect.py').read_text()
  result=subprocess.run(args+['/usr/bin/python3 -B -c '+shlex.quote(script)],input=b'',stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=240)
  assert len(result.stdout)<65536
  guest=json.loads(result.stdout);state['guest']=guest
  assert result.returncode==0 and guest['result']=='PASS_READ_ONLY'
  state['guest']=guest;state['result']='PASS_READ_ONLY'
 except BaseException as e:state['error']=str(e) if isinstance(e,m.InspectError) else type(e).__name__
 finally:
  m.cleanup(api,folder,state)
  if any(state[k] not in {'NOT_NEEDED','API_DELETE_CONFIRMED','ALREADY_ABSENT','REMOVED'} for k in ('guest_key_cleanup','account_key_cleanup','local_key_cleanup')):state['result']='FAIL'
  print('KINETRA_TRANSPORT='+json.dumps(state,sort_keys=True),flush=True)
  pathlib.Path(os.environ['RUNNER_TEMP'],'kinetra-availability.json').write_text(json.dumps(state,sort_keys=True)+'\n')
 return 0 if state['result']=='PASS_READ_ONLY' else 1
if __name__=='__main__':sys.exit(main())
