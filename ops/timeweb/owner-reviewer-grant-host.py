"""Grant only the owner-selected existing account; email is represented by its normalized hash.

Use the deployed audited CLI. Keep account UUID/CLI output in a private host audit;
return only sanitized status. No account creation, email, token issuance or restart.
"""
import fcntl,hashlib,json,os,pathlib,re,stat,subprocess,sys,time
APP='a61a42f2dc10749939a1044990bf2cf456e34b52'
IMAGE='ghcr.io/san4o9910/kinetra-backend@sha256:4926900d638e629fc7c2a275f92866be27b487dc901559ec7ff8fe301b42d6be'
TARGET='17e8c1c886fe95c8d6fb519c69da16fec494d3d3bf5573f558bd32ebf84c7f69'
S=pathlib.Path('/srv/kinetra-stage')
class Failure(Exception):pass
def require(condition,code):
 if not condition:raise Failure(code)
def command(args,timeout=30):
 result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout)
 require(result.returncode==0 and len(result.stdout)<=65536,'COMMAND_FAILED')
 return result.stdout
def read_private(path):
 info=path.lstat();require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600,'PRIVATE_AUDIT_INVALID');return path.read_bytes()
def write_private(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
def backend_id():
 ids=command(['docker','ps','-q','--filter','label=com.docker.compose.project=kinetra-production','--filter','label=com.docker.compose.service=backend']).decode().split()
 require(len(ids)==1,'UNIQUE_BACKEND_REQUIRED')
 data=json.loads(command(['docker','inspect',ids[0]]));require(len(data)==1,'BACKEND_INSPECTION_INVALID');c=data[0]
 require(c['Config']['Image']==IMAGE and c['Config']['Labels'].get('org.opencontainers.image.revision')==APP and c['State']['Running'] and c['State'].get('Health',{}).get('Status')=='healthy','DEPLOYED_BACKEND_MISMATCH')
 accepted=json.loads(read_private(S/'coaching-release-a61a42f2dc10-35036937433/accepted.json'))
 require(accepted['result']=='PASS_UPGRADED' and accepted['app']==APP and accepted['containers']['backend']==c['Id'],'ACCEPTED_BACKEND_IDENTITY_CHANGED')
 return c['Id']
def node(backend,code):return command(['docker','exec','--user','1000:1000','--workdir','/app',backend,'node','--input-type=module','-e',code])
def match(backend):
 code="""import {databasePool,closeDatabasePool} from './apps/backend/dist/db/pool.js';
try{const r=await databasePool.query("SELECT id, EXISTS(SELECT 1 FROM trainer_verification_reviewers r WHERE r.user_id=users.id) AS reviewer FROM users WHERE encode(sha256(convert_to(lower(email),'UTF8')),'hex')=$1",[TARGET]);console.log(JSON.stringify(r.rows));}finally{await closeDatabasePool()}
""".replace('TARGET',json.dumps(TARGET))
 rows=json.loads(node(backend,code));require(isinstance(rows,list) and len(rows)==1,'EXACT_ACCOUNT_NOT_FOUND')
 user=rows[0];require(set(user)=={'id','reviewer'} and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',user['id']) and type(user['reviewer']) is bool,'ACCOUNT_MATCH_INVALID');return user
def main():
 result={'schema':1,'result':'FAIL','stage':'IDENTITY','error':None,'grant_attempted':False,'account_matched':False,'can_review':False};lock=None
 try:
  os.umask(0o077);require(os.geteuid()==0,'ROOT_REQUIRED')
  raw=sys.stdin.buffer.read(1025);require(len(raw)<=1024,'INPUT_TOO_LARGE');request=json.loads(raw)
  require(set(request)=={'run'} and re.fullmatch(r'[1-9][0-9]{0,19}',request['run']),'RUN_INVALID')
  require(S.resolve()==S and S.is_dir() and S.stat().st_uid==0 and stat.S_IMODE(S.stat().st_mode)==0o700,'STAGE_INVALID')
  lock=open('/run/kinetra-database-stage.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  backend=backend_id();user=match(backend);result['account_matched']=True
  root=S/'owner-reviewer-audit'
  if not root.exists():root.mkdir(mode=0o700)
  require(root.resolve()==root and root.stat().st_uid==0 and stat.S_IMODE(root.stat().st_mode)==0o700,'AUDIT_DIRECTORY_INVALID')
  folder=root/request['run'];folder.mkdir(mode=0o700)
  write_private(folder/'request.json',{'run':request['run'],'target_hash':TARGET,'user_id':user['id'],'previously_reviewer':user['reviewer'],'app':APP,'backend_id':backend,'created_at':int(time.time())})
  result['stage']='GRANT'
  if not user['reviewer']:
   result['grant_attempted']=True
   output=command(['docker','exec','--user','1000:1000','--workdir','/app',backend,'node','apps/backend/dist/trainer-verification/reviewer-cli.js','grant','--user-id',user['id']])
   require(b"action: 'grant'" in output and b"status: 'success'" in output and user['id'].encode() in output,'CLI_GRANT_NOT_CONFIRMED')
   write_private(folder/'cli-audit.json',{'output':output.decode()})
  result['stage']='VERIFY'
  final=match(backend);require(final['id']==user['id'] and final['reviewer'],'PERSISTED_REVIEWER_NOT_CONFIRMED')
  code="""import {databasePool,closeDatabasePool} from './apps/backend/dist/db/pool.js';
import {PostgresTrainerVerificationRepository} from './apps/backend/dist/trainer-verification/postgres-trainer-verification.repository.js';
import {TrainerVerificationService} from './apps/backend/dist/trainer-verification/service.js';
import {SystemClock} from './apps/backend/dist/auth/service.js';
try{const service=new TrainerVerificationService(new PostgresTrainerVerificationRepository(databasePool),new SystemClock());console.log(JSON.stringify(await service.access(USER_ID)));}finally{await closeDatabasePool()}
""".replace('USER_ID',json.dumps(user['id']))
  require(json.loads(node(backend,code))=={'can_review':True},'APPLICATION_ACCESS_NOT_CONFIRMED')
  require(backend_id()==backend,'BACKEND_CHANGED_DURING_GRANT')
  result.update(result='PASS_REVIEWER_ACCESS',stage='COMPLETE',can_review=True)
  write_private(folder/'accepted.json',result)
 except BaseException as error:
  result['result']='FAIL';result['error']=str(error) if isinstance(error,Failure) else type(error).__name__
 finally:
  if lock:lock.close()
  print(json.dumps(result,sort_keys=True),flush=True)
 return 0 if result['result']=='PASS_REVIEWER_ACCESS' else 1
if __name__=='__main__':sys.exit(main())
