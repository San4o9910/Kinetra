"""Restore the existing release after reboot, and persist boot policies. No replacement or migration."""
import fcntl,hashlib,http.client,json,os,pathlib,stat,subprocess,sys,time
S=pathlib.Path('/srv/kinetra-stage')
IDS={'backend':'ba061ee45c22787f53a1579cd786aec408c642713520917e39222d6e4240b5e6','frontend':'198dd35a1df80833b2abacd5de037eee3d41053b32231668268ffade12985e21','postgres':'a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1'}
IMAGES={'backend':'ghcr.io/san4o9910/kinetra-backend@sha256:4926900d638e629fc7c2a275f92866be27b487dc901559ec7ff8fe301b42d6be','frontend':'ghcr.io/san4o9910/kinetra-frontend@sha256:efd7d884c7aa5500f2571c23049491d289591572100ad76f9cac1f911d41206b','postgres':'postgres:17-bookworm@sha256:7bade6d532592ca8ce7ee32def7399dad2607c4ea5583839fc4352a095a11ea6'}
def command(args,timeout=30):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout)
 if r.returncode:raise RuntimeError('COMMAND_FAILED:'+pathlib.Path(args[0]).name+':'+str(r.returncode))
 return r.stdout
def inventory():
 raw=json.loads(command(['docker','inspect',*IDS.values()]))
 selected={(c['Config'].get('Labels') or {}).get('com.docker.compose.service'):c for c in raw}
 assert set(selected)==set(IDS)
 for k,c in selected.items():
  assert c['Id']==IDS[k] and c['Config']['Image']==IMAGES[k]
  assert c['Config']['Labels']['com.docker.compose.project']=='kinetra-production'
 return selected
def write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def main():
 state={'result':'FAIL','stage':'PREFLIGHT','actions':[]};audit=None;lock=None
 try:
  assert os.geteuid()==0;os.umask(0o077)
  lock=open('/run/kinetra-database-stage.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  current=inventory();assert current['backend']['State']['Running'] and current['frontend']['State']['Running']
  assert not current['postgres']['State']['Running'] and current['postgres']['HostConfig']['RestartPolicy']['Name']=='no'
  assert subprocess.run(['systemctl','is-active','--quiet','caddy']).returncode==3
  assert command(['systemctl','is-enabled','docker']).strip()==b'enabled'
  config=pathlib.Path('/etc/caddy/Caddyfile');assert hashlib.sha256(config.read_bytes()).hexdigest()=='c06f2a92c3daaf28c1f0db737c2389447c9f33604615bb599d082df114c9372d'
  command(['/usr/bin/unshare','--net','--','/usr/sbin/runuser','-u','caddy','--','/usr/bin/env','-i','PATH=/usr/sbin:/usr/bin:/sbin:/bin','XDG_DATA_HOME=/var/lib/caddy/data','XDG_CONFIG_HOME=/var/lib/caddy/config','PUBLIC_IPV4=80.68.156.131','/usr/local/bin/caddy','validate','--config',str(config),'--adapter','caddyfile'])
  compose=S/'source/deploy/compose.single-server.yml';info=compose.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==0
  old=compose.read_bytes();assert hashlib.sha256(old).hexdigest()=='de3df2717c7484c4c486eef2e38c1250597db070fbb6cccaa39dcc8c1c40f885'
  assert old.count(b"    restart: 'no'")==1
  audit=S/'availability-repair-20260917';audit.mkdir(mode=0o700)
  write(audit/'previous-compose.single-server.yml',old)
  state['stage']='RESTORE_DATABASE'
  command(['docker','update','--restart','unless-stopped',IDS['postgres']]);state['actions'].append('postgres_restart_policy_enabled')
  command(['docker','start',IDS['postgres']]);state['actions'].append('existing_postgres_started')
  deadline=time.monotonic()+100
  while True:
   current=inventory()
   if all(current[k]['State'].get('Health',{}).get('Status')=='healthy' for k in ('postgres','backend')):break
   if time.monotonic()>deadline:raise RuntimeError('DATABASE_OR_BACKEND_NOT_READY')
   time.sleep(3)
  sql="SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migrations),'users',(SELECT count(*) FROM users),'reviewers',(SELECT count(*) FROM trainer_verification_reviewers));"
  db=json.loads(command(['docker','exec','--user','postgres',IDS['postgres'],'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','kinetra_bootstrap','-d','kinetra','-c',sql]));assert db['migrations']==15 and db['reviewers']>=1
  state['database']=db
  replacement=compose.with_name('compose.single-server.availability.tmp');write(replacement,old.replace(b"    restart: 'no'",b'    restart: unless-stopped'));os.chmod(replacement,stat.S_IMODE(info.st_mode));os.replace(replacement,compose)
  state['actions'].append('compose_postgres_restart_policy_persisted')
  state['stage']='RESTORE_HTTPS'
  command(['systemctl','enable','--now','caddy'],timeout=45);state['actions'].append('caddy_started_and_enabled')
  assert command(['systemctl','is-enabled','caddy']).strip()==b'enabled'
  assert command(['systemctl','is-active','caddy']).strip()==b'active'
  current=inventory();assert all(c['State']['Running'] for c in current.values())
  assert current['postgres']['HostConfig']['RestartPolicy']['Name']=='unless-stopped'
  state.update(result='PASS_AVAILABILITY_RESTORED',stage='COMPLETE',containers=IDS,caddy_enabled=True,postgres_restart='unless-stopped')
 except BaseException as e:
  state['error']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
 finally:
  if audit:write(audit/'result.json',json.dumps(state,sort_keys=True).encode())
  if lock:lock.close()
  print(json.dumps(state,sort_keys=True),flush=True)
 return 0 if state['result']=='PASS_AVAILABILITY_RESTORED' else 1
if __name__=='__main__':sys.exit(main())
