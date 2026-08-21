import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  baseLessonsGet: 0,
  lessonProgress: 0,
  baseProgramComplete: 0,
  currentWeekGet: 0,
  scheduleGet: 0,
  progressGet: 0,
  weeklyMetricsPut: 0,
  goalPut: 0,
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

const programWeekPayload = (weekNumber) => {
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
          weekNumber === 1 && dayOfWeek === 1
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
      json(response, 200, programWeekPayload(1));
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

      json(response, 200, programWeekPayload(weekNumber));
      return;
    }

    if (request.method === 'PUT' && request.url === '/api/v1/program/complete-workout') {
      if (!hasValidAccessToken(request)) {
        json(response, 401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid access token is required.' },
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
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
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
      exists('base-lessons-screen'),
    );
    assert.equal(await pathname(), '/base-lessons');
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.slide')"), null);
    assert.equal(await cdp.evaluate("sessionStorage.getItem('kinetra.onboarding.user')"), null);

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
    await waitFor('settings before logout', () => exists('settings-screen'));
    assert.equal(await pathname(), '/settings');
    assert.equal(await attribute('tab-settings', 'aria-current'), 'page');
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
    assert.ok(counters.baseLessonsGet >= 7);
    assert.equal(counters.lessonProgress, 6);
    assert.equal(counters.baseProgramComplete, 1);
    assert.ok(counters.currentWeekGet >= 2);
    assert.ok(counters.scheduleGet >= 3);
    assert.ok(counters.progressGet >= 1);
    assert.equal(counters.weeklyMetricsPut, 1);
    assert.equal(counters.goalPut, 1);
    assert.equal(counters.weekGet, 4);
    assert.equal(counters.workoutComplete, 1);
    assert.equal(counters.logout, 1);

    console.log('KINETRA_T04_BROWSER_E2E=PASS');
    console.log('KINETRA_T05_BROWSER_E2E=PASS');
    console.log('KINETRA_T06_BROWSER_E2E=PASS');
    console.log('KINETRA_T07_BROWSER_E2E=PASS');
    console.log('KINETRA_T08_BROWSER_E2E=PASS');
    console.log('KINETRA_T09_BROWSER_E2E=PASS');
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

await buildFrontendForBrowserTest();
await runBrowserScenario();
