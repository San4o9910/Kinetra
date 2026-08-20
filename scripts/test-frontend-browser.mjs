import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = path.join(root, 'apps/frontend/dist');
const apiPort = 3000;
const browserApiOrigin = `http://127.0.0.1:${apiPort}`;
const frontendOrigin = browserApiOrigin;
const chromeShutdownTimeoutMs = 5_000;
const profileCleanupAttempts = 3;
const profileCleanupDelayMs = 500;

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const runCommand = async (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} was terminated by ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}.`);
  }
};

const buildFrontendForBrowserTest = async () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  await runCommand(npmCommand, ['run', 'build', '-w', '@kinetra/shared']);
  await runCommand(npmCommand, ['run', 'build', '-w', '@kinetra/frontend'], {
    env: {
      ...process.env,
      VITE_API_URL: browserApiOrigin,
    },
  });

  const assetDirectory = path.join(frontendDist, 'assets');
  const builtAssets = await readdir(assetDirectory);
  const javascriptAsset = builtAssets.find((fileName) => fileName.endsWith('.js'));
  assert.notEqual(javascriptAsset, undefined, 'Vite did not produce a JavaScript asset.');
  const javascript = await readFile(path.join(assetDirectory, javascriptAsset), 'utf8');
  assert.ok(
    javascript.includes(browserApiOrigin),
    `Browser build does not contain the expected API origin ${browserApiOrigin}.`,
  );
  console.log(`KINETRA_BROWSER_API_ORIGIN=${browserApiOrigin}`);
};

const counters = {
  login: 0,
  refresh: 0,
  meUnauthorized: 0,
  surveySave: 0,
  onboardingComplete: 0,
  logout: 0,
};

let surveyVersion = 0;
let rejectNextRefresh = false;
let profile = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'browser-test@example.com',
    phone: null,
    emailVerified: true,
    avatarUrl: null,
    username: 'browser-test',
    firstName: 'Тест',
    onboardingStatus: 'survey_pending',
    notificationEnabled: true,
    level: 'beginner',
    timezone: 'Europe/Moscow',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  survey: null,
  subscription: {
    provider: null,
    status: 'none',
    isActive: false,
    startsAt: null,
    expiresAt: null,
    amountMinor: null,
    currency: null,
  },
};

const json = (response, status, body, extraHeaders = {}) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const hasRefreshCookie = (request) =>
  String(request.headers.cookie ?? '').includes('kinetra_refresh=');

const hasValidAccessToken = (request) =>
  String(request.headers.authorization ?? '').startsWith('Bearer access-refresh-');

const createMockApiServer = () =>
  createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', frontendOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');

    console.log(
      `KINETRA_BROWSER_API_REQUEST=${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} ` +
        `origin=${String(request.headers.origin ?? 'none')}`,
    );

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/browser-test-health') {
      json(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/auth/login') {
      const body = await readJsonBody(request);
      assert.equal(body.identifier, 'browser-test@example.com');
      assert.equal(body.password, 'correct-password');
      counters.login += 1;
      json(
        response,
        200,
        {
          user: {
            id: profile.user.id,
            email: profile.user.email,
            phone: null,
            emailVerified: true,
            createdAt: profile.user.createdAt,
          },
          accessToken: 'access-login-expired-for-retry-test',
          tokenType: 'Bearer',
          expiresIn: 900,
        },
        {
          'Set-Cookie':
            'kinetra_refresh=refresh-session-1; HttpOnly; Path=/api/v1/auth; SameSite=Lax',
        },
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/auth/refresh') {
      if (!hasRefreshCookie(request)) {
        json(response, 401, {
          error: { code: 'REFRESH_TOKEN_REQUIRED', message: 'Refresh session is required.' },
        });
        return;
      }

      counters.refresh += 1;

      if (rejectNextRefresh) {
        rejectNextRefresh = false;
        json(response, 401, {
          error: { code: 'REFRESH_TOKEN_REVOKED', message: 'Refresh session has expired.' },
        });
        return;
      }

      json(
        response,
        200,
        {
          user: {
            id: profile.user.id,
            email: profile.user.email,
            phone: null,
            emailVerified: true,
            createdAt: profile.user.createdAt,
          },
          accessToken: `access-refresh-${counters.refresh}`,
          tokenType: 'Bearer',
          expiresIn: 900,
        },
        {
          'Set-Cookie': `kinetra_refresh=refresh-session-${counters.refresh + 1}; HttpOnly; Path=/api/v1/auth; SameSite=Lax`,
        },
      );
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/auth/logout') {
      counters.logout += 1;
      response.writeHead(204, {
        'Set-Cookie': 'kinetra_refresh=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/me') {
      if (!hasValidAccessToken(request)) {
        counters.meUnauthorized += 1;
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      json(response, 200, profile);
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/me/survey') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body.injuries, ['knees', 'other']);
      assert.equal(body.injuries_detail, 'Старая травма голеностопа');
      counters.surveySave += 1;
      surveyVersion += 1;
      profile = {
        ...profile,
        user: {
          ...profile.user,
          onboardingStatus: 'onboarding_pending',
          updatedAt: new Date().toISOString(),
        },
        survey: {
          id: `00000000-0000-4000-8000-00000000000${surveyVersion + 1}`,
          version: surveyVersion,
          gender: body.gender,
          age_range: body.age_range,
          goal: body.goal,
          injuries: body.injuries,
          injuries_detail: body.injuries_detail ?? null,
          experience: body.experience,
          is_current: true,
          created_at: new Date().toISOString(),
        },
      };
      json(response, 200, profile);
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/me/onboarding-complete') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.onboardingComplete += 1;

      if (counters.onboardingComplete === 1) {
        rejectNextRefresh = true;
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      if (counters.onboardingComplete === 2) {
        json(response, 503, {
          error: {
            code: 'ONBOARDING_TEMPORARILY_UNAVAILABLE',
            message: 'Не удалось завершить онбординг. Попробуйте ещё раз.',
          },
        });
        return;
      }

      if (profile.user.onboardingStatus === 'onboarding_pending') {
        profile = {
          ...profile,
          user: {
            ...profile.user,
            onboardingStatus: 'base_lessons',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      json(response, 200, profile);
      return;
    }

    if ((request.url ?? '').startsWith('/api/')) {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return;
    }

    const pathname = new URL(request.url ?? '/', frontendOrigin).pathname;
    const requested = pathname === '/' ? '/index.html' : pathname;
    let filePath = path.join(frontendDist, requested);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        filePath = path.join(frontendDist, 'index.html');
      }
    } catch {
      filePath = path.join(frontendDist, 'index.html');
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  });

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
]);

const listen = async (server, port) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
};

const close = async (server) => {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const freePort = async () => {
  const server = net.createServer();
  await listen(server, 0);
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const port = address.port;
  await close(server);
  return port;
};

const findChrome = () => {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));

  if (chrome === undefined) {
    throw new Error('Chrome/Chromium was not found for the frontend browser test.');
  }

  return chrome;
};

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') {
        return;
      }

      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? 'CDP command failed.'));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
    }

    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const waitFor = async (label, predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  throw new Error(`Timed out waiting for ${label}.${lastError ? ` ${lastError}` : ''}`);
};

const selector = (testId) => `[data-testid=${JSON.stringify(testId)}]`;

const waitForProcessExit = async (child, timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
};

const terminateChrome = async (chrome) => {
  if (chrome === null || chrome.exitCode !== null || chrome.signalCode !== null) {
    return;
  }

  const gracefulExit = waitForProcessExit(chrome, chromeShutdownTimeoutMs);
  chrome.kill('SIGTERM');

  if (await gracefulExit) {
    return;
  }

  console.warn('Chrome did not exit after SIGTERM; sending SIGKILL.');
  const forcedExit = waitForProcessExit(chrome, chromeShutdownTimeoutMs);
  chrome.kill('SIGKILL');

  if (!(await forcedExit)) {
    throw new Error('Chrome did not exit after SIGKILL.');
  }
};

const removeProfileDirectory = async (profileDirectory) => {
  let lastError = null;

  for (let attempt = 1; attempt <= profileCleanupAttempts; attempt += 1) {
    try {
      await rm(profileDirectory, { recursive: true, force: true });
      assert.equal(
        existsSync(profileDirectory),
        false,
        `Chrome profile directory still exists after cleanup: ${profileDirectory}`,
      );
      console.log(`KINETRA_BROWSER_PROFILE_CLEANUP=PASS path=${profileDirectory}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < profileCleanupAttempts) {
        console.warn(
          `Chrome profile cleanup attempt ${attempt} failed; retrying in ${profileCleanupDelayMs}ms.`,
        );
        await sleep(profileCleanupDelayMs);
      }
    }
  }

  throw lastError ?? new Error(`Could not remove Chrome profile directory: ${profileDirectory}`);
};

