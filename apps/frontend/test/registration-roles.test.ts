import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TrainerVerificationApplicationInput } from '@kinetra/shared';

import { ApiClient } from '../src/lib/api.js';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

const verificationApplication: TrainerVerificationApplicationInput = {
  display_name: 'Анна Тренер',
  specialization: 'Мобильность',
  experience_years: 4,
  bio: 'Провожу индивидуальные занятия и помогаю развивать мобильность.',
  city: 'Москва',
  timezone: 'Europe/Moscow',
  materials: [
    {
      kind: 'professional_profile',
      url: 'https://example.test/anna',
      title: 'Профессиональный профиль',
    },
  ],
};

test('registration starts without a selected role and uses native accessible radios', async () => {
  const source = await readFile(`${frontendRoot}src/features/auth/RegisterScreen.tsx`, 'utf8');

  assert.match(source, /useState<RequestedRole \| null>\(null\)/u);
  assert.match(source, /<fieldset className="auth-role-picker">/u);
  assert.match(source, /<legend>Кем вы хотите пользоваться Kinetra\?<\/legend>/u);
  assert.match(source, /type="radio"/u);
  assert.match(source, /name="requested-role"/u);
  assert.match(source, /checked=\{requestedRole === role\.id\}/u);
  assert.match(source, /label: 'Тренер'/u);
  assert.match(source, /label: 'Тренирующийся'/u);
  assert.doesNotMatch(source, />Клиент</u);
  assert.match(source, /disabled=\{!canSubmit\}/u);
  assert.match(source, /kind: 'profile_retry'/u);
  assert.match(source, /Аккаунт создан\./u);
  assert.match(source, /Повторить загрузку профиля/u);
});

test('trainer verification exposes every public state and a loading screen', async () => {
  const source = await readFile(
    `${frontendRoot}src/features/trainer-verification/TrainerVerificationScreen.tsx`,
    'utf8',
  );
  assert.match(source, /data-testid="trainer-verification-loading"/u);
  assert.match(source, /Загружаем статус проверки/u);
  for (const state of [
    'not_started',
    'pending',
    'needs_more_info',
    'approved',
    'rejected',
    'withdrawn',
  ]) {
    assert.match(source, new RegExp(`\\b${state}:`, 'u'));
  }
  assert.match(source, /Проверить статус/u);
  assert.match(source, /state === 'needs_more_info'/u);
  assert.match(source, /Отозвать заявку/u);
});

test('verification material links are HTTPS-only', async () => {
  const source = await readFile(
    `${frontendRoot}src/features/trainer-verification/TrainerVerificationScreen.tsx`,
    'utf8',
  );
  assert.match(source, /new URL\(value\)\.protocol === 'https:'/u);
  assert.match(source, /укажите только HTTPS-ссылки/u);
});

test('approved verification refreshes trainer authority once and fails closed while inactive', async () => {
  const source = await readFile(
    `${frontendRoot}src/features/trainer-verification/TrainerVerificationScreen.tsx`,
    'utf8',
  );

  assert.match(source, /approvedProfileRefreshAttemptedRef = useRef\(false\)/u);
  assert.match(source, /profile\.account_role !== 'trainer'/u);
  assert.match(source, /права тренера пока не активны/u);
  assert.match(source, /!approvedProfileRefreshAttemptedRef\.current/u);
});

test('trainer verification client uses the exact authenticated user endpoints', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly body: string | null;
  }> = [];
  const response = {
    requested_role: 'trainer' as const,
    trainer_verification_state: 'not_started' as const,
    request: null,
  };
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/auth/login') {
        return Response.json({
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'trainer@example.test',
            phone: null,
            emailVerified: true,
            createdAt: '2026-08-28T00:00:00.000Z',
          },
          accessToken: 'trainer-token',
          tokenType: 'Bearer',
          expiresIn: 900,
        });
      }

      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body === undefined || init.body === null ? null : String(init.body),
      });
      return Response.json(response);
    },
  });

  await client.login('trainer@example.test', 'long-enough-password');
  await client.getTrainerVerification();
  await client.createTrainerVerification(verificationApplication);
  await client.updateTrainerVerification(verificationApplication);
  await client.withdrawTrainerVerification();

  assert.deepEqual(
    calls.map(({ path, method }) => ({ path, method })),
    [
      { path: '/api/v1/trainer-verification/me', method: 'GET' },
      { path: '/api/v1/trainer-verification', method: 'POST' },
      { path: '/api/v1/trainer-verification/me', method: 'PATCH' },
      { path: '/api/v1/trainer-verification/me/withdraw', method: 'POST' },
    ],
  );
  assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), verificationApplication);
  assert.deepEqual(JSON.parse(calls[2]?.body ?? ''), verificationApplication);
  assert.equal(calls[3]?.body, '{}');
});

test('frontend keeps pending requested trainers out of the trainer shell and chat runtime', async () => {
  const appSource = await readFile(`${frontendRoot}src/App.tsx`, 'utf8');
  const verificationSource = await readFile(
    `${frontendRoot}src/features/trainer-verification/TrainerVerificationScreen.tsx`,
    'utf8',
  );
  const actualTrainerGate = appSource.indexOf("if (profile.account_role === 'trainer')");
  const requestedTrainerGate = appSource.indexOf("if (profile.requested_role === 'trainer')");
  const signOutStateGate = appSource.indexOf("if (trainerSignOutState !== 'idle')");

  assert.ok(signOutStateGate >= 0);
  assert.ok(signOutStateGate < actualTrainerGate);
  assert.ok(actualTrainerGate >= 0);
  assert.ok(requestedTrainerGate > actualTrainerGate);
  assert.match(
    appSource,
    /session\.profile\.user\.onboardingStatus === 'active' && !trainerVerificationRequired/u,
  );
  assert.match(appSource, /onSignOut=\{handleTrainerSignOut\}/u);
  assert.match(verificationSource, /readonly onSignOut: \(\) => void/u);
  assert.match(verificationSource, />\s*Выйти\s*<\/button>/u);
});

test('verification UI uses link metadata only and defines mobile columns after desktop columns', async () => {
  const screenSource = await readFile(
    `${frontendRoot}src/features/trainer-verification/TrainerVerificationScreen.tsx`,
    'utf8',
  );
  const css = await readFile(`${frontendRoot}src/styles.css`, 'utf8');
  const desktopColumns = css.indexOf('.verification-fields {');
  const mobileBreakpoint = css.indexOf('@media (max-width: 560px)', desktopColumns);

  assert.doesNotMatch(screenSource, /type="file"/u);
  assert.doesNotMatch(screenSource, /\bS3\b/u);
  assert.match(screenSource, /Файлы не загружаются/u);
  assert.ok(desktopColumns >= 0);
  assert.ok(mobileBreakpoint > desktopColumns);
  assert.match(
    css.slice(mobileBreakpoint),
    /\.auth-role-options,[\s\S]*\.verification-fields,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/u,
  );
});
