import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h2 id="heading" tabindex="-1">Workout</h2><button id="back">Back</button><input aria-label="Weight"><script>window.trace=[];for(const t of ["keydown","keyup","focusin","focusout","mousedown","mouseup"])document.addEventListener(t,e=>trace.push({type:e.type,key:e.key,target:e.target.id}),true)</script>')});
await new Promise(r=>server.listen(5173,'127.0.0.1',r));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
console.log(execFileSync(process.env.CHROME_BIN,['--version'],{encoding:'utf8'}).trim());
for(const detached of [false,true]){
 const dir=await mkdtemp(join(tmpdir(),'kinetra-input-diagnostic-'));
 const chrome=spawn(process.env.CHROME_BIN,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-gpu','--no-proxy-server','--disable-features=LocalNetworkAccessChecks','--disable-default-apps','--disable-extensions','--disable-sync','--no-first-run','--mute-audio','--remote-debugging-pipe','--user-data-dir='+dir,'http://127.0.0.1:5173/login'],{detached,stdio:['ignore','ignore','ignore','pipe','pipe']});
 let seq=0,session,buffer='';const pending=new Map();
 chrome.stdio[4].on('data',b=>{buffer+=b.toString();let i;while((i=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!raw)continue;const m=JSON.parse(raw),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});chrome.stdio[3].write(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})})+'\0')});
 const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result.value;
 try{
 let target;for(let i=0;i<100&&!target;i++){target=(await send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1'));if(!target)await pause(100);}
 session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
 await send('Runtime.enable');await send('Page.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,screenWidth:1280,screenHeight:900,deviceScaleFactor:1,mobile:false});
 await pause(250);
 for(const mode of ['default','activate','focus-emulation','native-pointer']){
  if(mode==='activate'){await send('Target.activateTarget',{targetId:target.targetId});await send('Page.bringToFront');}
  if(mode==='focus-emulation')await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(mode==='native-pointer')for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:30,y:20,button:'left',clickCount:1});
  await evaluate('trace=[];document.querySelector("h2").focus()');
  for(const type of ['rawKeyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await pause(100);
  console.log(JSON.stringify({detached,mode,bounds:await send('Browser.getWindowForTarget'),page:await evaluate('({focused:document.hasFocus(),active:document.activeElement.outerHTML,trace})')}));
 }
 }finally{try{await send('Browser.close')}catch{}await pause(500);if(chrome.exitCode===null)chrome.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
}
server.close();
