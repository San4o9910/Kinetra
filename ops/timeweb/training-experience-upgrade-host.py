"""Install personal trainer programs, additive migration 018 and private host media.

Input is authenticated by the caller before SSH. No credentials arrive from the caller.
Existing private env files remain on the host. Caddy/PostgreSQL are never restarted.
"""
import base64,fcntl,hashlib,http.client,json,os,pathlib,re,resource,secrets,shutil,signal,stat,subprocess,sys,time
S=pathlib.Path('/srv/kinetra-stage');APP='c57cc5d54e87bb2468a9d84630557d4f52ec57d1';BASE='5be7df36f85b65c8248c221509ea3a7fec1919db'
OLD_IMAGES={'backend':'ghcr.io/san4o9910/kinetra-backend@sha256:96c21c21afeee176937afcff0996b38f4dc8c8d21d24ab7fdca1330644fc5a6d','frontend':'ghcr.io/san4o9910/kinetra-frontend@sha256:b394b4e58702ea7543640f8bd828a61a9aba26470ba52097dc221a532596884d'}
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
def remove_owned_config(path,expected):
 if path.exists() or path.is_symlink():
  require(private(path)==expected,'OWNED_CONFIGURATION_CHANGED');path.unlink()
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
 media=S/'source/deploy/compose.training-media.yml'
 extra=['-f',str(media)] if media.exists() else []
 command(['/usr/bin/env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL=C','KINETRA_JOB_ENV_FILE='+str(S/'env/jobs/migrate.env'),'docker','compose','--project-name','kinetra-production','--env-file',str(prod),'--env-file',str(S/'env/single-server.env'),'-f',str(S/'source/deploy/compose.production.yml'),'-f',str(S/'source/deploy/compose.single-server.yml'),*extra,'-f',str(override),*args],timeout=timeout)
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
def migrate(image,pgid,newhash,grants,work,net,ca):
 # Bounded job uses the existing dedicated migration role over verified TLS.
 name='kinetra-workspace-migrate-'+secrets.token_hex(8)
 code="""import assert from 'node:assert/strict';import pg from 'pg';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const c=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,statement_timeout:30000,lock_timeout:5000});await c.connect();try{
assert.equal((await c.query('SELECT current_user AS u')).rows[0].u,'kinetra_migrate');
assert.equal((await c.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);
await c.query('SELECT pg_advisory_lock(hashtext($1))',['kinetra-schema-migrations']);
const expected=JSON.parse(readFileSync('/release/migrations.json','utf8'));
const rows=(await c.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename')).rows;
for(const row of rows)assert.equal(expected[row.filename],row.checksum);
for(const [filename,checksum]of Object.entries(expected)){
const text=readFileSync('/app/apps/backend/migrations/'+filename,'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),checksum);
if(rows.some(r=>r.filename===filename))continue;
assert.ok(/^018_/.test(filename));await c.query('BEGIN');try{await c.query(text);await c.query('INSERT INTO schema_migrations(filename,checksum)VALUES($1,$2)',[filename,checksum]);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}}
await c.query(readFileSync('/release/runtime-grants.sql','utf8').replace(/^\\\\set ON_ERROR_STOP on\\r?\\n/m,''));
assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,Object.keys(expected).length);
console.log('MIGRATIONS_AND_GRANTS=PASS');
}finally{await c.end()}
"""
 work=work/'public';work.mkdir(mode=0o755);os.chmod(work,0o755)
 write(work/'migrations.json',json.dumps(newhash).encode());write(work/'runtime-grants.sql',grants)
 # Only public SQL/JSON is mounted. Readable by UID 1000, protected by root-only parent.
 os.chmod(work/'migrations.json',0o644);os.chmod(work/'runtime-grants.sql',0o644)
 args=['docker','run','--name',name,'--label','com.kinetra.coaching='+APP,'--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network',net,'--tmpfs','/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700','--env-file',str(S/'env/jobs/migrate.env'),'-e','NODE_EXTRA_CA_CERTS=/run/kinetra/postgres-ca.crt','--mount','type=bind,source='+ca+',target=/run/kinetra/postgres-ca.crt,readonly','--mount','type=bind,source='+str(work)+',target=/release,readonly',image,'node','--input-type=module','-e',code]
 try:
  out=command(args,timeout=150);require(out.strip()==b'MIGRATIONS_AND_GRANTS=PASS','MIGRATION_RESULT_INVALID')
 finally:
  r=subprocess.run(['docker','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
  if r.returncode==0:
   owned=json.loads(r.stdout)[0];require(owned['Config']['Labels'].get('com.kinetra.coaching')==APP and owned['Config']['Image']==image,'JOB_IDENTITY_CHANGED');command(['docker','rm','-f',owned['Id']])
def existing_media(media,configuration,expected):
 require(media.is_dir() and not media.is_symlink() and media.stat().st_uid==1000 and media.stat().st_gid==1000 and stat.S_IMODE(media.stat().st_mode)==0o700,'EXISTING_MEDIA_DIRECTORY_INVALID')
 require(private(configuration)==expected,'EXISTING_MEDIA_CONFIGURATION_CHANGED')
 return media
def main():
 state={'schema':1,'result':'FAIL','stage':'INPUT','error':None,'rollback':'NOT_NEEDED'};work=None;changed=False;pgid=None;lock=None;installed_config=None
 try:
  resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077);require(os.geteuid()==0,'ROOT_REQUIRED')
  raw=sys.stdin.buffer.read(262145);require(len(raw)<=262144,'INPUT_TOO_LARGE');data=json.loads(raw)
  require(set(data)=={'app','images','expected_containers','migrations','grants','media_compose','run'} and data['app']==APP,'INPUT_INVALID')
  require(set(data['images'])=={'backend','frontend'} and all(re.fullmatch('ghcr.io/san4o9910/kinetra-'+k+'@sha256:[a-f0-9]{64}',v) for k,v in data['images'].items()),'IMAGE_INVALID')
  require(re.fullmatch(r'[1-9][0-9]{0,19}',data['run']),'RUN_INVALID')
  require(S.is_dir() and S.resolve()==S and S.stat().st_uid==0 and stat.S_IMODE(S.stat().st_mode)==0o700,'STAGE_INVALID')
  lock=open('/run/kinetra-database-stage.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  current=inspect();require({k:c['Id'] for k,c in current.items()}==data['expected_containers'],'LIVE_IDENTITY_CHANGED')
  require(all(current[k]['Config']['Image']==v for k,v in OLD_IMAGES.items()),'BASE_IMAGES_CHANGED')
  require(all(c['State']['Running'] for c in current.values()),'BASE_NOT_RUNNING');pgid=current['postgres']['Id']
  require(current['backend']['State'].get('Health',{}).get('Status')=='healthy' and get('/health')[0]==200,'BASE_NOT_HEALTHY')
  oldledger=ledger(pgid);expected=data['migrations'];require(len(expected)==18 and len(oldledger)==17 and all(expected.get(r['filename'])==r['checksum'] for r in oldledger),'MIGRATION_HISTORY_CHANGED')
  grants=base64.b64decode(data['grants'],validate=True);require(len(grants)<16384 and b'chat_video_assets' in grants,'GRANTS_INVALID')
  prior=S/'training-experience-release-5be7df36f85b-35362046745'
  previous=json.loads(private(prior/'accepted.json'))
  require(previous['result']=='PASS_UPGRADED' and previous['app']==BASE and previous['images']==OLD_IMAGES,'PREVIOUS_RELEASE_CHANGED')
  require(current['postgres']['HostConfig']['RestartPolicy']['Name']=='unless-stopped','DATABASE_BOOT_POLICY_CHANGED')
  require(command(['systemctl','is-enabled','caddy']).strip()==b'enabled' and command(['systemctl','is-active','caddy']).strip()==b'active','HTTPS_BOOT_POLICY_CHANGED')
  reviewers=sql(pgid,'SELECT count(*) FROM trainer_verification_reviewers').strip();require(int(reviewers)>=1,'OWNER_REVIEWER_MISSING')
  state['stage']='PULL_IMAGES'
  for k,image in data['images'].items():
   command(['docker','pull',image],timeout=180)
   meta=json.loads(command(['docker','image','inspect',image]))[0];require(meta['Config']['Labels'].get('org.opencontainers.image.revision')==APP and meta['Architecture']=='amd64','IMAGE_REVISION_CHANGED')
  require(shutil.disk_usage(S).free>8*1024**3,'BACKUP_CAPACITY_INSUFFICIENT')
  work=S/('lesson-sharing-release-'+APP[:12]+'-'+data['run']);work.mkdir(mode=0o700)
  write(work/'request.json',raw);write(work/'previous-containers.json',json.dumps(current).encode())
  oldprod=private(S/'env/production.env');oldapi=private(S/'env/api.env')
  write(work/'previous-production.env',oldprod);write(work/'previous-api.env',oldapi)
  prod=env(oldprod);api=env(oldapi);api['AUTH_PASSWORD_MIN_LENGTH']='6'
  # Text chat has no external provider dependency. Private media flags remain explicit.
  api['CHAT_ENABLED']='true'
  api['TRAINING_MEDIA_DIR']='/training-media'
  require(all(api.get(k) for k in ('VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT')),'REMINDER_CONFIGURATION_MISSING')
  api['TRAINING_REMINDERS_ENABLED']='true'
  media_parent=S/'media'
  require(not media_parent.is_symlink() and media_parent.stat().st_uid==0 and stat.S_IMODE(media_parent.stat().st_mode)==0o700,'MEDIA_PARENT_INVALID')
  media=media_parent/'training-lessons'
  media_compose=base64.b64decode(data['media_compose'],validate=True)
  require(len(media_compose)<4096 and b'target: /training-media' in media_compose and b'create_host_path: false' in media_compose,'MEDIA_COMPOSE_INVALID')
  existing_media(media,S/'source/deploy/compose.training-media.yml',media_compose)
  prod['KINETRA_TRAINING_MEDIA_DIR']=str(media)
  write(work/'api.env',encoded(api));prod.update(BACKEND_IMAGE=data['images']['backend'],FRONTEND_IMAGE=data['images']['frontend'],VCS_REF=APP,KINETRA_API_ENV_FILE=str(work/'api.env'))
  write(work/'production.env',encoded(prod));write(work/'compose.json',json.dumps({'services':{'backend':{'labels':{'com.kinetra.coaching':APP},'volumes':[{'type':'bind','source':str(media),'target':'/training-media','bind':{'create_host_path':False}}]},'frontend':{'labels':{'com.kinetra.coaching':APP}}}}).encode())
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
  state['stage']='MIGRATIONS'
  networks=current['postgres']['NetworkSettings']['Networks'];require(len(networks)==1,'DATABASE_NETWORK_CHANGED');net=next(iter(networks))
  ca=next(m['Source'] for m in current['backend']['Mounts'] if m['Destination']=='/run/kinetra/postgres-ca.crt')
  migrate(data['images']['backend'],pgid,expected,grants,work,net,ca)
  state['stage']='REPLACE_APPLICATION';changed=True
  compose(work/'production.env',work/'compose.json',['up','-d','--no-deps','--no-build','--pull','never','backend','frontend'],timeout=180)
  now=healthy(data['images'],pgid)
  require('AUTH_PASSWORD_MIN_LENGTH=6' in now['backend']['Config']['Env'] and 'CHAT_ENABLED=true' in now['backend']['Config']['Env'] and 'TRAINING_REMINDERS_ENABLED=true' in now['backend']['Config']['Env'],'EFFECTIVE_ENVIRONMENT_MISMATCH')
  mount=next((m for m in now['backend']['Mounts'] if m['Destination']=='/training-media'),None)
  require(mount and mount['Source']==str(media) and mount['RW'] and 'TRAINING_MEDIA_DIR=/training-media' in now['backend']['Config']['Env'],'MEDIA_MOUNT_INVALID')
  media_check="""import assert from 'node:assert/strict';import {writeFile,unlink,stat} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {databasePool} from './apps/backend/dist/db/pool.js';import {TrainingService} from './apps/backend/dist/training/service.js';import {TrainingExperience} from './apps/backend/dist/training/experience.js';
const dir=process.env.TRAINING_MEDIA_DIR;assert.equal(dir,'/training-media');const info=await stat(dir);assert.equal(info.uid,1000);assert.equal(info.mode&511,448);const file=dir+'/release-probe-'+randomUUID();await writeFile(file,'private',{flag:'wx',mode:384});await unlink(file);
const service=new TrainingService(databasePool,true);assert.deepEqual(await service.myTraining(randomUUID()),{trainer_name:null,student_id:null,plans:[],assigned_lessons:[]});const experience=new TrainingExperience(service);assert.deepEqual(await experience.measurements(randomUUID()),{measurements:[]});assert.deepEqual(await experience.reschedules(randomUUID()),{requests:[]});assert.deepEqual(await experience.complaints(randomUUID()),{complaints:[]});assert.equal(process.env.TRAINING_REMINDERS_ENABLED,'true');await databasePool.end();console.log('LIVE_TRAINER_WORKSPACE=PASS');"""
  require(command(['docker','exec','--user','1000:1000','--workdir','/app',now['backend']['Id'],'node','--input-type=module','-e',media_check]).strip()==b'LIVE_TRAINER_WORKSPACE=PASS','LIVE_WORKSPACE_FAILED')
  require(all(get(p)[0]==401 for p in ('/api/v1/training/students','/api/v1/training/mine','/api/v1/training/lessons','/api/v1/training/templates','/api/v1/training/attention','/api/v1/training/measurements','/api/v1/training/reschedules','/api/v1/training/admin/complaints','/api/v1/training/lessons/00000000-0000-4000-8000-000000000001/assignments','/api/v1/training/media/00000000-0000-4000-8000-000000000001?token=invalid')),'TRAINING_AUTH_BOUNDARY_FAILED')
  require({r['filename']:r['checksum'] for r in ledger(pgid)}==expected,'FINAL_LEDGER_MISMATCH')
  html=get('/')[1].decode();assets=re.findall(r'(?:src|href)="(/assets/[^" ]+\.(?:js|css))"',html);require(len(assets)>=2,'ASSETS_MISSING')
  css=b''.join(get(p)[1] for p in assets if p.endswith('.css'));require(b'#ff4103' in css.lower() and b'#001621' in css.lower(),'NEW_PALETTE_MISSING')
  require(sql(pgid,'SELECT count(*) FROM trainer_verification_reviewers').strip()==reviewers,'REVIEWER_ACCESS_CHANGED')
  state['stage']='COMMIT_RELEASE_METADATA'
  require(private(S/'source/deploy/compose.training-media.yml')==media_compose,'EXISTING_MEDIA_CONFIGURATION_CHANGED')
  replace_private(S/'env/production.env',encoded(prod));replace_private(S/'env/api.env',encoded(api))
  state.update(result='PASS_UPGRADED',stage='COMPLETE',app=APP,images=data['images'],containers={k:c['Id'] for k,c in now.items()},migrations=len(expected),password_min_length=6,chat_enabled=True,private_trainer_media=True,trainer_workspace=True,training_experience=True,personal_reminders_enabled=True,lesson_assignments=True,video_brand_intro=True)
  write(work/'accepted.json',json.dumps(state,sort_keys=True).encode())
 except BaseException as e:
  state['result']='FAIL'
  state['error']=str(e) if isinstance(e,Failure) else type(e).__name__
  if changed and work:
   try:
    replace_private(S/'env/production.env',private(work/'previous-production.env'));replace_private(S/'env/api.env',private(work/'previous-api.env'))
    if installed_config:remove_owned_config(installed_config,media_compose)
    compose(work/'previous-production.env',work/'rollback.compose.json',['up','-d','--no-deps','--no-build','--pull','never','backend','frontend'],timeout=180);healthy(OLD_IMAGES,pgid);state['rollback']='PREVIOUS_APPLICATION_RESTORED_ADDITIVE_SCHEMA_RETAINED'
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
