"""Upgrade the recovered fixed host with unchanged schema and owned application rollback.

Input is authenticated by the caller before SSH. No credentials arrive from the caller.
Existing private env files remain on the host. Caddy/PostgreSQL are never restarted.
"""
import base64,fcntl,hashlib,http.client,json,os,pathlib,re,resource,secrets,shutil,signal,stat,subprocess,sys,time
S=pathlib.Path('/srv/kinetra-stage');APP='c4f63e798b3bb98b97ea9eb7de73ba5c167a54c5';BASE='a61a42f2dc10749939a1044990bf2cf456e34b52'
OLD_IMAGES={'backend':'ghcr.io/san4o9910/kinetra-backend@sha256:4926900d638e629fc7c2a275f92866be27b487dc901559ec7ff8fe301b42d6be','frontend':'ghcr.io/san4o9910/kinetra-frontend@sha256:efd7d884c7aa5500f2571c23049491d289591572100ad76f9cac1f911d41206b'}
class Failure(Exception):pass
def require(ok,code):
 if not ok:raise Failure(code)
def command(args,*,data=None,timeout=60,output=None):
 r=subprocess.run(args,input=data,stdout=output if output is not None else subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout)
 require(r.returncode==0,'COMMAND_FAILED');return r.stdout if output is None else b''
def private(path):
 info=path.lstat();require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600,'PRIVATE_FILE_INVALID');return path.read_bytes()
def write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def replace_private(path,data):
 temporary=path.with_name(path.name+'.coaching-'+secrets.token_hex(8));write(temporary,data);os.replace(temporary,path)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def env(raw):
 result={}
 for line in raw.decode().splitlines():
  if line and not line.startswith('#'):
   k,v=line.split('=',1);require(k not in result and re.fullmatch('[A-Z][A-Z0-9_]*',k),'ENV_INVALID');result[k]=v
 return result
def encoded(values):return ''.join(k+'='+v+'\n' for k,v in values.items()).encode()
def inspect():
 ids=command(['docker','ps','-aq']).decode().split();require(len(ids)==3,'UNEXPECTED_CONTAINERS')
 allc=json.loads(command(['docker','inspect',*ids]));result={c['Config']['Labels'].get('com.docker.compose.service'):c for c in allc}
 require(set(result)=={'backend','frontend','postgres'} and all(c['Config']['Labels'].get('com.docker.compose.project')=='kinetra-production' for c in allc),'PROJECT_IDENTITY_CHANGED');return result
