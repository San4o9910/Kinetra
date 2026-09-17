"""Read-only outage inventory. Only aggregate and allowlisted values leave the host."""
import http.client,json,os,pathlib,shutil,subprocess,sys
def run(args):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30)
 return r.returncode,r.stdout
def status(unit,operation):
 return run(['systemctl',operation,unit])[1].decode().strip()
def http(path):
 c=http.client.HTTPConnection('127.0.0.1',8080,timeout=8)
 try:
  c.request('GET',path);r=c.getresponse();r.read(1024);return r.status
 except (OSError,http.client.HTTPException):return 'unreachable'
 finally:c.close()
def main():
 assert os.geteuid()==0
 code,raw=run(['docker','ps','-aq']);assert code==0
 ids=raw.decode().split();assert len(ids)<=20
 code,raw=run(['docker','inspect',*ids]) if ids else (0,b'[]');assert code==0
 containers=json.loads(raw)
 selected={c['Config']['Labels'].get('com.docker.compose.service'):c for c in containers if c['Config']['Labels'].get('com.docker.compose.project')=='kinetra-production'}
 assert set(selected).issubset({'backend','frontend','postgres'})
 db=None
 if 'postgres' in selected and selected['postgres']['State']['Running']:
  query="SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migrations),'users',(SELECT count(*) FROM users),'reviewers',(SELECT count(*) FROM trainer_verification_reviewers),'requests',(SELECT count(*) FROM trainer_verification_requests WHERE submitted_at IS NOT NULL),'pending',(SELECT count(*) FROM trainer_verification_requests WHERE status='pending' AND submitted_at IS NOT NULL));"
  code,raw=run(['docker','exec','--user','postgres',selected['postgres']['Id'],'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','kinetra_bootstrap','-d','kinetra','-c',query])
  db=json.loads(raw) if code==0 else {'query':'failed'}
 evidence={'result':'PASS_READ_ONLY','total_containers':len(containers),'containers':{k:{'id':c['Id'],'image':c['Config']['Image'],'revision':c['Config']['Labels'].get('org.opencontainers.image.revision'),'running':c['State']['Running'],'status':c['State']['Status'],'exit_code':c['State']['ExitCode'],'oom_killed':c['State']['OOMKilled'],'started_at':c['State']['StartedAt'],'finished_at':c['State']['FinishedAt'],'restart_count':c['RestartCount'],'health':c['State'].get('Health',{}).get('Status'),'restart':c['HostConfig']['RestartPolicy']['Name']} for k,c in selected.items()},'database':db,'services':{unit:{'active':status(unit,'is-active'),'enabled':status(unit,'is-enabled')} for unit in ('docker','caddy')},'uptime_seconds':int(float(pathlib.Path('/proc/uptime').read_text().split()[0])),'free_bytes':shutil.disk_usage('/srv/kinetra-stage').free,'http':{p:http(p) for p in ('/','/health','/api/v1/me')}}
 print(json.dumps(evidence,sort_keys=True))
try:main()
except BaseException as e:
 print(json.dumps({'result':'FAIL_READ_ONLY','error':type(e).__name__}));sys.exit(1)
