#!/usr/bin/env node
// Anonymous acceptance on the approved existing host. No form interaction.
// The sole POST is the app's empty, cookie-free refresh bootstrap: deployed
// auth/router.ts at 73b6650 returns 401 before service/repository invocation.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
const ORIGIN='https://80.68.156.131', output=process.env.ACCEPTANCE_OUTPUT;
assert(output && output.startsWith('/'));
assert(typeof WebSocket==='function', 'NODE_WITH_NATIVE_WEBSOCKET_REQUIRED');
const report={schema:1,origin:ORIGIN,run:process.env.GITHUB_RUN_ID,checks:[],viewports:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{process.stderr.write('EXTERNAL_ACCEPTANCE_TIMEOUT\n');process.exit(1);},180000);
const get=url=>new Promise((resolve,reject)=>{
  const transport=url.startsWith('https:')?https:http;
  const req=transport.get(url,{timeout:15000,headers:{Accept:'*/*'}},res=>{
    let bytes=0;const chunks=[];
    const certificate=url.startsWith('https:')?res.socket.getPeerCertificate():null;
    const authorized=url.startsWith('https:')?res.socket.authorized:null;
    res.on('data',chunk=>{bytes+=chunk.length;if(bytes>2097152)res.destroy(new Error('RESPONSE_LIMIT'));else chunks.push(chunk);});
    res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),certificate,authorized}));
  });
  req.on('timeout',()=>req.destroy(new Error('GET_TIMEOUT')));
  req.on('error',reject);
});
let chrome,profile,ws;
try{
  await mkdir(output,{recursive:true});
  const shell=await get(ORIGIN+'/');
  assert.equal(shell.status,200);assert.equal(shell.authorized,true);
  assert(shell.certificate.subjectaltname.split(', ').includes('IP Address:80.68.156.131'));
  assert(!shell.headers['set-cookie']);assert.match(shell.headers['content-type'],/text\/html/);
  report.certificate={trusted:true,fingerprint:shell.certificate.fingerprint256,validTo:shell.certificate.valid_to};
  report.checks.push('trusted_ip_certificate','https_shell');
  for(const [path,status] of [['/health',200],['/ready',404],['/api/v1/me',401]]){
    const result=await get(ORIGIN+path);assert.equal(result.status,status);assert(!result.headers['set-cookie']);
    if(path==='/health')assert.equal(JSON.parse(result.body).status,'ok');
    if(path==='/api/v1/me')assert.match(result.headers['cache-control']??'',/no-store/);
    report.checks.push(path+':'+status);
  }
  const redirect=await get('http://80.68.156.131/');
  assert.equal(redirect.status,308);assert.equal(redirect.headers.location,ORIGIN+'/');
  report.checks.push('http_redirect_308');
  profile=await mkdtemp(join(tmpdir(),'kinetra-anonymous-'));
  chrome=spawn(process.env.CHROME_BIN,['--headless=new','--disable-gpu','--no-first-run',
    '--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',
    '--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const debuggerUrl=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('CHROME_START_TIMEOUT')),15000);
    chrome.once('error',reject);chrome.once('exit',()=>reject(new Error('CHROME_EARLY_EXIT')));
    chrome.stderr.on('data',part=>{text=(text+part.toString()).slice(-8192);const match=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  ws=new WebSocket(debuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let sequence=0,session,refreshCount=0;
  const pending=new Map(),responses=[],failures=[],runtimeErrors=[],blocked=[],eventErrors=[],refreshIds=new Set(),finished=new Set();
  function send(method,params={},target=session){
    return new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP_TIMEOUT_'+method));},15000);
      pending.set(id,{resolve,reject,timer});
      ws.send(JSON.stringify({id,method,params,...(target?{sessionId:target}:{})}));
    });
  }
  async function event(msg){
    const p=msg.params;
    if(msg.method==='Fetch.requestPaused'){
      const request=p.request,url=new URL(request.url),headers=Object.keys(request.headers).map(x=>x.toLowerCase());
      const anonymous=!headers.includes('cookie')&&!headers.includes('authorization');
      const readOnly=['GET','HEAD'].includes(request.method)&&url.origin===ORIGIN&&anonymous;
      const bootstrap=request.method==='POST'&&url.href===ORIGIN+'/api/v1/auth/refresh'&&anonymous&&request.postData==='{}'&&refreshCount<2;
      if(bootstrap){refreshCount++;if(p.networkId)refreshIds.add(p.networkId);}
      if(readOnly||bootstrap)await send('Fetch.continueRequest',{requestId:p.requestId});
      else{blocked.push(request.method+' '+url.origin+url.pathname);await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});}
    }else if(msg.method==='Network.responseReceived')responses.push({id:p.requestId,url:p.response.url,status:p.response.status});
    else if(msg.method==='Network.loadingFinished')finished.add(p.requestId);
    else if(msg.method==='Network.loadingFailed')failures.push(p.errorText);
    else if(msg.method==='Runtime.exceptionThrown')runtimeErrors.push(p.exceptionDetails.text);
  }
  ws.addEventListener('message',msg=>{
    const value=JSON.parse(msg.data);
    if(value.id){const entry=pending.get(value.id);if(entry){clearTimeout(entry.timer);pending.delete(value.id);value.error?entry.reject(new Error('CDP_'+value.error.message)):entry.resolve(value.result);}}
    else if(value.sessionId===session)event(value).catch(error=>eventErrors.push(error.message));
  });
  const target=await send('Target.createTarget',{url:'about:blank'},null);
  session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const nav=await send('Page.navigate',{url:ORIGIN+'/'});
  assert(!nav.errorText,nav.errorText);
  async function evaluate(expression){
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    assert(!result.exceptionDetails,'BROWSER_EVALUATION_FAILED');return result.result.value;
  }
  let loaded=false;
  for(let n=0;n<100;n++){
    loaded=await evaluate("Boolean(document.querySelector('[data-testid=\"login-screen\"]'))");
    if(loaded)break;await pause(200);
  }
  assert(loaded,'LOGIN_SCREEN_NOT_RENDERED');
  for(const [name,width,height,mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await pause(250);
    const view=await evaluate(`(()=>{
      const id=document.querySelector('[data-testid="login-identifier"]'),password=document.querySelector('[data-testid="login-password"]'),submit=document.querySelector('[data-testid="login-submit"]');
      const bounds=element=>{const r=element?.getBoundingClientRect();return Boolean(r&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1);};
      return {heading:document.querySelector('h1')?.textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        controlsVisible:[id,password,submit].every(bounds),empty:id?.value===''&&password?.value==='',submitDisabled:submit?.disabled,
        cookies:document.cookie,secure:window.isSecureContext};
    })()`);
    assert.equal(view.heading,'Войдите в аккаунт');assert.equal(view.width,width);
    assert(view.scrollWidth<=width+1,'HORIZONTAL_OVERFLOW');assert(view.controlsVisible&&view.empty&&view.submitDisabled&&view.secure);
    assert.equal(view.cookies,'');
    report.viewports.push({name,width,height,loginRendered:true,noHorizontalOverflow:true,emptySubmitDisabled:true});
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'));
  }
  for(let n=0;n<25&&[...refreshIds].some(id=>!finished.has(id));n++)await pause(100);
  assert(refreshCount>=1&&refreshCount<=2);assert.equal(refreshIds.size,refreshCount);
  for(const id of refreshIds){
    assert.equal(responses.find(x=>x.id===id)?.status,401);
    const body=await send('Network.getResponseBody',{requestId:id});
    const raw=body.base64Encoded?Buffer.from(body.body,'base64').toString():body.body;
    assert(raw.includes('REFRESH_TOKEN_REQUIRED'),'ANONYMOUS_REFRESH_BOUNDARY_CHANGED');
  }
  const assets=responses.filter(x=>new URL(x.url).pathname.startsWith('/assets/'));
  assert(assets.some(x=>x.url.endsWith('.js')&&x.status===200));assert(assets.some(x=>x.url.endsWith('.css')&&x.status===200));
  assert.deepEqual(blocked,[]);assert.deepEqual(failures,[]);assert.deepEqual(runtimeErrors,[]);assert.deepEqual(eventErrors,[]);
  report.checks.push('real_javascript_css_loaded','anonymous_refresh_401_before_service','no_uncaught_browser_exceptions');
  report.result='PASS_ANONYMOUS_EXTERNAL_ONLY';
  await writeFile(join(output,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
  console.log('KINETRA_EXTERNAL_ACCEPTANCE='+JSON.stringify(report));
}finally{
  clearTimeout(deadline);if(ws)ws.close();
  if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),pause(5000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL');}
  if(profile)await rm(profile,{recursive:true,force:true});
}