def sql(pg,text,database='kinetra'):
 return command(['docker','exec','--user','postgres',pg,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','kinetra_bootstrap','-d',database,'-c',text])
def ledger(pg,database='kinetra'):
 return json.loads(sql(pg,"SELECT json_agg(t) FROM (SELECT filename,checksum FROM schema_migrations ORDER BY filename)t",database))
def get(path):
 con=http.client.HTTPConnection('127.0.0.1',8080,timeout=8)
 try:
  con.request('GET',path);r=con.getresponse();body=r.read(4*1024*1024+1);require(len(body)<=4*1024*1024,'HTTP_TOO_LARGE');return r.status,body
 finally:con.close()
def compose(prod,override,args,timeout=90):
 command(['/usr/bin/env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL=C','KINETRA_JOB_ENV_FILE='+str(S/'env/jobs/migrate.env'),'docker','compose','--project-name','kinetra-production','--env-file',str(prod),'--env-file',str(S/'env/single-server.env'),'-f',str(S/'source/deploy/compose.production.yml'),'-f',str(S/'source/deploy/compose.single-server.yml'),'-f',str(override),*args],timeout=timeout)
def healthy(images,pgid):
 deadline=time.monotonic()+100
 while time.monotonic()<deadline:
  current=inspect();require(current['postgres']['Id']==pgid and current['postgres']['State']['Running'],'DATABASE_CHANGED')
  if all(current[k]['Config']['Image']==images[k] and current[k]['State']['Running'] for k in images) and current['backend']['State'].get('Health',{}).get('Status')=='healthy':
   for k in images:
    c=current[k];require(c['HostConfig']['ReadonlyRootfs'] and c['HostConfig']['CapDrop']==['ALL'] and 'no-new-privileges:true' in c['HostConfig']['SecurityOpt'],'SANDBOX_CHANGED')
   ports=current['frontend']['NetworkSettings']['Ports'].get('8080/tcp');require(ports==[{'HostIp':'127.0.0.1','HostPort':'8080'}],'PUBLIC_BIND_CHANGED')
   try:
    codes={path:get(path)[0] for path in ('/health','/ready','/api/v1/me','/')}
   except (OSError,http.client.HTTPException):
    time.sleep(2);continue
   if any(code in (502,503) for code in codes.values()):
    time.sleep(2);continue
   require(codes=={'/health':200,'/ready':404,'/api/v1/me':401,'/':200},'HTTP_ACCEPTANCE_FAILED')
   return current
  time.sleep(2)
 raise Failure('APPLICATION_HEALTH_TIMEOUT')
def main():
 state={'schema':1,'result':'FAIL','stage':'INPUT','error':None,'rollback':'NOT_NEEDED'};work=None;changed=False;pgid=None;lock=None
 try:
  resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077);require(os.geteuid()==0,'ROOT_REQUIRED')
  raw=sys.stdin.buffer.read(262145);require(len(raw)<=262144,'INPUT_TOO_LARGE');data=json.loads(raw)
  require(set(data)=={'app','images','expected_containers','migrations','grants','run'} and data['app']==APP,'INPUT_INVALID')
  require(set(data['images'])=={'backend','frontend'} and all(re.fullmatch('ghcr.io/san4o9910/kinetra-'+k+'@sha256:[a-f0-9]{64}',v) for k,v in data['images'].items()),'IMAGE_INVALID')
  require(re.fullmatch(r'[1-9][0-9]{0,19}',data['run']),'RUN_INVALID')
  require(S.is_dir() and S.resolve()==S and S.stat().st_uid==0 and stat.S_IMODE(S.stat().st_mode)==0o700,'STAGE_INVALID')
  lock=open('/run/kinetra-database-stage.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  current=inspect();require({k:c['Id'] for k,c in current.items()}==data['expected_containers'],'LIVE_IDENTITY_CHANGED')
  require(all(current[k]['Config']['Image']==v for k,v in OLD_IMAGES.items()),'BASE_IMAGES_CHANGED')
  require(all(c['State']['Running'] for c in current.values()),'BASE_NOT_RUNNING');pgid=current['postgres']['Id']
  require(current['backend']['State'].get('Health',{}).get('Status')=='healthy' and get('/health')[0]==200,'BASE_NOT_HEALTHY')
  oldledger=ledger(pgid);expected=data['migrations'];require(len(expected)==15 and len(oldledger)==15 and all(expected.get(r['filename'])==r['checksum'] for r in oldledger),'MIGRATION_HISTORY_CHANGED')
  grants=base64.b64decode(data['grants'],validate=True);require(len(grants)<16384 and b'chat_video_assets' in grants,'GRANTS_INVALID')
  prior=S/'coaching-release-a61a42f2dc10-35036937433'
  previous=json.loads(private(prior/'accepted.json'))
  require(previous['result']=='PASS_UPGRADED' and previous['app']==BASE and previous['images']==OLD_IMAGES,'PREVIOUS_RELEASE_CHANGED')
  require(current['postgres']['HostConfig']['RestartPolicy']['Name']=='unless-stopped','DATABASE_BOOT_POLICY_CHANGED')
  require(command(['systemctl','is-enabled','caddy']).strip()==b'enabled' and command(['systemctl','is-active','caddy']).strip()==b'active','HTTPS_BOOT_POLICY_CHANGED')
  reviewers=sql(pgid,'SELECT count(*) FROM trainer_verification_reviewers').strip();require(int(reviewers)>=1,'OWNER_REVIEWER_MISSING')
  state['stage']='PULL_IMAGES'
  for k,image in data['images'].items():
   command(['docker','pull',image],timeout=180)
   meta=json.loads(command(['docker','image','inspect',image]))[0];require(meta['Config']['Labels'].get('org.opencontainers.image.revision')==APP and meta['Architecture']=='amd64','IMAGE_REVISION_CHANGED')
  require(shutil.disk_usage(S).free>3*1024**3,'BACKUP_CAPACITY_INSUFFICIENT')
  work=S/('trainer-signup-release-'+APP[:12]+'-'+data['run']);work.mkdir(mode=0o700)
  write(work/'request.json',raw);write(work/'previous-containers.json',json.dumps(current).encode())
  oldprod=private(S/'env/production.env');oldapi=private(S/'env/api.env')
  write(work/'previous-production.env',oldprod);write(work/'previous-api.env',oldapi)
  prod=env(oldprod);api=env(oldapi);api['AUTH_PASSWORD_MIN_LENGTH']='6'
  # Text chat has no external provider dependency. Private media flags remain explicit.
  api['CHAT_ENABLED']='true'
  write(work/'api.env',encoded(api));prod.update(BACKEND_IMAGE=data['images']['backend'],FRONTEND_IMAGE=data['images']['frontend'],VCS_REF=APP,KINETRA_API_ENV_FILE=str(work/'api.env'))
  write(work/'production.env',encoded(prod));write(work/'compose.json',json.dumps({'services':{k:{'labels':{'com.kinetra.coaching':APP}} for k in ('backend','frontend')}}).encode())
  write(work/'rollback.compose.json',json.dumps({'services':{k:{'labels':{'com.kinetra.coaching':BASE}} for k in ('backend','frontend')}}).encode())
  compose(work/'production.env',work/'compose.json',['config','--quiet'])
  state['stage']='BACKUP_AND_RESTORE_CHECK'
  dump=work/'database.dump'
  with open(dump,'xb') as out:command(['docker','exec','--user','postgres',pgid,'pg_dump','-U','kinetra_bootstrap','-d','kinetra','--format=custom'],timeout=180,output=out);out.flush();os.fsync(out.fileno())
  require(dump.stat().st_size>1024,'BACKUP_EMPTY')
  restoredb='kinetra_restore_'+secrets.token_hex(8);created=False
  try:
   sql(pgid,'CREATE DATABASE '+restoredb+' TEMPLATE template0');created=True
   with open(dump,'rb') as inp:
    r=subprocess.run(['docker','exec','-i','--user','postgres',pgid,'pg_restore','-U','kinetra_bootstrap','--exit-on-error','-d',restoredb],stdin=inp,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=240);require(r.returncode==0,'RESTORE_CHECK_FAILED')
   require(ledger(pgid,restoredb)==oldledger,'RESTORED_LEDGER_MISMATCH')
   require(sql(pgid,"SELECT count(*) FROM users",restoredb).strip().isdigit(),'RESTORED_USERS_UNREADABLE')
  finally:
   if created:sql(pgid,'DROP DATABASE '+restoredb)
  state['backup']={'path':str(dump),'bytes':dump.stat().st_size,'sha256':hashlib.file_digest(open(dump,'rb'),'sha256').hexdigest(),'restore_verified':True}
  # This release does not change schema or grants. Verify the exact installed migration ledger.
  require({r['filename']:r['checksum'] for r in ledger(pgid)}==expected,'SCHEMA_CHANGED')
  state['stage']='REPLACE_APPLICATION';changed=True
  compose(work/'production.env',work/'compose.json',['up','-d','--no-deps','--no-build','--pull','never','backend','frontend'],timeout=180)
  now=healthy(data['images'],pgid)
  require('AUTH_PASSWORD_MIN_LENGTH=6' in now['backend']['Config']['Env'] and 'CHAT_ENABLED=true' in now['backend']['Config']['Env'],'EFFECTIVE_ENVIRONMENT_MISMATCH')
  schema_check="""import assert from 'node:assert/strict';import {trainerVerificationApplicationSchema as schema} from './apps/backend/dist/trainer-verification/schema.js';
const input={display_name:'Release validation',specialization:'Mobility',experience_years:0,bio:'Completed trainer education.\\nBeginning supervised practice.',city:'Moscow',timezone:'Europe/Moscow'};
const parsed=schema.safeParse(input);assert.equal(parsed.success,true);assert.deepEqual(parsed.data.materials,[]);assert.equal(schema.safeParse({...input,materials:[{kind:'other',title:'Unsafe',url:'javascript:alert(1)'}]}).success,false);console.log('LIVE_APPLICATION_WITHOUT_LINKS=PASS');"""
  require(command(['docker','exec','--user','1000:1000','--workdir','/app',now['backend']['Id'],'node','--input-type=module','-e',schema_check]).strip()==b'LIVE_APPLICATION_WITHOUT_LINKS=PASS','LIVE_APPLICATION_SCHEMA_FAILED')

  require({r['filename']:r['checksum'] for r in ledger(pgid)}==expected,'FINAL_LEDGER_MISMATCH')
  html=get('/')[1].decode();assets=re.findall(r'(?:src|href)="(/assets/[^" ]+\.(?:js|css))"',html);require(len(assets)>=2,'ASSETS_MISSING')
  css=b''.join(get(p)[1] for p in assets if p.endswith('.css'));require(b'#ff4103' in css.lower() and b'#001621' in css.lower(),'NEW_PALETTE_MISSING')
  require(sql(pgid,'SELECT count(*) FROM trainer_verification_reviewers').strip()==reviewers,'REVIEWER_ACCESS_CHANGED')
  state['stage']='COMMIT_RELEASE_METADATA'
  replace_private(S/'env/production.env',encoded(prod));replace_private(S/'env/api.env',encoded(api))
  state.update(result='PASS_UPGRADED',stage='COMPLETE',app=APP,images=data['images'],containers={k:c['Id'] for k,c in now.items()},migrations=len(expected),password_min_length=6,chat_enabled=True,application_without_links=True)
  write(work/'accepted.json',json.dumps(state,sort_keys=True).encode())
 except BaseException as e:
  state['result']='FAIL'
  state['error']=str(e) if isinstance(e,Failure) else type(e).__name__
  if changed and work:
   try:
    replace_private(S/'env/production.env',private(work/'previous-production.env'));replace_private(S/'env/api.env',private(work/'previous-api.env'))
    compose(work/'previous-production.env',work/'rollback.compose.json',['up','-d','--no-deps','--no-build','--pull','never','backend','frontend'],timeout=180);healthy(OLD_IMAGES,pgid);state['rollback']='PREVIOUS_APPLICATION_RESTORED_SCHEMA_UNCHANGED'
   except BaseException:state['rollback']='UNKNOWN_RECONCILE'
 finally:
  if lock:lock.close()
  if work:
   try:write(work/'attempt-result.json',json.dumps(state,sort_keys=True).encode())
   except BaseException:state['error']=state['error'] or 'RESULT_PERSISTENCE_FAILED';state['result']='FAIL'
  print(json.dumps(state,sort_keys=True),flush=True)
 return 0 if state['result']=='PASS_UPGRADED' else 1
def interrupted(signum,frame):
 signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
 raise Failure('RELEASE_INTERRUPTED')
if __name__=='__main__':
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted);sys.exit(main())
