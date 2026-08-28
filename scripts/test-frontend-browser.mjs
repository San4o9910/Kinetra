import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = path.join(root, 'apps/frontend/dist');
const apiPort = 3000;
const browserApiOrigin = `http://127.0.0.1:${apiPort}`;
const frontendOrigin = browserApiOrigin;
const chromeShutdownTimeoutMs = 5_000;
const chromeOwnsProcessGroup = process.platform !== 'win32';
const profileCleanupAttempts = 3;
const profileCleanupDelayMs = 500;
const profileCleanupStabilityMs = 1_000;
const profileCleanupPollMs = 100;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const browserFixtureNow = Date.now();
const fixtureTimestamp = (daysFromNow) =>
  new Date(browserFixtureNow + daysFromNow * millisecondsPerDay).toISOString();
const initialSubscriptionStartsAt = fixtureTimestamp(-30);
const initialSubscriptionExpiresAt = fixtureTimestamp(30);
const expiredSubscriptionStartsAt = fixtureTimestamp(-60);
const expiredSubscriptionExpiresAt = fixtureTimestamp(-1);
const renewedSubscriptionStartsAt = fixtureTimestamp(0);
const renewedSubscriptionExpiresAt = fixtureTimestamp(30);
const browserPushEndpoint = 'https://push.example.test/kinetra-browser-device';
const browserPushPublicKey =
  'BG_wO5SSQc4drdQ1GeaWDgqFtBppoFwygQOqK84VlMoWPE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo';
const browserPushP256dh =
  'BNcRdreALRFXTkOOUHK1EtK0b4vQm3xV9YVxNToPvN7aK8MvQ3rTn5Jk2wLs6cDf8gHa9qEb4yUi7oPx1mZn0Ac';