const assertNoBrowserProfileDirectories = async () => {
  const leftovers = (await readdir(os.tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('kinetra-browser-'))
    .map((entry) => path.join(os.tmpdir(), entry.name));

  assert.deepEqual(
    leftovers,
    [],
    `Browser profile directories remain after cleanup: ${leftovers.join(', ')}`,
  );
  console.log('KINETRA_BROWSER_TMP_CLEANUP=PASS');
};

const runBrowserScenario = async () => {
  const apiServer = createMockApiServer();
  const debugPort = await freePort();
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-'));
  let chrome = null;
  let cdp = null;
  let chromeErrors = '';

  try {
    await listen(apiServer, apiPort);

    const apiHealthResponse = await fetch(`${browserApiOrigin}/browser-test-health`);
    assert.equal(
      apiHealthResponse.status,
      200,
      'Mock API health check failed before Chrome launch.',
    );
    assert.deepEqual(await apiHealthResponse.json(), { status: 'ok' });
    console.log('KINETRA_BROWSER_MOCK_API=PASS');

    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-gpu',
        '--no-proxy-server',
        '--disable-features=LocalNetworkAccessChecks',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDirectory}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    chrome.stderr.on('data', (chunk) => {
      chromeErrors += chunk.toString();
    });

    let target = null;
    await waitFor('Chrome DevTools target', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets = await response.json();
        target = targets.find((item) => item.type === 'page') ?? null;
        return target?.webSocketDebuggerUrl !== undefined;
      } catch {
        return false;
      }
    });

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', {
      urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'],
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      screenWidth: 390,
      screenHeight: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `${frontendOrigin}/login` });

    const exists = (testId) =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))}) !== null`);
    const pathname = () => cdp.evaluate('window.location.pathname');
    const text = (testId) =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector(testId))})?.textContent?.trim() ?? null`,
      );
    const disabled = (testId) =>
      cdp.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(selector(testId))})?.disabled)`,
      );
    const attribute = (testId, name) =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector(testId))})?.getAttribute(${JSON.stringify(name)}) ?? null`,
      );
    const value = (testId) =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))})?.value ?? null`);
    const click = (testId) =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))})?.click()`);
    const doubleClick = (testId) =>
      cdp.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector(testId))});
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('Button not found: ${testId}');
        }
        button.click();
        button.click();
      })()`);
    const pressOnboardingKey = (key) =>
      cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector('onboarding-viewport'))});
        if (!(element instanceof HTMLElement)) {
          throw new Error('Onboarding keyboard viewport was not found.');
        }
        element.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: ${JSON.stringify(key)},
        }));
      })()`);
    const swipeOnboarding = async ({ fromX, fromY, toX, toY, pointerType = 'touch' }) => {
      const rect = await cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector('onboarding-viewport'))});
        if (!(element instanceof HTMLElement)) {
          throw new Error('Onboarding swipe viewport was not found.');
        }
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
      })()`);
      const x = (offset) => rect.left + Math.max(2, Math.min(offset, rect.width - 2));
      const y = (offset) => rect.top + Math.max(2, Math.min(offset, rect.height - 2));
      const start = { x: x(fromX), y: y(fromY) };
      const middle = { x: x((fromX + toX) / 2), y: y((fromY + toY) / 2) };
      const end = { x: x(toX), y: y(toY) };

      if (pointerType === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...start,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...middle,
          button: 'left',
          buttons: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...end,
          button: 'left',
          buttons: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...end,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        return;
      }

      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ ...start, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...middle, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...end, id: 1 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    };
    const assertOnboardingLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const metrics = await cdp.evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify('.onboarding-card')});
        const targets = [
          ...document.querySelectorAll(${JSON.stringify(
            '.onboarding-dot, .onboarding-settings, .onboarding-next, .onboarding-back, .onboarding-complete',
          )}),
        ];
        const cardRect = card?.getBoundingClientRect();
        const targetSizes = targets.map((target) => {
          const rect = target.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          cardLeft: cardRect?.left ?? -1,
          cardRight: cardRect?.right ?? window.innerWidth + 1,
          targetSizes,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Horizontal overflow at ${width}px.`);
      assert.ok(
        metrics.cardLeft >= 0 && metrics.cardRight <= width,
        `Card overflow at ${width}px.`,
      );
      assert.ok(metrics.targetSizes.length >= 8, `Touch targets missing at ${width}px.`);
      assert.ok(
        metrics.targetSizes.every(
          ({ width: targetWidth, height }) => targetWidth >= 44 && height >= 44,
        ),
        `Touch target below 44px at ${width}px: ${JSON.stringify(metrics.targetSizes)}`,
      );
    };
    const setValue = (testId, nextValue) =>
      cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector(testId))});
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          throw new Error('Input not found: ${testId}');
        }
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        setter?.call(element, ${JSON.stringify(nextValue)});
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    const waitStep = (step) =>
      waitFor(
        `survey step ${step}`,
        async () => (await text('survey-step')) === `Шаг ${step} из 5`,
      );
    const chooseAndNext = async (option, currentStep) => {
      await click(`survey-option-${option}`);
      await waitFor(
        `enabled next on step ${currentStep}`,
        async () => !(await disabled('survey-next')),
      );
      await click('survey-next');
      await waitStep(currentStep + 1);
    };
    const submitLogin = async () => {
      await setValue('login-identifier', 'browser-test@example.com');
      await setValue('login-password', 'correct-password');
      await waitFor('enabled login button', async () => !(await disabled('login-submit')));
      await click('login-submit');
    };
    const waitOnboardingSlide = (slide) =>
      waitFor(
        `onboarding slide ${slide}`,
        async () =>
          (await attribute(`onboarding-dot-${slide}`, 'aria-current')) === 'step' &&
          (await text(`onboarding-slide-${slide}`))?.includes(
            [
              'Добро пожаловать в Kinetra',
              'Активность не тратит энергию. Она её создаёт',
              '7 ритмов недели',
              'Изучите базу',
              'Вы сможете двигаться свободно и без боли',
              'Готовы начать?',
            ][slide - 1],
          ),
      );

    await waitFor('login screen', () => exists('login-screen'));
    assert.equal(await pathname(), '/login');
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);

    await submitLogin();

    await waitFor('survey after login and refresh retry', () => exists('survey-screen'));
    assert.equal(await pathname(), '/survey');
    await waitStep(1);
    assert.equal(await disabled('survey-next'), true);

    await chooseAndNext('male', 1);
    await chooseAndNext('26-35', 2);
    await chooseAndNext('general_health', 3);

    await click('survey-option-none');
    await waitFor(
      'none selected',
      async () => (await attribute('survey-option-none', 'aria-pressed')) === 'true',
    );
    await click('survey-option-knees');
    await waitFor(
      'none cleared by another injury',
      async () =>
        (await attribute('survey-option-none', 'aria-pressed')) === 'false' &&
        (await attribute('survey-option-knees', 'aria-pressed')) === 'true',
    );
    await click('survey-option-other');
    await waitFor('other injury detail field', () => exists('injuries-detail'));
    assert.equal(await disabled('survey-next'), true);
    await setValue('injuries-detail', 'Старая травма голеностопа');
    await waitFor('injury detail validation', async () => !(await disabled('survey-next')));
    await click('survey-next');
    await waitStep(5);

    await click('survey-option-novice');
    await waitFor('enabled save button', async () => !(await disabled('survey-save')));
    await click('survey-save');

    await waitFor('onboarding route after survey save', () => exists('onboarding-screen'));
    assert.equal(await pathname(), '/onboarding');
    await waitOnboardingSlide(1);
    assert.equal(await attribute('onboarding-slide-1', 'aria-label'), '1 из 6');
    assert.equal(await attribute('onboarding-dot-1', 'aria-current'), 'step');

    await assertOnboardingLayout(320);
    await assertOnboardingLayout(428);

    await click('open-settings');
    await waitFor('settings route', () => exists('settings-screen'));
    assert.equal(await pathname(), '/settings');
    await click('edit-survey');
    await waitFor('survey edit route', () => exists('survey-screen'));
    assert.equal(await pathname(), '/settings/survey');
    assert.equal(await attribute('survey-option-male', 'aria-checked'), 'true');

    await click('survey-next');
    await waitStep(2);
    await click('survey-next');
    await waitStep(3);
    await click('survey-next');
    await waitStep(4);
    assert.equal(await attribute('survey-option-knees', 'aria-pressed'), 'true');
    assert.equal(await attribute('survey-option-other', 'aria-pressed'), 'true');
    assert.equal(await value('injuries-detail'), 'Старая травма голеностопа');

    await cdp.evaluate('window.history.back()');
    await waitFor('settings after browser back', () => exists('settings-screen'));
    await click('close-settings');
    await waitFor('onboarding after settings', () => exists('onboarding-screen'));
    await waitOnboardingSlide(1);

    assert.equal(await text('onboarding-next'), 'Далее');
    await click('onboarding-next');
    await waitOnboardingSlide(2);

    await swipeOnboarding({ fromX: 300, fromY: 220, toX: 110, toY: 224 });
    await waitOnboardingSlide(3);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), '2');
    assert.ok((await text('onboarding-rhythms'))?.includes('СбНейрогимнастика'));

    await swipeOnboarding({ fromX: 220, fromY: 300, toX: 225, toY: 150 });
    await waitOnboardingSlide(3);

    await pressOnboardingKey('ArrowRight');
    await waitOnboardingSlide(4);
    await pressOnboardingKey('ArrowLeft');
    await waitOnboardingSlide(3);

    await swipeOnboarding({
      fromX: 110,
      fromY: 224,
      toX: 300,
      toY: 220,
      pointerType: 'mouse',
    });
    await waitOnboardingSlide(2);
    await click('onboarding-next');
    await waitOnboardingSlide(3);

    await click('onboarding-back');
    await waitOnboardingSlide(2);
    await click('onboarding-next');
    await waitOnboardingSlide(3);
    await click('onboarding-dot-4');
    await waitOnboardingSlide(4);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), '3');

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('server progress restored after reload', () => exists('onboarding-screen'));
    assert.equal(await pathname(), '/onboarding');
    await waitOnboardingSlide(4);
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);

    await click('onboarding-next');
    await waitOnboardingSlide(5);
    await click('onboarding-next');
    await waitOnboardingSlide(6);
    assert.equal(await text('onboarding-complete'), 'К базовым урокам');

    await doubleClick('onboarding-complete');
    await waitFor('login after expired onboarding session', () => exists('login-screen'));
    assert.equal(counters.onboardingComplete, 1);
    assert.equal(await pathname(), '/login');
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), '5');
    assert.equal(
      await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.user')"),
      profile.user.id,
    );

    await submitLogin();
    await waitFor('onboarding after reauthentication', () => exists('onboarding-screen'));
    await waitOnboardingSlide(6);

    await doubleClick('onboarding-complete');
    await waitFor('recoverable onboarding completion error', () => exists('onboarding-error'));
    assert.equal(counters.onboardingComplete, 2);
    assert.equal(await pathname(), '/onboarding');
    assert.equal(await disabled('onboarding-complete'), false);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), '5');

    await click('onboarding-complete');
    await waitFor('base lessons route after onboarding completion', () =>
      exists('journey-base_lessons'),
    );
    assert.equal(await pathname(), '/base-lessons');
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), null);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.user')"), null);

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('base lessons restored after reload', () => exists('journey-base_lessons'));
    assert.equal(await pathname(), '/base-lessons');

    profile = {
      ...profile,
      user: { ...profile.user, onboardingStatus: 'active' },
    };
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('active route', () => exists('journey-active'));
    assert.equal(await pathname(), '/');

    await click('open-settings');
    await waitFor('settings before logout', () => exists('settings-screen'));
    await click('logout');
    await waitFor('login after logout', () => exists('login-screen'));
    assert.equal(await pathname(), '/login');
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);

    assert.equal(counters.login, 2);
    assert.ok(
      counters.refresh >= 4,
      `Expected at least 4 refreshes, received ${counters.refresh}.`,
    );
    assert.ok(counters.meUnauthorized >= 1);
    assert.equal(counters.surveySave, 1);
    assert.equal(counters.onboardingComplete, 3);
    assert.equal(counters.logout, 1);

    console.log('KINETRA_T04_BROWSER_E2E=PASS');
    console.log('KINETRA_T05_BROWSER_E2E=PASS');
  } catch (error) {
    if (cdp !== null) {
      try {
        const diagnostics = await cdp.evaluate(`JSON.stringify({
          url: window.location.href,
          title: document.title,
          text: document.body?.innerText?.slice(0, 2000) ?? '',
          html: document.documentElement?.outerHTML?.slice(0, 4000) ?? '',
        })`);
        console.error(`Browser diagnostics: ${diagnostics}`);
      } catch (diagnosticError) {
        console.error('Could not collect browser diagnostics.', diagnosticError);
      }
    }
    if (chromeErrors.trim().length > 0) {
      console.error(chromeErrors.slice(-4_000));
    }
    throw error;
  } finally {
    cdp?.close();
    await terminateChrome(chrome);
    await close(apiServer);
    await removeProfileDirectory(profileDirectory);
    await assertNoBrowserProfileDirectories();
  }
};

await buildFrontendForBrowserTest();
await runBrowserScenario();
