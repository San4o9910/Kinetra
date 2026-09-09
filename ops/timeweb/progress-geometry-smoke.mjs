import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = process.env.KINETRA_REPO_ROOT ?? process.cwd();
const expectedCommit = 'b222c6dc4358c879a5df0b8b8160d0647cd63697';
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  expectedCommit,
);
const { default: React } = await import(pathToFileURL(`${root}/node_modules/react/index.js`));
const { renderToStaticMarkup } = await import(
  pathToFileURL(`${root}/node_modules/react-dom/server.node.js`)
);
const { ProgressView } = await import(
  pathToFileURL(`${root}/apps/frontend/src/features/progress/ProgressView.tsx`)
);
const src = await readFile(`${root}/scripts/test-frontend-browser.mjs`, 'utf8');
const fixtureStart = src.indexOf('let progressGoal =');
const fixtureEnd = src.indexOf('\n});', src.indexOf('const progressPayload =', fixtureStart)) + 4;
assert.ok(
  fixtureStart >= 0 && fixtureEnd > fixtureStart,
  'Exact browser fixture boundaries missing.',
);
const fixture = vm.runInNewContext(src.slice(fixtureStart, fixtureEnd) + '\nprogressPayload()');
let css = await readFile(`${root}/apps/frontend/src/styles.css`, 'utf8');
const markup = renderToStaticMarkup(
  React.createElement(ProgressView, {
    response: fixture,
    timezone: 'UTC',
    selectedMetric: 'energy',
    onMetricChange() {},
    onEditGoal() {},
    onOpenWeeklyMetrics() {},
  }),
);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div class="active-app-shell"><header class="active-app-header">KINETRA</header><div class="active-app-content">${markup}</div></div></body></html>`;
const profile = await mkdtemp('/tmp/kinetra-geometry-');
const chrome = spawn(
  process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-gpu',
    '--no-first-run',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
let stderr = '';
chrome.stderr.on('data', (c) => (stderr += c));
let next = 0,
  session,
  buffer = '';
const pending = new Map();
for (const stream of [chrome.stdio[3], chrome.stdio[4]])
  stream.on('error', (error) => {
    console.error(stderr);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
chrome.stdio[4].on('data', (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf('\0')) >= 0) {
    const s = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!s) continue;
    const m = JSON.parse(s),
      p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  }
});
chrome.on('exit', () => {
  for (const p of pending.values()) p.reject(Error(stderr));
  pending.clear();
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(Error(`CDP timeout: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    chrome.stdio[3].write(
      JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0',
    );
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const waitForChromeExit = () => {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      chrome.off('exit', onExit);
      resolve(false);
    }, 5000);
    chrome.once('exit', onExit);
  });
};
try {
  const target = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  assert.ok(target, 'Chrome page target missing.');
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
    .sessionId;
  await send('Page.enable');
  for (const width of [320, 428]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 820,
      screenWidth: width,
      screenHeight: 820,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const { frameTree } = await send('Page.getFrameTree');
    await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    const observations =
      await evaluate(`(()=>{const controls=[...document.querySelectorAll('[data-testid="progress-edit-goal"],[data-testid="progress-weekly-open"],.progress-metric-switch button')];
   if(controls.length!==6)throw Error('Expected six real progress controls.');
   const animations=document.getAnimations();animations.forEach(a=>a.pause());
   const minima=Object.fromEntries(controls.map(c=>[c.dataset.testid,{width:Infinity,height:Infinity}]));
   let belowThresholdCount=0;const firstFailures={};
   for(let ms=0;ms<=500;ms+=0.5){
    animations.forEach(a=>a.currentTime=ms);
    for(const scroll of ['bottom','top']){
     window.scrollTo({top:scroll==='bottom'?document.documentElement.scrollHeight:0,behavior:'auto'});
     for(const c of controls){const r=c.getBoundingClientRect();const minimum=minima[c.dataset.testid];minimum.width=Math.min(minimum.width,r.width);minimum.height=Math.min(minimum.height,r.height);if(r.height<44||r.width<44){belowThresholdCount++;firstFailures[c.dataset.testid]??={ms,scroll,id:c.dataset.testid,width:r.width,height:r.height,top:r.top,bottom:r.bottom,offsetHeight:c.offsetHeight,transform:getComputedStyle(c.closest('.progress-section')).transform};}}
    }
   }
   return {width:innerWidth,animationCount:animations.length,timeline:{startMs:0,endMs:500,stepMs:0.5},belowThresholdCount,firstFailures:Object.values(firstFailures),minima,scrollWidth:document.documentElement.scrollWidth};})()`);
    console.log(
      'KINETRA_PROGRESS_GEOMETRY_OBSERVATION=' +
        JSON.stringify({ commit: expectedCommit, ...observations }),
    );
  }
} finally {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    // Browser.close flushes profile writers; pipe closure can race its acknowledgement.
    await send('Browser.close').catch(() => undefined);
    if (!(await waitForChromeExit())) {
      chrome.kill('SIGTERM');
      if (!(await waitForChromeExit())) {
        chrome.kill('SIGKILL');
        assert.ok(await waitForChromeExit(), 'Chrome did not exit during diagnostic cleanup.');
      }
    }
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
