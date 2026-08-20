import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = path.join(root, 'apps/frontend/dist');
const apiPort = 3000;
const frontendPort = 4173;
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;

const counters = {
  login: 0,
  refresh: 0,
  meUnauthorized: 0,
  surveySave: 0,
  logout: 0,
};

let surveyVersion = 0;
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
    response.setHeader('Vary', 'Origin');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
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

    json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
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

const createStaticServer = () =>
  createServer(async (request, response) => {
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

const runBrowserScenario = async () => {
  const apiServer = createMockApiServer();
  const staticServer = createStaticServer();
  const debugPort = await freePort();
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-'));
  let chrome = null;
  let cdp = null;
  let chromeErrors = '';

  try {
    await listen(apiServer, apiPort);
    await listen(staticServer, frontendPort);

    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-gpu',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDirectory}`,
        `${frontendOrigin}/login`,
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
        target =
          targets.find(
            (item) => item.type === 'page' && String(item.url).startsWith(frontendOrigin),
          ) ?? null;
        return target?.webSocketDebuggerUrl !== undefined;
      } catch {
        return false;
      }
    });

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

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

    await waitFor('login screen', () => exists('login-screen'));
    assert.equal(await pathname(), '/login');
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);

    await setValue('login-identifier', 'browser-test@example.com');
    await setValue('login-password', 'correct-password');
    await waitFor('enabled login button', async () => !(await disabled('login-submit')));
    await click('login-submit');

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

    await waitFor('onboarding route after survey save', () => exists('journey-onboarding_pending'));
    assert.equal(await pathname(), '/onboarding');

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
    await waitFor('onboarding before reload', () => exists('journey-onboarding_pending'));

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('server progress restored after reload', () =>
      exists('journey-onboarding_pending'),
    );
    assert.equal(await pathname(), '/onboarding');
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);

    profile = {
      ...profile,
      user: { ...profile.user, onboardingStatus: 'base_lessons' },
    };
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('base lessons route', () => exists('journey-base_lessons'));
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

    assert.equal(counters.login, 1);
    assert.ok(
      counters.refresh >= 4,
      `Expected at least 4 refreshes, received ${counters.refresh}.`,
    );
    assert.ok(counters.meUnauthorized >= 1);
    assert.equal(counters.surveySave, 1);
    assert.equal(counters.logout, 1);

    console.log('KINETRA_T04_BROWSER_E2E=PASS');
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
    chrome?.kill('SIGTERM');
    await Promise.allSettled([close(apiServer), close(staticServer)]);
    await rm(profileDirectory, { recursive: true, force: true });
  }
};

await runBrowserScenario();