const browserPushAuth = 'AQIDBAUGBwgJCgsMDQ4PEA';

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
  const typescriptCli = path.join(root, 'node_modules/typescript/bin/tsc');
  const viteCli = path.join(root, 'node_modules/vite/bin/vite.js');
  const frontendRoot = path.join(root, 'apps/frontend');

  await runCommand(process.execPath, [typescriptCli, '-p', 'packages/shared/tsconfig.json']);
  await runCommand(process.execPath, [
    typescriptCli,
    '-p',
    'apps/frontend/tsconfig.json',
    '--noEmit',
  ]);
  await runCommand(process.execPath, [viteCli, 'build', '--mode', 'browser-test'], {
    cwd: frontendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VITE_API_URL: browserApiOrigin,
      VITE_PRIVATE_MEDIA_ORIGIN: frontendOrigin,
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
  baseLessonsGet: 0,
  lessonProgress: 0,
  baseProgramComplete: 0,
  currentWeekGet: 0,
  scheduleGet: 0,
  progressGet: 0,
  weeklyMetricsPut: 0,
  goalPut: 0,
  settingsProfileGet: 0,
  chatSessionGet: 0,
  subscriptionGet: 0,
  paymentCreate: 0,
  subscriptionCancel: 0,
  notificationsPut: 0,
  pushPublicKeyGet: 0,
  pushSubscriptionPost: 0,
  pushSubscriptionDelete: 0,
  accountDelete: 0,
  weekGet: 0,
  workoutComplete: 0,
  logout: 0,
};

const baseLessonTitles = [
  'Как понять правильно ли я дышу?',
  'Как правильно отжиматься?',
  'Как научиться подтягиваться?',
  'Как приседать?',
  'Как и зачем делать становую тягу?',
  'Я не хочу заниматься каждый день!',
  'Что я ем?',
];

let baseLessons = baseLessonTitles.map((title, index) => ({
  id: `10000000-0000-4000-8000-00000000000${index + 1}`,
  slug: `browser-base-lesson-${index + 1}`,
  title,
  description: `Браузерная фикстура базового урока ${index + 1}.`,
  duration_seconds: 600,
  order_index: index + 1,
  poster_url: null,
  video_url: index < 4 ? `${frontendOrigin}/browser-test-video.mp4?lesson=${index + 1}` : null,
  progress: {
    completion_percent: 0,
    completed: false,
  },
}));

const lessonProgressUpdates = [];
let failNextBaseLessonsGet = false;

const workoutSchedule = [
  {
    direction: 'breathing',
    title: 'Дыхание',
    description: 'Практика дыхания и контроля тела.',
    duration_minutes: 25,
    icon: '🧘',
  },
  {
    direction: 'strength',
    title: 'Сила',
    description: 'Силовая тренировка с постепенным ростом нагрузки.',
    duration_minutes: 35,
    icon: '💪',
  },
  {
    direction: 'body_therapy',
    title: 'Тело мой дом',
    description: 'Мягкая работа с подвижностью и ощущениями тела.',
    duration_minutes: 30,
    icon: '🌿',
  },
  {
    direction: 'functional',
    title: 'Функционал',
    description: 'Комплекс на координацию, силу и выносливость.',
    duration_minutes: 35,
    icon: '⚡',
  },
  {
    direction: 'stretching',
    title: 'Растяжка',
    description: 'Спокойная работа над гибкостью и расслаблением.',
    duration_minutes: 30,
    icon: '🧘‍♂️',
  },
  {
    direction: 'neuro',
    title: 'Нейрогимнастика',
    description: 'Короткая тренировка внимания, баланса и координации.',
    duration_minutes: 15,
    icon: '🧠',
  },
  {
    direction: 'recovery',
    title: 'Восстановление',
    description: 'Восстановительная практика без высокой нагрузки.',
    duration_minutes: 20,
    icon: '🍲',
  },
];

const scheduleDays = [
  {
    day_of_week: 1,
    day_label: 'Понедельник',
    direction: 'breathing',
    icon: '🧘',
    title: 'Дыхательная практика',
    description: 'Настройка нервной системы, учимся дышать животом.',
    duration_minutes: 25,
  },
  {
    day_of_week: 2,
    day_label: 'Вторник',
    direction: 'strength',
    icon: '💪',
    title: 'Силовая тренировка',
    description: 'Приседания, тяги, жимы. 3 круга.',
    duration_minutes: 35,
  },
  {
    day_of_week: 3,
    day_label: 'Среда',
    direction: 'body_therapy',
    icon: '🌿',
    title: 'Тело мой дом',
    description: 'Снимаем зажимы, работаем с телом.',
    duration_minutes: 30,
  },
  {
    day_of_week: 4,
    day_label: 'Четверг',
    direction: 'functional',
    icon: '⚡',
    title: 'Функциональная тренировка',
    description: 'Динамика, координация, баланс.',
    duration_minutes: 35,
  },
  {
    day_of_week: 5,
    day_label: 'Пятница',
    direction: 'stretching',
    icon: '🧘‍♂️',
    title: 'Растяжка',
    description: 'Восстанавливаем длину мышц.',
    duration_minutes: 30,
  },
  {
    day_of_week: 6,
    day_label: 'Суббота',
    direction: 'neuro',
    icon: '🧠',
    title: 'Нейрогимнастика',
    description: 'Упражнения для мозга и координации.',
    duration_minutes: 15,
  },
  {
    day_of_week: 7,
    day_label: 'Воскресенье',
    direction: 'recovery',
    icon: '🍲',
    title: 'Восстановление',
    description: 'Самомассаж и полезное блюдо.',
    duration_minutes: 20,
  },
];

const completedWorkoutIds = new Set();
const workoutCompletionUpdates = [];
let holdWorkoutCompletionResponse = false;
let releaseWorkoutCompletionResponse = null;

const workoutVideoId = (weekNumber, dayOfWeek) =>
  `20000000-0000-4000-8${String(weekNumber).padStart(3, '0')}-${String(dayOfWeek).padStart(12, '0')}`;

const programWeekPayload = (weekNumber, includeWorkoutMedia = true) => {
  const days = workoutSchedule.map((workout, index) => {
    const dayOfWeek = index + 1;
    const videoId = workoutVideoId(weekNumber, dayOfWeek);
    const completed = completedWorkoutIds.has(videoId);

    return {
      id: `30000000-0000-4000-8${String(weekNumber).padStart(3, '0')}-${String(dayOfWeek).padStart(12, '0')}`,
      day_of_week: dayOfWeek,
      ...workout,
      video: {
        id: videoId,
        video_url:
          includeWorkoutMedia && weekNumber === 1 && dayOfWeek === 1
            ? `${frontendOrigin}/browser-test-video.mp4?workout=${dayOfWeek}`
            : null,
        poster_url: null,
      },
      completed,
      completed_at: completed ? '2026-08-20T12:30:00.000Z' : null,
    };
  });
  const daysCompleted = days.filter(({ completed }) => completed).length;

  return {
    week: {
      id: `40000000-0000-4000-8000-${String(weekNumber).padStart(12, '0')}`,
      week_number: weekNumber,
      title: `Неделя ${weekNumber}`,
      status: weekNumber === 1 ? 'active' : 'locked',
      days,
      days_completed: daysCompleted,
      total_days: 7,
    },
    total_weeks: 12,
    overall_progress: {
      weeks_completed: daysCompleted === 7 ? 1 : 0,
      total_workouts_done: completedWorkoutIds.size,
    },
  };
};

const scheduleWeekPayload = (weekNumber, includeCompletions) => {
  const days = scheduleDays.map((day) => ({
    ...day,
    completed:
      includeCompletions && completedWorkoutIds.has(workoutVideoId(weekNumber, day.day_of_week)),
  }));

  return {
    week_number: weekNumber,
    title: `Неделя ${weekNumber}`,
    days,
    days_completed: days.filter(({ completed }) => completed).length,
    total_days: 7,
  };
};

const schedulePayload = () => ({
  current_week: scheduleWeekPayload(1, true),
  next_week: scheduleWeekPayload(2, false),
});

let progressGoal = {
  current_goal: 'general_health',
  goal_label: 'Хочу поддерживать форму и здоровье',
  set_at: '2026-08-20T08:00:00.000Z',
};

let progressParams = {
  gender: 'male',
  age_range: '26-35',
  experience: 'novice',
  injuries: ['knees', 'other'],
  survey_updated_at: '2026-08-20T08:00:00.000Z',
};

let progressMetrics = {
  current_week: 3,
  history: [
    {
      program_week: 1,
      energy: 6,
      sleep: 5,
      mood: 7,
      body_satisfaction: 5,
      note: 'Было тяжело, но интересно',
      created_at: '2026-08-04T09:00:00.000Z',
    },
    {
      program_week: 2,
      energy: 7,
      sleep: 6,
      mood: 7,
      body_satisfaction: 6,
      note: null,
      created_at: '2026-08-11T09:00:00.000Z',
    },
  ],
  pending_survey: true,
};

const progressAchievements = {
  unlocked: [
    {
      code: 'first_base_lesson',
      title: 'Первый шаг',
      description: 'Просмотрен первый базовый урок',
      icon_key: '🎯',
      unlocked_at: '2026-08-18T09:00:00.000Z',
    },
    {
      code: 'base_unlocked',
      title: 'База пройдена',
      description: '4 базовых урока завершены',
      icon_key: '🔓',
      unlocked_at: '2026-08-19T09:00:00.000Z',
    },
  ],
  locked: [
    {
      code: 'first_workout',
      title: 'Первая тренировка',
      description: 'Первая тренировка из программы',
      icon_key: '💪',
      progress: '0/1',
    },
    {
      code: 'week_complete',
      title: 'Неделя завершена',
      description: 'Все 7 дней за неделю',
      icon_key: '🏆',
      progress: '0/7',
    },
    {
      code: 'streak_3',
      title: 'Три подряд',
      description: '3 тренировки подряд',
      icon_key: '🔥',
      progress: '0/3',
    },
  ],
  total_unlocked: 2,
  total_available: 5,
};

const progressStats = {
  total_workouts: 15,
  total_weeks_completed: 2,
  current_streak: 3,
  best_streak: 5,
  total_minutes_trained: 450,
};

const progressPayload = () => ({
  goal: progressGoal,
  params: progressParams,
  metrics: progressMetrics,
  achievements: progressAchievements,
  stats: progressStats,
});

let notificationPreferences = {
  workout_reminders: true,
  reminder_time: '09:00',
  weekly_survey_reminder: true,
};

const notificationUpdates = [];
const pushSubscriptionUpdates = [];
const pushSubscriptionDeletes = [];

const settingsProfilePayload = () => ({
  email: profile.user.email,
  phone: profile.user.phone,
  created_at: profile.user.createdAt,
  onboarding_status: profile.user.onboardingStatus,
  notification_preferences: notificationPreferences,
});

let subscriptionPayload = {
  status: 'active',
  provider: 'yukassa',
  starts_at: initialSubscriptionStartsAt,
  expires_at: initialSubscriptionExpiresAt,
  amount: 799,
  currency: 'RUB',
  auto_renew: true,
  days_remaining: 30,
};
let pendingSubscriptionPollsRemaining = 0;

const baseLessonsPayload = () => {
  const totalCompleted = baseLessons.filter(
    ({ progress }) => progress.completion_percent >= 90,
  ).length;

  return {
    lessons: baseLessons,
    total_completed: totalCompleted,
    unlock_threshold: 4,
    program_unlocked: totalCompleted >= 4,
  };
};

let surveyVersion = 0;
let rejectNextRefresh = false;
let profile = {
  account_role: 'client',
  trainer_profile: null,
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

const createFixtureServer = (handler) =>
  createServer((request, response) => {
    void handler(request, response).catch((caught) => {
      const code = caught instanceof Error ? caught.code : undefined;
      if (
        (request.aborted || request.destroyed || response.destroyed) &&
        (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE')
      )
        return;
      setImmediate(() => {
        throw caught;
      });
    });
  });

const createMockApiServer = () =>
  createFixtureServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', frontendOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
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

    if (request.method === 'POST' && request.url === '/__browser-test/subscription/expire') {
      subscriptionPayload = {
        status: 'expired',
        provider: 'yukassa',
        starts_at: expiredSubscriptionStartsAt,
        expires_at: expiredSubscriptionExpiresAt,
        amount: 799,
        currency: 'RUB',
        auto_renew: false,
        days_remaining: 0,
      };
      pendingSubscriptionPollsRemaining = 0;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'POST' && request.url === '/__browser-test/subscription/activate') {
      subscriptionPayload = {
        status: 'active',
        provider: 'yukassa',
        starts_at: initialSubscriptionStartsAt,
        expires_at: initialSubscriptionExpiresAt,
        amount: 799,
        currency: 'RUB',
        auto_renew: true,
        days_remaining: 30,
      };
      pendingSubscriptionPollsRemaining = 0;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'GET' && (request.url ?? '').startsWith('/browser-test-video.mp4')) {
      response.writeHead(204, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
      });
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

    if (request.method === 'GET' && request.url === '/api/v1/chat/session') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.chatSessionGet += 1;
      json(response, 200, {
        role: 'client',
        enabled: false,
        available: false,
        photo_uploads_enabled: false,
        conversation: null,
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/settings/profile') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.settingsProfileGet += 1;
      json(response, 200, settingsProfilePayload());
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/settings/subscription') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.subscriptionGet += 1;
      if (subscriptionPayload.status === 'pending') {
        if (pendingSubscriptionPollsRemaining > 0) {
          pendingSubscriptionPollsRemaining -= 1;
        } else {
          subscriptionPayload = {
            status: 'active',
            provider: 'yukassa',
            starts_at: renewedSubscriptionStartsAt,
            expires_at: renewedSubscriptionExpiresAt,
            amount: 799,
            currency: 'RUB',
            auto_renew: true,
            days_remaining: 30,
          };
        }
      }
      json(response, 200, subscriptionPayload);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/push/public-key') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.pushPublicKeyGet += 1;
      json(response, 200, { public_key: browserPushPublicKey });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/push/subscriptions') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, {
        endpoint: browserPushEndpoint,
        keys: { p256dh: browserPushP256dh, auth: browserPushAuth },
        expirationTime: null,
      });
      counters.pushSubscriptionPost += 1;
      pushSubscriptionUpdates.push(body);
      json(response, 200, { subscribed: true });
      return;
    }

    if (request.method === 'DELETE' && request.url === '/api/v1/push/subscriptions') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, { endpoint: browserPushEndpoint });
      counters.pushSubscriptionDelete += 1;
      pushSubscriptionDeletes.push(body);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/payments/create') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, { return_url: `${frontendOrigin}/payment/success` });
      counters.paymentCreate += 1;
      subscriptionPayload = {
        status: 'pending',
        provider: 'yukassa',
        starts_at: null,
        expires_at: null,
        amount: 799,
        currency: 'RUB',
        auto_renew: true,
        days_remaining: null,
      };
      // App bootstrap and PaymentSuccessScreen both request the canonical subscription. Keeping
      // two pending responses proves the success screen polls instead of trusting the return URL.
      pendingSubscriptionPollsRemaining = 2;
      json(response, 201, {
        payment_id: '2f000000-0000-4000-8000-000000000011',
        confirmation_url: `${frontendOrigin}/payment/success?provider=browser-mock`,
        status: 'pending',
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/payments/cancel-subscription') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.subscriptionCancel += 1;
      subscriptionPayload = { ...subscriptionPayload, auto_renew: false };
      json(response, 200, subscriptionPayload);
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/settings/notifications') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(Object.keys(body).sort(), [
        'reminder_time',
        'weekly_survey_reminder',
        'workout_reminders',
      ]);
      assert.deepEqual(
        body,
        counters.notificationsPut === 0
          ? {
              workout_reminders: false,
              reminder_time: '10:30',
              weekly_survey_reminder: false,
            }
          : {
              workout_reminders: false,
              reminder_time: '10:30',
              weekly_survey_reminder: true,
            },
      );
      counters.notificationsPut += 1;
      notificationPreferences = body;
      notificationUpdates.push(body);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'DELETE' && request.url === '/api/v1/settings/account') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, { confirm: 'DELETE' });
      counters.accountDelete += 1;
      response.writeHead(204, {
        'Cache-Control': 'no-store',
        'Set-Cookie': 'kinetra_refresh=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax',
      });
      response.end();
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

    if (request.method === 'GET' && request.url === '/api/v1/base-lessons') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.baseLessonsGet += 1;

      if (failNextBaseLessonsGet) {
        failNextBaseLessonsGet = false;
        json(response, 503, {
          error: {
            code: 'BASE_LESSONS_TEMPORARILY_UNAVAILABLE',
            message: 'Base lessons are temporarily unavailable.',
          },
        });
        return;
      }

      json(response, 200, baseLessonsPayload());
      return;
    }

    const lessonProgressMatch = (request.url ?? '').match(
      /^\/api\/v1\/base-lessons\/([^/]+)\/progress$/u,
    );

    if (request.method === 'PUT' && lessonProgressMatch !== null) {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const lessonId = decodeURIComponent(lessonProgressMatch[1] ?? '');
      const lessonIndex = baseLessons.findIndex(({ id }) => id === lessonId);

      if (lessonIndex < 0) {
        json(response, 404, {
          error: { code: 'BASE_LESSON_NOT_FOUND', message: 'Base lesson was not found.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.equal(Number.isInteger(body.position_seconds), true);
      assert.ok(body.position_seconds >= 0);
      assert.equal(typeof body.completion_percent, 'number');
      assert.ok(body.completion_percent >= 0 && body.completion_percent <= 100);
      assert.deepEqual(Object.keys(body).sort(), ['completion_percent', 'position_seconds']);

      const lesson = baseLessons[lessonIndex];
      assert.notEqual(lesson, undefined);
      const completedAt = '2026-08-20T12:00:00.000Z';
      const completionPercent = Math.max(
        lesson?.progress.completion_percent ?? 0,
        body.completion_percent,
      );
      const progress = {
        completion_percent: completionPercent,
        completed: completionPercent >= 90,
      };
      baseLessons = baseLessons.map((current, index) =>
        index === lessonIndex ? { ...current, progress } : current,
      );
      counters.lessonProgress += 1;
      lessonProgressUpdates.push({ lessonId, ...body });

      json(response, 200, {
        position_seconds: body.position_seconds,
        completion_percent: completionPercent,
        completed: progress.completed,
        completed_at: progress.completed ? completedAt : null,
      });
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/base-lessons/complete-program') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.baseProgramComplete += 1;
      const { total_completed: totalCompleted } = baseLessonsPayload();

      if (totalCompleted < 4) {
        json(response, 400, {
          error: {
            code: 'INSUFFICIENT_LESSONS',
            message: 'Complete at least 4 base lessons before opening the program.',
          },
        });
        return;
      }

      if (profile.user.onboardingStatus === 'base_lessons') {
        profile = {
          ...profile,
          user: {
            ...profile.user,
            onboardingStatus: 'active',
            updatedAt: new Date().toISOString(),
          },
        };
      }

      json(response, 200, profile);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/program/current-week') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.currentWeekGet += 1;
      json(response, 200, programWeekPayload(1, profile.user.onboardingStatus === 'active'));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/program/schedule') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.scheduleGet += 1;
      json(response, 200, schedulePayload());
      return;
    }

    if (request.method === 'GET' && request.url === '/api/v1/progress') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      counters.progressGet += 1;
      json(response, 200, progressPayload());
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/progress/weekly-metrics') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, {
        program_week: 3,
        energy: 8,
        sleep: 7,
        mood: 8,
        body_satisfaction: 7,
        note: 'Чувствую прилив сил',
      });
      counters.weeklyMetricsPut += 1;
      progressMetrics = {
        current_week: 3,
        history: [
          ...progressMetrics.history.filter(({ program_week: programWeek }) => programWeek !== 3),
          {
            ...body,
            created_at: '2026-08-21T10:00:00.000Z',
          },
        ].sort((left, right) => left.program_week - right.program_week),
        pending_survey: false,
      };
      json(response, 200, progressMetrics);
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/progress/goal') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(body, { goal: 'strength' });
      assert.notEqual(profile.survey, null, 'Goal update requires the browser survey fixture.');
      counters.goalPut += 1;
      surveyVersion += 1;
      progressGoal = {
        current_goal: 'strength',
        goal_label: 'Хочу стать сильнее и выносливее',
        set_at: '2026-08-21T09:30:00.000Z',
      };
      progressParams = {
        ...progressParams,
        survey_updated_at: progressGoal.set_at,
      };
      profile = {
        ...profile,
        survey: {
          ...profile.survey,
          id: `00000000-0000-4000-8000-00000000000${surveyVersion + 1}`,
          version: surveyVersion,
          goal: 'strength',
          is_current: true,
          created_at: progressGoal.set_at,
        },
      };
      json(response, 200, progressGoal);
      return;
    }

    const programWeekMatch = (request.url ?? '').match(/^\/api\/v1\/program\/weeks\/(\d+)$/u);

    if (request.method === 'GET' && programWeekMatch !== null) {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      const weekNumber = Number(programWeekMatch[1]);
      counters.weekGet += 1;

      if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 2) {
        json(response, 403, {
          error: { code: 'PROGRAM_WEEK_LOCKED', message: 'Эта неделя пока недоступна.' },
        });
        return;
      }

      json(
        response,
        200,
        programWeekPayload(weekNumber, profile.user.onboardingStatus === 'active'),
      );
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/program/complete-workout') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
        });
        return;
      }

      if (profile.user.onboardingStatus !== 'active') {
        json(response, 403, {
          error: {
            code: 'BASE_LESSONS_REQUIRED',
            message: 'Complete at least four base lessons before starting a workout.',
          },
        });
        return;
      }

      const body = await readJsonBody(request);
      assert.deepEqual(Object.keys(body).sort(), ['program_week', 'video_id']);
      assert.equal(body.program_week, 1);
      assert.equal(body.video_id, workoutVideoId(1, 1));
      counters.workoutComplete += 1;
      workoutCompletionUpdates.push(body);

      if (holdWorkoutCompletionResponse) {
        await new Promise((resolve) => {
          releaseWorkoutCompletionResponse = resolve;
        });
        holdWorkoutCompletionResponse = false;
        releaseWorkoutCompletionResponse = null;
      }

      completedWorkoutIds.add(body.video_id);
      json(response, 200, programWeekPayload(1));
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
  constructor(commandStream, responseStream) {
    this.commandStream = commandStream;
    this.responseStream = responseStream;
    this.responseBuffer = '';
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.responseStream.on('data', (chunk) => {
      this.responseBuffer += chunk.toString('utf8');
      let delimiter = this.responseBuffer.indexOf('\0');

      while (delimiter >= 0) {
        const payload = this.responseBuffer.slice(0, delimiter);
        this.responseBuffer = this.responseBuffer.slice(delimiter + 1);
        delimiter = this.responseBuffer.indexOf('\0');

        if (payload.length === 0) {
          continue;
        }

        const message = JSON.parse(payload);
        if (typeof message.id !== 'number') {
          continue;
        }

        const pending = this.pending.get(message.id);
        if (pending === undefined) {
          continue;
        }

        this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new Error(message.error.message ?? 'CDP command failed.'));
        } else {
          pending.resolve(message.result);
        }
      }
    });

    const rejectPending = (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.responseStream.once('error', rejectPending);
    this.responseStream.once('close', () => rejectPending(new Error('Chrome CDP pipe closed.')));
  }

  async attachToPage() {
    let target = null;
    await waitFor('Chrome DevTools target', async () => {
      const targets = await this.send('Target.getTargets');
      target =
        targets.targetInfos.find(
          (item) => item.type === 'page' && String(item.url).startsWith(frontendOrigin),
        ) ?? null;
      return target !== null;
    });

    const attached = await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (this.sessionId !== null) {
        message.sessionId = this.sessionId;
      }
      this.commandStream.write(`${JSON.stringify(message)}\0`);
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
    this.commandStream.end();
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

const chromeProcessGroupExists = (chrome) => {
  if (!chromeOwnsProcessGroup || chrome.pid === undefined) return false;
  try {
    process.kill(-chrome.pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

const waitForChromeProcessGroupExit = async (chrome, timeoutMs) => {
  if (!chromeOwnsProcessGroup) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!chromeProcessGroupExists(chrome)) return true;
    await sleep(50);
  }
  return !chromeProcessGroupExists(chrome);
};

const signalChrome = (chrome, signal) => {
  if (chromeOwnsProcessGroup && chrome.pid !== undefined) {
    try {
      process.kill(-chrome.pid, signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill(signal);
};

const waitForChromeExit = async (chrome, timeoutMs) => {
  const [processExited, processGroupExited] = await Promise.all([
    waitForProcessExit(chrome, timeoutMs),
    waitForChromeProcessGroupExit(chrome, timeoutMs),
  ]);
  return processExited && processGroupExited;
};

const terminateChrome = async (chrome) => {
  if (chrome === null) return;
  if ((chrome.exitCode !== null || chrome.signalCode !== null) && !chromeProcessGroupExists(chrome))
    return;

  const gracefulExit = waitForChromeExit(chrome, chromeShutdownTimeoutMs);
  signalChrome(chrome, 'SIGTERM');

  if (await gracefulExit) {
    return;
  }

  console.warn('Chrome process group did not exit after SIGTERM; sending SIGKILL.');
  const forcedExit = waitForChromeExit(chrome, chromeShutdownTimeoutMs);
  signalChrome(chrome, 'SIGKILL');

  if (!(await forcedExit)) {
    throw new Error('Chrome process group did not exit after SIGKILL.');
  }
};

const profileDirectoryRemainsAbsent = async (profileDirectory) => {
  const deadline = Date.now() + profileCleanupStabilityMs;
  while (Date.now() < deadline) {
    if (existsSync(profileDirectory)) return false;
    await sleep(profileCleanupPollMs);
  }
  return !existsSync(profileDirectory);
};

const removeProfileDirectory = async (profileDirectory) => {
  let lastError = null;

  for (let attempt = 1; attempt <= profileCleanupAttempts; attempt += 1) {
    try {
      await rm(profileDirectory, { recursive: true, force: true });
      assert.equal(
        await profileDirectoryRemainsAbsent(profileDirectory),
        true,
        `Chrome profile directory was recreated after cleanup: ${profileDirectory}`,
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
        '--remote-debugging-pipe',
        `--user-data-dir=${profileDirectory}`,
        `${frontendOrigin}/login`,
      ],
      {
        detached: chromeOwnsProcessGroup,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      },
    );

    chrome.stderr.on('data', (chunk) => {
      chromeErrors += chunk.toString();
    });

    const commandStream = chrome.stdio[3];
    const responseStream = chrome.stdio[4];
    assert.notEqual(commandStream, null, 'Chrome did not expose its CDP command pipe.');
    assert.notEqual(responseStream, null, 'Chrome did not expose its CDP response pipe.');
    cdp = new CdpClient(commandStream, responseStream);
    await cdp.connect();
    await cdp.attachToPage();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const storageKey = 'kinetra.browser-acceptance.push-state.v1';
        const defaultSnapshot = {
          permission: 'default',
          permissionRequests: 0,
          getSubscriptionCalls: 0,
          subscribeCalls: 0,
          unsubscribeCalls: 0,
          subscribeOptions: null,
          subscriptionExists: false,
        };
        const readSnapshot = () => {
          try {
            const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
            return parsed !== null && typeof parsed === 'object'
              ? { ...defaultSnapshot, ...parsed }
              : defaultSnapshot;
          } catch {
            return defaultSnapshot;
          }
        };
        const snapshot = readSnapshot();
        const state = {
          permission: snapshot.permission,
          permissionRequests: snapshot.permissionRequests,
          getSubscriptionCalls: snapshot.getSubscriptionCalls,
          subscribeCalls: snapshot.subscribeCalls,
          unsubscribeCalls: snapshot.unsubscribeCalls,
          subscribeOptions: snapshot.subscribeOptions,
          subscription: null,
        };
        const persist = () => {
          try {
            sessionStorage.setItem(
              storageKey,
              JSON.stringify({
                permission: state.permission,
                permissionRequests: state.permissionRequests,
                getSubscriptionCalls: state.getSubscriptionCalls,
                subscribeCalls: state.subscribeCalls,
                unsubscribeCalls: state.unsubscribeCalls,
                subscribeOptions: state.subscribeOptions,
                subscriptionExists: state.subscription !== null,
              }),
            );
          } catch {
            // The assertion suite will expose environments where same-tab persistence is absent.
          }
        };
        const makeSubscription = () => {
          const subscription = {
            endpoint: ${JSON.stringify(browserPushEndpoint)},
            expirationTime: null,
            toJSON: () => ({
              endpoint: ${JSON.stringify(browserPushEndpoint)},
              expirationTime: null,
              keys: {
                p256dh: ${JSON.stringify(browserPushP256dh)},
                auth: ${JSON.stringify(browserPushAuth)},
              },
            }),
            unsubscribe: async () => {
              state.unsubscribeCalls += 1;
              if (state.subscription === subscription) {
                state.subscription = null;
              }
              persist();
              return true;
            },
          };
          return subscription;
        };

        if (snapshot.subscriptionExists === true) {
          state.subscription = makeSubscription();
        }

        Object.defineProperty(window, '__kinetraPushTest', {
          configurable: false,
          enumerable: false,
          value: state,
          writable: false,
        });
        Object.defineProperty(Notification, 'permission', {
          configurable: true,
          get: () => state.permission,
        });
        Object.defineProperty(Notification, 'requestPermission', {
          configurable: true,
          value: async () => {
            state.permissionRequests += 1;
            state.permission = 'granted';
            persist();
            return 'granted';
          },
        });
        Object.defineProperty(PushManager.prototype, 'getSubscription', {
          configurable: true,
          value: async () => {
            state.getSubscriptionCalls += 1;
            persist();
            return state.subscription;
          },
        });
        Object.defineProperty(PushManager.prototype, 'subscribe', {
          configurable: true,
          value: async (options) => {
            state.subscribeCalls += 1;
            state.subscribeOptions = {
              userVisibleOnly: options?.userVisibleOnly === true,
              applicationServerKeyLength:
                options?.applicationServerKey?.byteLength ??
                options?.applicationServerKey?.length ??
                null,
            };
            state.subscription = makeSubscription();
            persist();
            return state.subscription;
          },
        });
      })();`,
    });
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', {
      urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'],
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
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
    const assertBaseLessonsLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(`new Promise((resolve) => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const metrics = await cdp.evaluate(`(() => {
        const cards = [
          ...document.querySelectorAll(${JSON.stringify('[data-testid^="base-lesson-card-"]')})
        ];
        const footer = document.querySelector(${JSON.stringify('.base-lessons-fixed-action')});
        const complete = document.querySelector(${JSON.stringify(selector('base-lessons-complete'))});
        const lastCard = cards.at(-1);
        const footerRect = footer?.getBoundingClientRect();
        const completeRect = complete?.getBoundingClientRect();
        const lastCardRect = lastCard?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          cardCount: cards.length,
          cardsInsideViewport: cards.every((card) => {
            const rect = card.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth && rect.height >= 44;
          }),
          footerBottom: footerRect?.bottom ?? -1,
          completeHeight: completeRect?.height ?? 0,
          lastCardBottom: lastCardRect?.bottom ?? window.innerHeight + 1,
          footerTop: footerRect?.top ?? -1,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Base lessons horizontal overflow at ${width}px.`);
      assert.equal(metrics.cardCount, 7);
      assert.equal(metrics.cardsInsideViewport, true, `Base lesson card overflow at ${width}px.`);
      assert.ok(
        Math.abs(metrics.footerBottom - metrics.innerHeight) <= 1,
        `Fixed footer is not pinned to the viewport at ${width}px.`,
      );
      assert.ok(metrics.completeHeight >= 44, `Base lesson CTA is below 44px at ${width}px.`);
      assert.ok(
        metrics.lastCardBottom <= metrics.footerTop,
        `Fixed CTA overlaps the final lesson at ${width}px.`,
      );
      await cdp.evaluate("window.scrollTo({ top: 0, behavior: 'auto' })");
    };
    const assertMainScreenLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(`new Promise((resolve) => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const metrics = await cdp.evaluate(`(() => {
        const cards = [
          ...document.querySelectorAll(${JSON.stringify('[data-testid^="workout-card-"]')})
        ];
        const tabBar = document.querySelector(${JSON.stringify(selector('tab-bar'))});
        const tabs = [
          ...document.querySelectorAll(${JSON.stringify('[data-testid^="tab-"]')})
        ].filter((tab) => tab.getAttribute('data-testid') !== 'tab-bar');
        const lastCard = cards.at(-1);
        const tabBarRect = tabBar?.getBoundingClientRect();
        const lastCardRect = lastCard?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          cardCount: cards.length,
          cardsInsideViewport: cards.every((card) => {
            const rect = card.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth && rect.height >= 44;
          }),
          tabCount: tabs.length,
          tabTargetsAreLargeEnough: tabs.every((tab) => {
            const rect = tab.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          tabBarBottom: tabBarRect?.bottom ?? -1,
          tabBarTop: tabBarRect?.top ?? -1,
          tabBarHeight: tabBarRect?.height ?? 0,
          lastCardBottom: lastCardRect?.bottom ?? window.innerHeight + 1,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Main screen horizontal overflow at ${width}px.`);
      assert.equal(metrics.cardCount, 7);
      assert.equal(metrics.cardsInsideViewport, true, `Workout card overflow at ${width}px.`);
      assert.equal(metrics.tabCount, 4);
      assert.equal(metrics.tabTargetsAreLargeEnough, true, `Tab target below 44px at ${width}px.`);
      assert.ok(
        Math.abs(metrics.tabBarBottom - metrics.innerHeight) <= 1,
        `Tab bar is not pinned to the viewport at ${width}px.`,
      );
      assert.ok(metrics.tabBarHeight >= 56, `Tab bar is below 56px at ${width}px.`);
      assert.ok(
        metrics.lastCardBottom <= metrics.tabBarTop,
        `Tab bar overlaps the final workout at ${width}px.`,
      );
      await cdp.evaluate("window.scrollTo({ top: 0, behavior: 'auto' })");
    };
    const assertScheduleLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(`new Promise((resolve) => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const metrics = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll(${JSON.stringify('.schedule-day-card')})];
        const segments = [
          ...document.querySelectorAll(${JSON.stringify('.schedule-segmented button')})
        ];
        const tabBar = document.querySelector(${JSON.stringify(selector('tab-bar'))});
        const panel = document.querySelector(${JSON.stringify('.schedule-panel')});
        const lastCard = cards.at(-1);
        const tabBarRect = tabBar?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        const lastCardRect = lastCard?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          cardCount: cards.length,
          cardsInsideViewport: cards.every((card) => {
            const rect = card.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth && rect.height >= 44;
          }),
          segmentCount: segments.length,
          segmentTargetsAreLargeEnough: segments.every((segment) => {
            const rect = segment.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          panelInsideViewport:
            panelRect !== undefined &&
            panelRect.left >= 0 &&
            panelRect.right <= window.innerWidth,
          tabBarBottom: tabBarRect?.bottom ?? -1,
          tabBarTop: tabBarRect?.top ?? -1,
          lastCardBottom: lastCardRect?.bottom ?? window.innerHeight + 1,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Schedule horizontal overflow at ${width}px.`);
      assert.equal(metrics.cardCount, 7);
      assert.equal(metrics.cardsInsideViewport, true, `Schedule card overflow at ${width}px.`);
      assert.equal(metrics.segmentCount, 2);
      assert.equal(
        metrics.segmentTargetsAreLargeEnough,
        true,
        `Schedule segment target below 44px at ${width}px.`,
      );
      assert.equal(metrics.panelInsideViewport, true, `Schedule panel overflow at ${width}px.`);
      assert.ok(
        Math.abs(metrics.tabBarBottom - metrics.innerHeight) <= 1,
        `Tab bar is not pinned on Schedule at ${width}px.`,
      );
      assert.ok(
        metrics.lastCardBottom <= metrics.tabBarTop,
        `Tab bar overlaps the final schedule card at ${width}px.`,
      );
      await cdp.evaluate("window.scrollTo({ top: 0, behavior: 'auto' })");
    };
    const assertProgressLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(`new Promise((resolve) => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const metrics = await cdp.evaluate(`(() => {
        const sectionIds = [
          'progress-goal-section',
          'progress-metrics-section',
          'progress-stats-section',
          'progress-achievements-section',
        ];
        const sections = sectionIds
          .map((testId) => document.querySelector('[data-testid="' + testId + '"]'))
          .filter((section) => section instanceof HTMLElement);
        const chart = document.querySelector(${JSON.stringify(selector('progress-chart'))});
        const controls = [
          document.querySelector(${JSON.stringify(selector('progress-edit-goal'))}),
          document.querySelector(${JSON.stringify(selector('progress-weekly-open'))}),
          ...document.querySelectorAll(${JSON.stringify('.progress-metric-switch button')}),
        ].filter((control) => control instanceof HTMLElement);
        const tabBar = document.querySelector(${JSON.stringify(selector('tab-bar'))});
        const tabs = [
          ...document.querySelectorAll(${JSON.stringify('[data-testid^="tab-"]')})
        ].filter((tab) => tab.getAttribute('data-testid') !== 'tab-bar');
        const lastAchievement = document.querySelector(
          ${JSON.stringify('[data-testid="progress-achievement-streak_3"]')}
        );
        const chartRect = chart?.getBoundingClientRect();
        const tabBarRect = tabBar?.getBoundingClientRect();
        const lastAchievementRect = lastAchievement?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          sectionCount: sections.length,
          sectionsInsideViewport: sections.every((section) => {
            const rect = section.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
          chartInsideViewport:
            chartRect !== undefined && chartRect.left >= 0 && chartRect.right <= window.innerWidth,
          controlCount: controls.length,
          controlsAreLargeEnough: controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          tabCount: tabs.length,
          tabTargetsAreLargeEnough: tabs.every((tab) => {
            const rect = tab.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          tabBarBottom: tabBarRect?.bottom ?? -1,
          tabBarTop: tabBarRect?.top ?? -1,
          lastAchievementBottom: lastAchievementRect?.bottom ?? window.innerHeight + 1,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Progress horizontal overflow at ${width}px.`);
      assert.equal(metrics.sectionCount, 4);
      assert.equal(
        metrics.sectionsInsideViewport,
        true,
        `Progress section overflow at ${width}px.`,
      );
      assert.equal(metrics.chartInsideViewport, true, `Progress chart overflow at ${width}px.`);
      assert.equal(metrics.controlCount, 6);
      assert.equal(
        metrics.controlsAreLargeEnough,
        true,
        `Progress control below 44px at ${width}px.`,
      );
      assert.equal(metrics.tabCount, 4);
      assert.equal(
        metrics.tabTargetsAreLargeEnough,
        true,
        `Progress tab target below 44px at ${width}px.`,
      );
      assert.ok(
        Math.abs(metrics.tabBarBottom - metrics.innerHeight) <= 1,
        `Tab bar is not pinned on Progress at ${width}px.`,
      );
      assert.ok(
        metrics.lastAchievementBottom <= metrics.tabBarTop,
        `Tab bar overlaps the final achievement at ${width}px.`,
      );
      await cdp.evaluate("window.scrollTo({ top: 0, behavior: 'auto' })");
    };
    const assertSettingsLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(`new Promise((resolve) => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const metrics = await cdp.evaluate(`(() => {
        const sectionIds = [
          'settings-subscription-section',
          'settings-notifications-section',
          'settings-profile-section',
          'settings-appearance-section',
          'settings-support-section',
          'settings-account-section',
        ];
        const sections = sectionIds
          .map((testId) => document.querySelector('[data-testid="' + testId + '"]'))
          .filter((section) => section instanceof HTMLElement);
        const controls = [
          ...document.querySelectorAll(${JSON.stringify(
            '.settings-close, .settings-row, .settings-theme-option, .settings-subscription-actions > *',
          )}),
        ].filter((control) => control instanceof HTMLElement);
        const tabBar = document.querySelector(${JSON.stringify(selector('tab-bar'))});
        const accountSection = document.querySelector(
          ${JSON.stringify(selector('settings-account-section'))}
        );
        const tabBarRect = tabBar?.getBoundingClientRect();
        const accountRect = accountSection?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          sectionCount: sections.length,
          sectionsInsideViewport: sections.every((section) => {
            const rect = section.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
          controlCount: controls.length,
          controlsAreLargeEnough: controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
          tabBarBottom: tabBarRect?.bottom ?? -1,
          tabBarTop: tabBarRect?.top ?? -1,
          accountBottom: accountRect?.bottom ?? window.innerHeight + 1,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Settings horizontal overflow at ${width}px.`);
      assert.equal(metrics.sectionCount, 6);
      assert.equal(
        metrics.sectionsInsideViewport,
        true,
        `Settings section overflow at ${width}px.`,
      );
      assert.ok(metrics.controlCount >= 14, `Settings controls missing at ${width}px.`);
      assert.equal(
        metrics.controlsAreLargeEnough,
        true,
        `Settings control below 44px at ${width}px.`,
      );
      assert.ok(
        Math.abs(metrics.tabBarBottom - metrics.innerHeight) <= 1,
        `Tab bar is not pinned on Settings at ${width}px.`,
      );
      assert.ok(
        metrics.accountBottom <= metrics.tabBarTop,
        `Tab bar overlaps the account section at ${width}px.`,
      );
      await cdp.evaluate("window.scrollTo({ top: 0, behavior: 'auto' })");
    };
    const assertPaymentLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate(
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const metrics = await cdp.evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(selector('payment-card'))});
        const submit = document.querySelector(${JSON.stringify(selector('create-payment'))});
        const back = document.querySelector(${JSON.stringify('.payment-back')});
        const benefits = [
          ...document.querySelectorAll(${JSON.stringify('.payment-benefits li')})
        ];
        const cardRect = card?.getBoundingClientRect();
        const submitRect = submit?.getBoundingClientRect();
        const backRect = back?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          cardInsideViewport:
            cardRect !== undefined && cardRect.left >= 0 && cardRect.right <= window.innerWidth,
          cardRadius: card instanceof HTMLElement ? getComputedStyle(card).borderRadius : null,
          benefitCount: benefits.length,
          benefitsInsideViewport: benefits.every((benefit) => {
            const rect = benefit.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
          submitHeight: submitRect?.height ?? 0,
          backWidth: backRect?.width ?? 0,
          backHeight: backRect?.height ?? 0,
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Payment horizontal overflow at ${width}px.`);
      assert.equal(metrics.cardInsideViewport, true, `Payment card overflow at ${width}px.`);
      assert.notEqual(metrics.cardRadius, '0px');
      assert.equal(metrics.benefitCount, 5);
      assert.equal(metrics.benefitsInsideViewport, true, `Payment benefit overflow at ${width}px.`);
      assert.ok(metrics.submitHeight >= 44, `Payment CTA below 44px at ${width}px.`);
      assert.ok(
        metrics.backWidth >= 44 && metrics.backHeight >= 44,
        `Payment back target below 44px at ${width}px.`,
      );
    };
    const assertWeeklyMetricsDialogLayout = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 820,
        screenWidth: width,
        screenHeight: 820,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.evaluate('new Promise((resolve) => requestAnimationFrame(resolve))');
      const metrics = await cdp.evaluate(`(() => {
        const dialog = document.querySelector(${JSON.stringify(selector('progress-metrics-dialog'))});
        if (!(dialog instanceof HTMLDialogElement)) {
          throw new Error('Weekly metrics dialog was not found.');
        }
        const ranges = [...dialog.querySelectorAll('input[type="range"]')];
        const actions = [...dialog.querySelectorAll('.progress-dialog-actions button')];
        const rect = dialog.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          open: dialog.open,
          dialogInsideViewport:
            rect.left >= 0 &&
            rect.right <= window.innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= window.innerHeight,
          scrollIsContained: dialog.scrollHeight >= dialog.clientHeight,
          rangeCount: ranges.length,
          rangesAreLargeEnough: ranges.every((range) => range.getBoundingClientRect().height >= 44),
          actionCount: actions.length,
          actionsAreLargeEnough: actions.every(
            (action) => action.getBoundingClientRect().height >= 44,
          ),
        };
      })()`);
      assert.equal(metrics.innerWidth, width);
      assert.ok(metrics.scrollWidth <= width, `Progress dialog overflow at ${width}px.`);
      assert.equal(metrics.open, true);
      assert.equal(metrics.dialogInsideViewport, true, `Progress dialog is clipped at ${width}px.`);
      assert.equal(metrics.scrollIsContained, true);
      assert.equal(metrics.rangeCount, 4);
      assert.equal(metrics.rangesAreLargeEnough, true, `Progress range below 44px at ${width}px.`);
      assert.equal(metrics.actionCount, 2);
      assert.equal(
        metrics.actionsAreLargeEnough,
        true,
        `Progress dialog action below 44px at ${width}px.`,
      );
    };
    const setValue = (testId, nextValue) =>
      cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector(testId))});
        if (!(element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement)) {
          throw new Error('Input not found: ${testId}');
        }
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
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
    assert.equal(
      await cdp.evaluate(
        "window.isSecureContext && typeof navigator.locks?.request === 'function'",
      ),
      true,
      'Authenticated browser acceptance requires origin-wide Web Locks.',
    );

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
    await waitFor(
      'settings route',
      async () => (await exists('edit-survey')) && (await exists('close-settings')),
    );
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
    await waitFor(
      'settings after browser back',
      async () => (await exists('close-settings')) && (await exists('edit-survey')),
    );
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
    assert.equal(await text('onboarding-complete'), 'Открыть Kinetra');

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
    await waitFor(
      'exploration home after onboarding completion',
      async () =>
        (await pathname()) === '/' &&
        (await exists('main-screen')) &&
        (await exists('training-preparation-card')),
    );
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), null);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.user')"), null);

    await waitFor(
      'exploration preparation progress and seven protected workout cards',
      async () =>
        (await text('training-preparation-progress')) === 'Пройдено 0 из 4 необходимых' &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify('[data-training-access="base-lessons-required"]')}).length`,
        )) === 7,
    );
    const workoutCompletionsBeforeExploration = counters.workoutComplete;
    await click('workout-card-1');
    await waitFor('base lessons explanation instead of workout player', () =>
      dialogIsOpen('base-lessons-required-dialog'),
    );
    assert.equal(await exists('workout-player'), false);
    assert.equal(counters.workoutComplete, workoutCompletionsBeforeExploration);
    assert.ok((await text('base-lessons-required-dialog'))?.includes('свободно изучать'));
    await click('continue-exploring-app');
    await waitFor(
      'exploration dialog closed',
      async () => !(await dialogIsOpen('base-lessons-required-dialog')),
    );

    assert.equal(await exists('chat-fab'), false);
    const chatSessionRequestsBeforeExplorationProbe = counters.chatSessionGet;
    await cdp.evaluate(`
      window.history.pushState(null, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    `);
    await waitFor(
      'chat route is rejected during exploration',
      async () =>
        (await pathname()) === '/' &&
        (await exists('training-preparation-card')) &&
        !(await exists('chat-fab')),
    );
    assert.equal(counters.chatSessionGet, chatSessionRequestsBeforeExplorationProbe);
    console.log('KINETRA_EXPLORATION_CHAT_LOCK=PASS');

    await click('tab-schedule');
    await waitFor(
      'schedule is available during exploration',
      async () => (await pathname()) === '/schedule' && (await exists('schedule-panel-current')),
    );
    await click('tab-progress');
    await waitFor(
      'progress is available during exploration',
      async () => (await pathname()) === '/progress' && (await exists('progress-goal-section')),
    );
    await click('tab-settings');
    await waitFor(
      'settings are available during exploration',
      async () => (await pathname()) === '/settings' && (await exists('settings-screen')),
    );
    await click('tab-home');
    await waitFor(
      'exploration home restored from tab bar',
      async () => (await pathname()) === '/' && (await exists('training-preparation-card')),
    );
    console.log('KINETRA_ONBOARDING_EXPLORATION_NAVIGATION=PASS');

    const currentWeekRequestsBeforeExplorationPaywall = counters.currentWeekGet;
    const explorationExpireStatus = await cdp.evaluate(`fetch(
      ${JSON.stringify(`${frontendOrigin}/__browser-test/subscription/expire`)},
      { method: 'POST' }
    ).then((response) => response.status)`);
    assert.equal(explorationExpireStatus, 204);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'subscription gate precedes base-lessons workout gate',
      async () =>
        (await pathname()) === '/' &&
        (await exists('program-subscription-locked')) &&
        (await dialogIsOpen('subscription-paywall-dialog')) &&
        !(await dialogIsOpen('base-lessons-required-dialog')),
    );
    assert.equal(counters.currentWeekGet, currentWeekRequestsBeforeExplorationPaywall);
    console.log('KINETRA_EXPLORATION_PAYWALL_PRECEDENCE=PASS');

    const explorationActivateStatus = await cdp.evaluate(`fetch(
      ${JSON.stringify(`${frontendOrigin}/__browser-test/subscription/activate`)},
      { method: 'POST' }
    ).then((response) => response.status)`);
    assert.equal(explorationActivateStatus, 204);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'exploration home restored after subscription activation',
      async () => (await pathname()) === '/' && (await exists('training-preparation-card')),
    );

    await click('preparation-open-base-lessons');
    await waitFor('explicit base lessons route from exploration home', () =>
      exists('base-lessons-screen'),
    );
    assert.equal(await pathname(), '/base-lessons');
    assert.equal(await exists('tab-bar'), false);
    assert.equal(await exists('chat-fab'), false);
    console.log('KINETRA_BASE_LESSONS_STANDALONE=PASS');

    await click('base-lessons-back-to-app');
    await waitFor(
      'base lessons can return to exploration home',
      async () => (await pathname()) === '/' && (await exists('training-preparation-card')),
    );
    await click('preparation-open-base-lessons');
    await waitFor('base lessons reopened after voluntary return', () =>
      exists('base-lessons-screen'),
    );
    assert.equal(await pathname(), '/base-lessons');
    console.log('KINETRA_BASE_LESSONS_OPTIONAL_ROUTE=PASS');

    await waitFor(
      'seven base lessons with initial progress',
      async () =>
        (await attribute('base-lessons-progress', 'aria-valuetext')) === 'Пройдено 0 из 7' &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify('[data-testid^="base-lesson-card-"]')}).length`,
        )) === 7,
    );
    const renderedLessonCards = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="base-lesson-card-"]')})
    ].map((card) => card.textContent?.replace(/\\s+/gu, ' ').trim() ?? '')`);
    assert.equal(renderedLessonCards.length, 7);
    for (const [index, title] of baseLessonTitles.entries()) {
      assert.ok(
        renderedLessonCards[index]?.includes(title),
        `Base lesson ${index + 1} does not contain its expected title.`,
      );
    }
    const initialLessonStates = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="base-lesson-status-"]')})
    ].map((status) => ({
      state: status.getAttribute('data-state'),
      hasEmptyCircle: status.querySelector('.base-lesson-empty-circle') !== null,
    }))`);
    assert.deepEqual(
      initialLessonStates,
      Array.from({ length: 7 }, () => ({ state: 'not-started', hasEmptyCircle: true })),
    );
    assert.equal(await disabled('base-lessons-complete'), true);
    assert.equal(await text('base-lessons-complete'), 'Пройдите ещё 4 уроков');
    await assertBaseLessonsLayout(320);
    await assertBaseLessonsLayout(428);

    await click('base-lesson-card-7');
    await waitFor('base lesson video placeholder', () => exists('base-lesson-video-placeholder'));
    assert.equal(await pathname(), '/base-lessons');
    assert.ok(
      (await text('base-lesson-video-placeholder'))?.includes('Видео скоро будет доступно'),
    );
    await waitFor('base lesson history entry', () =>
      cdp.evaluate(
        `window.history.state?.kinetraBaseLessonId === ${JSON.stringify(baseLessons[6]?.id)}`,
      ),
    );
    const baseLessonGetsBeforePlaceholderBack = counters.baseLessonsGet;
    failNextBaseLessonsGet = true;
    await cdp.evaluate('window.history.back()');
    await waitFor('base lesson list after placeholder despite a failed refetch', () =>
      exists('base-lessons-screen'),
    );
    await waitFor(
      'failed placeholder background refetch',
      () => counters.baseLessonsGet === baseLessonGetsBeforePlaceholderBack + 1,
    );
    assert.equal(counters.lessonProgress, 0);
    console.log('KINETRA_T06_SYSTEM_BACK=PASS');

    await click('base-lesson-card-1');
    await waitFor('video player for periodic progress', () => exists('base-lesson-video'));
    const periodicVideoProgress = await cdp.evaluate(`(() => {
      const video = document.querySelector(${JSON.stringify(selector('base-lesson-video'))});
      if (!(video instanceof HTMLVideoElement)) {
        throw new Error('Base lesson video was not found.');
      }
      Object.defineProperties(video, {
        duration: { configurable: true, value: 100 },
        currentTime: { configurable: true, writable: true, value: 45 },
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
      });
      return { currentTime: video.currentTime, duration: video.duration, paused: video.paused };
    })()`);
    assert.deepEqual(periodicVideoProgress, { currentTime: 45, duration: 100, paused: false });
    await waitFor(
      'ten-second periodic progress PUT',
      () => lessonProgressUpdates.length === 1,
      13_000,
    );
    assert.deepEqual(lessonProgressUpdates[0], {
      lessonId: baseLessons[0]?.id,
      position_seconds: 45,
      completion_percent: 45,
    });
    const pausedAfterPeriodicPut = await cdp.evaluate(`(() => {
      const video = document.querySelector(${JSON.stringify(selector('base-lesson-video'))});
      if (!(video instanceof HTMLVideoElement)) {
        throw new Error('Base lesson video was not found.');
      }
      Object.defineProperty(video, 'paused', { configurable: true, value: true });
      return video.paused;
    })()`);
    assert.equal(pausedAfterPeriodicPut, true);
    console.log('KINETRA_T06_PERIODIC_PROGRESS=PASS');

    await click('base-lesson-back');
    await waitFor('final in-progress PUT on Back', () => lessonProgressUpdates.length === 2);
    await waitFor('in-progress lesson list', () => exists('base-lessons-screen'));
    assert.equal(await attribute('base-lesson-status-1', 'data-state'), 'in-progress');
    const inProgressVisual = await cdp.evaluate(`(() => {
      const status = document.querySelector(${JSON.stringify(selector('base-lesson-status-1'))});
      const bar = status?.querySelector('.base-lesson-card-progress > span');
      return {
        text: status?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
        width: bar instanceof HTMLElement ? bar.style.width : null,
      };
    })()`);
    assert.ok(inProgressVisual.text.includes('45%'));
    assert.equal(inProgressVisual.width, '45%');
    assert.equal(await disabled('base-lessons-complete'), true);
    assert.equal(await text('base-lessons-complete'), 'Пройдите ещё 4 уроков');

    await click('base-lesson-card-1');
    await waitFor('first lesson player for completion', () => exists('base-lesson-video'));
    const completedFirstVideoProgress = await cdp.evaluate(`(() => {
      const video = document.querySelector(${JSON.stringify(selector('base-lesson-video'))});
      if (!(video instanceof HTMLVideoElement)) {
        throw new Error('Base lesson video was not found.');
      }
      Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        writable: true,
        value: 95,
      });
      return { currentTime: video.currentTime, duration: video.duration };
    })()`);
    assert.deepEqual(completedFirstVideoProgress, { currentTime: 95, duration: 100 });
    await click('base-lesson-back');
    await waitFor('completed first lesson PUT', () => lessonProgressUpdates.length === 3);
    await waitFor(
      'first lesson aggregate progress',
      async () =>
        (await attribute('base-lessons-progress', 'aria-valuetext')) === 'Пройдено 1 из 7',
    );
    assert.equal(await attribute('base-lesson-status-1', 'data-state'), 'completed');
    const completedVisual = await cdp.evaluate(`(() => {
      const status = document.querySelector(${JSON.stringify(selector('base-lesson-status-1'))});
      return {
        text: status?.textContent?.trim() ?? '',
        hasCheck: status?.querySelector('svg') !== null,
      };
    })()`);
    assert.deepEqual(completedVisual, { text: 'Пройден', hasCheck: true });

    for (let orderIndex = 2; orderIndex <= 4; orderIndex += 1) {
      await click(`base-lesson-card-${orderIndex}`);
      await waitFor(`video player for base lesson ${orderIndex}`, async () =>
        exists('base-lesson-player'),
      );
      await waitFor(`video element for base lesson ${orderIndex}`, () =>
        exists('base-lesson-video'),
      );
      const overriddenVideoProgress = await cdp.evaluate(`(() => {
        const video = document.querySelector(${JSON.stringify(selector('base-lesson-video'))});
        if (!(video instanceof HTMLVideoElement)) {
          throw new Error('Base lesson video was not found.');
        }
        Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
        Object.defineProperty(video, 'currentTime', {
          configurable: true,
          writable: true,
          value: 95,
        });
        return { currentTime: video.currentTime, duration: video.duration };
      })()`);
      assert.deepEqual(overriddenVideoProgress, { currentTime: 95, duration: 100 });

      await click('base-lesson-back');
      await waitFor(
        `final progress PUT for base lesson ${orderIndex}`,
        () => lessonProgressUpdates.length === orderIndex + 2,
      );
      await waitFor(`base lesson list refreshed after lesson ${orderIndex}`, () =>
        exists('base-lessons-screen'),
      );
      await waitFor(
        `base lesson aggregate progress ${orderIndex} of 7`,
        async () =>
          (await attribute('base-lessons-progress', 'aria-valuetext')) ===
          `Пройдено ${orderIndex} из 7`,
      );

      const remaining = 4 - orderIndex;
      if (remaining > 0) {
        assert.equal(await disabled('base-lessons-complete'), true);
        assert.equal(await text('base-lessons-complete'), `Пройдите ещё ${remaining} уроков`);
      } else {
        assert.equal(await disabled('base-lessons-complete'), false);
        assert.equal(await text('base-lessons-complete'), 'Перейти к программе');
      }
    }

    assert.deepEqual(
      lessonProgressUpdates.map(({ lessonId }) => lessonId),
      [
        baseLessons[0]?.id,
        baseLessons[0]?.id,
        baseLessons[0]?.id,
        ...baseLessons.slice(1, 4).map(({ id }) => id),
      ],
    );
    console.log('KINETRA_T06_CARD_STATES=PASS');
    await click('base-lessons-complete');
    await waitFor('T07 main screen after base lesson completion', () => exists('main-screen'));
    assert.equal(await pathname(), '/');

    await waitFor(
      'current program week with seven workouts',
      async () =>
        (await text('week-heading')) === 'Неделя 1' &&
        (await attribute('week-progress', 'aria-valuenow')) === '0' &&
        (await attribute('week-progress', 'aria-valuemax')) === '7' &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify('[data-testid^="workout-card-"]')}).length`,
        )) === 7,
    );
    const renderedWorkoutCards = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="workout-card-"]')})
    ].map((card) => card.textContent?.replace(/\\s+/gu, ' ').trim() ?? '')`);
    assert.equal(renderedWorkoutCards.length, 7);
    for (const [index, workout] of workoutSchedule.entries()) {
      const cardText = renderedWorkoutCards[index] ?? '';
      assert.ok(cardText.includes(workout.title), `Workout ${index + 1} title is missing.`);
      assert.ok(cardText.includes(workout.icon), `Workout ${index + 1} icon is missing.`);
      assert.ok(
        cardText.includes(String(workout.duration_minutes)),
        `Workout ${index + 1} duration is missing.`,
      );
    }
    const initialWorkoutStates = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="workout-status-"]')})
    ].map((status) => status.getAttribute('data-state'))`);
    assert.deepEqual(
      initialWorkoutStates,
      Array.from({ length: 7 }, () => 'available'),
    );
    assert.equal(await disabled('week-previous'), true);
    assert.equal(await disabled('week-next'), false);

    const tabState = await cdp.evaluate(`(() => {
      const ids = ['tab-home', 'tab-schedule', 'tab-progress', 'tab-settings'];
      return {
        count: ids.filter((id) => document.querySelector('[data-testid="' + id + '"]')).length,
        active: ids.filter((id) =>
          document.querySelector('[data-testid="' + id + '"]')?.getAttribute('aria-current') === 'page'
        ),
      };
    })()`);
    assert.deepEqual(tabState, { count: 4, active: ['tab-home'] });

    const todayState = await cdp.evaluate(`(() => {
      const cards = [
        ...document.querySelectorAll(${JSON.stringify('[data-testid^="workout-card-"]')})
      ];
      const todayCards = cards.filter((card) => card.getAttribute('data-today') === 'true');
      return {
        count: todayCards.length,
        highlighted: todayCards[0]?.classList.contains('is-today') ?? false,
      };
    })()`);
    assert.deepEqual(todayState, { count: 1, highlighted: true });
    assert.equal(await exists('today-workout'), true);
    await assertMainScreenLayout(320);
    await assertMainScreenLayout(428);

    await click('tab-schedule');
    await waitFor(
      'T08 current schedule with seven days',
      async () =>
        (await pathname()) === '/schedule' &&
        (await exists('schedule-panel-current')) &&
        (await attribute('schedule-progress', 'aria-valuenow')) === '0' &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify('[data-testid^="schedule-current-day-"]')}).length`,
        )) === 7,
    );
    assert.equal(await attribute('tab-schedule', 'aria-current'), 'page');
    assert.equal(await attribute('schedule-segmented', 'role'), 'tablist');
    assert.equal(await attribute('schedule-segment-current', 'aria-selected'), 'true');
    assert.equal(await attribute('schedule-segment-next', 'aria-selected'), 'false');
    assert.equal(await text('schedule-current-week-heading'), 'Текущая неделя · 1');
    assert.equal(await attribute('schedule-progress', 'aria-valuemax'), '7');
    assert.equal(await attribute('schedule-progress', 'aria-valuetext'), 'Выполнено 0 из 7');

    const currentScheduleCards = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="schedule-current-day-"]')})
    ].map((card) => ({
      testId: card.getAttribute('data-testid'),
      completed: card.getAttribute('data-completed'),
      hasCompletion: card.querySelector(${JSON.stringify('[data-testid^="schedule-completed-"]')}) !== null,
      text: card.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
    }))`);
    assert.equal(currentScheduleCards.length, 7);
    for (const [index, expectedDay] of scheduleDays.entries()) {
      const renderedDay = currentScheduleCards[index];
      assert.equal(renderedDay?.testId, `schedule-current-day-${expectedDay.day_of_week}`);
      assert.equal(renderedDay?.completed, 'false');
      assert.equal(renderedDay?.hasCompletion, false);
      assert.ok(renderedDay?.text.includes(expectedDay.day_label));
      assert.ok(renderedDay?.text.includes(expectedDay.title));
      assert.ok(renderedDay?.text.includes(expectedDay.description));
      assert.ok(renderedDay?.text.includes(`${expectedDay.duration_minutes} мин`));
      assert.ok(renderedDay?.text.includes(expectedDay.icon));
    }
    await assertScheduleLayout(320);
    await assertScheduleLayout(428);

    await click('schedule-segment-next');
    await waitFor(
      'T08 next schedule segment with seven days',
      async () =>
        (await exists('schedule-panel-next')) &&
        (await attribute('schedule-segment-next', 'aria-selected')) === 'true' &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify('[data-testid^="schedule-next-day-"]')}).length`,
        )) === 7,
    );
    assert.equal(await exists('schedule-panel-current'), false);
    assert.equal(await text('schedule-next-week-heading'), 'Следующая неделя · 2');
    assert.equal(await attribute('schedule-segment-current', 'aria-selected'), 'false');

    const nextScheduleCards = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify('[data-testid^="schedule-next-day-"]')})
    ].map((card) => ({
      testId: card.getAttribute('data-testid'),
      completed: card.getAttribute('data-completed'),
      hasCompletion: card.querySelector(${JSON.stringify('[data-testid^="schedule-completed-"]')}) !== null,
      text: card.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
    }))`);
    assert.equal(nextScheduleCards.length, 7);
    for (const [index, expectedDay] of scheduleDays.entries()) {
      const renderedDay = nextScheduleCards[index];
      assert.equal(renderedDay?.testId, `schedule-next-day-${expectedDay.day_of_week}`);
      assert.equal(renderedDay?.completed, 'false');
      assert.equal(renderedDay?.hasCompletion, false);
      assert.ok(renderedDay?.text.includes(expectedDay.day_label));
      assert.ok(renderedDay?.text.includes(expectedDay.title));
      assert.ok(renderedDay?.text.includes(expectedDay.description));
      assert.ok(renderedDay?.text.includes(`${expectedDay.duration_minutes} мин`));
      assert.ok(renderedDay?.text.includes(expectedDay.icon));
    }
    await assertScheduleLayout(320);
    await assertScheduleLayout(428);

    await click('schedule-segment-current');
    await waitFor('T08 current segment restored', () => exists('schedule-panel-current'));
    console.log('KINETRA_T08_SCHEDULE_CONTENT=PASS');

    await click('schedule-current-day-4');
    await waitFor(
      'T08 schedule card opens Home',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );
    assert.equal(await attribute('tab-home', 'aria-current'), 'page');
    console.log('KINETRA_T08_CARD_NAVIGATION=PASS');

    await click('tab-schedule');
    await waitFor('schedule restored before continuing tab navigation', () =>
      exists('schedule-panel-current'),
    );
    await click('tab-progress');
    await waitFor(
      'T09 progress dashboard with four blocks',
      async () =>
        (await pathname()) === '/progress' &&
        (await exists('progress-goal-section')) &&
        (await exists('progress-metrics-section')) &&
        (await exists('progress-stats-section')) &&
        (await exists('progress-achievements-section')) &&
        counters.progressGet >= 1,
    );
    assert.equal(await attribute('tab-progress', 'aria-current'), 'page');
    assert.equal((await text('progress-screen'))?.includes('Скоро'), false);
    assert.equal(await text('progress-goal-label'), 'Хочу поддерживать форму и здоровье');
    assert.equal(await exists('progress-weekly-open'), true);
    assert.equal(await attribute('progress-chart', 'data-metric'), 'energy');
    assert.equal(
      await cdp.evaluate(
        `document.querySelectorAll(${JSON.stringify(selector('progress-chart-point'))}).length`,
      ),
      2,
    );
    assert.ok((await text('progress-chart'))?.includes('Нед 1'));
    assert.ok((await text('progress-chart'))?.includes('Нед 2'));

    for (const [testId, expected] of [
      ['progress-stat-total-workouts', '15'],
      ['progress-stat-weeks', '2'],
      ['progress-stat-current-streak', '3 дня'],
      ['progress-stat-best-streak', '5 дней'],
      ['progress-stat-minutes', '7ч 30мин'],
    ]) {
      assert.ok((await text(testId))?.includes(expected), `${testId} must include ${expected}.`);
    }

    assert.equal(await text('progress-achievement-count'), '2/5');
    for (const achievement of progressAchievements.unlocked) {
      const testId = `progress-achievement-${achievement.code}`;
      const copy = await text(testId);
      const expectedDate = achievement.code === 'first_base_lesson' ? '18.08.2026' : '19.08.2026';
      assert.equal(await attribute(testId, 'data-state'), 'unlocked');
      assert.ok(copy?.includes(achievement.icon_key));
      assert.ok(copy?.includes(achievement.title));
      assert.ok(copy?.includes(achievement.description));
      assert.ok(copy?.includes('Получено'));
      assert.ok(copy?.includes(expectedDate));
    }
    for (const achievement of progressAchievements.locked) {
      const testId = `progress-achievement-${achievement.code}`;
      const copy = await text(testId);
      assert.equal(await attribute(testId, 'data-state'), 'locked');
      assert.ok(copy?.includes(achievement.icon_key));
      assert.ok(copy?.includes(achievement.title));
      assert.ok(copy?.includes(achievement.description));
      assert.ok(copy?.includes(achievement.progress));
      assert.equal(copy?.includes('Получено'), false);
    }
    const achievementPresentation = await cdp.evaluate(`(() => ({
      unlockedOpacity: getComputedStyle(
        document.querySelector(${JSON.stringify(selector('progress-achievement-first_base_lesson'))})
      ).opacity,
      unlockedHasDate: document.querySelector(
        ${JSON.stringify(`${selector('progress-achievement-first_base_lesson')} time`)}
      ) !== null,
      lockedOpacity: getComputedStyle(
        document.querySelector(${JSON.stringify(selector('progress-achievement-first_workout'))})
      ).opacity,
      lockedHasDate: document.querySelector(
        ${JSON.stringify(`${selector('progress-achievement-first_workout')} time`)}
      ) !== null,
    }))()`);
    assert.deepEqual(achievementPresentation, {
      unlockedOpacity: '1',
      unlockedHasDate: true,
      lockedOpacity: '0.3',
      lockedHasDate: false,
    });
    await assertProgressLayout(320);
    await assertProgressLayout(428);
    console.log('KINETRA_T09_PROGRESS_CONTENT=PASS');

    await click('progress-edit-goal');
    await waitFor('T09 goal dialog', () =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector('progress-goal-dialog'))})?.open === true`,
      ),
    );
    assert.equal(await attribute('progress-goal-dialog', 'aria-modal'), 'true');
    const goalDialogOptions = await cdp.evaluate(`[
      ...document.querySelectorAll(${JSON.stringify(
        `${selector('progress-goal-dialog')} input[name="progress-goal"]`,
      )})
    ].map((input) => ({ value: input.value, label: input.closest('label')?.textContent?.trim() }))`);
    assert.deepEqual(goalDialogOptions, [
      { value: 'flexibility', label: 'Хочу быть гибким и подвижным' },
      { value: 'strength', label: 'Хочу стать сильнее и выносливее' },
      { value: 'awareness', label: 'Хочу лучше чувствовать своё тело' },
      { value: 'general_health', label: '✓Хочу поддерживать форму и здоровье' },
    ]);
    await click('progress-goal-option-strength');
    await waitFor('T09 strength goal selected', () =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(
          `${selector('progress-goal-option-strength')} input`,
        )})?.checked === true`,
      ),
    );
    await click('progress-goal-save');
    await waitFor(
      'T09 goal update applied',
      async () =>
        counters.goalPut === 1 &&
        !(await exists('progress-goal-dialog')) &&
        (await text('progress-goal-label')) === 'Хочу стать сильнее и выносливее',
    );
    console.log('KINETRA_T09_GOAL_UPDATE=PASS');

    await click('progress-weekly-open');
    await waitFor('T09 weekly metrics dialog', () =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector('progress-metrics-dialog'))})?.open === true`,
      ),
    );
    const rangeContract = await cdp.evaluate(`[
      'weekly-energy',
      'weekly-sleep',
      'weekly-mood',
      'weekly-body-satisfaction',
    ].map((testId) => {
      const input = document.querySelector('[data-testid="' + testId + '"]');
      return {
        testId,
        type: input?.getAttribute('type'),
        min: input?.getAttribute('min'),
        max: input?.getAttribute('max'),
        step: input?.getAttribute('step'),
        value: input?.value,
      };
    })`);
    assert.deepEqual(
      rangeContract,
      ['weekly-energy', 'weekly-sleep', 'weekly-mood', 'weekly-body-satisfaction'].map(
        (testId) => ({ testId, type: 'range', min: '1', max: '10', step: '1', value: '5' }),
      ),
    );
    assert.equal(await attribute('weekly-note', 'maxlength'), '500');
    await assertWeeklyMetricsDialogLayout(320);
    await setValue('weekly-energy', '8');
    await setValue('weekly-sleep', '7');
    await setValue('weekly-mood', '8');
    await setValue('weekly-body-satisfaction', '7');
    await setValue('weekly-note', 'Чувствую прилив сил');
    await waitFor(
      'T09 weekly metric controls updated',
      async () =>
        (await text('weekly-energy-value')) === '8' &&
        (await text('weekly-sleep-value')) === '7' &&
        (await text('weekly-mood-value')) === '8' &&
        (await text('weekly-body-satisfaction-value')) === '7' &&
        (await value('weekly-note')) === 'Чувствую прилив сил',
    );
    await click('weekly-save');
    await waitFor(
      'T09 weekly metrics update applied',
      async () =>
        counters.weeklyMetricsPut === 1 &&
        !(await exists('progress-metrics-dialog')) &&
        !(await exists('progress-weekly-open')) &&
        (await cdp.evaluate(
          `document.querySelectorAll(${JSON.stringify(selector('progress-chart-point'))}).length`,
        )) === 3 &&
        (await text('progress-chart'))?.includes('Нед 3'),
    );
    console.log('KINETRA_T09_WEEKLY_METRICS=PASS');

    for (const metric of ['energy', 'sleep', 'mood', 'body-satisfaction']) {
      await click(`progress-chart-tab-${metric}`);
      await waitFor(`T09 ${metric} chart`, async () => {
        const dataMetric = metric === 'body-satisfaction' ? 'body_satisfaction' : metric;
        return (
          (await attribute(`progress-chart-tab-${metric}`, 'aria-pressed')) === 'true' &&
          (await attribute('progress-chart', 'data-metric')) === dataMetric &&
          (await cdp.evaluate(
            `document.querySelectorAll(${JSON.stringify(selector('progress-chart-point'))}).length`,
          )) === 3
        );
      });
    }
    console.log('KINETRA_T09_CHARTS=PASS');

    await click('tab-home');
    await waitFor(
      'main screen after tab navigation',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );
    console.log('KINETRA_T07_TAB_NAVIGATION=PASS');

    await click('today-workout');
    await waitFor('today workout player or placeholder', async () => exists('workout-player'));
    assert.equal(
      (await exists('workout-video')) || (await exists('workout-video-placeholder')),
      true,
    );
    await cdp.evaluate('window.history.back()');
    await waitFor(
      'week list after today workout system Back',
      async () =>
        (await exists('main-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );
    console.log('KINETRA_T07_SYSTEM_BACK=PASS');

    await click('workout-card-7');
    await waitFor('placeholder before Home tab reselection', () =>
      exists('workout-video-placeholder'),
    );
    await click('tab-home');
    await waitFor(
      'Home tab closes the current workout without a hidden history entry',
      async () =>
        (await pathname()) === '/' &&
        (await exists('main-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );
    await click('week-next');
    await waitFor(
      'preview week before Forward restores a workout from another week',
      async () => (await text('week-heading')) === 'Неделя 2',
    );
    await cdp.evaluate('window.history.forward()');
    await waitFor(
      'Forward restores the workout and week represented by its history entry',
      async () =>
        (await exists('workout-video-placeholder')) &&
        (await cdp.evaluate(`
          typeof window.history.state?.kinetraWorkoutVideoId === 'string' &&
          window.history.state?.kinetraProgramWeek === 1
        `)),
    );
    await cdp.evaluate('window.history.back()');
    await waitFor(
      'Back closes the Forward-restored workout',
      async () =>
        (await exists('main-screen')) &&
        (await text('week-heading')) === 'Неделя 1' &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );

    await click('workout-card-7');
    await waitFor('placeholder before player reload', () => exists('workout-video-placeholder'));
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'reload restores the workout from history state',
      async () =>
        (await exists('workout-video-placeholder')) &&
        (await cdp.evaluate(`
          typeof window.history.state?.kinetraWorkoutVideoId === 'string' &&
          window.history.state?.kinetraProgramWeek === 1
        `)),
    );
    await cdp.evaluate('window.history.back()');
    await waitFor(
      'Back after player reload returns to the week',
      async () =>
        (await exists('main-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );

    await click('workout-card-7');
    await waitFor('placeholder before cross-tab navigation', () =>
      exists('workout-video-placeholder'),
    );
    await click('tab-schedule');
    await waitFor(
      'Schedule tab replaces the workout history sentinel',
      async () =>
        (await pathname()) === '/schedule' &&
        (await exists('schedule-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );
    await cdp.evaluate('window.history.back()');
    await waitFor(
      'browser Back after player tab navigation restores Home once',
      async () =>
        (await pathname()) === '/' &&
        (await exists('main-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );
    console.log('KINETRA_T07_PLAYER_TAB_HISTORY=PASS');

    await click('week-next');
    await waitFor(
      'future week preview',
      async () =>
        (await text('week-heading')) === 'Неделя 2' &&
        (await cdp.evaluate(`(() => {
          const statuses = [
            ...document.querySelectorAll(${JSON.stringify('[data-testid^="workout-status-"]')})
          ];
          return statuses.length === 7 &&
            statuses.every((status) => status.getAttribute('data-state') === 'locked');
        })()`)),
    );
    assert.equal(await disabled('week-previous'), false);
    assert.equal(await disabled('week-next'), true);
    assert.equal(await exists('today-workout'), false);
    await click('week-previous');
    await waitFor(
      'current week after previous arrow',
      async () => (await text('week-heading')) === 'Неделя 1',
    );
    console.log('KINETRA_T07_WEEK_NAVIGATION=PASS');

    await click('workout-card-7');
    await waitFor('T07 missing workout video placeholder', () =>
      exists('workout-video-placeholder'),
    );
    assert.ok((await text('workout-video-placeholder'))?.includes('Видео скоро будет доступно'));
    await click('workout-back');
    await waitFor(
      'week list after workout placeholder',
      async () =>
        (await exists('main-screen')) &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );

    await click('workout-card-1');
    await waitFor('T07 workout video player', () => exists('workout-video'));
    const belowThresholdProgress = await cdp.evaluate(`(() => {
      const video = document.querySelector(${JSON.stringify(selector('workout-video'))});
      if (!(video instanceof HTMLVideoElement)) {
        throw new Error('Workout video was not found.');
      }
      Object.defineProperties(video, {
        duration: { configurable: true, value: 100 },
        currentTime: { configurable: true, writable: true, value: 89 },
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
      });
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      return { currentTime: video.currentTime, duration: video.duration };
    })()`);
    assert.deepEqual(belowThresholdProgress, { currentTime: 89, duration: 100 });
    const belowThresholdSettled = await cdp.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(
        document.querySelector(${JSON.stringify(selector('workout-player'))})
          ?.getAttribute('aria-busy') ?? null
      )));
    })`);
    assert.equal(belowThresholdSettled, 'false');
    assert.equal(workoutCompletionUpdates.length, 0);

    holdWorkoutCompletionResponse = true;
    const completedWorkoutProgress = await cdp.evaluate(`(() => {
      const video = document.querySelector(${JSON.stringify(selector('workout-video'))});
      if (!(video instanceof HTMLVideoElement)) {
        throw new Error('Workout video was not found.');
      }
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        writable: true,
        value: 95,
      });
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
      return { currentTime: video.currentTime, duration: video.duration };
    })()`);
    assert.deepEqual(completedWorkoutProgress, { currentTime: 95, duration: 100 });
    await waitFor(
      'held complete-workout response while the player is saving',
      async () =>
        workoutCompletionUpdates.length === 1 &&
        releaseWorkoutCompletionResponse !== null &&
        (await attribute('workout-player', 'aria-busy')) === 'true',
    );
    assert.equal(await attribute('tab-bar', 'aria-busy'), 'true');
    assert.equal(await attribute('tab-schedule', 'aria-disabled'), 'true');
    await click('tab-schedule');
    const routeWhileSaving = await cdp.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => resolve({
        pathname: window.location.pathname,
        playerVisible: document.querySelector(${JSON.stringify(selector('workout-player'))}) !== null,
      }));
    })`);
    assert.deepEqual(routeWhileSaving, { pathname: '/', playerVisible: true });
    await cdp.evaluate('window.history.back()');
    await waitFor(
      'system Back is held on the single player entry while completion is saving',
      async () =>
        (await exists('workout-player')) &&
        (await attribute('workout-player', 'aria-busy')) === 'true' &&
        (await cdp.evaluate(
          `window.history.state?.kinetraWorkoutVideoId === ${JSON.stringify(workoutVideoId(1, 1))}`,
        )),
    );
    await cdp.evaluate('window.history.forward()');
    const playerAfterBlockedForward = await cdp.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        visible: document.querySelector(${JSON.stringify(selector('workout-player'))}) !== null,
          busy: document.querySelector(${JSON.stringify(selector('workout-player'))})
            ?.getAttribute('aria-busy') ?? null,
          videoId: window.history.state?.kinetraWorkoutVideoId ?? null,
          programWeek: window.history.state?.kinetraProgramWeek ?? null,
      })));
    })`);
    assert.deepEqual(playerAfterBlockedForward, {
      visible: true,
      busy: 'true',
      videoId: workoutVideoId(1, 1),
      programWeek: 1,
    });
    assert.equal(workoutCompletionUpdates.length, 1);
    releaseWorkoutCompletionResponse();
    assert.deepEqual(workoutCompletionUpdates[0], {
      video_id: workoutVideoId(1, 1),
      program_week: 1,
    });
    await waitFor('workout completion response applied', () =>
      cdp.evaluate(`(() => {
          const message = document.querySelector(${JSON.stringify('.workout-completion-message')});
          return message?.textContent?.trim() === 'Тренировка пройдена' &&
            document.querySelector(${JSON.stringify(selector('workout-player'))})
              ?.getAttribute('aria-busy') === 'false';
        })()`),
    );
    assert.equal(await attribute('tab-bar', 'aria-busy'), 'false');
    if (await exists('workout-player')) {
      await click('workout-back');
    }
    await waitFor(
      'completed workout card after returning to week',
      async () =>
        (await attribute('workout-status-1', 'data-state')) === 'completed' &&
        (await attribute('week-progress', 'aria-valuenow')) === '1' &&
        (await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId === undefined')),
    );
    assert.ok((await text('workout-status-1'))?.includes('Пройдено'));
    console.log('KINETRA_T07_WORKOUT_COMPLETION=PASS');

    await click('tab-schedule');
    await waitFor(
      'T08 completed workout reflected in Schedule',
      async () =>
        (await pathname()) === '/schedule' &&
        (await exists('schedule-panel-current')) &&
        (await attribute('schedule-progress', 'aria-valuenow')) === '1' &&
        (await attribute('schedule-current-day-1', 'data-completed')) === 'true' &&
        (await exists('schedule-completed-1')),
    );
    assert.equal(await attribute('schedule-progress', 'aria-valuetext'), 'Выполнено 1 из 7');
    assert.ok((await text('schedule-completed-1'))?.includes('✅'));
    assert.ok((await text('schedule-completed-1'))?.includes('Выполнено'));
    const completedScheduleStyle = await cdp.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(selector('schedule-current-day-1'))});
      if (!(card instanceof HTMLElement)) {
        throw new Error('Completed schedule card was not found.');
      }
      const style = getComputedStyle(card);
      return {
        completedClass: card.classList.contains('is-completed'),
        borderLeftColor: style.borderLeftColor,
        borderLeftWidth: style.borderLeftWidth,
      };
    })()`);
    assert.deepEqual(completedScheduleStyle, {
      completedClass: true,
      borderLeftColor: 'rgb(200, 241, 105)',
      borderLeftWidth: '3px',
    });
    console.log('KINETRA_T08_COMPLETION_STATE=PASS');

    await click('tab-home');
    await waitFor(
      'main route after T08 completion-state check',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor('T07 main route restored after reload', () => exists('main-screen'));
    assert.equal(await pathname(), '/');
    assert.equal(await attribute('workout-status-1', 'data-state'), 'completed');

    await click('tab-settings');
    await waitFor(
      'T10 settings content',
      async () =>
        (await pathname()) === '/settings' &&
        (await exists('settings-subscription-section')) &&
        (await exists('settings-notifications-section')) &&
        (await exists('settings-profile-section')) &&
        (await exists('settings-appearance-section')) &&
        (await exists('settings-support-section')) &&
        (await exists('settings-account-section')),
    );
    assert.equal(await pathname(), '/settings');
    assert.equal(await attribute('tab-settings', 'aria-current'), 'page');
    assert.ok((await text('settings-screen'))?.includes('Подписка'));
    assert.ok((await text('settings-screen'))?.includes('Уведомления'));
    assert.ok((await text('settings-screen'))?.includes('Профиль'));
    assert.ok((await text('settings-screen'))?.includes('Оформление'));
    assert.ok((await text('settings-screen'))?.includes('Поддержка'));
    assert.ok((await text('settings-screen'))?.includes('Аккаунт'));
    assert.ok((await text('settings-screen'))?.includes('browser-test@example.com'));
    assert.equal(await text('settings-member-since'), 'С нами с августа 2026');
    assert.equal(await attribute('settings-subscription-card', 'data-status'), 'active');
    const initialSubscriptionStatusText = await text('settings-subscription-status');
    assert.ok(initialSubscriptionStatusText?.startsWith('Активна до '));
    assert.ok((await text('settings-subscription-provider'))?.includes('ЮKassa'));
    assert.ok((await text('settings-subscription-provider'))?.includes('799 ₽'));
    assert.equal(await exists('settings-renew-subscription'), false);
    assert.equal(await exists('settings-cancel-auto-renew'), true);
    assert.equal(await attribute('settings-contact-coach', 'href'), 'mailto:coach@kinetra.app');
    assert.equal(await disabled('edit-survey'), false);
    await assertSettingsLayout(320);
    await assertSettingsLayout(428);
    console.log('KINETRA_T10_SETTINGS_CONTENT=PASS');

    assert.equal(await exists('settings-push-device'), true);
    assert.equal(await attribute('settings-push-device', 'data-permission'), 'default');
    assert.equal(await attribute('settings-push-device', 'data-browser-subscribed'), 'false');
    assert.equal(await attribute('settings-push-device', 'data-backend-registration'), 'unknown');
    assert.equal(await exists('settings-push-enable'), true);
    assert.equal(await exists('settings-push-disable'), false);
    assert.deepEqual(
      await cdp.evaluate(`(() => {
        const state = window.__kinetraPushTest;
        return {
          permission: state?.permission ?? null,
          permissionRequests: state?.permissionRequests ?? -1,
          subscribeCalls: state?.subscribeCalls ?? -1,
          subscriptionExists: state?.subscription !== null,
        };
      })()`),
      {
        permission: 'default',
        permissionRequests: 0,
        subscribeCalls: 0,
        subscriptionExists: false,
      },
    );
    assert.equal(counters.pushPublicKeyGet, 0);
    assert.equal(counters.pushSubscriptionPost, 0);
    assert.equal(counters.pushSubscriptionDelete, 0);

    await click('settings-push-enable');
    await waitFor(
      'T13 explicit device push registration',
      async () =>
        counters.pushPublicKeyGet === 1 &&
        counters.pushSubscriptionPost === 1 &&
        (await attribute('settings-push-device', 'data-permission')) === 'granted' &&
        (await attribute('settings-push-device', 'data-browser-subscribed')) === 'true' &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'registered',
    );
    assert.equal(await exists('settings-push-enable'), false);
    assert.equal(await exists('settings-push-disable'), true);
    assert.deepEqual(
      await cdp.evaluate(`(() => {
        const state = window.__kinetraPushTest;
        return {
          permission: state.permission,
          permissionRequests: state.permissionRequests,
          subscribeCalls: state.subscribeCalls,
          subscribeOptions: state.subscribeOptions,
          subscriptionExists: state.subscription !== null,
        };
      })()`),
      {
        permission: 'granted',
        permissionRequests: 1,
        subscribeCalls: 1,
        subscribeOptions: { userVisibleOnly: true, applicationServerKeyLength: 65 },
        subscriptionExists: true,
      },
    );

    const notificationPutsBeforeChanges = counters.notificationsPut;
    await setValue('settings-reminder-time', '10:30');
    await waitFor(
      'T10 reminder time changed before debounce',
      async () => (await value('settings-reminder-time')) === '10:30',
    );
    await click('settings-weekly-survey-reminder');
    await waitFor('T10 weekly reminder disabled', () =>
      cdp.evaluate(
        `document.querySelector(${JSON.stringify(selector('settings-weekly-survey-reminder'))})?.checked === false`,
      ),
    );
    await click('settings-workout-reminders');
    await waitFor(
      'T10 workout reminders disabled with pending autosave',
      async () =>
        (await cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector('settings-workout-reminders'))})?.checked === false`,
        )) &&
        !(await exists('settings-reminder-time')) &&
        (await text('settings-notification-save-status')) === 'Сохраняем…',
    );
    assert.equal(counters.notificationsPut, notificationPutsBeforeChanges);
    await waitFor(
      'T10 debounced notification preferences saved once',
      async () =>
        counters.notificationsPut === notificationPutsBeforeChanges + 1 &&
        (await text('settings-notification-save-status')) === 'Сохранено',
    );
    assert.deepEqual(notificationUpdates, [
      {
        workout_reminders: false,
        reminder_time: '10:30',
        weekly_survey_reminder: false,
      },
    ]);

    await click('settings-weekly-survey-reminder');
    await click('close-settings');
    await waitFor(
      'T10 pending notification preferences flushed on settings unmount',
      async () =>
        counters.notificationsPut === notificationPutsBeforeChanges + 2 &&
        (await pathname()) === '/' &&
        (await exists('main-screen')),
    );
    assert.deepEqual(notificationUpdates, [
      {
        workout_reminders: false,
        reminder_time: '10:30',
        weekly_survey_reminder: false,
      },
      {
        workout_reminders: false,
        reminder_time: '10:30',
        weekly_survey_reminder: true,
      },
    ]);
    await click('tab-settings');
    await waitFor('T10 settings restored after unmount notification flush', () =>
      exists('settings-appearance-section'),
    );
    assert.equal(
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(
          selector('settings-weekly-survey-reminder'),
        )})?.checked === true`,
      ),
      true,
    );
    console.log('KINETRA_T10_NOTIFICATIONS=PASS');

    await waitFor(
      'T13 device subscription survives T10 toggle changes and settings remount',
      async () =>
        (await attribute('settings-push-device', 'data-browser-subscribed')) === 'true' &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'unknown' &&
        (await exists('settings-push-enable')) &&
        (await exists('settings-push-disable')),
    );
    assert.equal(counters.pushSubscriptionDelete, 0);
    assert.equal(counters.pushPublicKeyGet, 1);
    assert.equal(counters.pushSubscriptionPost, 1);

    await click('settings-push-enable');
    await waitFor(
      'T13 existing browser subscription is re-registered without a new permission prompt',
      async () =>
        counters.pushSubscriptionPost === 2 &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'registered',
    );
    assert.equal(counters.pushPublicKeyGet, 1);
    assert.deepEqual(
      await cdp.evaluate(`(() => ({
        permissionRequests: window.__kinetraPushTest.permissionRequests,
        subscribeCalls: window.__kinetraPushTest.subscribeCalls,
      }))()`),
      { permissionRequests: 1, subscribeCalls: 1 },
    );

    await click('settings-push-disable');
    await waitFor(
      'T13 explicit device push removal',
      async () =>
        counters.pushSubscriptionDelete === 1 &&
        (await attribute('settings-push-device', 'data-browser-subscribed')) === 'false' &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'not_registered',
    );
    assert.equal(await exists('settings-push-disable'), false);
    assert.equal(await cdp.evaluate('window.__kinetraPushTest.unsubscribeCalls'), 1);

    await click('settings-push-enable');
    await waitFor(
      'T13 device can subscribe again after explicit removal',
      async () =>
        counters.pushPublicKeyGet === 2 &&
        counters.pushSubscriptionPost === 3 &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'registered',
    );
    assert.deepEqual(
      await cdp.evaluate(`(() => ({
        permissionRequests: window.__kinetraPushTest.permissionRequests,
        subscribeCalls: window.__kinetraPushTest.subscribeCalls,
      }))()`),
      { permissionRequests: 1, subscribeCalls: 2 },
    );

    const readThemeState = () =>
      cdp.evaluate(`(() => {
        const root = document.documentElement;
        const selected = document.querySelector('input[name="kinetra-theme"]:checked');
        return {
          preference: root.dataset.themePreference ?? null,
          resolved: root.dataset.theme ?? null,
          stored: localStorage.getItem('kinetra.theme.v1'),
          selected: selected instanceof HTMLInputElement ? selected.value : null,
          themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
          colorScheme: getComputedStyle(root).colorScheme,
          backgroundToken: getComputedStyle(root).getPropertyValue('--background').trim(),
          bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
      })()`);
    assert.deepEqual(await readThemeState(), {
      preference: 'system',
      resolved: 'dark',
      stored: 'system',
      selected: 'system',
      themeColor: '#080909',
      colorScheme: 'dark',
      backgroundToken: '#080909',
      bodyBackground: 'rgb(8, 9, 9)',
    });

    await click('settings-theme-light');
    await waitFor(
      'T10 explicit light theme',
      async () => (await readThemeState()).resolved === 'light',
    );
    assert.deepEqual(await readThemeState(), {
      preference: 'light',
      resolved: 'light',
      stored: 'light',
      selected: 'light',
      themeColor: '#F4F6F2',
      colorScheme: 'light',
      backgroundToken: '#f4f6f2',
      bodyBackground: 'rgb(244, 246, 242)',
    });

    await click('close-settings');
    await waitFor(
      'T10 light theme applies to the main program outside settings',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );
    assert.deepEqual(
      await cdp.evaluate(`(() => {
        const main = document.querySelector(${JSON.stringify(selector('main-screen'))});
        const heading = document.querySelector(${JSON.stringify(selector('week-heading'))});
        return {
          preference: document.documentElement.dataset.themePreference ?? null,
          resolved: document.documentElement.dataset.theme ?? null,
          background: main instanceof HTMLElement ? getComputedStyle(main).backgroundColor : null,
          headingColor:
            heading instanceof HTMLElement ? getComputedStyle(heading).color : null,
        };
      })()`),
      {
        preference: 'light',
        resolved: 'light',
        background: 'rgb(244, 246, 242)',
        headingColor: 'rgb(17, 20, 20)',
      },
    );
    await click('tab-settings');
    await waitFor(
      'T10 light preference remains selected after returning to settings',
      async () =>
        (await exists('settings-appearance-section')) &&
        (await readThemeState()).preference === 'light',
    );

    await click('settings-theme-dark');
    await waitFor(
      'T10 explicit dark theme',
      async () => (await readThemeState()).resolved === 'dark',
    );
    assert.deepEqual(await readThemeState(), {
      preference: 'dark',
      resolved: 'dark',
      stored: 'dark',
      selected: 'dark',
      themeColor: '#080909',
      colorScheme: 'dark',
      backgroundToken: '#080909',
      bodyBackground: 'rgb(8, 9, 9)',
    });

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'T10 explicit dark preference restored after reload',
      async () =>
        (await exists('settings-appearance-section')) &&
        (await readThemeState()).preference === 'dark',
    );
    assert.equal((await readThemeState()).stored, 'dark');

    await click('settings-theme-system');
    await waitFor('T10 system theme follows emulated dark mode', async () => {
      const theme = await readThemeState();
      return theme.preference === 'system' && theme.resolved === 'dark';
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await waitFor('T10 system theme reacts to light mode', async () => {
      const theme = await readThemeState();
      return theme.preference === 'system' && theme.resolved === 'light';
    });
    assert.deepEqual(await readThemeState(), {
      preference: 'system',
      resolved: 'light',
      stored: 'system',
      selected: 'system',
      themeColor: '#F4F6F2',
      colorScheme: 'light',
      backgroundToken: '#f4f6f2',
      bodyBackground: 'rgb(244, 246, 242)',
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    await waitFor(
      'T10 system theme reacts back to dark mode',
      async () => (await readThemeState()).resolved === 'dark',
    );
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'T10 system preference restored after reload',
      async () =>
        (await exists('settings-appearance-section')) &&
        (await readThemeState()).preference === 'system' &&
        (await readThemeState()).resolved === 'dark',
    );
    assert.deepEqual(await readThemeState(), {
      preference: 'system',
      resolved: 'dark',
      stored: 'system',
      selected: 'system',
      themeColor: '#080909',
      colorScheme: 'dark',
      backgroundToken: '#080909',
      bodyBackground: 'rgb(8, 9, 9)',
    });
    console.log('KINETRA_T10_THEME_MODES=PASS');

    const dialogIsOpen = (testId) =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))})?.open === true`);
    const closeDialogFromBackdrop = async (testId) => {
      await click(testId);
      await waitFor(`${testId} closed from backdrop`, async () => !(await dialogIsOpen(testId)));
    };

    await click('settings-change-level');
    await waitFor('T10 level dialog', () => dialogIsOpen('settings-level-dialog'));
    assert.ok((await text('settings-level-dialog'))?.includes('Мастерство'));
    assert.ok((await text('settings-level-dialog'))?.includes('Пик'));
    await closeDialogFromBackdrop('settings-level-dialog');

    await click('settings-about');
    await waitFor('T10 about dialog', () => dialogIsOpen('settings-about-dialog'));
    assert.equal(await text('settings-app-version'), '0.4.0');
    assert.ok((await text('settings-about-dialog'))?.includes('Политика конфиденциальности'));
    await closeDialogFromBackdrop('settings-about-dialog');

    await click('settings-cancel-auto-renew');
    await waitFor('T10 renewal dialog', () => dialogIsOpen('settings-renewal-dialog'));
    assert.ok((await text('settings-renewal-dialog'))?.includes('Отменить автопродление?'));
    assert.ok((await text('settings-renewal-dialog'))?.includes('до даты окончания'));
    const subscriptionCancelsBeforeConfirmation = counters.subscriptionCancel;
    await closeDialogFromBackdrop('settings-renewal-dialog');
    assert.equal(counters.subscriptionCancel, subscriptionCancelsBeforeConfirmation);

    await click('settings-cancel-auto-renew');
    await waitFor('T11 auto-renew cancellation confirmation', () =>
      dialogIsOpen('settings-renewal-dialog'),
    );
    await click('settings-cancel-auto-renew-confirm');
    await waitFor(
      'T11 auto-renew disabled without shortening the active term',
      async () =>
        counters.subscriptionCancel === subscriptionCancelsBeforeConfirmation + 1 &&
        !(await dialogIsOpen('settings-renewal-dialog')) &&
        (await attribute('settings-subscription-card', 'data-status')) === 'active' &&
        (await text('settings-subscription-status')) === initialSubscriptionStatusText &&
        (await text('settings-auto-renew-state')) === 'Автопродление отключено' &&
        !(await exists('settings-cancel-auto-renew')),
    );
    assert.equal(subscriptionPayload.auto_renew, false);
    assert.equal(subscriptionPayload.expires_at, initialSubscriptionExpiresAt);
    console.log('KINETRA_T11_SETTINGS_SUBSCRIPTION=PASS');

    const currentWeekRequestsBeforePaywall = counters.currentWeekGet;
    const expireStatus = await cdp.evaluate(`fetch(
      ${JSON.stringify(`${frontendOrigin}/__browser-test/subscription/expire`)},
      { method: 'POST' }
    ).then((response) => {
      window.history.replaceState(
        {
          kinetraWorkoutVideoId: ${JSON.stringify(workoutVideoId(1, 2))},
          kinetraProgramWeek: 1,
          browserAcceptanceState: 'preserved',
        },
        '',
        '/',
      );
      return response.status;
    })`);
    assert.equal(expireStatus, 204);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'T11 expired subscription locks the paid program and opens paywall',
      async () =>
        (await pathname()) === '/' &&
        (await exists('program-subscription-locked')) &&
        (await dialogIsOpen('subscription-paywall-dialog')),
    );
    assert.equal(counters.currentWeekGet, currentWeekRequestsBeforePaywall);
    assert.equal(await exists('workout-player'), false);
    assert.equal(
      await cdp.evaluate(
        'window.history.state?.kinetraWorkoutVideoId === undefined && window.history.state?.kinetraProgramWeek === undefined',
      ),
      true,
    );
    assert.equal(await cdp.evaluate('window.history.state?.browserAcceptanceState'), 'preserved');
    assert.equal(
      await cdp.evaluate(
        `document.querySelectorAll(${JSON.stringify('[data-testid^="workout-card-"]')}).length`,
      ),
      0,
    );
    assert.ok((await text('subscription-paywall-dialog'))?.includes('Подписка истекла'));
    await click('paywall-renew');
    await waitFor(
      'T11 paywall renewal opens the internal payment route',
      async () => (await pathname()) === '/payment' && (await exists('payment-screen')),
    );
    assert.equal(await cdp.evaluate('window.history.state?.kinetraWorkoutVideoId'), undefined);
    assert.ok((await text('payment-screen'))?.includes('Kinetra Premium'));
    assert.ok((await text('payment-price'))?.includes('799 ₽'));
    assert.ok((await text('payment-screen'))?.includes('Подписка продлевается автоматически'));
    await assertPaymentLayout(320);
    await assertPaymentLayout(428);

    const paymentCreatesBeforeSubmit = counters.paymentCreate;
    const subscriptionGetsBeforePayment = counters.subscriptionGet;
    await doubleClick('create-payment');
    await waitFor(
      'T11 same-origin provider return opens the success screen',
      async () =>
        counters.paymentCreate === paymentCreatesBeforeSubmit + 1 &&
        (await pathname()) === '/payment/success' &&
        (await exists('payment-success-screen')),
    );
    await waitFor(
      'T11 success screen polls canonical subscription until active',
      async () =>
        (await text('payment-success-status')) === 'Ваша подписка активирована' &&
        !(await disabled('start-training')),
      10_000,
    );
    assert.ok(
      counters.subscriptionGet >= subscriptionGetsBeforePayment + 3,
      'Payment return must verify canonical subscription more than once.',
    );
    console.log('KINETRA_T11_PAYMENT_FLOW=PASS');

    await click('start-training');
    await waitFor(
      'T11 activated subscription restores the paid program',
      async () =>
        (await pathname()) === '/' &&
        (await exists('main-screen')) &&
        (await exists('workout-card-2')),
    );
    await click('workout-card-2');
    await waitFor('T11 activated subscription opens a workout player', () =>
      exists('workout-player'),
    );
    await click('workout-back');
    await waitFor('T11 paid program restored after leaving player', () => exists('main-screen'));
    console.log('KINETRA_T11_PAYWALL=PASS');

    await cdp.evaluate(`(() => {
      window.history.pushState(null, '', '/payment/cancel');
      window.dispatchEvent(new PopStateEvent('popstate'));
    })()`);
    await waitFor(
      'T11 payment cancellation route',
      async () =>
        (await pathname()) === '/payment/cancel' && (await exists('payment-cancel-screen')),
    );
    assert.ok((await text('payment-cancel-screen'))?.includes('Оплата не завершена'));
    await click('payment-later');
    await waitFor(
      'T11 payment later returns to the program',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );
    await cdp.evaluate(`(() => {
      window.history.pushState(null, '', '/payment/cancel');
      window.dispatchEvent(new PopStateEvent('popstate'));
    })()`);
    await waitFor('T11 payment cancellation route reopened', () => exists('payment-cancel-screen'));
    await click('retry-payment');
    await waitFor(
      'T11 active subscriber retry safely returns to the program',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );

    await click('tab-settings');
    await waitFor('T11 settings restored before destructive T10 flows', () =>
      exists('settings-account-section'),
    );
    assert.deepEqual(
      await cdp.evaluate(`(() => ({
        permission: window.__kinetraPushTest.permission,
        subscriptionExists: window.__kinetraPushTest.subscription !== null,
        unsubscribeCalls: window.__kinetraPushTest.unsubscribeCalls,
      }))()`),
      {
        permission: 'granted',
        subscriptionExists: true,
        unsubscribeCalls: 1,
      },
    );

    const accountDeletesBeforeCancel = counters.accountDelete;
    await click('settings-delete-account');
    await waitFor('T10 account deletion warning', () => dialogIsOpen('settings-delete-dialog'));
    assert.ok((await text('settings-delete-dialog'))?.includes('Удалить аккаунт?'));
    await click('settings-delete-continue');
    await waitFor('T10 account deletion second stage', () =>
      exists('settings-delete-confirmation'),
    );
    assert.equal(await disabled('settings-delete-confirm'), true);
    await setValue('settings-delete-confirmation', 'delete');
    assert.equal(await disabled('settings-delete-confirm'), true);
    await setValue('settings-delete-confirmation', 'DELETE');
    await waitFor(
      'T10 exact account deletion confirmation accepted',
      async () => !(await disabled('settings-delete-confirm')),
    );
    await closeDialogFromBackdrop('settings-delete-dialog');
    assert.equal(counters.accountDelete, accountDeletesBeforeCancel);
    assert.equal(await exists('settings-delete-confirmation'), false);

    await click('settings-delete-account');
    await waitFor('T10 account deletion reopened', () => dialogIsOpen('settings-delete-dialog'));
    await click('settings-delete-continue');
    await waitFor('T10 account deletion confirmation input restored', () =>
      exists('settings-delete-confirmation'),
    );
    await setValue('settings-delete-confirmation', 'DELETE');
    await waitFor(
      'T10 account deletion enabled',
      async () => !(await disabled('settings-delete-confirm')),
    );
    await click('settings-delete-confirm');
    await waitFor(
      'T10 account deletion redirects to login',
      async () =>
        counters.accountDelete === accountDeletesBeforeCancel + 1 &&
        (await pathname()) === '/login' &&
        (await exists('login-screen')),
    );
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);
    assert.equal(await cdp.evaluate('window.__kinetraPushTest.subscription === null'), true);
    assert.equal(await cdp.evaluate('window.__kinetraPushTest.unsubscribeCalls'), 2);
    assert.equal(counters.pushSubscriptionDelete, 1);
    console.log('KINETRA_T10_ACCOUNT_DELETION=PASS');

    await submitLogin();
    await waitFor(
      'T10 active app after reauthentication following deletion mock',
      async () => (await pathname()) === '/' && (await exists('main-screen')),
    );
    await click('tab-settings');
    await waitFor('T10 settings before confirmed logout', () => exists('settings-account-section'));
    await waitFor(
      'T13 device is unsubscribed after account deletion',
      async () =>
        (await attribute('settings-push-device', 'data-browser-subscribed')) === 'false' &&
        (await exists('settings-push-enable')),
    );
    await click('settings-push-enable');
    await waitFor(
      'T13 device is registered before logout cleanup',
      async () =>
        counters.pushPublicKeyGet === 3 &&
        counters.pushSubscriptionPost === 4 &&
        (await attribute('settings-push-device', 'data-backend-registration')) === 'registered',
    );
    const logoutsBeforeConfirmation = counters.logout;
    await click('logout');
    await waitFor('T10 logout confirmation dialog', () => dialogIsOpen('settings-logout-dialog'));
    assert.equal(counters.logout, logoutsBeforeConfirmation);
    assert.ok((await text('settings-logout-dialog'))?.includes('Выйти из аккаунта?'));
    await closeDialogFromBackdrop('settings-logout-dialog');
    assert.equal(counters.logout, logoutsBeforeConfirmation);
    await click('logout');
    await waitFor('T10 logout confirmation reopened', () => dialogIsOpen('settings-logout-dialog'));
    await click('logout-confirm');
    await waitFor(
      'login after confirmed logout',
      async () =>
        counters.logout === logoutsBeforeConfirmation + 1 &&
        (await pathname()) === '/login' &&
        (await exists('login-screen')),
    );
    assert.equal(await cdp.evaluate("localStorage.getItem('kinetra.accessToken')"), null);
    assert.equal(counters.pushSubscriptionDelete, 2);
    assert.equal(await cdp.evaluate('window.__kinetraPushTest.subscription === null'), true);
    assert.equal(await cdp.evaluate('window.__kinetraPushTest.unsubscribeCalls'), 3);
    console.log('KINETRA_T10_LOGOUT=PASS');

    assert.equal(counters.login, 3);
    assert.ok(
      counters.refresh >= 4,
      `Expected at least 4 refreshes, received ${counters.refresh}.`,
    );
    assert.ok(counters.meUnauthorized >= 1);
    assert.equal(counters.surveySave, 1);
    assert.equal(counters.onboardingComplete, 3);
    assert.ok(counters.baseLessonsGet >= 7);
    assert.equal(counters.lessonProgress, 6);
    assert.equal(counters.baseProgramComplete, 1);
    assert.ok(counters.currentWeekGet >= 2);
    assert.ok(counters.scheduleGet >= 3);
    assert.ok(counters.progressGet >= 1);
    assert.equal(counters.weeklyMetricsPut, 1);
    assert.equal(counters.goalPut, 1);
    assert.ok(counters.settingsProfileGet >= 5);
    assert.ok(counters.subscriptionGet >= 5);
    assert.equal(counters.paymentCreate, 1);
    assert.equal(counters.subscriptionCancel, 1);
    assert.equal(counters.notificationsPut, 2);
    assert.equal(counters.pushPublicKeyGet, 3);
    assert.equal(counters.pushSubscriptionPost, 4);
    assert.equal(counters.pushSubscriptionDelete, 2);
    assert.equal(pushSubscriptionUpdates.length, 4);
    assert.deepEqual(
      pushSubscriptionDeletes,
      Array.from({ length: 2 }, () => ({ endpoint: browserPushEndpoint })),
    );
    assert.deepEqual(
      await cdp.evaluate(`(() => ({
        permission: window.__kinetraPushTest.permission,
        permissionRequests: window.__kinetraPushTest.permissionRequests,
        subscribeCalls: window.__kinetraPushTest.subscribeCalls,
        unsubscribeCalls: window.__kinetraPushTest.unsubscribeCalls,
        subscriptionExists: window.__kinetraPushTest.subscription !== null,
      }))()`),
      {
        permission: 'granted',
        permissionRequests: 1,
        subscribeCalls: 3,
        unsubscribeCalls: 3,
        subscriptionExists: false,
      },
    );
    assert.equal(counters.accountDelete, 1);
    assert.equal(counters.weekGet, 4);
    assert.equal(counters.workoutComplete, 1);
    assert.equal(counters.logout, 1);

    console.log('KINETRA_T04_BROWSER_E2E=PASS');
    console.log('KINETRA_T05_BROWSER_E2E=PASS');
    console.log('KINETRA_T06_BROWSER_E2E=PASS');
    console.log('KINETRA_T07_BROWSER_E2E=PASS');
    console.log('KINETRA_T08_BROWSER_E2E=PASS');
    console.log('KINETRA_T09_BROWSER_E2E=PASS');
    console.log('KINETRA_T10_BROWSER_E2E=PASS');
    console.log('KINETRA_T11_BROWSER_E2E=PASS');
    console.log('KINETRA_T13_BROWSER_E2E=PASS');
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
    releaseWorkoutCompletionResponse?.();
    releaseWorkoutCompletionResponse = null;
    holdWorkoutCompletionResponse = false;
    cdp?.close();
    await terminateChrome(chrome);
    await close(apiServer);
    await removeProfileDirectory(profileDirectory);
    await assertNoBrowserProfileDirectories();
  }
};

const t12ClientId = '90000000-0000-4000-8000-000000000001';
const t12TrainerId = '90000000-0000-4000-8000-000000000002';
const t12ConversationId = '91000000-0000-4000-8000-000000000001';
const t12OtherConversationId = '91000000-0000-4000-8000-000000000099';
const t12OtherPhotoId = '93000000-0000-4000-8000-000000000099';
const t12ViewportMatrix = [
  { width: 320, height: 568 },
  { width: 428, height: 926 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const t12ThemeMatrix = ['light', 'dark', 'system'];

const t12AccountForToken = (token) => {
  if (token.startsWith('t12-access-client-')) return 'client';
  if (token.startsWith('t12-access-trainer-')) return 'trainer';
  return null;
};

const t12AccountForRequest = (request) => {
  const authorization = String(request.headers.authorization ?? '');
  return authorization.startsWith('Bearer ')
    ? t12AccountForToken(authorization.slice('Bearer '.length))
    : null;
};

const t12Profile = (role) => {
  const trainer = role === 'trainer';
  return {
    account_role: role,
    trainer_profile: trainer
      ? { display_name: 'Ирина Тренер', avatar_url: null, can_manage_videos: true }
      : null,
    user: {
      id: trainer ? t12TrainerId : t12ClientId,
      email: trainer ? 'chat-trainer@example.test' : 'chat-client@example.test',
      phone: null,
      emailVerified: true,
      avatarUrl: null,
      username: trainer ? 'chat-trainer' : 'chat-client',
      firstName: trainer ? 'Ирина' : 'Анна',
      onboardingStatus: 'active',
      notificationEnabled: true,
      level: 'beginner',
      timezone: 'Europe/Moscow',
      createdAt: '2026-08-23T08:00:00.000Z',
      updatedAt: '2026-08-23T08:00:00.000Z',
    },
    survey: null,
    subscription: trainer
      ? {
          provider: null,
          status: 'none',
          isActive: false,
          startsAt: null,
          expiresAt: null,
          amountMinor: null,
          currency: null,
        }
      : {
          provider: 'yukassa',
          status: 'active',
          isActive: true,
          startsAt: initialSubscriptionStartsAt,
          expiresAt: initialSubscriptionExpiresAt,
          amountMinor: 79_900,
          currency: 'RUB',
        },
  };
};

const createT12BrowserServer = (syntheticVideo) => {
  const syntheticDifferentVideo = Buffer.from(syntheticVideo);
  syntheticDifferentVideo[0] ^= 0xff;
  assert.equal(syntheticDifferentVideo.length, syntheticVideo.length);
  const videoPreviewExpiresInSeconds = 120;
  const videoPreviewSignature = 'a'.repeat(64);
  const state = {
    conversationCreated: false,
    messages: [],
    clientReadSequence: 0,
    trainerReadSequence: 0,
    loginCount: { client: 0, trainer: 0 },
    logoutCount: { client: 0, trainer: 0 },
    logoutAuthorizations: { client: [], trainer: [] },
    refreshCount: { client: 0, trainer: 0 },
    currentAccessToken: { client: null, trainer: null },
    messageSenders: [],
    messageRequestAttempts: new Map(),
    messageBroadcastCount: new Map(),
    readUpdates: [],
    socketConnections: { client: new Set(), trainer: new Set() },
    sockets: { client: new Set(), trainer: new Set() },
    socketConnectionCount: { client: 0, trainer: 0 },
    socketDisconnectCount: { client: 0, trainer: 0 },
    deltaQueries: [],
    duplicateMessageId: null,
    missedMessageId: null,
    photoUploadKeyOrder: [],
    photoUploadAttempts: new Map(),
    photos: new Map(),
    photoAccessRequests: [],
    accountDeleteAuthorization: null,
    accountDeleteExpectedAuthorization: null,
    accountDeleteCount: 0,
    pushSubscriptionDeleteCount: 0,
    browserPushUnsubscribed: false,
    mediaDeletionJobs: [],
    staleSessionRace: null,
    videoUploadSequence: 0,
    videoProgramGets: 0,
    videoProgramRefreshedAfterFatal: false,
    videoUploadCreates: 0,
    videoPartSigns: 0,
    videoPartPuts: 0,
    videoTransientFailures: 0,
    videoCancels: 0,
    videoCompletes: 0,
    videoPolls: 0,
    videoUnpublishes: 0,
    videoSlots: new Map(),
    videoUploads: new Map(),
    videoEvents: [],
    videoEventSequence: 0,
    videoUnexpectedXhrSends: 0,
    videoResumeUploadId: null,
  };
  const fatalSiblingHolds = new Set();
  const releaseFatalSiblingPuts = () => {
    for (const hold of [...fatalSiblingHolds]) {
      if (!hold.response.destroyed && !hold.response.writableEnded) {
        hold.response.writeHead(598, { 'Cache-Control': 'no-store' });
        hold.response.end();
      }
      hold.request.resume();
      hold.release();
    }
  };

  const accountId = (role) => (role === 'client' ? t12ClientId : t12TrainerId);
  const otherRole = (role) => (role === 'client' ? 'trainer' : 'client');
  const lastSequence = () => state.messages.length;
  const readSequence = (role) =>
    role === 'client' ? state.clientReadSequence : state.trainerReadSequence;
  const unreadCount = (role) =>
    state.messages.filter(
      (message) => message.sender_role === otherRole(role) && message.sequence > readSequence(role),
    ).length;
  const conversationState = (role) => ({
    last_message_sequence: lastSequence(),
    own_last_read_sequence: readSequence(role),
    counterpart_last_read_sequence: readSequence(otherRole(role)),
    unread_count: unreadCount(role),
  });
  const projectMessage = (message, role) => ({
    ...message,
    is_mine: message.sender_role === role,
  });
  const appendMessage = ({ senderRole, kind, text, photo = null, clientMessageId = null }) => {
    const sequence = state.messages.length + 1;
    const message = {
      id: `92000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      conversation_id: t12ConversationId,
      sequence,
      client_message_id:
        clientMessageId ?? `94000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      sender_role: senderRole,
      is_mine: true,
      sender_name: senderRole === 'client' ? 'Анна Клиент' : 'Ирина Тренер',
      kind,
      text,
      photo,
      created_at: new Date(Date.UTC(2026, 7, 24, 10, sequence, 0)).toISOString(),
    };
    state.messages.push(message);
    state.messageSenders.push(senderRole);
    return message;
  };
  const readyPhoto = (id, ownerRole = 'client') => ({
    id,
    status: 'ready',
    mime_type: 'image/webp',
    width: 192,
    height: 192,
    size_bytes: 1_024,
    expires_at: fixtureTimestamp(1),
    owner_role: ownerRole,
    object_key: `chat/browser-test/${id}.webp`,
    attached: false,
  });
  const publicPhoto = (photo) => ({
    id: photo.id,
    status: photo.attached ? 'attached' : photo.status,
    mime_type: photo.mime_type,
    width: photo.width,
    height: photo.height,
    size_bytes: photo.size_bytes,
    expires_at: photo.attached ? null : photo.expires_at,
  });
  const lastMessage = () => {
    const message = state.messages.at(-1);
    return message === undefined
      ? null
      : {
          kind: message.kind,
          preview: message.kind === 'photo' ? 'Фото' : message.text,
          created_at: message.created_at,
        };
  };
  const clientConversation = () => ({
    id: t12ConversationId,
    trainer: { display_name: 'Ирина Тренер', avatar_url: null },
    last_message_sequence: lastSequence(),
    last_read_sequence: state.clientReadSequence,
    counterpart_last_read_sequence: state.trainerReadSequence,
    unread_count: unreadCount('client'),
  });
  const inboxConversation = () => ({
    id: t12ConversationId,
    client: {
      display_name: 'Анна Клиент',
      secondary_label: 'chat-client@example.test',
      avatar_url: null,
    },
    last_message: lastMessage(),
    unread_count: unreadCount('trainer'),
    activity_at: state.messages.at(-1)?.created_at ?? '2026-08-24T09:00:00.000Z',
  });
  const chatSession = (role) =>
    role === 'client'
      ? {
          role: 'client',
          enabled: true,
          available: true,
          photo_uploads_enabled: true,
          conversation: state.conversationCreated ? clientConversation() : null,
        }
      : {
          role: 'trainer',
          enabled: true,
          photo_uploads_enabled: true,
          profile: { display_name: 'Ирина Тренер', avatar_url: null },
          unread_count: unreadCount('trainer'),
        };

  const videoDirections = [
    'breathing',
    'strength',
    'body_therapy',
    'functional',
    'stretching',
    'neuro',
    'recovery',
  ];
  const videoDayLabels = [
    'Понедельник',
    'Вторник',
    'Среда',
    'Четверг',
    'Пятница',
    'Суббота',
    'Воскресенье',
  ];
  const videoIdFor = (weekNumber, dayOfWeek) =>
    `95000000-0000-4000-8000-${String(weekNumber * 10 + dayOfWeek).padStart(12, '0')}`;
  const videoSlotKey = (weekNumber, dayOfWeek) => `${weekNumber}:${dayOfWeek}`;
  const videoEvent = (type, record, partNumber = null) => {
    const event = {
      sequence: ++state.videoEventSequence,
      type,
      upload_id: record.id,
      part_number: partNumber,
    };
    state.videoEvents.push(event);
    return event;
  };
  const videoUploadDto = (status, id, sizeBytes, weekNumber, dayOfWeek) => ({
    id,
    video_id: videoIdFor(weekNumber, dayOfWeek),
    week_number: weekNumber,
    day_of_week: dayOfWeek,
    status,
    expected_size_bytes: sizeBytes,
    uploaded_bytes: status === 'uploading' ? 0 : sizeBytes,
    part_size_bytes: 5_242_880,
    part_count: Math.ceil(sizeBytes / 5_242_880),
    expires_at: fixtureTimestamp(1),
    failure_code: null,
    verified_media:
      status === 'published'
        ? {
            duration_seconds: 10,
            width: 1280,
            height: 720,
            video_codec: 'h264',
            audio_codec: null,
            sha256: 'a'.repeat(64),
          }
        : null,
  });
  const ensureVideoSlot = (weekNumber, dayOfWeek) => {
    const key = videoSlotKey(weekNumber, dayOfWeek);
    let slot = state.videoSlots.get(key);
    if (slot === undefined) {
      slot = {
        key,
        weekNumber,
        dayOfWeek,
        liveUploadId: null,
        latestUploadId: null,
        mediaAvailable: false,
        revision: 0,
      };
      state.videoSlots.set(key, slot);
    }
    return slot;
  };
  const createVideoUploadRecord = ({
    id,
    weekNumber,
    dayOfWeek,
    sizeBytes,
    behavior = 'normal',
  }) => {
    const slot = ensureVideoSlot(weekNumber, dayOfWeek);
    assert.equal(slot.liveUploadId, null, `Browser fixture slot ${slot.key} is already busy.`);
    const record = {
      id,
      weekNumber,
      dayOfWeek,
      behavior,
      dto: videoUploadDto('uploading', id, sizeBytes, weekNumber, dayOfWeek),
      acceptedParts: new Map(),
      signedChecksums: new Map(),
      partAttempts: new Map(),
      polls: 0,
      stats: {
        signs: 0,
        putStarts: 0,
        abortedPuts: 0,
        completes: 0,
        cancels: 0,
      },
    };
    state.videoUploads.set(id, record);
    slot.liveUploadId = id;
    slot.latestUploadId = id;
    return record;
  };
  const requireVideoUpload = (uploadId) => {
    const record = state.videoUploads.get(uploadId);
    assert.notEqual(record, undefined, `Unknown browser video upload ${uploadId}.`);
    return record;
  };
  const syntheticPartSize = 5_242_880;
  const resumeRecord = createVideoUploadRecord({
    id: '96900000-0000-4000-8000-000000000005',
    weekNumber: 1,
    dayOfWeek: 5,
    sizeBytes: syntheticVideo.length,
    behavior: 'resume',
  });
  resumeRecord.acceptedParts.set(1, {
    size_bytes: Math.min(syntheticPartSize, syntheticVideo.length),
    checksum_sha256: createHash('sha256')
      .update(syntheticVideo.subarray(0, syntheticPartSize))
      .digest('base64'),
  });
  state.videoResumeUploadId = resumeRecord.id;

  const videoSlot = (weekNumber, dayOfWeek) => {
    const slot = state.videoSlots.get(videoSlotKey(weekNumber, dayOfWeek));
    const live =
      slot?.liveUploadId === null || slot?.liveUploadId === undefined
        ? null
        : requireVideoUpload(slot.liveUploadId).dto;
    const latest =
      slot?.latestUploadId === null || slot?.latestUploadId === undefined
        ? null
        : requireVideoUpload(slot.latestUploadId).dto;
    const mediaAvailable = slot?.mediaAvailable ?? false;
    let slotState = 'empty';
    if (live !== null) {
      slotState = mediaAvailable
        ? 'replacing'
        : ['creating', 'uploading'].includes(live.status)
          ? 'uploading'
          : 'processing';
    } else if (mediaAvailable) {
      slotState = 'available';
    } else if (latest?.status === 'published') {
      slotState = 'hidden';
    } else if (
      ['failed', 'expired', 'superseded', 'verification_quarantined'].includes(latest?.status)
    ) {
      slotState = 'failed';
    }
    return {
      video_id: videoIdFor(weekNumber, dayOfWeek),
      day_of_week: dayOfWeek,
      day_label: videoDayLabels[dayOfWeek - 1],
      direction: videoDirections[dayOfWeek - 1],
      title: `Тренировка ${weekNumber}.${dayOfWeek}`,
      duration_minutes: 25,
      media: {
        available: mediaAvailable,
        revision: slot?.revision ?? 0,
        duration_seconds: latest?.status === 'published' ? 10 : null,
        uploaded_at: latest?.status === 'published' ? fixtureTimestamp(0) : null,
      },
      slot_state: slotState,
      live_upload: live,
      latest_upload: latest,
    };
  };
  const videoProgram = () => ({
    summary: {
      total: 84,
      available: [...state.videoSlots.values()].filter((slot) => slot.mediaAvailable).length,
      processing: [...state.videoSlots.values()].filter((slot) => {
        if (slot.liveUploadId === null) return false;
        return ['completing', 'verification_pending', 'verifying'].includes(
          requireVideoUpload(slot.liveUploadId).dto.status,
        );
      }).length,
      failed: [...state.videoSlots.values()].filter((slot) => {
        if (slot.latestUploadId === null) return false;
        return ['failed', 'expired', 'superseded', 'verification_quarantined'].includes(
          requireVideoUpload(slot.latestUploadId).dto.status,
        );
      }).length,
    },
    weeks: Array.from({ length: 12 }, (_, weekIndex) => ({
      week_number: weekIndex + 1,
      title: `Неделя ${weekIndex + 1}`,
      days: Array.from({ length: 7 }, (_, dayIndex) => videoSlot(weekIndex + 1, dayIndex + 1)),
    })),
  });

  let staleSessionReleasePromise = null;
  let resolveStaleSessionRequests = null;
  const releaseStaleSessionRace = () => {
    const race = state.staleSessionRace;
    if (race === null || race.released) return;
    race.released = true;
    resolveStaleSessionRequests?.();
    resolveStaleSessionRequests = null;
    staleSessionReleasePromise = null;
  };

  let namespace;
  const emitConversationUpdated = (role) => {
    namespace.to(`account:${accountId(role)}`).emit('chat:conversation:updated', {
      conversation_id: t12ConversationId,
      last_message: lastMessage(),
      unread_count: unreadCount(role),
    });
  };
  const emitMessage = (message) => {
    state.messageBroadcastCount.set(
      message.id,
      (state.messageBroadcastCount.get(message.id) ?? 0) + 1,
    );
    for (const role of ['client', 'trainer']) {
      namespace.to(`account:${accountId(role)}`).emit('chat:message:new', {
        message: projectMessage(message, role),
      });
      emitConversationUpdated(role);
    }
  };
  const emitMessageToRole = (message, role) => {
    state.messageBroadcastCount.set(
      message.id,
      (state.messageBroadcastCount.get(message.id) ?? 0) + 1,
    );
    namespace.to(`account:${accountId(role)}`).emit('chat:message:new', {
      message: projectMessage(message, role),
    });
    emitConversationUpdated(role);
  };

  const unauthorized = (response) =>
    json(response, 401, {
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' },
    });

  const server = createFixtureServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', frontendOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Idempotency-Key',
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? '/', frontendOrigin);
    const { pathname } = requestUrl;

    if (request.method === 'GET' && pathname === '/browser-test-health') {
      json(response, 200, { status: 'ok', scenario: 't12' });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/__browser-test/t12/photo/')) {
      const body = await readFile(path.join(frontendDist, 'icons/icon-192.png'));
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-store',
      });
      response.end(body);
      return;
    }

    if (request.method === 'GET' && pathname === '/__browser-test/t14/synthetic.mp4') {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': syntheticVideo.length,
        'Cache-Control': 'private, no-store',
      });
      response.end(syntheticVideo);
      return;
    }
    if (request.method === 'GET' && pathname === '/__browser-test/t14/synthetic-different.mp4') {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': syntheticDifferentVideo.length,
        'Cache-Control': 'private, no-store',
      });
      response.end(syntheticDifferentVideo);
      return;
    }
    if (pathname === '/__browser-test/t14/must-not-send') {
      state.videoUnexpectedXhrSends += 1;
      json(response, 500, {
        error: { code: 'UNEXPECTED_XHR_SEND', message: 'An already-aborted XHR was sent.' },
      });
      return;
    }

    const videoPartPutMatch = pathname.match(
      /^\/__browser-test\/t14\/uploads\/([^/]+)\/parts\/(\d+)$/u,
    );
    if (request.method === 'PUT' && videoPartPutMatch !== null) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.match(String(request.headers['x-amz-checksum-sha256'] ?? ''), /^[A-Za-z0-9+/]{43}=$/u);
      const operationId = videoPartPutMatch[1];
      const partNumber = Number(videoPartPutMatch[2]);
      const record = requireVideoUpload(operationId);
      const checksum = String(request.headers['x-amz-checksum-sha256']);
      assert.equal(record.signedChecksums.get(partNumber), checksum);
      const attempt = (record.partAttempts.get(partNumber) ?? 0) + 1;
      record.partAttempts.set(partNumber, attempt);
      state.videoPartPuts += 1;
      record.stats.putStarts += 1;
      videoEvent('put_start', record, partNumber);
      let aborted = false;
      const markAborted = () => {
        if (aborted) return;
        aborted = true;
        record.stats.abortedPuts += 1;
        videoEvent('put_aborted', record, partNumber);
      };
      request.once('aborted', markAborted);
      response.once('close', () => {
        if (!response.writableEnded) markAborted();
      });
      if (record.behavior === 'fatal-first-part' && partNumber !== 1) {
        request.pause();
        await new Promise((resolve) => {
          let released = false;
          const hold = {
            request,
            response,
            release: () => {
              if (released) return;
              released = true;
              fatalSiblingHolds.delete(hold);
              resolve();
            },
          };
          fatalSiblingHolds.add(hold);
          request.once('aborted', hold.release);
          response.once('close', hold.release);
        });
        return;
      }
      let bytes = 0;
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          await sleep(12);
        }
      } catch (caught) {
        if (aborted || request.destroyed) {
          markAborted();
          return;
        }
        throw caught;
      }
      if (aborted || response.destroyed) return;
      if (record.behavior === 'transient-first-part' && partNumber === 1 && attempt === 1) {
        state.videoTransientFailures += 1;
        videoEvent('transient_rejected', record, partNumber);
        json(response, 503, {
          error: { code: 'S3_TRANSIENT', message: 'Deterministic transient storage failure.' },
        });
        return;
      }
      if (record.behavior === 'fatal-first-part' && partNumber === 1) {
        videoEvent(attempt === 3 ? 'fatal_rejected' : 'fatal_retry_rejected', record, partNumber);
        json(response, 503, {
          error: { code: 'S3_FATAL', message: 'Deterministic fatal part failure.' },
        });
        return;
      }
      record.acceptedParts.set(partNumber, {
        size_bytes: bytes,
        checksum_sha256: checksum,
      });
      videoEvent('put_accepted', record, partNumber);
      response.writeHead(200, {
        ETag: `"browser-part-${partNumber}"`,
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/duplicate-event') {
      const message = appendMessage({
        senderRole: 'trainer',
        kind: 'text',
        text: 'Дубликат realtime должен отобразиться один раз',
      });
      state.duplicateMessageId = message.id;
      const payload = { message: projectMessage(message, 'client') };
      namespace.to(`account:${t12ClientId}`).emit('chat:message:new', payload);
      namespace.to(`account:${t12ClientId}`).emit('chat:message:new', payload);
      emitConversationUpdated('client');
      emitConversationUpdated('client');
      namespace.to(`account:${t12TrainerId}`).emit('chat:message:new', {
        message: projectMessage(message, 'trainer'),
      });
      emitConversationUpdated('trainer');
      json(response, 200, { message_id: message.id, sequence: message.sequence });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/cross-sender-collision') {
      const ownClientMessage = state.messages.find(
        ({ sender_role: senderRole }) => senderRole === 'client',
      );
      assert.notEqual(ownClientMessage, undefined);
      const counterpartMessage = appendMessage({
        senderRole: 'trainer',
        kind: 'text',
        text: 'Сообщение тренера с совпавшим client_message_id',
        clientMessageId: ownClientMessage.client_message_id,
      });
      emitMessage(counterpartMessage);
      json(response, 200, {
        own_message_id: ownClientMessage.id,
        counterpart_message_id: counterpartMessage.id,
        client_message_id: ownClientMessage.client_message_id,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/disconnect-delta') {
      for (const socket of state.sockets.client) {
        socket.conn.close();
      }
      const message = appendMessage({
        senderRole: 'trainer',
        kind: 'text',
        text: 'Пропущенное сообщение восстановлено через REST delta',
      });
      state.missedMessageId = message.id;
      namespace.to(`account:${t12TrainerId}`).emit('chat:message:new', {
        message: projectMessage(message, 'trainer'),
      });
      emitConversationUpdated('trainer');
      json(response, 200, { message_id: message.id, sequence: message.sequence });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/stale-session/arm') {
      assert.equal(
        state.staleSessionRace,
        null,
        'The deterministic stale-session race may only be armed once.',
      );
      assert.equal(unreadCount('client'), 0);
      assert.equal(unreadCount('trainer'), 0);
      staleSessionReleasePromise = new Promise((resolve) => {
        resolveStaleSessionRequests = resolve;
      });
      state.staleSessionRace = {
        snapshots: {
          client: chatSession('client'),
          trainer: chatSession('trainer'),
        },
        heldRequests: { client: 0, trainer: 0 },
        staleResponses: { client: 0, trainer: 0 },
        eventMessageIds: [],
        eventEmitted: false,
        released: false,
      };
      for (const role of ['client', 'trainer']) {
        for (const socket of state.sockets[role]) socket.conn.close();
      }
      json(response, 200, {
        client_unread: state.staleSessionRace.snapshots.client.conversation.unread_count,
        trainer_unread: state.staleSessionRace.snapshots.trainer.unread_count,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/stale-session/emit') {
      const race = state.staleSessionRace;
      assert.notEqual(race, null, 'The stale-session race must be armed before its event.');
      assert.deepEqual(race.heldRequests, { client: 1, trainer: 1 });
      assert.equal(race.eventEmitted, false);
      const clientUnreadMessage = appendMessage({
        senderRole: 'trainer',
        kind: 'text',
        text: 'Новое событие не должно быть затёрто старой client session',
      });
      const trainerUnreadMessage = appendMessage({
        senderRole: 'client',
        kind: 'text',
        text: 'Новое событие не должно быть затёрто старой trainer session',
      });
      race.eventMessageIds = [clientUnreadMessage.id, trainerUnreadMessage.id];
      race.eventEmitted = true;
      emitConversationUpdated('client');
      emitConversationUpdated('trainer');
      json(response, 200, {
        client_unread: unreadCount('client'),
        trainer_unread: unreadCount('trainer'),
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/stale-session/release') {
      const race = state.staleSessionRace;
      assert.notEqual(race, null, 'The stale-session race must be armed before release.');
      assert.equal(race.eventEmitted, true, 'The newer socket event must precede stale release.');
      releaseStaleSessionRace();
      json(response, 200, { released: true });
      return;
    }

    if (request.method === 'POST' && pathname === '/__browser-test/t12/push-unsubscribed') {
      state.browserPushUnsubscribed = true;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'POST' && pathname === '/api/v1/auth/login') {
      const body = await readJsonBody(request);
      const role =
        body.identifier === 'chat-client@example.test' && body.password === 'client-password'
          ? 'client'
          : body.identifier === 'chat-trainer@example.test' && body.password === 'trainer-password'
            ? 'trainer'
            : null;
      if (role === null) {
        json(response, 401, {
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
        });
        return;
      }
      state.loginCount[role] += 1;
      const profile = t12Profile(role);
      const accessToken = `t12-access-${role}-login-${state.loginCount[role]}`;
      state.currentAccessToken[role] = accessToken;
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
          accessToken,
          tokenType: 'Bearer',
          expiresIn: 900,
        },
        {
          'Set-Cookie': `kinetra_refresh=t12-${role}; HttpOnly; Path=/api/v1/auth; SameSite=Lax`,
        },
      );
      return;
    }

    if (request.method === 'POST' && pathname === '/api/v1/auth/refresh') {
      const cookie = String(request.headers.cookie ?? '');
      const role = cookie.includes('kinetra_refresh=t12-client')
        ? 'client'
        : cookie.includes('kinetra_refresh=t12-trainer')
          ? 'trainer'
          : null;
      if (role === null) {
        unauthorized(response);
        return;
      }
      state.refreshCount[role] += 1;
      const profile = t12Profile(role);
      const accessToken = `t12-access-${role}-refresh-${state.refreshCount[role]}`;
      state.currentAccessToken[role] = accessToken;
      json(response, 200, {
        user: {
          id: profile.user.id,
          email: profile.user.email,
          phone: null,
          emailVerified: true,
          createdAt: profile.user.createdAt,
        },
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 900,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/v1/auth/logout') {
      const cookie = String(request.headers.cookie ?? '');
      const role =
        t12AccountForRequest(request) ??
        (cookie.includes('kinetra_refresh=t12-client')
          ? 'client'
          : cookie.includes('kinetra_refresh=t12-trainer')
            ? 'trainer'
            : null);
      if (role !== null) {
        state.logoutCount[role] += 1;
        state.logoutAuthorizations[role].push(String(request.headers.authorization ?? ''));
      }

      if (role === 'trainer' && state.logoutCount.trainer === 1) {
        json(response, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Temporary trainer logout failure.' },
        });
        return;
      }

      response.writeHead(204, {
        'Set-Cookie': 'kinetra_refresh=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax',
      });
      response.end();
      return;
    }

    const role = t12AccountForRequest(request);
    if (pathname.startsWith('/api/') && role === null) {
      unauthorized(response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/me') {
      json(response, 200, t12Profile(role));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/trainer/videos/program') {
      assert.equal(role, 'trainer');
      state.videoProgramGets += 1;
      if (state.videoEvents.some((event) => event.type === 'fatal_rejected'))
        state.videoProgramRefreshedAfterFatal = true;
      json(response, 200, videoProgram(), { 'Cache-Control': 'no-store' });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/v1/trainer/videos/uploads') {
      assert.equal(role, 'trainer');
      const body = await readJsonBody(request);
      assert.equal(body.week_number, 1);
      assert.equal([2, 3, 4, 6].includes(body.day_of_week), true);
      assert.equal(body.mime_type, 'video/mp4');
      assert.equal(Number.isInteger(body.size_bytes) && body.size_bytes > 0, true);
      assert.match(String(request.headers['idempotency-key'] ?? ''), /^[0-9a-f-]{36}$/u);
      state.videoUploadSequence += 1;
      state.videoUploadCreates += 1;
      const id = `96000000-0000-4000-8000-${String(state.videoUploadSequence).padStart(12, '0')}`;
      const record = createVideoUploadRecord({
        id,
        weekNumber: body.week_number,
        dayOfWeek: body.day_of_week,
        sizeBytes: body.size_bytes,
        behavior:
          body.day_of_week === 3
            ? 'transient-first-part'
            : body.day_of_week === 4
              ? 'fatal-first-part'
              : 'normal',
      });
      videoEvent('upload_created', record);
      json(response, 201, { upload: record.dto }, { 'Cache-Control': 'no-store' });
      return;
    }

    const videoPartsMatch = pathname.match(
      /^\/api\/v1\/trainer\/videos\/uploads\/([^/]+)\/parts$/u,
    );
    if (request.method === 'GET' && videoPartsMatch !== null) {
      assert.equal(role, 'trainer');
      const record = requireVideoUpload(videoPartsMatch[1]);
      const parts = [...record.acceptedParts.entries()]
        .map(([partNumber, accepted]) => ({
          part_number: partNumber,
          size_bytes: accepted.size_bytes,
          checksum_sha256: accepted.checksum_sha256,
        }))
        .sort((left, right) => left.part_number - right.part_number);
      json(response, 200, { parts }, { 'Cache-Control': 'no-store' });
      return;
    }
    if (request.method === 'POST' && videoPartsMatch !== null) {
      assert.equal(role, 'trainer');
      const record = requireVideoUpload(videoPartsMatch[1]);
      const slot = ensureVideoSlot(record.weekNumber, record.dayOfWeek);
      assert.equal(slot.liveUploadId, record.id);
      assert.equal(record.dto.status, 'uploading');
      const body = await readJsonBody(request);
      assert.equal(Array.isArray(body.parts), true);
      state.videoPartSigns += body.parts.length;
      record.stats.signs += body.parts.length;
      for (const part of body.parts) {
        assert.equal(Number.isInteger(part.part_number), true);
        assert.match(String(part.checksum_sha256 ?? ''), /^[A-Za-z0-9+/]{43}=$/u);
        record.signedChecksums.set(part.part_number, part.checksum_sha256);
        videoEvent('part_signed', record, part.part_number);
      }
      json(
        response,
        200,
        {
          parts: body.parts.map((part) => ({
            part_number: part.part_number,
            upload_url: `${frontendOrigin}/__browser-test/t14/uploads/${videoPartsMatch[1]}/parts/${part.part_number}`,
            expires_at: fixtureTimestamp(1),
            required_headers: { 'x-amz-checksum-sha256': part.checksum_sha256 },
          })),
        },
        { 'Cache-Control': 'no-store' },
      );
      return;
    }

    const videoCompleteMatch = pathname.match(
      /^\/api\/v1\/trainer\/videos\/uploads\/([^/]+)\/complete$/u,
    );
    if (request.method === 'POST' && videoCompleteMatch !== null) {
      assert.equal(role, 'trainer');
      const record = requireVideoUpload(videoCompleteMatch[1]);
      const slot = ensureVideoSlot(record.weekNumber, record.dayOfWeek);
      assert.equal(slot.liveUploadId, record.id);
      assert.deepEqual(await readJsonBody(request), {});
      assert.equal(record.acceptedParts.size, record.dto.part_count);
      state.videoCompletes += 1;
      record.stats.completes += 1;
      videoEvent('complete', record);
      record.dto = {
        ...record.dto,
        status: 'verification_pending',
        uploaded_bytes: record.dto.expected_size_bytes,
      };
      json(
        response,
        202,
        { upload: record.dto },
        { 'Cache-Control': 'no-store', 'Retry-After': '1' },
      );
      return;
    }

    const videoUploadMatch = pathname.match(/^\/api\/v1\/trainer\/videos\/uploads\/([^/]+)$/u);
    if (request.method === 'DELETE' && videoUploadMatch !== null) {
      assert.equal(role, 'trainer');
      const record = requireVideoUpload(videoUploadMatch[1]);
      const slot = ensureVideoSlot(record.weekNumber, record.dayOfWeek);
      assert.equal(slot.liveUploadId, record.id);
      assert.deepEqual(await readJsonBody(request), {});
      state.videoCancels += 1;
      record.stats.cancels += 1;
      videoEvent('cancel', record);
      const cancelled = {
        ...record.dto,
        status: 'cancelled',
      };
      record.dto = cancelled;
      slot.latestUploadId = record.id;
      slot.liveUploadId = null;
      json(response, 200, { upload: cancelled }, { 'Cache-Control': 'no-store' });
      return;
    }
    if (request.method === 'GET' && videoUploadMatch !== null) {
      assert.equal(role, 'trainer');
      const record = requireVideoUpload(videoUploadMatch[1]);
      const slot = ensureVideoSlot(record.weekNumber, record.dayOfWeek);
      assert.equal(slot.liveUploadId, record.id);
      state.videoPolls += 1;
      record.polls += 1;
      if (record.polls === 1) {
        record.dto = { ...record.dto, status: 'verifying' };
      } else {
        record.dto = videoUploadDto(
          'published',
          record.id,
          record.dto.expected_size_bytes,
          record.weekNumber,
          record.dayOfWeek,
        );
        slot.mediaAvailable = true;
        slot.revision += 1;
        slot.latestUploadId = record.id;
        slot.liveUploadId = null;
        videoEvent('published', record);
      }
      json(
        response,
        200,
        { upload: record.dto },
        { 'Cache-Control': 'no-store', 'Retry-After': '1' },
      );
      return;
    }

    const videoPreviewMatch = pathname.match(
      /^\/api\/v1\/trainer\/videos\/workouts\/([^/]+)\/preview-url$/u,
    );
    if (request.method === 'GET' && videoPreviewMatch !== null) {
      assert.equal(role, 'trainer');
      const slot = [...state.videoSlots.values()].find(
        (candidate) =>
          videoIdFor(candidate.weekNumber, candidate.dayOfWeek) === videoPreviewMatch[1],
      );
      assert.notEqual(slot, undefined);
      assert.notEqual(slot.latestUploadId, null);
      assert.equal(requireVideoUpload(slot.latestUploadId).dto.status, 'published');
      json(
        response,
        200,
        {
          url: `${frontendOrigin}/__browser-test/t14/synthetic.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KINETRA_BROWSER_TEST%2F20260825%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260825T120000Z&X-Amz-Expires=${videoPreviewExpiresInSeconds}&X-Amz-SignedHeaders=host&X-Amz-Signature=${videoPreviewSignature}`,
          expires_at: new Date(
            browserFixtureNow + videoPreviewExpiresInSeconds * 1_000,
          ).toISOString(),
        },
        { 'Cache-Control': 'no-store' },
      );
      return;
    }

    const videoUnpublishMatch = pathname.match(
      /^\/api\/v1\/trainer\/videos\/weeks\/(\d+)\/days\/(\d+)\/unpublish$/u,
    );
    if (request.method === 'POST' && videoUnpublishMatch !== null) {
      assert.equal(role, 'trainer');
      assert.deepEqual(await readJsonBody(request), {});
      const weekNumber = Number(videoUnpublishMatch[1]);
      const dayOfWeek = Number(videoUnpublishMatch[2]);
      const slot = ensureVideoSlot(weekNumber, dayOfWeek);
      assert.notEqual(slot.latestUploadId, null);
      assert.equal(requireVideoUpload(slot.latestUploadId).dto.status, 'published');
      state.videoUnpublishes += 1;
      if (slot.mediaAvailable) slot.revision += 1;
      slot.mediaAvailable = false;
      json(response, 200, videoSlot(weekNumber, dayOfWeek), { 'Cache-Control': 'no-store' });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/settings/subscription') {
      json(response, 200, {
        status: 'active',
        provider: 'yukassa',
        starts_at: initialSubscriptionStartsAt,
        expires_at: initialSubscriptionExpiresAt,
        amount: 799,
        currency: 'RUB',
        auto_renew: true,
        days_remaining: 30,
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/settings/profile') {
      const profile = t12Profile(role);
      json(response, 200, {
        email: profile.user.email,
        phone: null,
        created_at: profile.user.createdAt,
        onboarding_status: 'active',
        notification_preferences: {
          workout_reminders: true,
          reminder_time: '09:00',
          weekly_survey_reminder: true,
        },
      });
      return;
    }

    if (request.method === 'DELETE' && pathname === '/api/v1/push/subscriptions') {
      state.pushSubscriptionDeleteCount += 1;
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (request.method === 'DELETE' && pathname === '/api/v1/settings/account') {
      assert.equal(role, 'client', 'Only the T12 client account is deleted in this scenario.');
      assert.deepEqual(await readJsonBody(request), { confirm: 'DELETE' });
      state.accountDeleteAuthorization = String(request.headers.authorization ?? '');
      assert.equal(
        state.accountDeleteAuthorization,
        state.accountDeleteExpectedAuthorization,
        'Account deletion must use the access token captured before browser push cleanup.',
      );
      assert.equal(
        state.browserPushUnsubscribed,
        true,
        'Strict browser push unsubscribe must complete before account deletion starts.',
      );
      state.accountDeleteCount += 1;
      for (const photo of state.photos.values()) {
        state.mediaDeletionJobs.push({
          object_key: photo.object_key,
          reason: 'account_deleted',
          attempts: 0,
        });
      }
      state.conversationCreated = false;
      state.messages.length = 0;
      response.writeHead(204, {
        'Cache-Control': 'no-store',
        'Set-Cookie': 'kinetra_refresh=; HttpOnly; Path=/api/v1/auth; Max-Age=0; SameSite=Lax',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/program/current-week') {
      json(response, 200, programWeekPayload(1));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/chat/session') {
      const race = state.staleSessionRace;
      if (race !== null && !race.released && race.heldRequests[role] === 0) {
        race.heldRequests[role] += 1;
        const staleSnapshot = race.snapshots[role];
        const releasePromise = staleSessionReleasePromise;
        assert.notEqual(releasePromise, null);
        await releasePromise;
        race.staleResponses[role] += 1;
        json(response, 200, staleSnapshot);
        return;
      }
      json(response, 200, chatSession(role));
      return;
    }

    if (request.method === 'POST' && pathname === '/api/v1/chat/conversations') {
      assert.equal(role, 'client', 'Only the client may create the T12 conversation.');
      state.conversationCreated = true;
      json(response, 201, { conversation: clientConversation() });
      setImmediate(() => {
        emitConversationUpdated('client');
        emitConversationUpdated('trainer');
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/v1/chat/conversations') {
      assert.equal(role, 'trainer', 'Only the trainer may load the T12 inbox.');
      const filter = requestUrl.searchParams.get('filter') ?? 'all';
      const query = (requestUrl.searchParams.get('query') ?? '').toLocaleLowerCase('ru-RU');
      const matches =
        state.conversationCreated &&
        (filter !== 'unread' || unreadCount('trainer') > 0) &&
        (query.length === 0 || 'анна клиент chat-client@example.test'.includes(query));
      json(response, 200, {
        items: matches ? [inboxConversation()] : [],
        next_cursor: null,
      });
      return;
    }

    const conversationSummaryMatch = pathname.match(/^\/api\/v1\/chat\/conversations\/([^/]+)$/u);
    if (request.method === 'GET' && conversationSummaryMatch !== null) {
      if (role !== 'trainer') {
        json(response, 403, {
          error: { code: 'CHAT_NOT_AVAILABLE', message: 'Trainer access is required.' },
        });
        return;
      }
      if (!state.conversationCreated || conversationSummaryMatch[1] !== t12ConversationId) {
        json(response, 404, {
          error: { code: 'CHAT_RESOURCE_NOT_FOUND', message: 'Chat resource not found.' },
        });
        return;
      }
      json(response, 200, { conversation: inboxConversation() });
      return;
    }

    const photoUploadMatch = pathname.match(/^\/api\/v1\/chat\/conversations\/([^/]+)\/photos$/u);
    if (request.method === 'POST' && photoUploadMatch !== null) {
      assert.equal(photoUploadMatch[1], t12ConversationId);
      assert.equal(role, 'client');
      assert.match(String(request.headers['content-type'] ?? ''), /^multipart\/form-data;/u);
      const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
      assert.ok(idempotencyKey.length > 0, 'Photo upload requires an Idempotency-Key.');
      for await (const chunk of request) {
        // Drain the deterministic browser fixture upload without parsing private bytes.
        void chunk;
      }
      if (!state.photoUploadKeyOrder.includes(idempotencyKey)) {
        state.photoUploadKeyOrder.push(idempotencyKey);
      }
      const attempts = (state.photoUploadAttempts.get(idempotencyKey) ?? 0) + 1;
      state.photoUploadAttempts.set(idempotencyKey, attempts);
      const photoIndex = state.photoUploadKeyOrder.indexOf(idempotencyKey) + 1;

      if (photoIndex === 2 && attempts === 1) {
        json(response, 503, {
          error: {
            code: 'CHAT_PHOTO_STORAGE_UNAVAILABLE',
            message: 'Photo storage is temporarily unavailable.',
          },
        });
        return;
      }

      const photoId = `93000000-0000-4000-8000-${String(photoIndex).padStart(12, '0')}`;
      let photo = state.photos.get(photoId);
      if (photo === undefined) {
        photo = readyPhoto(photoId);
        state.photos.set(photoId, photo);
      }
      json(response, attempts === 1 ? 201 : 200, { photo: publicPhoto(photo) });
      return;
    }

    const photoStatusMatch = pathname.match(/^\/api\/v1\/chat\/photos\/([^/]+)\/status$/u);
    if (request.method === 'GET' && photoStatusMatch !== null) {
      const photo = state.photos.get(photoStatusMatch[1]);
      const allowed =
        photo !== undefined &&
        (photo.owner_role === role ||
          (photo.attached && (role === 'client' || role === 'trainer')));
      if (!allowed) {
        json(response, 404, {
          error: { code: 'CHAT_RESOURCE_NOT_FOUND', message: 'Chat resource not found.' },
        });
        return;
      }
      json(response, 200, { photo: publicPhoto(photo) });
      return;
    }

    const photoAccessMatch = pathname.match(/^\/api\/v1\/chat\/photos\/([^/]+)\/access$/u);
    if (request.method === 'GET' && photoAccessMatch !== null) {
      const photo = state.photos.get(photoAccessMatch[1]);
      const allowed =
        photo !== undefined &&
        (photo.owner_role === role ||
          (photo.attached && (role === 'client' || role === 'trainer')));
      state.photoAccessRequests.push({ role, photoId: photoAccessMatch[1], allowed });
      if (!allowed) {
        json(response, 404, {
          error: { code: 'CHAT_RESOURCE_NOT_FOUND', message: 'Chat resource not found.' },
        });
        return;
      }
      json(response, 200, {
        url: `${frontendOrigin}/__browser-test/t12/photo/${photo.id}`,
        expires_at: fixtureTimestamp(1),
      });
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/v1\/chat\/conversations\/([^/]+)\/messages$/u);
    if (messagesMatch !== null && messagesMatch[1] !== t12ConversationId) {
      json(response, 404, {
        error: { code: 'CHAT_CONVERSATION_NOT_FOUND', message: 'Conversation not found.' },
      });
      return;
    }

    if (request.method === 'GET' && messagesMatch !== null) {
      const before = Number(requestUrl.searchParams.get('before_sequence') ?? 0);
      const after = Number(requestUrl.searchParams.get('after_sequence') ?? 0);
      const filtered = state.messages.filter((message) => {
        if (Number.isInteger(before) && before > 0) return message.sequence < before;
        if (Number.isInteger(after) && after > 0) return message.sequence > after;
        return true;
      });
      if (Number.isInteger(after) && after > 0) {
        state.deltaQueries.push({
          role,
          afterSequence: after,
          returnedSequences: filtered.map(({ sequence }) => sequence),
        });
      }
      json(response, 200, {
        messages: filtered.map((message) => projectMessage(message, role)),
        conversation_state: conversationState(role),
        next_before_sequence: null,
        has_more_before: false,
        next_after_sequence: filtered.at(-1)?.sequence ?? null,
        has_more_after: false,
      });
      return;
    }

    if (request.method === 'POST' && messagesMatch !== null) {
      const body = await readJsonBody(request);
      assert.ok(body.kind === 'text' || body.kind === 'photo');
      assert.equal(typeof body.client_message_id, 'string');
      assert.ok(body.client_message_id.length > 0);
      if (body.kind === 'text') {
        assert.equal(typeof body.text, 'string');
        assert.ok(body.text.trim().length > 0);
      } else {
        assert.ok(body.text === null || typeof body.text === 'string');
        assert.equal(typeof body.photo_id, 'string');
      }
      const requestAttemptKey = `${role}:${body.client_message_id}`;
      const requestAttempt = (state.messageRequestAttempts.get(requestAttemptKey) ?? 0) + 1;
      state.messageRequestAttempts.set(requestAttemptKey, requestAttempt);
      const replay = state.messages.find(
        (message) =>
          message.sender_role === role && message.client_message_id === body.client_message_id,
      );
      if (replay !== undefined) {
        const replayText =
          body.text === null || body.text === undefined || body.text.trim().length === 0
            ? null
            : body.text.trim();
        assert.equal(body.kind, replay.kind);
        assert.equal(replayText, replay.text);
        assert.equal(body.kind === 'photo' ? body.photo_id : null, replay.photo?.id ?? null);
        json(response, 200, {
          message: projectMessage(replay, role),
          conversation_state: conversationState(role),
          replayed: true,
        });
        return;
      }
      let attachedPhoto = null;
      if (body.kind === 'photo') {
        const photo = state.photos.get(body.photo_id);
        assert.notEqual(photo, undefined, 'Photo message must reference an uploaded photo.');
        assert.equal(photo.owner_role, role);
        assert.equal(photo.attached, false);
        photo.attached = true;
        attachedPhoto = publicPhoto(photo);
      }
      const message = appendMessage({
        senderRole: role,
        kind: body.kind,
        text:
          body.text === null || body.text === undefined || body.text.trim().length === 0
            ? null
            : body.text.trim(),
        photo: attachedPhoto,
        clientMessageId: body.client_message_id,
      });
      if (
        role === 'client' &&
        body.kind === 'text' &&
        body.text.trim() === 'Сообщение клиента через realtime' &&
        requestAttempt === 1
      ) {
        emitMessageToRole(message, 'trainer');
        const committedPayload = JSON.stringify({
          message: projectMessage(message, role),
          conversation_state: conversationState(role),
          replayed: false,
        });
        response.writeHead(201, {
          'Content-Length': Buffer.byteLength(committedPayload),
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.flushHeaders();
        response.write(committedPayload.slice(0, Math.max(1, committedPayload.length - 1)));
        await sleep(100);
        response.destroy();
        return;
      }
      json(response, 201, {
        message: projectMessage(message, role),
        conversation_state: conversationState(role),
        replayed: false,
      });
      setImmediate(() => emitMessage(message));
      return;
    }

    const readMatch = pathname.match(/^\/api\/v1\/chat\/conversations\/([^/]+)\/read$/u);
    if (request.method === 'PUT' && readMatch !== null) {
      assert.equal(readMatch[1], t12ConversationId);
      const body = await readJsonBody(request);
      assert.equal(Number.isInteger(body.through_sequence), true);
      const throughSequence = Math.max(0, Math.min(body.through_sequence, lastSequence()));
      if (role === 'client')
        state.clientReadSequence = Math.max(state.clientReadSequence, throughSequence);
      if (role === 'trainer')
        state.trainerReadSequence = Math.max(state.trainerReadSequence, throughSequence);
      state.readUpdates.push({ role, throughSequence });
      json(response, 200, { conversation_state: conversationState(role) });
      setImmediate(() => {
        const payload = {
          conversation_id: t12ConversationId,
          reader_role: role,
          through_sequence: throughSequence,
          read_at: new Date().toISOString(),
        };
        namespace.to(`account:${t12ClientId}`).emit('chat:read:updated', payload);
        namespace.to(`account:${t12TrainerId}`).emit('chat:read:updated', payload);
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
      return;
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    let filePath = path.join(frontendDist, requested);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) filePath = path.join(frontendDist, 'index.html');
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

  const socketServer = new SocketIOServer(server, {
    cors: { origin: frontendOrigin, credentials: true },
    transports: ['websocket'],
  });
  namespace = socketServer.of('/chat');
  namespace.use((socket, next) => {
    const accessToken =
      typeof socket.handshake.auth.accessToken === 'string'
        ? socket.handshake.auth.accessToken
        : '';
    const role = t12AccountForToken(accessToken);
    if (role === null) {
      next(new Error('Authentication required.'));
      return;
    }
    socket.data.role = role;
    next();
  });
  namespace.on('connection', (socket) => {
    const role = socket.data.role;
    state.socketConnectionCount[role] += 1;
    state.socketConnections[role].add(socket.id);
    state.sockets[role].add(socket);
    void socket.join(`account:${accountId(role)}`);
    socket.on('chat:sync', (_event, acknowledge) => acknowledge({ delta_required: false }));
    socket.on('disconnect', () => {
      state.socketDisconnectCount[role] += 1;
      state.socketConnections[role].delete(socket.id);
      state.sockets[role].delete(socket);
    });
  });

  return { server, socketServer, state, releaseFatalSiblingPuts, releaseStaleSessionRace };
};

const launchT12BrowserContext = async (profileDirectory, width, height) => {
  let chromeErrors = '';
  const chrome = spawn(
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
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDirectory}`,
      `${frontendOrigin}/login`,
    ],
    {
      detached: chromeOwnsProcessGroup,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
  chrome.stderr.on('data', (chunk) => {
    chromeErrors += chunk.toString();
  });
  const commandStream = chrome.stdio[3];
  const responseStream = chrome.stdio[4];
  assert.notEqual(commandStream, null, 'Chrome did not expose its T12 CDP command pipe.');
  assert.notEqual(responseStream, null, 'Chrome did not expose its T12 CDP response pipe.');
  const cdp = new CdpClient(commandStream, responseStream);
  await cdp.connect();
  await cdp.attachToPage();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const pushStorageKey = 'kinetra.t12-browser.push-active.v1';
      const state = {
        online: true,
        visibility: 'visible',
        pushSubscribed: sessionStorage.getItem(pushStorageKey) === 'true',
        pushUnsubscribeCalls: 0,
        lifecycleOrder: [],
        t14XhrSendCalls: 0,
        t14ActiveXhrAborts: [],
        t14AbortBeforeNextXhr: false,
        t14PreAbortedXhrTriggers: 0,
        t14PreAbortedControllerCount: 0,
      };
      const persistPush = () => {
        if (state.pushSubscribed) sessionStorage.setItem(pushStorageKey, 'true');
        else sessionStorage.removeItem(pushStorageKey);
      };
      const subscription = {
        endpoint: ${JSON.stringify(browserPushEndpoint)},
        expirationTime: null,
        toJSON: () => ({
          endpoint: ${JSON.stringify(browserPushEndpoint)},
          expirationTime: null,
          keys: {
            p256dh: ${JSON.stringify(browserPushP256dh)},
            auth: ${JSON.stringify(browserPushAuth)},
          },
        }),
        unsubscribe: async () => {
          state.lifecycleOrder.push('browser-unsubscribe:start');
          state.pushUnsubscribeCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          state.pushSubscribed = false;
          persistPush();
          state.lifecycleOrder.push('browser-unsubscribe:done');
          await fetch('/__browser-test/t12/push-unsubscribed', {
            method: 'POST',
            credentials: 'include',
          });
          return true;
        },
      };
      const NativeAbortController = window.AbortController;
      const trackedT14Controllers = [];
      let captureT14Controllers = false;
      class TrackedT14AbortController extends NativeAbortController {
        constructor() {
          super();
          if (captureT14Controllers) trackedT14Controllers.push(this);
        }
      }
      Object.defineProperty(window, 'AbortController', {
        configurable: true,
        writable: true,
        value: TrackedT14AbortController,
      });
      const NativeXmlHttpRequest = window.XMLHttpRequest;
      const nativeXhrAbort = NativeXmlHttpRequest.prototype.abort;
      const nativeXhrOpen = NativeXmlHttpRequest.prototype.open;
      const nativeXhrSend = NativeXmlHttpRequest.prototype.send;
      const t14XhrDetails = new WeakMap();
      NativeXmlHttpRequest.prototype.open = function (method, url, ...args) {
        t14XhrDetails.set(this, {
          finished: false,
          method: String(method).toUpperCase(),
          pathname: new URL(String(url), window.location.href).pathname,
          sent: false,
        });
        return nativeXhrOpen.call(this, method, url, ...args);
      };
      NativeXmlHttpRequest.prototype.send = function (...args) {
        state.t14XhrSendCalls += 1;
        const details = t14XhrDetails.get(this);
        if (details !== undefined) {
          details.sent = true;
          this.addEventListener(
            'loadend',
            () => {
              details.finished = true;
            },
            { once: true },
          );
        }
        return nativeXhrSend.apply(this, args);
      };
      NativeXmlHttpRequest.prototype.abort = function (...args) {
        const details = t14XhrDetails.get(this);
        if (
          details !== undefined &&
          details.method === 'PUT' &&
          details.sent &&
          !details.finished
        )
          state.t14ActiveXhrAborts.push(details.pathname);
        return nativeXhrAbort.apply(this, args);
      };
      const nativeFetch = window.fetch.bind(window);
      const abortAfterSignResponseJson = new WeakSet();
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const input = args[0];
        const init = args[1];
        const requestMethod = String(
          init?.method ?? (input instanceof Request ? input.method : 'GET'),
        ).toUpperCase();
        const requestUrl = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.href,
        );
        if (
          state.t14AbortBeforeNextXhr &&
          requestMethod === 'POST' &&
          new RegExp('^/api/v1/trainer/videos/uploads/[^/]+/parts$', 'u').test(
            requestUrl.pathname,
          )
        ) {
          abortAfterSignResponseJson.add(response);
        }
        return response;
      };
      const nativeResponseJson = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const value = await nativeResponseJson.apply(this, args);
        if (state.t14AbortBeforeNextXhr && abortAfterSignResponseJson.has(this)) {
          state.t14AbortBeforeNextXhr = false;
          captureT14Controllers = false;
          state.t14PreAbortedXhrTriggers += 1;
          state.t14PreAbortedControllerCount = trackedT14Controllers.length;
          for (const controller of trackedT14Controllers.splice(0)) controller.abort();
        }
        return value;
      };
      try {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => state.visibility,
        });
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => state.visibility === 'hidden',
        });
      } catch {
        // Assertions on the exposed state still fail if the browser forbids this test override.
      }
      try {
        Object.defineProperty(Navigator.prototype, 'onLine', {
          configurable: true,
          get: () => state.online,
        });
      } catch {
        // Assertions on navigator.onLine expose unsupported browser versions.
      }
      if (typeof PushManager !== 'undefined') {
        Object.defineProperty(PushManager.prototype, 'getSubscription', {
          configurable: true,
          value: async () => state.pushSubscribed ? subscription : null,
        });
      }
      Object.defineProperty(window, '__kinetraT12BrowserTest', {
        configurable: false,
        value: {
          state,
          setVisibility: (visibility) => {
            state.visibility = visibility;
            document.dispatchEvent(new Event('visibilitychange'));
          },
          setOnline: (online) => {
            state.online = online;
            window.dispatchEvent(new Event(online ? 'online' : 'offline'));
          },
          activatePushSubscription: () => {
            state.pushSubscribed = true;
            persistPush();
          },
          armAbortBeforeNextVideoXhr: () => {
            trackedT14Controllers.splice(0);
            captureT14Controllers = true;
            state.t14AbortBeforeNextXhr = true;
            return state.t14XhrSendCalls;
          },
        },
      });
    })();`,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await cdp.send('Page.navigate', { url: `${frontendOrigin}/login` });

  const exists = (testId) =>
    cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))}) !== null`);
  const pathname = () => cdp.evaluate('window.location.pathname');
  const bodyText = () => cdp.evaluate("document.body?.innerText ?? ''");
  const text = (testId) =>
    cdp.evaluate(
      `document.querySelector(${JSON.stringify(selector(testId))})?.textContent?.trim() ?? null`,
    );
  const disabled = (testId) =>
    cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector(testId))})?.disabled)`);
  const click = (testId) =>
    cdp.evaluate(`document.querySelector(${JSON.stringify(selector(testId))})?.click()`);
  const trustedClick = async (testId) => {
    const point = await cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector(testId))});
      if (!(element instanceof HTMLElement)) {
        throw new Error('T12 trusted-click target not found: ${testId}');
      }
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error('T12 trusted-click target is not visible: ${testId}');
      }
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  };
  const pressEscape = async () => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  };
  const setValue = (testId, value) =>
    cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector(testId))});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error('T12 input not found: ${testId}');
      }
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  let navigationSequence = 0;
  const navigate = async (route) => {
    const previousDocumentMarker = `t12-navigation-${++navigationSequence}`;
    await cdp.evaluate(
      `document.documentElement.dataset.kinetraBrowserDocument = ${JSON.stringify(previousDocumentMarker)}`,
    );
    const result = await cdp.send('Page.navigate', { url: `${frontendOrigin}${route}` });
    if (typeof result.errorText === 'string') {
      throw new Error(`T12 navigation to ${route} failed: ${result.errorText}`);
    }
    await waitFor(
      `new browser document for ${route}`,
      async () =>
        (await cdp.evaluate(
          `document.documentElement.dataset.kinetraBrowserDocument !== ${JSON.stringify(previousDocumentMarker)} && document.readyState === 'complete'`,
        )) === true,
      20_000,
    );
    return result;
  };
  const setVisibility = (visibility) =>
    cdp.evaluate(`window.__kinetraT12BrowserTest.setVisibility(${JSON.stringify(visibility)})`);
  const setOnline = (online) =>
    cdp.evaluate(`window.__kinetraT12BrowserTest.setOnline(${JSON.stringify(online)})`);
  const setViewport = (nextWidth, nextHeight) =>
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width: nextWidth,
      height: nextHeight,
      screenWidth: nextWidth,
      screenHeight: nextHeight,
      deviceScaleFactor: 1,
      mobile: nextWidth < 600,
    });
  const setTheme = async (theme) => {
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [
        {
          name: 'prefers-color-scheme',
          value: theme === 'light' ? 'light' : 'dark',
        },
      ],
    });
    await cdp.evaluate(`(() => {
      const next = ${JSON.stringify(theme)};
      localStorage.setItem('kinetra.theme.v1', next);
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'kinetra.theme.v1',
        newValue: next,
      }));
    })()`);
  };
  const layoutMetrics = () =>
    cdp.evaluate(`(() => {
      const root = document.documentElement;
      const fab = document.querySelector(${JSON.stringify(selector('chat-fab'))});
      const tabBar = document.querySelector('nav');
      const fabRect = fab?.getBoundingClientRect() ?? null;
      const tabRect = tabBar?.getBoundingClientRect() ?? null;
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: root.scrollWidth,
        theme: root.dataset.theme ?? null,
        themePreference: root.dataset.themePreference ?? null,
        fab: fabRect === null ? null : {
          width: fabRect.width,
          height: fabRect.height,
          right: fabRect.right,
          bottom: fabRect.bottom,
        },
        tab: tabRect === null ? null : {
          top: tabRect.top,
          bottom: tabRect.bottom,
        },
      };
    })()`);
  const cspImageSources = () =>
    cdp.evaluate(`(() => {
      const content = document.querySelector(
        'meta[http-equiv="Content-Security-Policy" i]',
      )?.getAttribute('content') ?? '';
      const directive = content.split(';').map((part) => part.trim()).find(
        (part) => part.startsWith('img-src '),
      );
      return directive === undefined ? [] : directive.split(/\\s+/u).slice(1);
    })()`);
  const selectPhoto = (name) =>
    cdp.evaluate(`(async () => {
      const input = document.querySelector(${JSON.stringify(selector('chat-photo-input'))});
      if (!(input instanceof HTMLInputElement)) throw new Error('T12 photo input not found.');
      const response = await fetch('/icons/icon-192.png', { cache: 'no-store' });
      const blob = await response.blob();
      const file = new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  const selectVideo = (name, variant = 'normal') =>
    cdp.evaluate(`(async () => {
      const input = document.querySelector(${JSON.stringify(selector('trainer-video-file-input'))});
      if (!(input instanceof HTMLInputElement)) throw new Error('T14 video input not found.');
      const response = await fetch(${JSON.stringify(
        variant === 'different'
          ? '/__browser-test/t14/synthetic-different.mp4'
          : '/__browser-test/t14/synthetic.mp4',
      )}, { cache: 'no-store' });
      const blob = await response.blob();
      const file = new File([blob], ${JSON.stringify(name)}, { type: 'video/mp4' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return file.size;
    })()`);
  const armAbortBeforeNextVideoXhr = () =>
    cdp.evaluate('window.__kinetraT12BrowserTest.armAbortBeforeNextVideoXhr()');
  const videoXhrState = () =>
    cdp.evaluate(`(() => ({
      sendCalls: window.__kinetraT12BrowserTest.state.t14XhrSendCalls,
      activeAborts: [...window.__kinetraT12BrowserTest.state.t14ActiveXhrAborts],
      triggers: window.__kinetraT12BrowserTest.state.t14PreAbortedXhrTriggers,
      controllerCount: window.__kinetraT12BrowserTest.state.t14PreAbortedControllerCount,
    }))()`);
  const videoSlotUi = (weekNumber, dayOfWeek) =>
    cdp.evaluate(`(() => {
      const progress = document.querySelector(${JSON.stringify(
        selector(`trainer-video-progress-${weekNumber}-${dayOfWeek}`),
      )});
      const cancel = document.querySelector(${JSON.stringify(
        selector(`trainer-video-cancel-${weekNumber}-${dayOfWeek}`),
      )});
      const resume = document.querySelector(${JSON.stringify(
        selector(`trainer-video-resume-${weekNumber}-${dayOfWeek}`),
      )});
      const upload = document.querySelector(${JSON.stringify(
        selector(`trainer-video-upload-${weekNumber}-${dayOfWeek}`),
      )});
      return {
        progress: progress?.getAttribute('aria-valuenow') === null || progress === null
          ? null
          : Number(progress.getAttribute('aria-valuenow')),
        cancel: cancel instanceof HTMLButtonElement,
        cancelDisabled: cancel instanceof HTMLButtonElement ? cancel.disabled : null,
        resume: resume instanceof HTMLButtonElement,
        resumeDisabled: resume instanceof HTMLButtonElement ? resume.disabled : null,
        upload: upload instanceof HTMLButtonElement,
        uploadDisabled: upload instanceof HTMLButtonElement ? upload.disabled : null,
      };
    })()`);
  const videoCapabilityState = (accessToken = null) =>
    cdp.evaluate(`(async () => {
      const signedNeedle = 'X-Amz-Signature=';
      const preview = document.querySelector('.trainer-video-preview video');
      const previewUrl = preview instanceof HTMLVideoElement ? (preview.currentSrc || preview.src) : null;
      const localValues = Object.values(localStorage).map(String);
      const sessionValues = Object.values(sessionStorage).map(String);
      const historyState = JSON.stringify(window.history.state ?? null);
      const cacheRequests = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        cacheRequests.push(...(await cache.keys()).map((request) => request.url));
      }
      const token = ${JSON.stringify(accessToken ?? '')};
      return {
        previewUrl,
        capabilityInDom: [...document.querySelectorAll('[src], [href]')].some((element) =>
          String(element.getAttribute('src') ?? element.getAttribute('href') ?? '').includes(signedNeedle)
        ),
        capabilityInLocalStorage: localValues.some((value) => value.includes(signedNeedle)),
        capabilityInSessionStorage: sessionValues.some((value) => value.includes(signedNeedle)),
        capabilityInHistory: historyState.includes(signedNeedle),
        capabilityInCache: cacheRequests.some((url) => url.includes(signedNeedle)),
        accessTokenInStorage: token.length > 0 && [...localValues, ...sessionValues].some((value) =>
          value.includes(token)
        ),
      };
    })()`);
  const messageCount = (messageId) =>
    cdp.evaluate(
      `document.querySelectorAll('[data-message-id=${JSON.stringify(messageId)}]').length`,
    );
  const viewerOpen = () =>
    cdp.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector('chat-photo-viewer'))})?.open)`,
    );
  const viewerHistoryId = () =>
    cdp.evaluate('window.history.state?.kinetraChatPhotoViewer ?? null');
  const activatePushSubscription = () =>
    cdp.evaluate('window.__kinetraT12BrowserTest.activatePushSubscription()');
  const pushLifecycle = () =>
    cdp.evaluate(`(() => ({
      subscribed: window.__kinetraT12BrowserTest.state.pushSubscribed,
      unsubscribeCalls: window.__kinetraT12BrowserTest.state.pushUnsubscribeCalls,
      order: [...window.__kinetraT12BrowserTest.state.lifecycleOrder],
    }))()`);
  const authenticatedFetch = (route, token) =>
    cdp.evaluate(`fetch(${JSON.stringify(route)}, {
      headers: { Authorization: ${JSON.stringify(`Bearer ${token}`)} },
      credentials: 'include',
      cache: 'no-store',
    }).then(async (response) => ({
      status: response.status,
      body: await response.json().catch(() => null),
    }))`);
  const draftKeys = () =>
    cdp.evaluate(`Object.keys(sessionStorage).filter((key) =>
      key.startsWith('kinetra.chat.draft.v1:'))`);
  const clickButtonWithText = (label) =>
    cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)},
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error('Button not found: ${label}');
      button.click();
    })()`);

  return {
    chrome,
    cdp,
    exists,
    pathname,
    bodyText,
    text,
    disabled,
    click,
    trustedClick,
    pressEscape,
    setValue,
    navigate,
    setVisibility,
    setOnline,
    setViewport,
    setTheme,
    layoutMetrics,
    cspImageSources,
    selectPhoto,
    selectVideo,
    armAbortBeforeNextVideoXhr,
    videoXhrState,
    videoSlotUi,
    videoCapabilityState,
    messageCount,
    viewerOpen,
    viewerHistoryId,
    activatePushSubscription,
    pushLifecycle,
    authenticatedFetch,
    draftKeys,
    clickButtonWithText,
    chromeErrors: () => chromeErrors,
  };
};

