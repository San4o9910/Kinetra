"""Read-only inventory for the already authorized coaching update; no credentials emitted."""
import json,os,pathlib,re,shutil,stat,subprocess,sys
S=pathlib.Path('/srv/kinetra-stage')
def cmd(args,inp=None):
 r=subprocess.run(args,input=inp,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30,check=True)
 return r.stdout
def read(path):
 info=path.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o077
 return path.read_bytes()
def main():
 assert os.geteuid()==0
 ids=cmd(['docker','ps','-aq']).decode().split()
 assert len(ids)==3
 containers=json.loads(cmd(['docker','inspect',*ids]))
 selected={c['Config']['Labels'].get('com.docker.compose.service'):c for c in containers}
 assert set(selected)=={'backend','frontend','postgres'}
 assert all(c['Config']['Labels'].get('com.docker.compose.project')=='kinetra-production' and c['State']['Running'] for c in containers)
 pg=selected['postgres']['Id']
 sql="SELECT json_build_object('ledger',(SELECT json_agg(t) FROM (SELECT filename,checksum FROM schema_migrations ORDER BY filename)t),'database_bytes',pg_database_size(current_database()),'users',(SELECT count(*) FROM users),'reviewers',(SELECT count(*) FROM trainer_verification_reviewers));"
 raw=cmd(['docker','exec','--user','postgres',pg,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','kinetra_bootstrap','-d','kinetra','-c',sql])
 db=json.loads(raw)
 values={}
 for line in read(S/'env/api.env').decode().splitlines():
  if line and not line.startswith('#'):
   k,v=line.split('=',1);values[k]=v
 flags={k:values.get(k,'unset') for k in ('AUTH_PASSWORD_MIN_LENGTH','CHAT_ENABLED','CHAT_PHOTO_UPLOADS_ENABLED','TRAINER_VIDEO_UPLOADS_ENABLED','PAYMENTS_ENABLED','AUTH_EMAIL_VERIFICATION_REQUIRED')}
 assert all(re.fullmatch(r'[A-Za-z0-9_-]{1,16}',v) for v in flags.values())
 evidence={'schema':1,'result':'PASS_READ_ONLY','containers':{k:{'id':c['Id'],'image':c['Config']['Image'],'image_id':c['Image'],'revision':c['Config']['Labels'].get('org.opencontainers.image.revision'),'health':c['State'].get('Health',{}).get('Status'),'restart':c['HostConfig']['RestartPolicy']['Name']} for k,c in selected.items()},'database':db,'flags':flags,'ai_configured':bool(values.get('KINETRA_AI_API_KEY') and values.get('KINETRA_AI_MODEL')),'free_bytes':shutil.disk_usage(S).free,'caddy_active':cmd(['systemctl','is-active','caddy']).decode().strip()=='active'}
 print(json.dumps(evidence,sort_keys=True))
try:main()
except BaseException as e:
 print(json.dumps({'result':'FAIL_READ_ONLY','error':type(e).__name__}));sys.exit(1)
