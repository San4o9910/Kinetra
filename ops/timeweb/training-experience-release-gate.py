"""Authenticate immutable successful release evidence; prepare public-only host input."""
import base64,hashlib,importlib.util,io,json,os,pathlib,re,stat,urllib.error,urllib.parse,urllib.request,zipfile
APP='5be7df36f85b65c8248c221509ea3a7fec1919db';BASE='9d6dced30e194a418016c9e45e5d353e50786cb1';RUNTIME='73b665065e00a5b375e90f701373b3e0856a0386';MERGED='cd6bd3c853caaea4a262e7821776461cb691f504';CONTROL='62914709020a9143ffb141d63d116514f617aa17'
IMAGES={'backend':'ghcr.io/san4o9910/kinetra-backend@sha256:96c21c21afeee176937afcff0996b38f4dc8c8d21d24ab7fdca1330644fc5a6d','frontend':'ghcr.io/san4o9910/kinetra-frontend@sha256:b394b4e58702ea7543640f8bd828a61a9aba26470ba52097dc221a532596884d'}
CONTAINERS={'backend':'030a6cfc33a99eefff400f0742665bb013db9f3aa053ac680e57e468982453e3','frontend':'77f4e2f5cb9f4d919d4f7391b2d6ee33de9ce975f0f46074e92872fe11a89176','postgres':'a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
opener=urllib.request.build_opener(NoRedirect)
def api(path,archive=False):
 req=urllib.request.Request('https://api.github.com/repos/San4o9910/Kinetra'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
 try:r=opener.open(req,timeout=30)
 except urllib.error.HTTPError as e:
  assert archive and e.code==302
  location=e.headers['Location'];u=urllib.parse.urlsplit(location)
  assert u.scheme=='https' and not u.username and not u.password and u.port in (None,443) and u.hostname.endswith(('.blob.core.windows.net','.actions.githubusercontent.com'))
  r=opener.open(location,timeout=60)
 with r:body=r.read(64*1024*1024+1)
 assert len(body)<=64*1024*1024
 return body if archive else json.loads(body)
def success(runid,sha,path,jobs_count):
 run=api('/actions/runs/'+str(runid));assert run['repository']['full_name']=='San4o9910/Kinetra' and run['head_sha']==sha and run['path']==path and run['status']=='completed' and run['conclusion']=='success' and run['run_attempt']==1
 jobs=api('/actions/runs/'+str(runid)+'/jobs?per_page=100');assert jobs['total_count']==jobs_count
 assert all(j['conclusion']=='success' and j['status']=='completed' and all(s['conclusion']=='success' for s in j['steps']) for j in jobs['jobs'])
 return run
def main():
 assert os.environ['GITHUB_REPOSITORY']=='San4o9910/Kinetra' and os.environ['GITHUB_REF']=='refs/heads/ops/timeweb-hourly-preflight-20260909' and os.environ['GITHUB_RUN_ATTEMPT']=='1'
 pr=api('/pulls/26');assert pr['merged'] and pr['merge_commit_sha']==MERGED and pr['head']['sha']==APP
 merged=api('/commits/'+MERGED);assert [p['sha'] for p in merged['parents']]==[BASE,APP]
 assert merged['commit']['tree']==api('/commits/'+APP)['commit']['tree']
 success(35361452226,MERGED,'.github/workflows/ci.yml',3)
 success(35354608729,'eb8a37a9830a9f464d0d73e5f113a53a20baccc1','.github/workflows/kinetra-availability.yml',1)
 success(35361504599,CONTROL,'.github/workflows/kinetra-training-experience-images.yml',1)
 art=api('/actions/artifacts/10555595692');assert not art['expired'] and art['workflow_run']['id']==35361504599 and art['workflow_run']['head_sha']==CONTROL
 digest='32b3eb2e62567d1ccf11f13a07039aaf89e9a986073e2d98982cd80272f832d3';assert art['digest']=='sha256:'+digest
 raw=api('/actions/artifacts/10555595692/zip',archive=True);assert hashlib.sha256(raw).hexdigest()==digest
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  assert len(z.namelist())==len(set(z.namelist()))<=150
  def member(name):
   info=z.getinfo(name);assert not info.is_dir() and not info.flag_bits&1 and info.file_size<=16*1024*1024
   return z.read(info)
  source=json.loads(member('source-gates.json'));assert source['app_commit']==APP and source['base_commit']==BASE and source['merge_commit']=='7a4412cfc74e51743a78a274cb40e6e141270768'
  summary=json.loads(member('scan-summary.json'));assert summary['errors']==[] and summary['scanner_step_outcome']=='success' and {i['image'] for i in summary['images']}==set(IMAGES)
  assert all(i['vulnerability_count']==0 and i['secret_count']==0 for i in summary['images'])
  assert member('qualification.txt').strip()==b'KINETRA_IMAGE_SCAN_HIGH_CRITICAL=PASS'
  assert b'KINETRA_TRAINING_PHONE_VIDEO_PHOTO_RUNTIME=PASS' in member('backend-smoke.txt').splitlines()
  images=dict(line.split('=',1) for line in member('published-images.env').decode().splitlines());assert images=={k.upper()+'_IMAGE':v for k,v in IMAGES.items()}
  # Reevaluate the unchanged approved media runtime's exact source identities and expiry.
  policy=pathlib.Path(__file__).with_name('upstream-disposition.py');assert hashlib.sha256(policy.read_bytes()).hexdigest()=='ba9d7f7d4a5475de9a4401be60694bcbeab1e62308d2f304454360fc72d2267e'
  spec=importlib.util.spec_from_file_location('policy',policy);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  decision=module.evaluate(module.strict_json(member('upstream-media/production.json')),member('source-components.cdx.json'),RUNTIME)
  assert decision==module.strict_json(member('upstream-media/disposition.json')) and decision['result']=='PASS' and decision['unresolved_high_critical_findings']==0
  upstream=json.loads(member('upstream-media/summary.json'));assert upstream['result']=='PASS' and upstream['positive-control']['result']=='PASS' and upstream['production']['result']=='PASS' and upstream['unresolved_high_critical_findings']==0
  for target,image in IMAGES.items():
   manifest=member(target+'-registry-manifest.json');assert hashlib.sha256(manifest).hexdigest()==image.split('@sha256:')[1]
   meta=json.loads(member(target+'-image.json'));assert len(meta)==1 and meta[0]['Config']['Labels']['org.opencontainers.image.revision']==APP and json.loads(manifest)['config']['digest']==meta[0]['Id']
 app=pathlib.Path(os.environ['APP_CHECKOUT']);migrations={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((app/'apps/backend/migrations').glob('*.sql'))};assert len(migrations)==17
 payload={'app':APP,'images':IMAGES,'expected_containers':CONTAINERS,'migrations':migrations,'grants':base64.b64encode((app/'deploy/postgres/runtime-grants.sql').read_bytes()).decode(),'media_compose':base64.b64encode((app/'deploy/compose.training-media.yml').read_bytes()).decode(),'run':os.environ['GITHUB_RUN_ID']}
 receipt={'control':os.environ['GITHUB_SHA'],'run':os.environ['GITHUB_RUN_ID'],'payload':payload}
 path=pathlib.Path(os.environ['RUNNER_TEMP'],'kinetra-training-experience-request.json');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(receipt,f);f.flush();os.fsync(f.fileno())
 print('KINETRA_COACHING_RELEASE_GATES=PASS')
if __name__=='__main__':main()