const runT12BrowserScenario = async () => {
  const syntheticVideoDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'kinetra-t14-video-fixture-'),
  );
  const syntheticVideoPath = path.join(syntheticVideoDirectory, 'synthetic.mp4');
  await runCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=960x540:rate=30:duration=10',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      '8M',
      '-maxrate',
      '8M',
      '-bufsize',
      '16M',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      syntheticVideoPath,
    ],
    { stdio: 'ignore' },
  );
  const syntheticVideo = await readFile(syntheticVideoPath);
  assert.ok(syntheticVideo.length > 5_242_880);
  const fixture = createT12BrowserServer(syntheticVideo);
  const t14BrowserEvidence = {
    parallelSlots: false,
    cancelIsolation: false,
    fatalSiblingAbort: false,
    resumeIdentity: false,
    nativePreAbortedNoSend: false,
    previewPrivateUrl: false,
    previewCapabilityCleared: false,
    reloadPolling: false,
    logoutCapabilityCleared: false,
    coexistence: false,
  };
  const clientProfileDirectory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-'));
  const trainerProfileDirectory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-browser-'));
  let client = null;
  let trainer = null;

  const loginContext = async (context, identifier, password, expectedPath, expectedTestId) => {
    await waitFor(`${identifier} login screen`, () => context.exists('login-screen'));
    await context.setValue('login-identifier', identifier);
    await context.setValue('login-password', password);
    await waitFor(
      `${identifier} enabled login`,
      async () => !(await context.disabled('login-submit')),
    );
    await context.click('login-submit');
    await waitFor(
      `${identifier} authenticated route`,
      async () => {
        return (
          (await context.pathname()) === expectedPath && (await context.exists(expectedTestId))
        );
      },
      25_000,
    );
  };

  const assertResponsiveThemeMatrix = async () => {
    for (const { width, height } of t12ViewportMatrix) {
      for (const theme of t12ThemeMatrix) {
        await Promise.all([
          client.setViewport(width, height),
          trainer.setViewport(width, height),
          client.setTheme(theme),
          trainer.setTheme(theme),
        ]);
        const expectedResolvedTheme = theme === 'light' ? 'light' : 'dark';
        await waitFor(`${width}x${height} ${theme} theme application`, async () => {
          const [clientMetrics, trainerMetrics] = await Promise.all([
            client.layoutMetrics(),
            trainer.layoutMetrics(),
          ]);
          return (
            clientMetrics.themePreference === theme &&
            trainerMetrics.themePreference === theme &&
            clientMetrics.theme === expectedResolvedTheme &&
            trainerMetrics.theme === expectedResolvedTheme
          );
        });
        const [clientMetrics, trainerMetrics] = await Promise.all([
          client.layoutMetrics(),
          trainer.layoutMetrics(),
        ]);
        for (const [surface, metrics] of [
          ['client', clientMetrics],
          ['trainer', trainerMetrics],
        ]) {
          assert.equal(metrics.innerWidth, width, `${surface} viewport width must be exact.`);
          assert.equal(metrics.innerHeight, height, `${surface} viewport height must be exact.`);
          assert.ok(
            metrics.scrollWidth <= width,
            `${surface} horizontally overflows at ${width}x${height} in ${theme}.`,
          );
        }
        assert.notEqual(clientMetrics.fab, null, 'Client home must expose the chat FAB.');
        assert.equal(clientMetrics.fab.width, 56);
        assert.equal(clientMetrics.fab.height, 56);
        assert.ok(clientMetrics.fab.right <= width);
        if (clientMetrics.tab !== null) {
          assert.ok(
            clientMetrics.fab.bottom <= clientMetrics.tab.top,
            `FAB overlaps bottom navigation at ${width}x${height} in ${theme}.`,
          );
        }
      }
    }

    await Promise.all([
      client.setViewport(390, 844),
      trainer.setViewport(1280, 900),
      client.setTheme('system'),
      trainer.setTheme('system'),
    ]);
  };

  try {
    await listen(fixture.server, apiPort);
    const health = await fetch(`${browserApiOrigin}/browser-test-health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', scenario: 't12' });

    client = await launchT12BrowserContext(clientProfileDirectory, 390, 844);
    trainer = await launchT12BrowserContext(trainerProfileDirectory, 1280, 900);
    await Promise.all([
      loginContext(client, 'chat-client@example.test', 'client-password', '/', 'main-screen'),
      loginContext(
        trainer,
        'chat-trainer@example.test',
        'trainer-password',
        '/trainer/chats',
        'trainer-chat-screen',
      ),
    ]);
    assert.deepEqual(fixture.state.loginCount, { client: 1, trainer: 1 });
    for (const [label, context] of [
      ['client', client],
      ['trainer', trainer],
    ]) {
      const imageSources = await context.cspImageSources();
      assert.deepEqual(
        [...new Set(imageSources)].sort(),
        ["'self'", 'blob:', frontendOrigin].sort(),
        `${label} CSP img-src must be limited to self, blob and the private media origin.`,
      );
      assert.equal(imageSources.length, 3);
      assert.equal(
        imageSources.some((source) => ['*', 'https:', 'http:'].includes(source)),
        false,
      );
    }

    await client.navigate('/trainer/videos');
    await waitFor(
      'client video-admin route guard',
      async () =>
        (await client.pathname()) === '/' &&
        (await client.exists('main-screen')) &&
        fixture.state.videoProgramGets === 0,
      20_000,
    );

    await trainer.cdp.evaluate(`(() => {
      const link = [...document.querySelectorAll('a')].find(
        (candidate) => candidate.textContent?.trim() === 'Видео'
      );
      if (!(link instanceof HTMLAnchorElement)) throw new Error('T14 trainer video nav missing.');
      link.click();
    })()`);
    await waitFor(
      'trainer video inventory independent of chat runtime',
      async () =>
        (await trainer.pathname()) === '/trainer/videos' &&
        (await trainer.exists('trainer-video-screen')) &&
        fixture.state.videoProgramGets >= 1 &&
        (await trainer.bodyText()).includes('Готово 0 из 84'),
      20_000,
    );
    const inventoryShape = await trainer.cdp.evaluate(`(() => ({
      weekButtons: document.querySelectorAll('nav[aria-label="Недели программы"] button').length,
      visibleSlots: document.querySelectorAll('.trainer-video-slot').length,
      fileAccept: document.querySelector('[data-testid="trainer-video-file-input"]')?.getAttribute('accept') ?? null,
      internalKeysVisible: /storage_key|multipart_upload_id|videos\\/workouts\\//u.test(document.body.innerText),
    }))()`);
    assert.deepEqual(inventoryShape, {
      weekButtons: 12,
      visibleSlots: 7,
      fileAccept: 'video/mp4,.mp4',
      internalKeysVisible: false,
    });

    for (const width of [320, 428, 768, 959, 960, 1440]) {
      await trainer.setViewport(width, width < 700 ? 820 : 900);
      const metrics = await trainer.cdp.evaluate(`(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll('nav[aria-label="Недели программы"] button')]
          .every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
      }))()`);
      assert.equal(metrics.width, width);
      assert.ok(
        metrics.scrollWidth <= width,
        `T14 video admin overflows horizontally at ${width}px.`,
      );
      assert.equal(metrics.targets, true, `T14 week target is below 44px at ${width}px.`);
    }
    await trainer.setViewport(1280, 900);

    await trainer.cdp.send('Network.enable');
    await trainer.cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 5,
      downloadThroughput: 20_000_000,
      uploadThroughput: 20_000_000,
      connectionType: 'wifi',
    });

    await trainer.click('trainer-video-upload-1-6');
    await sleep(100);
    const xhrSendCallsBeforeAbort = await trainer.armAbortBeforeNextVideoXhr();
    assert.equal(
      await trainer.selectVideo('synthetic-workout-pre-aborted.mp4'),
      syntheticVideo.length,
    );
    await waitFor(
      'T14 actual browser aborts before the first video XHR send',
      async () => {
        const xhrState = await trainer.videoXhrState();
        const slot = fixture.state.videoSlots.get('1:6');
        const record =
          slot?.liveUploadId === null || slot?.liveUploadId === undefined
            ? null
            : fixture.state.videoUploads.get(slot.liveUploadId);
        return (
          xhrState.triggers === 1 &&
          xhrState.controllerCount >= 2 &&
          record?.stats.signs >= 1 &&
          (await trainer.videoSlotUi(1, 6)).cancelDisabled === false
        );
      },
      20_000,
    );
    const preAbortedSlot = fixture.state.videoSlots.get('1:6');
    assert.notEqual(preAbortedSlot, undefined);
    assert.notEqual(preAbortedSlot.liveUploadId, null);
    const preAbortedRecord = fixture.state.videoUploads.get(preAbortedSlot.liveUploadId);
    assert.notEqual(preAbortedRecord, undefined);
    assert.equal(preAbortedRecord.stats.putStarts, 0);
    assert.equal(preAbortedRecord.stats.completes, 0);
    assert.equal((await trainer.videoXhrState()).sendCalls, xhrSendCallsBeforeAbort);
    assert.equal(fixture.state.videoUnexpectedXhrSends, 0);
    t14BrowserEvidence.nativePreAbortedNoSend = true;
    await trainer.click('trainer-video-cancel-1-6');
    await waitFor(
      'T14 pre-aborted fixture upload is explicitly cancelled',
      async () =>
        preAbortedRecord.stats.cancels === 1 && (await trainer.videoSlotUi(1, 6)).upload === true,
      20_000,
    );

    await trainer.cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: 10_000_000,
      uploadThroughput: 2_000_000,
      connectionType: 'wifi',
    });
    await trainer.click('trainer-video-upload-1-2');
    await sleep(100);
    assert.equal(await trainer.selectVideo('synthetic-workout-day-2.mp4'), syntheticVideo.length);
    await trainer.click('trainer-video-upload-1-3');
    await sleep(100);
    assert.equal(await trainer.selectVideo('synthetic-workout-day-3.mp4'), syntheticVideo.length);
    await waitFor(
      'T14 two slots expose independent intermediate progress and cancel controls',
      async () => {
        const [day2, day3] = await Promise.all([
          trainer.videoSlotUi(1, 2),
          trainer.videoSlotUi(1, 3),
        ]);
        return (
          day2.progress > 0 &&
          day2.progress < 100 &&
          day3.progress > 0 &&
          day3.progress < 100 &&
          day2.cancel &&
          day2.cancelDisabled === false &&
          day3.cancel &&
          day3.cancelDisabled === false
        );
      },
      30_000,
    );
    const parallelDay2Slot = fixture.state.videoSlots.get('1:2');
    const parallelDay3Slot = fixture.state.videoSlots.get('1:3');
    assert.notEqual(parallelDay2Slot, undefined);
    assert.notEqual(parallelDay3Slot, undefined);
    assert.notEqual(parallelDay2Slot.liveUploadId, null);
    assert.notEqual(parallelDay3Slot.liveUploadId, null);
    assert.notEqual(parallelDay2Slot.liveUploadId, parallelDay3Slot.liveUploadId);
    const parallelDay2Record = fixture.state.videoUploads.get(parallelDay2Slot.liveUploadId);
    const parallelDay3Record = fixture.state.videoUploads.get(parallelDay3Slot.liveUploadId);
    assert.notEqual(parallelDay2Record, undefined);
    assert.notEqual(parallelDay3Record, undefined);
    t14BrowserEvidence.parallelSlots = true;

    await trainer.click('trainer-video-cancel-1-2');
    await waitFor(
      'T14 cancelling one slot leaves the sibling upload active',
      async () => {
        const day2 = await trainer.videoSlotUi(1, 2);
        const day3 = await trainer.videoSlotUi(1, 3);
        return (
          parallelDay2Record.stats.cancels === 1 &&
          parallelDay2Record.stats.completes === 0 &&
          day2.upload &&
          parallelDay3Record.stats.cancels === 0 &&
          parallelDay3Slot.liveUploadId === parallelDay3Record.id &&
          day3.cancel &&
          day3.cancelDisabled === false
        );
      },
      20_000,
    );

    await trainer.cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 5,
      downloadThroughput: 20_000_000,
      uploadThroughput: 20_000_000,
      connectionType: 'wifi',
    });
    await waitFor(
      'T14 sibling upload reaches verification before a real page reload',
      () =>
        parallelDay3Record.stats.completes === 1 &&
        parallelDay3Record.polls === 1 &&
        parallelDay3Record.dto.status === 'verifying',
      40_000,
    );
    await trainer.cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(
      'T14 reload restores the processing slot and resumes durable status polling',
      async () =>
        (await trainer.pathname()) === '/trainer/videos' &&
        (await trainer.exists('trainer-video-screen')) &&
        (await trainer.bodyText()).includes('Файл загружен, проверяем'),
      25_000,
    );
    await waitFor(
      'T14 sibling slot reaches publication after the other slot is cancelled',
      async () =>
        parallelDay3Slot.mediaAvailable &&
        parallelDay3Record.stats.completes === 1 &&
        parallelDay3Record.polls >= 2 &&
        fixture.state.videoTransientFailures === 1 &&
        (await trainer.exists('trainer-video-preview-1-3')),
      40_000,
    );
    assert.equal(parallelDay2Record.stats.completes, 0);
    assert.equal(parallelDay3Record.stats.cancels, 0);
    assert.equal(parallelDay3Record.stats.abortedPuts, 0);
    assert.equal(parallelDay3Record.acceptedParts.size, parallelDay3Record.dto.part_count);
    t14BrowserEvidence.cancelIsolation = true;
    t14BrowserEvidence.reloadPolling = true;

    await trainer.click('trainer-video-preview-1-3');
    await waitFor(
      'T14 preview uses a short SigV4-shaped capability without app tokens',
      async () => {
        const capability = await trainer.videoCapabilityState(
          fixture.state.currentAccessToken.trainer,
        );
        if (capability.previewUrl === null) return false;
        const url = new URL(capability.previewUrl);
        return (
          url.pathname === '/__browser-test/t14/synthetic.mp4' &&
          url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
          url.searchParams.get('X-Amz-Expires') === '120' &&
          /^[a-f0-9]{64}$/u.test(url.searchParams.get('X-Amz-Signature') ?? '') &&
          !url.searchParams.has('token') &&
          !url.searchParams.has('access_token') &&
          capability.capabilityInDom &&
          !capability.capabilityInLocalStorage &&
          !capability.capabilityInSessionStorage &&
          !capability.capabilityInHistory &&
          !capability.capabilityInCache &&
          !capability.accessTokenInStorage
        );
      },
    );
    t14BrowserEvidence.previewPrivateUrl = true;
    await trainer.clickButtonWithText('Закрыть');
    await waitFor(
      'T14 closing preview removes the signed capability from browser-owned state',
      async () => {
        const capability = await trainer.videoCapabilityState(
          fixture.state.currentAccessToken.trainer,
        );
        return (
          capability.previewUrl === null &&
          !capability.capabilityInDom &&
          !capability.capabilityInLocalStorage &&
          !capability.capabilityInSessionStorage &&
          !capability.capabilityInHistory &&
          !capability.capabilityInCache &&
          !capability.accessTokenInStorage
        );
      },
    );
    t14BrowserEvidence.previewCapabilityCleared = true;
    await trainer.cdp.evaluate('window.confirm = () => true');
    await trainer.click('trainer-video-hide-1-3');
    await waitFor(
      'T14 soft unpublish returns the hidden placeholder state',
      async () =>
        fixture.state.videoUnpublishes === 1 &&
        !parallelDay3Slot.mediaAvailable &&
        (await trainer.bodyText()).includes('Скрыто — клиенты видят заглушку'),
      20_000,
    );

    await trainer.click('trainer-video-upload-1-4');
    await sleep(100);
    assert.equal(await trainer.selectVideo('synthetic-workout-fatal.mp4'), syntheticVideo.length);
    await waitFor(
      'T14 fatal part failure aborts an active sibling XHR',
      async () => {
        const slot = fixture.state.videoSlots.get('1:4');
        const record =
          slot?.liveUploadId === null || slot?.liveUploadId === undefined
            ? null
            : fixture.state.videoUploads.get(slot.liveUploadId);
        if (record === null || record.partAttempts.get(1) !== 3) return false;
        const siblingPrefix = `/__browser-test/t14/uploads/${record.id}/parts/`;
        return (await trainer.videoXhrState()).activeAborts.some(
          (pathname) => pathname.startsWith(siblingPrefix) && pathname !== `${siblingPrefix}1`,
        );
      },
      40_000,
    );
    await waitFor(
      'T14 fatal part failure remains visible after inventory refresh',
      async () => {
        if (
          !fixture.state.videoProgramRefreshedAfterFatal ||
          !(await trainer.bodyText()).includes('Part upload failed with 503')
        )
          return false;
        await sleep(250);
        return (await trainer.bodyText()).includes('Part upload failed with 503');
      },
      20_000,
    );
    const fatalSlot = fixture.state.videoSlots.get('1:4');
    assert.notEqual(fatalSlot, undefined);
    assert.notEqual(fatalSlot.liveUploadId, null);
    const fatalRecord = fixture.state.videoUploads.get(fatalSlot.liveUploadId);
    assert.notEqual(fatalRecord, undefined);
    const fatalEvent = fixture.state.videoEvents.find(
      (event) => event.upload_id === fatalRecord.id && event.type === 'fatal_rejected',
    );
    assert.notEqual(fatalEvent, undefined);
    assert.equal(fatalRecord.stats.completes, 0);
    assert.ok(fatalRecord.stats.putStarts >= 2);
    const fatalSiblingPrefix = `/__browser-test/t14/uploads/${fatalRecord.id}/parts/`;
    assert.equal(
      (await trainer.videoXhrState()).activeAborts.some(
        (pathname) =>
          pathname.startsWith(fatalSiblingPrefix) && pathname !== `${fatalSiblingPrefix}1`,
      ),
      true,
    );
    fixture.releaseFatalSiblingPuts();
    await sleep(1_000);
    assert.deepEqual(
      fixture.state.videoEvents.filter(
        (event) =>
          event.upload_id === fatalRecord.id &&
          event.sequence > fatalEvent.sequence &&
          ['part_signed', 'put_start', 'complete'].includes(event.type),
      ),
      [],
    );
    t14BrowserEvidence.fatalSiblingAbort = true;
    await trainer.clickButtonWithText('Закрыть');
    await trainer.click('trainer-video-cancel-1-4');
    await waitFor(
      'T14 fatal fixture upload remains explicitly cancellable',
      async () => fatalRecord.stats.cancels === 1 && (await trainer.videoSlotUi(1, 4)).upload,
      20_000,
    );

    const resumeRecord = fixture.state.videoUploads.get(fixture.state.videoResumeUploadId);
    assert.notEqual(resumeRecord, undefined);
    assert.equal((await trainer.videoSlotUi(1, 5)).resumeDisabled, false);
    const resumeMutationsBeforeMismatch = {
      signs: resumeRecord.stats.signs,
      puts: resumeRecord.stats.putStarts,
      completes: resumeRecord.stats.completes,
    };
    await trainer.click('trainer-video-resume-1-5');
    await sleep(100);
    assert.equal(
      await trainer.selectVideo('synthetic-workout-same-size-different.mp4', 'different'),
      syntheticVideo.length,
    );
    await waitFor(
      'T14 resume rejects a same-size different file before any mutation',
      async () =>
        (await trainer.bodyText()).includes('Выбран другой файл') &&
        (await trainer.videoSlotUi(1, 5)).resumeDisabled === false,
      20_000,
    );
    assert.deepEqual(
      {
        signs: resumeRecord.stats.signs,
        puts: resumeRecord.stats.putStarts,
        completes: resumeRecord.stats.completes,
      },
      resumeMutationsBeforeMismatch,
    );
    await trainer.clickButtonWithText('Закрыть');
    await trainer.click('trainer-video-resume-1-5');
    await sleep(100);
    assert.equal(await trainer.selectVideo('synthetic-workout-resume.mp4'), syntheticVideo.length);
    const resumeSlot = fixture.state.videoSlots.get('1:5');
    assert.notEqual(resumeSlot, undefined);
    await waitFor(
      'T14 exact-file resume skips the accepted part and publishes',
      async () =>
        resumeSlot.mediaAvailable &&
        resumeRecord.stats.completes === 1 &&
        (await trainer.exists('trainer-video-preview-1-5')),
      40_000,
    );
    assert.equal(
      fixture.state.videoEvents.some(
        (event) =>
          event.upload_id === resumeRecord.id &&
          event.part_number === 1 &&
          ['part_signed', 'put_start'].includes(event.type),
      ),
      false,
    );
    assert.equal(
      fixture.state.videoEvents.some(
        (event) =>
          event.upload_id === resumeRecord.id &&
          event.part_number === 2 &&
          event.type === 'put_accepted',
      ),
      true,
    );
    assert.equal(resumeRecord.acceptedParts.size, resumeRecord.dto.part_count);
    t14BrowserEvidence.resumeIdentity = true;

    const browserStorageLeaks = await trainer.cdp.evaluate(`({
      local: Object.values(localStorage).some((value) => String(value).includes('X-Amz-')),
      session: Object.values(sessionStorage).some((value) => String(value).includes('X-Amz-')),
    })`);
    assert.deepEqual(browserStorageLeaks, { local: false, session: false });

    await trainer.navigate('/trainer/chats');
    await waitFor(
      'T12 chat remains usable after the T14 lifecycle',
      () => trainer.exists('trainer-chat-screen'),
      20_000,
    );

    await client.navigate('/trainer/chats');
    await waitFor(
      'client trainer-route guard',
      async () =>
        (await client.pathname()) === '/' &&
        (await client.exists('main-screen')) &&
        (await client.exists('chat-fab')),
      20_000,
    );

    await trainer.navigate('/chat');
    await waitFor(
      'trainer client-route guard',
      async () =>
        (await trainer.pathname()) === '/trainer/chats' &&
        (await trainer.exists('trainer-chat-screen')),
      20_000,
    );
    await waitFor(
      'two authenticated T12 sockets',
      () =>
        fixture.state.socketConnections.client.size === 1 &&
        fixture.state.socketConnections.trainer.size === 1,
      20_000,
    );
    await waitFor(
      'trainer initial empty inbox',
      async () => (await trainer.bodyText()).includes('Диалогов пока нет.'),
      20_000,
    );
    await assertResponsiveThemeMatrix();

    await client.click('chat-fab');
    await waitFor('client chat route', async () => (await client.pathname()) === '/chat');
    await waitFor('client empty conversation', () => client.exists('chat-empty-state'), 20_000);
    assert.equal(fixture.state.conversationCreated, true);

    await waitFor(
      'trainer realtime-created conversation without navigation',
      () => trainer.exists('trainer-conversation-row'),
      20_000,
    );
    await client.setValue('chat-message-input', 'Сообщение клиента через realtime');
    await waitFor(
      'enabled client chat send',
      async () => !(await client.disabled('chat-send-button')),
    );
    await client.click('chat-send-button');
    await waitFor(
      'committed text with lost response keeps its bound draft and one failed bubble',
      async () =>
        fixture.state.messages.length === 1 &&
        (await client.bodyText()).includes('Сообщение клиента через realtime') &&
        (await client.bodyText()).includes('Не отправлено') &&
        (await client.bodyText()).includes('Повторить') &&
        (await client.bodyText()).includes('Не удалось связаться с сервером.') &&
        !(await client.bodyText()).includes('Failed to fetch') &&
        (await client.cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector('chat-message-input'))})?.value ?? null`,
        )) === 'Сообщение клиента через realtime' &&
        (await client.draftKeys()).length === 1,
      20_000,
    );
    const committedAfterLostResponse = fixture.state.messages[0];
    const optimisticAfterLostResponseId = `optimistic:${committedAfterLostResponse.client_message_id}`;
    assert.equal(
      fixture.state.messageRequestAttempts.get(
        `client:${committedAfterLostResponse.client_message_id}`,
      ),
      1,
    );
    assert.equal(await client.messageCount(committedAfterLostResponse.id), 0);
    assert.equal(await client.messageCount(optimisticAfterLostResponseId), 1);
    assert.equal(fixture.state.messageBroadcastCount.get(committedAfterLostResponse.id), 1);
    await client.clickButtonWithText('Повторить');
    await waitFor(
      'idempotent retry reconciles the single canonical message',
      async () =>
        fixture.state.messageRequestAttempts.get(
          `client:${committedAfterLostResponse.client_message_id}`,
        ) === 2 &&
        (await client.messageCount(committedAfterLostResponse.id)) === 1 &&
        (await client.messageCount(optimisticAfterLostResponseId)) === 0 &&
        (await client.bodyText()).includes('Отправлено') &&
        !(await client.bodyText()).includes('Не отправлено') &&
        (await client.draftKeys()).length === 0 &&
        (await client.cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector('chat-message-input'))})?.value ?? null`,
        )) === '',
      20_000,
    );
    assert.equal(fixture.state.messages.length, 1);
    assert.equal(fixture.state.messageBroadcastCount.get(committedAfterLostResponse.id), 1);
    assert.equal((await client.draftKeys()).length, 0);
    assert.deepEqual(fixture.state.messageSenders, ['client']);

    await waitFor(
      'trainer realtime unread preview',
      async () => {
        const text = await trainer.bodyText();
        const unreadLabel = await trainer.cdp.evaluate(
          "document.querySelector('.trainer-conversation-badge')?.getAttribute('aria-label') ?? null",
        );
        return (
          text.includes('Сообщение клиента через realtime') && unreadLabel === '1 непрочитанных'
        );
      },
      20_000,
    );
    await trainer.click('trainer-conversation-row');
    await waitFor(
      'trainer conversation detail',
      async () =>
        (await trainer.pathname()) === `/trainer/chats/${t12ConversationId}` &&
        (await trainer.exists('chat-conversation-screen')) &&
        (await trainer.bodyText()).includes('Сообщение клиента через realtime'),
      20_000,
    );
    await waitFor(
      'trainer visible-message read cursor',
      () => fixture.state.trainerReadSequence === 1,
      20_000,
    );
    await waitFor(
      'client realtime read receipt',
      async () => (await client.bodyText()).includes('Прочитано'),
      20_000,
    );

    await client.navigate('/');
    await waitFor(
      'client home restored with existing conversation',
      async () =>
        (await client.pathname()) === '/' &&
        (await client.exists('main-screen')) &&
        (await client.exists('chat-fab')),
      20_000,
    );
    await waitFor(
      'client socket restored after home reload',
      () => fixture.state.socketConnections.client.size === 1,
      20_000,
    );
    await trainer.setValue('chat-message-input', 'Ответ тренера для FAB');
    await waitFor(
      'enabled trainer chat send',
      async () => !(await trainer.disabled('chat-send-button')),
    );
    await trainer.click('chat-send-button');
    await waitFor(
      'trainer canonical sent message',
      () =>
        fixture.state.messages.length === 2 &&
        fixture.state.messageSenders.join(',') === 'client,trainer',
      20_000,
    );
    await waitFor(
      'client FAB realtime unread badge',
      async () => (await client.text('chat-fab-badge')) === '1',
      20_000,
    );

    await client.click('chat-fab');
    await waitFor(
      'client realtime answer history',
      async () =>
        (await client.pathname()) === '/chat' &&
        (await client.bodyText()).includes('Ответ тренера для FAB'),
      20_000,
    );
    await waitFor(
      'client visible-message read cursor',
      () => fixture.state.clientReadSequence === 2,
      20_000,
    );
    await waitFor(
      'trainer realtime read receipt',
      async () => (await trainer.bodyText()).includes('Прочитано'),
      20_000,
    );

    await client.setVisibility('hidden');
    await waitFor(
      'client hidden visibility seam',
      async () => (await client.cdp.evaluate('document.visibilityState')) === 'hidden',
    );
    await sleep(150);
    const readBeforeHiddenMessage = fixture.state.clientReadSequence;
    const duplicateResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/duplicate-event`,
      { method: 'POST' },
    );
    assert.equal(duplicateResponse.status, 200);
    const duplicatePayload = await duplicateResponse.json();
    await waitFor(
      'hidden duplicate realtime message rendered once',
      async () =>
        (await client.bodyText()).includes('Дубликат realtime должен отобразиться один раз') &&
        (await client.messageCount(duplicatePayload.message_id)) === 1,
      20_000,
    );
    await sleep(650);
    assert.equal(
      fixture.state.clientReadSequence,
      readBeforeHiddenMessage,
      'A hidden chat document must not acknowledge an incoming message as read.',
    );
    assert.equal(fixture.state.duplicateMessageId, duplicatePayload.message_id);
    await client.click('chat-back');
    await waitFor(
      'duplicate event keeps server-authoritative FAB unread at one',
      async () =>
        (await client.exists('main-screen')) && (await client.text('chat-fab-badge')) === '1',
      20_000,
    );
    assert.equal(fixture.state.clientReadSequence, readBeforeHiddenMessage);
    await client.click('chat-fab');
    await waitFor(
      'hidden chat history deduplicates the realtime message',
      async () =>
        (await client.exists('chat-conversation-screen')) &&
        (await client.messageCount(duplicatePayload.message_id)) === 1,
      20_000,
    );
    assert.equal(fixture.state.clientReadSequence, readBeforeHiddenMessage);
    await client.setVisibility('visible');
    await waitFor(
      'duplicate message read after visibility restoration',
      () => fixture.state.clientReadSequence === duplicatePayload.sequence,
      20_000,
    );
    await client.click('chat-back');
    await waitFor(
      'read acknowledgement resets server-authoritative FAB badge',
      async () =>
        (await client.exists('main-screen')) &&
        (await client.exists('chat-fab')) &&
        !(await client.exists('chat-fab-badge')),
      20_000,
    );

    await trainer.navigate('/trainer/chats');
    await waitFor(
      'trainer inbox ready without unread before stale-session race',
      async () =>
        (await trainer.pathname()) === '/trainer/chats' &&
        (await trainer.exists('trainer-conversation-row')) &&
        (await trainer.cdp.evaluate(
          "document.querySelector('.trainer-conversation-badge')?.getAttribute('aria-label') ?? null",
        )) === null &&
        fixture.state.socketConnections.trainer.size === 1,
      20_000,
    );
    const connectionsBeforeStaleRace = {
      client: fixture.state.socketConnectionCount.client,
      trainer: fixture.state.socketConnectionCount.trainer,
    };
    const staleRaceArmResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/stale-session/arm`,
      { method: 'POST' },
    );
    assert.equal(staleRaceArmResponse.status, 200);
    assert.deepEqual(await staleRaceArmResponse.json(), {
      client_unread: 0,
      trainer_unread: 0,
    });
    await waitFor(
      'both reconnect session requests held with stale unread snapshots',
      () =>
        fixture.state.staleSessionRace?.heldRequests.client === 1 &&
        fixture.state.staleSessionRace.heldRequests.trainer === 1 &&
        fixture.state.socketConnectionCount.client > connectionsBeforeStaleRace.client &&
        fixture.state.socketConnectionCount.trainer > connectionsBeforeStaleRace.trainer &&
        fixture.state.socketConnections.client.size === 1 &&
        fixture.state.socketConnections.trainer.size === 1,
      25_000,
    );
    const staleRaceEventResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/stale-session/emit`,
      { method: 'POST' },
    );
    assert.equal(staleRaceEventResponse.status, 200);
    assert.deepEqual(await staleRaceEventResponse.json(), {
      client_unread: 1,
      trainer_unread: 1,
    });
    await waitFor(
      'newer conversation event updates FAB and trainer inbox before stale REST release',
      async () =>
        (await client.text('chat-fab-badge')) === '1' &&
        (await trainer.cdp.evaluate(
          "document.querySelector('.trainer-conversation-badge')?.getAttribute('aria-label') ?? null",
        )) === '1 непрочитанных',
      20_000,
    );
    const staleRaceReleaseResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/stale-session/release`,
      { method: 'POST' },
    );
    assert.equal(staleRaceReleaseResponse.status, 200);
    assert.deepEqual(await staleRaceReleaseResponse.json(), { released: true });
    await waitFor(
      'server completes both stale lower-unread session responses',
      () =>
        fixture.state.staleSessionRace?.staleResponses.client === 1 &&
        fixture.state.staleSessionRace.staleResponses.trainer === 1,
      20_000,
    );
    await sleep(650);
    assert.equal(await client.text('chat-fab-badge'), '1');
    assert.equal(
      await trainer.cdp.evaluate(
        "document.querySelector('.trainer-conversation-badge')?.getAttribute('aria-label') ?? null",
      ),
      '1 непрочитанных',
      'A stale trainer session response must not roll the newer inbox unread count back.',
    );
    assert.equal(fixture.state.staleSessionRace?.eventMessageIds.length, 2);

    await client.click('chat-fab');
    await waitFor('client chat reopened for photo flow', () =>
      client.exists('chat-conversation-screen'),
    );

    await waitFor(
      'photo attachment enabled by server session capability',
      async () => !(await client.disabled('chat-attachment-button')),
    );
    await client.selectPhoto('t12-success.png');
    await waitFor(
      'successful photo upload ready in composer',
      async () =>
        (await client.exists('chat-photo-draft')) &&
        !(await client.exists('chat-photo-retry')) &&
        !(await client.disabled('chat-send-button')) &&
        fixture.state.photoUploadKeyOrder.length === 1,
      20_000,
    );
    const successfulPhotoKey = fixture.state.photoUploadKeyOrder[0];
    assert.equal(fixture.state.photoUploadAttempts.get(successfulPhotoKey), 1);
    await client.setValue('chat-message-input', 'Подпись к безопасной фотографии');
    await client.click('chat-send-button');
    await waitFor(
      'canonical photo message and signed thumbnail',
      async () =>
        fixture.state.messages.some(
          ({ kind, text }) => kind === 'photo' && text === 'Подпись к безопасной фотографии',
        ) &&
        !(await client.exists('chat-photo-draft')) &&
        (await client.exists('chat-photo-thumbnail')) &&
        !(await client.disabled('chat-photo-thumbnail')),
      20_000,
    );
    const attachedPhoto = [...fixture.state.photos.values()].find(({ attached }) => attached);
    assert.notEqual(attachedPhoto, undefined);

    const waitForPhotoViewerOpen = (label) =>
      waitFor(
        label,
        async () => {
          const historyId = await client.viewerHistoryId();
          return (
            (await client.viewerOpen()) &&
            typeof historyId === 'string' &&
            historyId.startsWith('viewer-')
          );
        },
        20_000,
      );
    const waitForPhotoViewerClosed = (label) =>
      waitFor(
        label,
        async () =>
          !(await client.viewerOpen()) &&
          (await client.viewerHistoryId()) === null &&
          (await client.pathname()) === '/chat',
        20_000,
      );
    const waitForPhotoThumbnailFocus = (label) =>
      waitFor(
        label,
        async () =>
          (await client.cdp.evaluate(
            `document.activeElement?.getAttribute('data-testid') ?? null`,
          )) === 'chat-photo-thumbnail',
        20_000,
      );

    await client.trustedClick('chat-photo-thumbnail');
    await waitForPhotoViewerOpen('fullscreen photo viewer with owned History entry');
    await waitFor(
      'fullscreen viewer decoded signed image',
      () =>
        client.cdp.evaluate(`(() => {
          const viewer = document.querySelector(${JSON.stringify(selector('chat-photo-viewer'))});
          const image = viewer?.querySelector('img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
      })()`),
      20_000,
    );
    await client.trustedClick('chat-photo-viewer-close');
    await waitForPhotoViewerClosed('photo viewer close button consumes owned History entry');
    await waitForPhotoThumbnailFocus('photo viewer close button returns focus to thumbnail');

    await client.trustedClick('chat-photo-thumbnail');
    await waitForPhotoViewerOpen('photo viewer reopened for browser Back');
    await client.cdp.evaluate('window.history.back()');
    await waitForPhotoViewerClosed('browser Back closes photo viewer and consumes History entry');
    await waitForPhotoThumbnailFocus('browser Back returns focus to thumbnail');

    await client.trustedClick('chat-photo-thumbnail');
    await waitForPhotoViewerOpen('photo viewer reopened for Escape');
    await client.pressEscape();
    await waitForPhotoViewerClosed('Escape closes photo viewer and consumes History entry');
    await waitForPhotoThumbnailFocus('Escape returns focus to thumbnail');

    const messageCountBeforeFailedDraft = fixture.state.messages.length;
    await client.selectPhoto('t12-retry.png');
    await waitFor(
      'failed photo upload retry state',
      async () =>
        (await client.exists('chat-photo-draft')) &&
        (await client.exists('chat-photo-retry')) &&
        (await client.bodyText()).includes('Photo storage is temporarily unavailable.'),
      20_000,
    );
    assert.equal(fixture.state.photoUploadKeyOrder.length, 2);
    const retryPhotoKey = fixture.state.photoUploadKeyOrder[1];
    assert.equal(fixture.state.photoUploadAttempts.get(retryPhotoKey), 1);
    await client.click('chat-photo-retry');
    await waitFor(
      'failed photo retry uses same key and becomes ready',
      async () =>
        fixture.state.photoUploadAttempts.get(retryPhotoKey) === 2 &&
        !(await client.exists('chat-photo-retry')) &&
        !(await client.disabled('chat-send-button')),
      20_000,
    );
    assert.deepEqual(fixture.state.photoUploadKeyOrder, [successfulPhotoKey, retryPhotoKey]);
    await client.click('chat-photo-remove');
    await waitFor(
      'retried photo removed without creating a message',
      async () =>
        !(await client.exists('chat-photo-draft')) &&
        fixture.state.messages.length === messageCountBeforeFailedDraft &&
        (await client.draftKeys()).length === 0,
    );

    const historyMessageIds = fixture.state.messages.map(({ id }) => id);
    const socketConnectionsBeforeHistoryReload = fixture.state.socketConnectionCount.client;
    const socketDisconnectsBeforeHistoryReload = fixture.state.socketDisconnectCount.client;
    await client.navigate('/chat');
    await waitFor(
      'chat history and socket restored after full reload',
      async () =>
        (await client.exists('chat-conversation-screen')) &&
        (await client.bodyText()).includes('Сообщение клиента через realtime') &&
        (await client.bodyText()).includes('Ответ тренера для FAB') &&
        (await client.bodyText()).includes('Подпись к безопасной фотографии') &&
        fixture.state.socketConnections.client.size === 1 &&
        fixture.state.socketConnectionCount.client > socketConnectionsBeforeHistoryReload &&
        fixture.state.socketDisconnectCount.client > socketDisconnectsBeforeHistoryReload,
      20_000,
    );
    for (const messageId of historyMessageIds) {
      assert.equal(await client.messageCount(messageId), 1, `Reload duplicated ${messageId}.`);
    }
    assert.equal(await client.exists('chat-photo-thumbnail'), true);

    const deltaQueriesBeforeDisconnect = fixture.state.deltaQueries.length;
    const socketConnectionsBeforeDisconnect = fixture.state.socketConnectionCount.client;
    const socketDisconnectsBeforeDisconnect = fixture.state.socketDisconnectCount.client;
    const disconnectResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/disconnect-delta`,
      { method: 'POST' },
    );
    assert.equal(disconnectResponse.status, 200);
    const disconnectPayload = await disconnectResponse.json();
    await waitFor(
      'socket reconnect restores missed message through REST delta',
      async () =>
        fixture.state.socketConnections.client.size === 1 &&
        fixture.state.socketConnectionCount.client > socketConnectionsBeforeDisconnect &&
        fixture.state.socketDisconnectCount.client > socketDisconnectsBeforeDisconnect &&
        fixture.state.deltaQueries.length > deltaQueriesBeforeDisconnect &&
        fixture.state.deltaQueries.some(
          ({ role, returnedSequences }) =>
            role === 'client' && returnedSequences.includes(disconnectPayload.sequence),
        ) &&
        (await client.bodyText()).includes('Пропущенное сообщение восстановлено через REST delta'),
      25_000,
    );
    assert.equal(await client.messageCount(disconnectPayload.message_id), 1);
    assert.equal(fixture.state.missedMessageId, disconnectPayload.message_id);

    await client.setOnline(false);
    await waitFor(
      'offline composer state',
      async () =>
        (await client.exists('chat-offline-note')) &&
        (await client.disabled('chat-send-button')) &&
        (await client.disabled('chat-attachment-button')),
    );
    const messageCountBeforeOfflineDraft = fixture.state.messages.length;
    await client.setValue('chat-message-input', 'Offline draft remains session scoped');
    await waitFor('offline session draft persisted', async () => {
      const keys = await client.draftKeys();
      return keys.length === 1 && keys[0].includes(t12ClientId);
    });
    await client.click('chat-send-button');
    await sleep(250);
    assert.equal(fixture.state.messages.length, messageCountBeforeOfflineDraft);
    await client.setOnline(true);
    await waitFor(
      'offline draft survives returning online',
      async () =>
        !(await client.exists('chat-offline-note')) &&
        (await client.cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector('chat-message-input'))})?.value ?? null`,
        )) === 'Offline draft remains session scoped',
    );

    const clientAccessToken = fixture.state.currentAccessToken.client;
    const trainerAccessToken = fixture.state.currentAccessToken.trainer;
    assert.equal(typeof clientAccessToken, 'string');
    assert.equal(typeof trainerAccessToken, 'string');
    const [foreignConversation, foreignPhoto, trainerUnattachedPhoto] = await Promise.all([
      client.authenticatedFetch(
        `/api/v1/chat/conversations/${t12OtherConversationId}/messages`,
        clientAccessToken,
      ),
      client.authenticatedFetch(`/api/v1/chat/photos/${t12OtherPhotoId}/access`, clientAccessToken),
      trainer.authenticatedFetch(
        `/api/v1/chat/photos/${[...fixture.state.photos.values()].find(({ attached }) => !attached).id}/access`,
        trainerAccessToken,
      ),
    ]);
    assert.equal(foreignConversation.status, 404);
    assert.equal(foreignPhoto.status, 404);
    assert.equal(trainerUnattachedPhoto.status, 404);
    assert.equal(foreignPhoto.body.error.code, 'CHAT_RESOURCE_NOT_FOUND');
    assert.equal(trainerUnattachedPhoto.body.error.code, 'CHAT_RESOURCE_NOT_FOUND');

    const crossSenderCollisionResponse = await fetch(
      `${browserApiOrigin}/__browser-test/t12/cross-sender-collision`,
      { method: 'POST' },
    );
    assert.equal(crossSenderCollisionResponse.status, 200);
    const crossSenderCollision = await crossSenderCollisionResponse.json();
    await waitFor(
      'cross-sender client_message_id collision retains both canonical messages',
      async () =>
        (await client.messageCount(crossSenderCollision.own_message_id)) === 1 &&
        (await client.messageCount(crossSenderCollision.counterpart_message_id)) === 1 &&
        (await client.bodyText()).includes('Сообщение тренера с совпавшим client_message_id'),
      20_000,
    );
    await client.navigate('/chat');
    await waitFor(
      'cross-sender collision remains intact after canonical history reload',
      async () =>
        (await client.messageCount(crossSenderCollision.own_message_id)) === 1 &&
        (await client.messageCount(crossSenderCollision.counterpart_message_id)) === 1,
      20_000,
    );

    await trainer.navigate(`/trainer/chats/${t12ConversationId}`);
    await waitFor(
      'trainer conversation restored before retryable logout',
      () => trainer.exists('chat-conversation-screen'),
      20_000,
    );
    await trainer.setValue('chat-message-input', 'Черновик тренера сохраняется до server ACK');
    await waitFor(
      'trainer account-scoped draft before failed logout',
      async () => {
        const keys = await trainer.draftKeys();
        return keys.length === 1 && keys[0].includes(t12TrainerId);
      },
      20_000,
    );
    const capturedTrainerLogoutBearer = `Bearer ${fixture.state.currentAccessToken.trainer}`;
    await trainer.clickButtonWithText('Выйти');
    await waitFor(
      'trainer logout failure remains explicitly signed in and retryable',
      async () =>
        (await trainer.exists('trainer-sign-out-failed')) &&
        !(await trainer.exists('login-screen')) &&
        (await trainer.bodyText()).includes('Выход не завершен') &&
        (await trainer.bodyText()).includes('Вы по-прежнему вошли в аккаунт') &&
        fixture.state.logoutCount.trainer === 1 &&
        fixture.state.socketConnections.trainer.size === 0,
      20_000,
    );
    assert.equal((await trainer.draftKeys()).length, 1);
    assert.deepEqual(fixture.state.logoutAuthorizations.trainer, [capturedTrainerLogoutBearer]);
    await trainer.clickButtonWithText('Повторить');
    await waitFor(
      'trainer retry confirms logout before route and draft teardown',
      async () =>
        (await trainer.exists('login-screen')) &&
        fixture.state.logoutCount.trainer === 2 &&
        fixture.state.socketConnections.trainer.size === 0,
      20_000,
    );
    assert.deepEqual(fixture.state.logoutAuthorizations.trainer, [
      capturedTrainerLogoutBearer,
      capturedTrainerLogoutBearer,
    ]);
    assert.deepEqual(await trainer.draftKeys(), []);
    await waitFor(
      'T14 logout keeps preview capability and access token out of storage',
      async () => {
        const capability = await trainer.videoCapabilityState(
          fixture.state.currentAccessToken.trainer,
        );
        return (
          capability.previewUrl === null &&
          !capability.capabilityInDom &&
          !capability.capabilityInLocalStorage &&
          !capability.capabilityInSessionStorage &&
          !capability.capabilityInHistory &&
          !capability.capabilityInCache &&
          !capability.accessTokenInStorage
        );
      },
    );
    t14BrowserEvidence.logoutCapabilityCleared = true;

    await client.setValue('chat-message-input', 'Черновик должен удалиться при выходе');
    await waitFor('account-scoped client chat draft before logout', async () => {
      const keys = await client.draftKeys();
      return keys.length === 1 && keys[0].includes(t12ClientId);
    });
    await client.navigate('/settings');
    await waitFor('client settings for logout', () => client.exists('settings-screen'), 20_000);
    await client.click('logout');
    await waitFor('client logout confirmation', () => client.exists('logout-confirm'));
    await client.click('logout-confirm');
    await waitFor(
      'client logout route and socket teardown',
      async () =>
        (await client.exists('login-screen')) &&
        fixture.state.logoutCount.client === 1 &&
        fixture.state.socketConnections.client.size === 0,
      20_000,
    );
    assert.deepEqual(await client.draftKeys(), [], 'Client logout must clear T12 chat drafts.');

    await loginContext(client, 'chat-client@example.test', 'client-password', '/', 'main-screen');
    await client.click('chat-fab');
    await waitFor('client chat restored before account deletion', () =>
      client.exists('chat-conversation-screen'),
    );
    await client.setValue('chat-message-input', 'Черновик удаляется вместе с аккаунтом');
    await waitFor(
      'account deletion draft persisted',
      async () => (await client.draftKeys()).length === 1,
    );
    await client.click('chat-back');
    await waitFor('client home before account deletion', () => client.exists('main-screen'));
    await client.activatePushSubscription();
    await waitFor(
      'T13 browser push seam ready for destructive lifecycle',
      async () =>
        (await client.pushLifecycle()).subscribed &&
        (await client.cdp.evaluate(
          `navigator.serviceWorker.getRegistration('/').then(
            (registration) => registration?.active?.state === 'activated',
          )`,
        )),
      20_000,
    );
    await client.click('tab-settings');
    await waitFor('settings account deletion surface', () =>
      client.exists('settings-account-section'),
    );
    fixture.state.accountDeleteExpectedAuthorization = `Bearer ${fixture.state.currentAccessToken.client}`;
    await client.click('settings-delete-account');
    await waitFor('account deletion warning', () => client.exists('settings-delete-continue'));
    await client.click('settings-delete-continue');
    await waitFor('account deletion confirmation', () =>
      client.exists('settings-delete-confirmation'),
    );
    await client.setValue('settings-delete-confirmation', 'DELETE');
    await waitFor(
      'account deletion confirmation enabled',
      async () => !(await client.disabled('settings-delete-confirm')),
    );
    await client.click('settings-delete-confirm');
    await waitFor(
      'account deletion captured-token lifecycle and socket teardown',
      async () =>
        fixture.state.accountDeleteCount === 1 &&
        fixture.state.socketConnections.client.size === 0 &&
        (await client.exists('login-screen')),
      20_000,
    );
    assert.deepEqual(await client.draftKeys(), []);
    assert.deepEqual(await client.pushLifecycle(), {
      subscribed: false,
      unsubscribeCalls: 1,
      order: ['browser-unsubscribe:start', 'browser-unsubscribe:done'],
    });
    assert.equal(fixture.state.pushSubscriptionDeleteCount, 0);
    assert.equal(
      fixture.state.accountDeleteAuthorization,
      fixture.state.accountDeleteExpectedAuthorization,
    );
    assert.equal(fixture.state.mediaDeletionJobs.length, fixture.state.photos.size);
    assert.ok(fixture.state.mediaDeletionJobs.length >= 2);
    assert.equal(
      new Set(fixture.state.mediaDeletionJobs.map(({ object_key: objectKey }) => objectKey)).size,
      fixture.state.mediaDeletionJobs.length,
    );

    assert.ok(fixture.state.messageSenders.includes('client'));
    assert.ok(fixture.state.messageSenders.includes('trainer'));
    assert.ok(
      fixture.state.readUpdates.some(
        ({ role, throughSequence }) => role === 'trainer' && throughSequence === 1,
      ),
    );
    assert.ok(
      fixture.state.readUpdates.some(
        ({ role, throughSequence }) => role === 'client' && throughSequence >= 2,
      ),
    );
    t14BrowserEvidence.coexistence = true;
    assert.deepEqual(t14BrowserEvidence, {
      parallelSlots: true,
      cancelIsolation: true,
      fatalSiblingAbort: true,
      resumeIdentity: true,
      nativePreAbortedNoSend: true,
      previewPrivateUrl: true,
      previewCapabilityCleared: true,
      reloadPolling: true,
      logoutCapabilityCleared: true,
      coexistence: true,
    });
  } catch (error) {
    for (const [label, context] of [
      ['client', client],
      ['trainer', trainer],
    ]) {
      if (context === null) continue;
      try {
        const diagnostics = await context.cdp.evaluate(`(async () => {
          let serviceWorkers = [];
          if ('serviceWorker' in navigator) {
            try {
              const registrations = await navigator.serviceWorker.getRegistrations();
              serviceWorkers = registrations.map((registration) => ({
                scope: registration.scope,
                active: registration.active?.state ?? null,
                installing: registration.installing?.state ?? null,
                waiting: registration.waiting?.state ?? null,
              }));
            } catch {
              serviceWorkers = [{ error: 'registration-inspection-failed' }];
            }
          }
          const pushState = window.__kinetraT12BrowserTest?.state ?? null;
          return JSON.stringify({
            url: window.location.href,
            readyState: document.readyState,
            text: document.body?.innerText?.slice(0, 2000) ?? '',
            drafts: Object.keys(sessionStorage).filter((key) => key.startsWith('kinetra.chat.draft.v1:')),
            push: pushState === null ? null : {
              subscribed: pushState.pushSubscribed,
              unsubscribeCalls: pushState.pushUnsubscribeCalls,
              lifecycleOrder: [...pushState.lifecycleOrder],
            },
            serviceWorkers,
            historyState: window.history.state,
          });
        })()`);
        console.error(`T12 ${label} diagnostics: ${diagnostics}`);
      } catch (diagnosticError) {
        console.error(`Could not collect T12 ${label} diagnostics.`, diagnosticError);
      }
      const chromeErrors = context.chromeErrors();
      if (chromeErrors.trim().length > 0) console.error(chromeErrors.slice(-4_000));
    }
    throw error;
  } finally {
    fixture.releaseFatalSiblingPuts();
    fixture.releaseStaleSessionRace();
    client?.cdp.close();
    trainer?.cdp.close();
    await Promise.all([
      terminateChrome(client?.chrome ?? null),
      terminateChrome(trainer?.chrome ?? null),
    ]);
    await new Promise((resolve) => fixture.socketServer.close(resolve));
    await close(fixture.server);
    await Promise.all([
      removeProfileDirectory(clientProfileDirectory),
      removeProfileDirectory(trainerProfileDirectory),
      rm(syntheticVideoDirectory, { recursive: true, force: true }),
    ]);
    await assertNoBrowserProfileDirectories();
  }

  console.log('KINETRA_T14_T07_T12_T13_COEXISTENCE=PASS');
  console.log('KINETRA_T14_BROWSER_E2E=PASS');
  console.log('KINETRA_T12_BROWSER_E2E=PASS');
};

await buildFrontendForBrowserTest();
await runBrowserScenario();
await runT12BrowserScenario();
