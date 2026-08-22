import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const failures = [];
const passes = [];

const pass = (message) => passes.push(message);
const fail = (message) => failures.push(message);

const readText = async (relativePath) =>
  readFile(resolve(root, relativePath), { encoding: 'utf8' });

const readJson = async (relativePath) => JSON.parse(await readText(relativePath));

const expectFile = async (relativePath) => {
  try {
    await access(resolve(root, relativePath));
    pass(`file: ${relativePath}`);
    return true;
  } catch {
    fail(`missing file: ${relativePath}`);
    return false;
  }
};

const expectIncludes = (text, fragment, message) => {
  if (text.includes(fragment)) {
    pass(message);
  } else {
    fail(message);
  }
};

const expectMatches = (text, pattern, message) => {
  if (pattern.test(text)) {
    pass(message);
  } else {
    fail(message);
  }
};

const requiredFiles = [
  '.env.example',
  '.github/workflows/ci.yml',
  'docker-compose.yml',
  'README.md',
  'docs/T02_AUTH_API.md',
  'docs/T04_PROFILE_SURVEY.md',
  'docs/T05_ONBOARDING_CAROUSEL.md',
  'docs/T06_BASE_LESSONS.md',
  'docs/T07_MAIN_SCREEN.md',
  'docs/T08_SCHEDULE.md',
  'docs/T09_PROGRESS.md',
  'docs/T10_SETTINGS.md',
  'docs/T11_PAYMENTS.md',
  'docs/T13_PUSH_NOTIFICATIONS.md',
  'apps/frontend/index.html',
  'apps/frontend/src/features/auth/LoginScreen.tsx',
  'apps/frontend/src/features/survey/SurveyWizard.tsx',
  'apps/frontend/src/features/survey/model.ts',
  'apps/frontend/src/features/onboarding/OnboardingCarousel.tsx',
  'apps/frontend/src/features/onboarding/model.ts',
  'apps/frontend/src/features/base-lessons/BaseLessonsScreen.tsx',
  'apps/frontend/src/features/base-lessons/BaseLessonsView.tsx',
  'apps/frontend/src/features/base-lessons/LessonPlayer.tsx',
  'apps/frontend/src/features/base-lessons/model.ts',
  'apps/frontend/src/features/navigation/TabBar.tsx',
  'apps/frontend/src/features/program/ProgramScreen.tsx',
  'apps/frontend/src/features/program/ProgramWeekView.tsx',
  'apps/frontend/src/features/program/WorkoutPlayer.tsx',
  'apps/frontend/src/features/program/history.ts',
  'apps/frontend/src/features/program/model.ts',
  'apps/frontend/src/features/schedule/ScheduleScreen.tsx',
  'apps/frontend/src/features/schedule/ScheduleView.tsx',
  'apps/frontend/src/features/progress/ProgressDialogs.tsx',
  'apps/frontend/src/features/progress/ProgressLineChart.tsx',
  'apps/frontend/src/features/progress/ProgressScreen.tsx',
  'apps/frontend/src/features/progress/ProgressView.tsx',
  'apps/frontend/src/features/progress/model.ts',
  'apps/frontend/src/features/settings/SettingsDialogs.tsx',
  'apps/frontend/src/features/settings/SettingsIcons.tsx',
  'apps/frontend/src/features/settings/SettingsScreen.tsx',
  'apps/frontend/src/features/settings/SettingsView.tsx',
  'apps/frontend/src/features/settings/model.ts',
  'apps/frontend/src/features/theme/ThemeProvider.tsx',
  'apps/frontend/src/features/theme/model.ts',
  'apps/frontend/src/features/payments/model.ts',
  'apps/frontend/src/features/payments/PaymentView.tsx',
  'apps/frontend/src/features/payments/PaymentScreen.tsx',
  'apps/frontend/src/features/payments/PaymentSuccessScreen.tsx',
  'apps/frontend/src/features/payments/PaymentCancelScreen.tsx',
  'apps/frontend/src/features/payments/SubscriptionPaywallDialog.tsx',
  'apps/frontend/src/features/payments/SubscriptionLockedScreen.tsx',
  'apps/frontend/src/features/payments/SubscriptionVerificationState.tsx',
  'apps/frontend/src/routing.ts',
  'apps/frontend/test/api-session.test.ts',
  'apps/frontend/test/survey-routing.test.ts',
  'apps/frontend/test/onboarding.test.ts',
  'apps/frontend/test/base-lessons-api.test.ts',
  'apps/frontend/test/base-lessons.test.ts',
  'apps/frontend/test/main-screen.test.ts',
  'apps/frontend/test/program-api.test.ts',
  'apps/frontend/test/schedule-api.test.ts',
  'apps/frontend/test/schedule.test.ts',
  'apps/frontend/test/progress-api.test.ts',
  'apps/frontend/test/progress.test.ts',
  'apps/frontend/test/settings-api.test.ts',
  'apps/frontend/test/settings.test.ts',
  'apps/frontend/test/theme.test.ts',
  'apps/frontend/test/payments-api.test.ts',
  'apps/frontend/test/payments.test.ts',
  'apps/frontend/test/push-notifications.test.ts',
  'apps/frontend/test/service-worker.test.ts',
  'apps/frontend/public/manifest.webmanifest',
  'apps/frontend/public/service-worker.js',
  'apps/frontend/public/offline.html',
  'apps/frontend/public/theme-init.js',
  'apps/frontend/public/icons/icon-192.png',
  'apps/frontend/public/icons/icon-512.png',
  'apps/frontend/public/icons/icon-maskable-512.png',
  'apps/frontend/src/pwa/registerServiceWorker.ts',
  'apps/frontend/src/pwa/pushNotifications.ts',
  'apps/backend/migrations/001_auth.sql',
  'apps/backend/migrations/002_content.sql',
  'apps/backend/migrations/003_survey.sql',
  'apps/backend/migrations/004_base_lessons.sql',
  'apps/backend/migrations/005_program_media_availability.sql',
  'apps/backend/migrations/006_schedule_copy.sql',
  'apps/backend/migrations/007_progress_data_contract.sql',
  'apps/backend/migrations/008_notifications.sql',
  'apps/backend/migrations/009_payments.sql',
  'apps/backend/migrations/010_push_notifications.sql',
  'apps/backend/scripts/migrate.mjs',
  'apps/backend/scripts/seed.mjs',
  'apps/backend/scripts/verify-content.mjs',
  'apps/backend/src/app.ts',
  'apps/backend/src/server.ts',
  'apps/backend/src/auth/cookies.ts',
  'apps/backend/src/auth/normalization.ts',
  'apps/backend/src/auth/password.ts',
  'apps/backend/src/auth/postgres-auth.repository.ts',
  'apps/backend/src/auth/rate-limit.ts',
  'apps/backend/src/auth/router.ts',
  'apps/backend/src/auth/service.ts',
  'apps/backend/src/auth/tokens.ts',
  'apps/backend/src/auth/middleware.ts',
  'apps/backend/src/profile/postgres-profile.repository.ts',
  'apps/backend/src/profile/router.ts',
  'apps/backend/src/profile/schema.ts',
  'apps/backend/src/profile/service.ts',
  'apps/backend/src/base-lessons/router.ts',
  'apps/backend/src/base-lessons/schema.ts',
  'apps/backend/src/base-lessons/service.ts',
  'apps/backend/src/base-lessons/repository.ts',
  'apps/backend/src/base-lessons/postgres-base-lessons.repository.ts',
  'apps/backend/src/base-lessons/runtime.ts',
  'apps/backend/src/base-lessons/storage.ts',
  'apps/backend/src/program/router.ts',
  'apps/backend/src/program/schema.ts',
  'apps/backend/src/program/service.ts',
  'apps/backend/src/program/repository.ts',
  'apps/backend/src/program/postgres-program.repository.ts',
  'apps/backend/src/program/runtime.ts',
  'apps/backend/src/progress/postgres-progress.repository.ts',
  'apps/backend/src/progress/repository.ts',
  'apps/backend/src/progress/router.ts',
  'apps/backend/src/progress/runtime.ts',
  'apps/backend/src/progress/schema.ts',
  'apps/backend/src/progress/service.ts',
  'apps/backend/src/settings/postgres-settings.repository.ts',
  'apps/backend/src/settings/repository.ts',
  'apps/backend/src/settings/router.ts',
  'apps/backend/src/settings/runtime.ts',
  'apps/backend/src/settings/schema.ts',
  'apps/backend/src/settings/service.ts',
  'apps/backend/src/payments/repository.ts',
  'apps/backend/src/payments/postgres-payments.repository.ts',
  'apps/backend/src/payments/schema.ts',
  'apps/backend/src/payments/yookassa-client.ts',
  'apps/backend/src/payments/webhook-source.ts',
  'apps/backend/src/payments/service.ts',
  'apps/backend/src/payments/router.ts',
  'apps/backend/src/payments/runtime.ts',
  'apps/backend/src/payments/renewal-service.ts',
  'apps/backend/src/payments/run-renewals.ts',
  'apps/backend/src/payments/subscription-access.ts',
  'apps/backend/src/push/schema.ts',
  'apps/backend/src/push/repository.ts',
  'apps/backend/src/push/postgres-push.repository.ts',
  'apps/backend/src/push/webpush-sender.ts',
  'apps/backend/src/push/service.ts',
  'apps/backend/src/push/scheduler-service.ts',
  'apps/backend/src/push/router.ts',
  'apps/backend/src/push/runtime.ts',
  'apps/backend/src/push/run-notifications.ts',
  'apps/backend/test/auth.e2e.test.ts',
  'apps/backend/test/profile.e2e.test.ts',
  'apps/backend/test/profile.postgres.test.ts',
  'apps/backend/test/base-lessons.e2e.test.ts',
  'apps/backend/test/base-lessons.postgres.test.ts',
  'apps/backend/test/program.e2e.test.ts',
  'apps/backend/test/program.postgres.test.ts',
  'apps/backend/test/progress.e2e.test.ts',
  'apps/backend/test/progress.postgres.test.ts',
  'apps/backend/test/settings.e2e.test.ts',
  'apps/backend/test/settings.postgres.test.ts',
  'apps/backend/test/payments.e2e.test.ts',
  'apps/backend/test/payments.postgres.test.ts',
  'apps/backend/test/yookassa-client.test.ts',
  'apps/backend/test/push.e2e.test.ts',
  'apps/backend/test/push.postgres.test.ts',
  'apps/backend/test/webpush-sender.test.ts',
  'apps/backend/test/notification-scheduler.test.ts',
  'apps/backend/test/support/fake-object-url-signer.ts',
  'apps/backend/test/support/fake-subscription-access-checker.ts',
  'apps/backend/test/support/fake-yookassa-client.ts',
  'apps/backend/test/support/in-memory-base-lessons.repository.ts',
  'apps/backend/test/support/in-memory-program.repository.ts',
  'apps/backend/test/support/in-memory-progress.repository.ts',
  'apps/backend/test/support/in-memory-settings.repository.ts',
  'apps/backend/test/support/in-memory-payments.repository.ts',
  'apps/backend/test/support/in-memory-push.repository.ts',
  'apps/backend/test/support/fake-webpush-sender.ts',
  'scripts/test-frontend-browser.mjs',
  'packages/shared/src/index.ts',
];

await Promise.all(requiredFiles.map(expectFile));

const rootPackage = await readJson('package.json');
const frontendPackage = await readJson('apps/frontend/package.json');
const backendPackage = await readJson('apps/backend/package.json');
const sharedPackage = await readJson('packages/shared/package.json');

if (
  rootPackage.name === 'kinetra' &&
  frontendPackage.name === '@kinetra/frontend' &&
  backendPackage.name === '@kinetra/backend' &&
  sharedPackage.name === '@kinetra/shared'
) {
  pass('Kinetra workspace package names are exact');
} else {
  fail('Kinetra workspace package names are exact');
}

if (
  Array.isArray(rootPackage.workspaces) &&
  rootPackage.workspaces.includes('apps/*') &&
  rootPackage.workspaces.includes('packages/*')
) {
  pass('npm workspaces configured');
} else {
  fail('npm workspaces configured');
}

for (const dependency of ['bcrypt', 'express', 'jose', 'pg', 'socket.io']) {
  if (backendPackage.dependencies?.[dependency]) {
    pass(`backend dependency: ${dependency}`);
  } else {
    fail(`backend dependency: ${dependency}`);
  }
}

for (const dependency of ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']) {
  if (backendPackage.dependencies?.[dependency]) {
    pass(`T06 backend dependency: ${dependency}`);
  } else {
    fail(`T06 backend dependency: ${dependency}`);
  }
}

if (
  !Object.keys(backendPackage.dependencies ?? {}).some((dependency) =>
    /yoo-?kassa|yookassa|yoomoney/iu.test(dependency),
  )
) {
  pass('T11 uses the documented YooKassa REST API without an unofficial SDK dependency');
} else {
  fail('T11 uses the documented YooKassa REST API without an unofficial SDK dependency');
}

if (backendPackage.dependencies?.['web-push']) {
  pass('T13 backend dependency: web-push');
} else {
  fail('T13 backend dependency: web-push');
}

if (backendPackage.devDependencies?.['@types/web-push']) {
  pass('T13 backend TypeScript dependency: @types/web-push');
} else {
  fail('T13 backend TypeScript dependency: @types/web-push');
}

if (frontendPackage.dependencies?.['socket.io-client']) {
  pass('frontend dependency: socket.io-client');
} else {
  fail('frontend dependency: socket.io-client');
}

for (const script of ['db:migrate', 'db:seed', 'db:verify-content', 'test', 'typecheck', 'build']) {
  if (backendPackage.scripts?.[script]) {
    pass(`backend script: ${script}`);
  } else {
    fail(`backend script: ${script}`);
  }
}

if (backendPackage.scripts?.['payments:renew'] === 'node dist/payments/run-renewals.js') {
  pass('T11 backend exposes the built daily renewal command');
} else {
  fail('T11 backend exposes the built daily renewal command');
}

if (backendPackage.scripts?.['notifications:send'] === 'node dist/push/run-notifications.js') {
  pass('T13 backend exposes the built one-shot notification worker');
} else {
  fail('T13 backend exposes the built one-shot notification worker');
}

const manifest = await readJson('apps/frontend/public/manifest.webmanifest');
for (const field of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color']) {
  if (manifest[field]) {
    pass(`manifest field: ${field}`);
  } else {
    fail(`manifest field: ${field}`);
  }
}

if (manifest.name === 'Kinetra' && manifest.display === 'standalone') {
  pass('manifest identifies Kinetra as standalone PWA');
} else {
  fail('manifest identifies Kinetra as standalone PWA');
}

const manifestIcons = new Map((manifest.icons ?? []).map((icon) => [icon.sizes, icon]));
for (const size of ['192x192', '512x512']) {
  if (manifestIcons.has(size)) {
    pass(`manifest icon: ${size}`);
  } else {
    fail(`manifest icon: ${size}`);
  }
}

if ((manifest.icons ?? []).some((icon) => String(icon.purpose).includes('maskable'))) {
  pass('maskable PWA icon declared');
} else {
  fail('maskable PWA icon declared');
}

const readPngSize = async (relativePath) => {
  const buffer = await readFile(resolve(root, relativePath));
  const signature = buffer.subarray(0, 8).toString('hex');

  if (signature !== '89504e470d0a1a0a' || buffer.length < 24) {
    return null;
  }

  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

for (const [relativePath, expected] of [
  ['apps/frontend/public/icons/icon-192.png', 192],
  ['apps/frontend/public/icons/icon-512.png', 512],
  ['apps/frontend/public/icons/icon-maskable-512.png', 512],
]) {
  const dimensions = await readPngSize(relativePath);

  if (dimensions?.width === expected && dimensions.height === expected) {
    pass(`PNG dimensions: ${relativePath}`);
  } else {
    fail(`PNG dimensions: ${relativePath}`);
  }
}

const indexHtml = await readText('apps/frontend/index.html');
expectIncludes(indexHtml, 'manifest.webmanifest', 'PWA manifest linked from index.html');
expectIncludes(indexHtml, 'theme-color', 'PWA theme metadata present');

const registration = await readText('apps/frontend/src/pwa/registerServiceWorker.ts');
expectIncludes(
  registration,
  "serviceWorker.register('/service-worker.js')",
  'service worker registration present',
);

const serviceWorker = await readText('apps/frontend/public/service-worker.js');
expectIncludes(
  serviceWorker,
  "caches.match('/offline.html')",
  'offline navigation fallback present',
);
expectMatches(
  serviceWorker,
  /pathname\.startsWith\('\/api\/'\)/u,
  'service worker bypasses API calls',
);

const backendApp = await readText('apps/backend/src/app.ts');
expectIncludes(backendApp, "app.get('/health'", 'health endpoint present');
expectIncludes(backendApp, "'/api/v1/auth'", 'auth router mounted under /api/v1/auth');
expectIncludes(backendApp, "app.disable('x-powered-by')", 'Express signature header disabled');

const router = await readText('apps/backend/src/auth/router.ts');
for (const endpoint of [
  '/register',
  '/login',
  '/refresh',
  '/logout',
  '/password-reset/request',
  '/password-reset/confirm',
  '/verify-email',
]) {
  expectIncludes(router, `'${endpoint}'`, `auth endpoint: POST ${endpoint}`);
}
expectIncludes(router, 'assertNoUserIdOverride', 'request body cannot override user identity');
expectIncludes(router, 'emailVerificationEnabled', 'verify-email route is configuration-gated');
expectIncludes(
  router,
  "response.setHeader('Cache-Control', 'no-store')",
  'auth responses disable caching',
);
expectIncludes(
  router,
  'clearRefreshTokenCookie',
  'invalid/logout/reset flows clear refresh cookie',
);

const password = await readText('apps/backend/src/auth/password.ts');
expectIncludes(password, "from 'bcrypt'", 'bcrypt implementation imported');
expectIncludes(password, 'bcrypt.hash', 'password hashing uses bcrypt');
expectIncludes(password, 'bcrypt.compare', 'password verification uses bcrypt');
expectIncludes(password, '72 UTF-8 bytes', 'bcrypt 72-byte boundary enforced');

const tokens = await readText('apps/backend/src/auth/tokens.ts');
expectIncludes(tokens, 'randomBytes(48)', 'opaque tokens use cryptographic randomness');
expectIncludes(tokens, "createHash('sha256')", 'opaque tokens are hashed with SHA-256');
expectIncludes(tokens, 'new SignJWT', 'access JWT is signed with jose');
expectIncludes(tokens, 'jwtVerify', 'access JWT verification is implemented');
expectIncludes(tokens, "alg: 'HS256'", 'JWT algorithm is pinned to HS256');
expectIncludes(tokens, '.setExpirationTime', 'access JWT has expiration');

const normalization = await readText('apps/backend/src/auth/normalization.ts');
expectIncludes(normalization, "normalize('NFKC')", 'identifiers use Unicode normalization');
expectIncludes(normalization, 'domainToASCII', 'email domain is normalized to ASCII');
expectIncludes(normalization, 'PHONE_PATTERN', 'phone normalization enforces international format');

const service = await readText('apps/backend/src/auth/service.ts');
expectIncludes(service, 'DUMMY_BCRYPT_HASH', 'unknown login performs a dummy password comparison');
expectIncludes(service, 'PASSWORD_RESET_REQUEST_MESSAGE', 'password reset uses a generic response');
expectIncludes(service, 'rotateRefreshSession', 'refresh token rotation implemented');
expectIncludes(service, 'replacePasswordUsingResetToken', 'one-time password reset implemented');
expectIncludes(service, 'emailVerificationRequired', 'optional email verification implemented');

const repository = await readText('apps/backend/src/auth/postgres-auth.repository.ts');
expectIncludes(repository, "await client.query('BEGIN')", 'PostgreSQL transactions implemented');
expectIncludes(repository, 'FOR UPDATE', 'one-time and refresh tokens are row-locked');
expectIncludes(repository, 'replaced_by_token_id', 'refresh replacement chain stored');
expectMatches(
  repository,
  /WHERE user_id = \$1 AND revoked_at IS NULL/u,
  'all active refresh sessions can be revoked',
);
expectMatches(repository, /\$1/u, 'PostgreSQL repository uses parameterized queries');

const migration = await readText('apps/backend/migrations/001_auth.sql');
for (const table of [
  'users',
  'refresh_tokens',
  'password_reset_tokens',
  'email_verification_tokens',
]) {
  expectMatches(
    migration,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'u'),
    `table: ${table}`,
  );
}
expectIncludes(migration, 'password_hash text NOT NULL', 'only password hash column is defined');
expectIncludes(migration, 'token_hash char(64) NOT NULL', 'token tables store hashes');
expectIncludes(migration, 'revoked_at timestamptz NULL', 'refresh revocation timestamp stored');
expectIncludes(
  migration,
  'used_at timestamptz NULL',
  'one-time token consumption timestamp stored',
);
expectIncludes(migration, 'expires_at timestamptz NOT NULL', 'token TTL stored');
expectIncludes(
  migration,
  'password_reset_tokens_one_outstanding_idx',
  'only one outstanding reset token per user',
);

const contentMigration = await readText('apps/backend/migrations/002_content.sql');
for (const table of [
  'videos',
  'program_weeks',
  'program_days',
  'subscriptions',
  'video_progress',
  'workout_completions',
  'weekly_metrics',
  'achievements',
  'user_achievements',
]) {
  expectMatches(
    contentMigration,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'u'),
    `T03 table: ${table}`,
  );
}
expectIncludes(
  contentMigration,
  "type IN ('base_lesson', 'workout')",
  'video types are constrained',
);
expectIncludes(
  contentMigration,
  "provider IN ('yukassa', 'tribute')",
  'subscription providers are constrained',
);
expectIncludes(
  contentMigration,
  'videos_workout_schedule_unique_idx',
  'workout schedule has a unique index',
);
expectIncludes(
  contentMigration,
  'PRIMARY KEY (user_id, video_id)',
  'video progress has a composite primary key',
);
expectIncludes(
  contentMigration,
  'PRIMARY KEY (user_id, achievement_id)',
  'user achievements have a composite primary key',
);

const contentSeed = await readText('apps/backend/scripts/seed.mjs');
expectIncludes(contentSeed, 'weekNumber <= 12', 'seed creates 12 program weeks');
expectIncludes(contentSeed, 'daySchedule', 'seed defines the seven-day schedule');
expectIncludes(contentSeed, 'baseLessons', 'seed defines base lessons');
expectIncludes(contentSeed, 'workoutSlugs', 'seed creates workout videos');
expectIncludes(contentSeed, 'achievements', 'seed defines initial achievements');
expectIncludes(contentSeed, 'ON CONFLICT', 'seed is idempotent');
expectIncludes(contentSeed, 'KINETRA_CONTENT_SEED=PASS', 'seed performs count verification');
expectIncludes(
  contentSeed,
  "'base_lesson', NULL, NULL, $4, NULL, NULL, 'published'",
  'T06 seed creates base lessons without fake media keys',
);

const contentVerifier = await readText('apps/backend/scripts/verify-content.mjs');
expectIncludes(
  contentVerifier,
  'KINETRA_T03_DATABASE_VERIFICATION=PASS',
  'T03 database verification script is present',
);
for (const databaseInvariant of [
  'videos_workout_storage_key_required',
  'video_progress_completed_state_valid',
  'video_progress_user_completed_idx',
]) {
  expectIncludes(
    contentVerifier,
    databaseInvariant,
    `T06 database verifier checks ${databaseInvariant}`,
  );
}
expectMatches(
  contentVerifier,
  /WHERE conname = ANY\(\$1::text\[\]\)[\s\S]*?\[\s*\[\s*'videos_storage_key_not_blank'/u,
  'T06 database verifier binds constraint names as one PostgreSQL array parameter',
);
expectIncludes(
  contentVerifier,
  'videos_media_available_requires_storage_key',
  'T07 database verifier checks the workout media availability constraint',
);

const ciWorkflow = await readText('.github/workflows/ci.yml');
expectIncludes(ciWorkflow, 'run: npm run db:seed', 'CI executes the T03 seed');
expectIncludes(
  ciWorkflow,
  'run: npm run db:verify-content',
  'CI verifies the T03 schema and seeded data',
);
expectIncludes(
  ciWorkflow,
  'DATABASE_URL: postgresql://kinetra:kinetra_test_ci@localhost:5432/kinetra_test',
  'CI passes DATABASE_URL to the PostgreSQL test job',
);
expectIncludes(
  ciWorkflow,
  "KINETRA_REQUIRE_POSTGRES_TEST: 'true'",
  'CI requires the PostgreSQL integration test',
);
expectIncludes(ciWorkflow, 'run: npm run db:migrate', 'CI migrates PostgreSQL before tests');
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T04_POSTGRES_INTEGRATION=PASS'",
  'CI proves that the PostgreSQL integration test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T05_POSTGRES_INTEGRATION=PASS'",
  'CI proves that the T05 PostgreSQL integration test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T05_BROWSER_E2E=PASS'",
  'CI proves that the T05 browser acceptance test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T06_BACKEND_E2E=PASS'",
  'CI proves that the T06 HTTP E2E test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T06_POSTGRES_INTEGRATION=PASS'",
  'CI proves that the T06 PostgreSQL integration test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T06_BROWSER_E2E=PASS'",
  'CI proves that the T06 browser acceptance test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T07_BACKEND_E2E=PASS'",
  'CI proves that the T07 HTTP E2E test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T07_POSTGRES_INTEGRATION=PASS'",
  'CI proves that the T07 PostgreSQL integration test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T07_BROWSER_E2E=PASS'",
  'CI proves that the T07 browser acceptance test executed',
);
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T07_TEST_SUITE=PASS'",
  'CI emits the T07 suite completion marker',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T08_BACKEND_E2E=PASS'",
  'CI proves that the T08 HTTP E2E test executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T08_CARD_NAVIGATION=PASS'",
  'CI proves that the T08 card navigation scenario executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T08_COMPLETION_STATE=PASS'",
  'CI proves that the T08 completion scenario executed',
);
expectIncludes(
  ciWorkflow,
  "grep -F 'KINETRA_T08_BROWSER_E2E=PASS'",
  'CI proves that the T08 browser acceptance test executed',
);
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T08_TEST_SUITE=PASS'",
  'CI emits the T08 suite completion marker',
);
expectIncludes(
  ciWorkflow,
  'sha256sum -c MANIFEST.sha256',
  'CI verifies the checked-in source manifest',
);
expectIncludes(
  ciWorkflow,
  'git ls-files',
  'CI proves that the source manifest covers every tracked file',
);
expectIncludes(
  ciWorkflow,
  "awk '{ print $2 }' MANIFEST.sha256",
  'CI compares manifest entries before validating hashes',
);
expectIncludes(
  ciWorkflow,
  "find /tmp -maxdepth 1 -type d -name 'kinetra-browser-*'",
  'CI rejects leftover browser profile directories',
);

const surveyMigration = await readText('apps/backend/migrations/003_survey.sql');
expectMatches(
  surveyMigration,
  /CREATE TABLE IF NOT EXISTS survey_answers\b/u,
  'T04 survey_answers table is created',
);
expectIncludes(
  surveyMigration,
  'survey_answers_one_current_idx',
  'T04 allows only one current survey per user',
);
expectIncludes(
  surveyMigration,
  'kinetra_text_array_has_unique_elements',
  'T04 database rejects duplicate injury options',
);
expectIncludes(
  surveyMigration,
  'char_length(btrim(injuries_detail)) BETWEEN 1 AND 500',
  'T04 database enforces injury detail length',
);

const authMiddleware = await readText('apps/backend/src/auth/middleware.ts');
expectIncludes(authMiddleware, 'claims.sub', 'T04 protected identity comes from JWT subject');
expectIncludes(authMiddleware, 'request.auth', 'T04 auth middleware stores verified principal');
expectIncludes(
  authMiddleware,
  'AUTHENTICATION_REQUIRED',
  'T04 auth middleware rejects invalid access tokens',
);

const profileRouter = await readText('apps/backend/src/profile/router.ts');
expectMatches(profileRouter, /router\.get\(\s*['"]\/['"]/u, 'T04 GET /api/v1/me route exists');
expectMatches(
  profileRouter,
  /router\.put\(\s*['"]\/survey['"]/u,
  'T04 PUT /api/v1/me/survey route exists',
);
expectIncludes(profileRouter, 'requireAuthenticatedPrincipal', 'T04 routes require JWT principal');
expectMatches(
  profileRouter,
  /router\.put\(\s*['"]\/onboarding-complete['"]/u,
  'T05 PUT /api/v1/me/onboarding-complete route exists',
);

const surveySchema = await readText('apps/backend/src/profile/schema.ts');
expectIncludes(surveySchema, '.strict()', 'T04 survey payload rejects unknown fields');
expectIncludes(surveySchema, "'18-25'", 'T04 age ranges are enumerated');
expectIncludes(surveySchema, 'new Set(injuries)', 'T04 API rejects duplicate injury options');
expectIncludes(surveySchema, 'injuries_detail', 'T04 other injury requires details');

const profileRepository = await readText('apps/backend/src/profile/postgres-profile.repository.ts');
expectIncludes(profileRepository, 'FOR UPDATE', 'T04 survey versioning locks the user row');
expectIncludes(
  profileRepository,
  'SET is_current = false',
  'T04 supersedes the previous survey version',
);
expectIncludes(
  profileRepository,
  "WHEN onboarding_status = 'survey_pending' THEN 'onboarding_pending'",
  'T04 advances onboarding status after the first survey',
);
expectIncludes(
  profileRepository,
  "onboarding_status === 'onboarding_pending'",
  'T05 only advances an onboarding-pending profile',
);
expectIncludes(
  profileRepository,
  "SET onboarding_status = 'base_lessons'",
  'T05 advances onboarding atomically to base lessons',
);

const baseLessonsMigration = await readText('apps/backend/migrations/004_base_lessons.sql');
expectIncludes(
  baseLessonsMigration,
  'ALTER COLUMN storage_key DROP NOT NULL',
  'T06 permits base lesson video placeholders',
);
expectIncludes(
  baseLessonsMigration,
  "type = 'base_lesson' OR storage_key IS NOT NULL",
  'T06 keeps workout storage keys mandatory',
);
expectIncludes(
  baseLessonsMigration,
  'completed_at IS NULL OR completion_percent >= 90',
  'T06 completion timestamp accepts the ninety-percent threshold',
);
expectIncludes(
  baseLessonsMigration,
  'video_progress_user_completed_idx',
  'T06 completion lookup has a user-scoped partial index',
);

const programMediaMigration = await readText(
  'apps/backend/migrations/005_program_media_availability.sql',
);
expectIncludes(
  programMediaMigration,
  'media_available boolean NOT NULL DEFAULT false',
  'T07 workout media stays unavailable until an upload is confirmed',
);
expectIncludes(
  programMediaMigration,
  'videos_media_available_requires_storage_key',
  'T07 available media must have a storage key',
);
expectIncludes(
  programMediaMigration,
  'NOT media_available OR storage_key IS NOT NULL',
  'T07 database rejects available media without an object key',
);

expectIncludes(
  backendApp,
  "'/api/v1/base-lessons'",
  'T06 base lessons router is mounted under /api/v1/base-lessons',
);

const baseLessonsRouter = await readText('apps/backend/src/base-lessons/router.ts');
expectMatches(baseLessonsRouter, /router\.get\(\s*['"]\/['"]/u, 'T06 GET lesson list route exists');
expectMatches(
  baseLessonsRouter,
  /router\.put\(\s*['"]\/complete-program['"]/u,
  'T06 complete-program route exists',
);
expectMatches(
  baseLessonsRouter,
  /router\.put\(\s*['"]\/:lessonId\/progress['"]/u,
  'T06 progress route exists',
);
expectIncludes(baseLessonsRouter, 'router.use(authMiddleware)', 'T06 routes require access JWT');
expectIncludes(baseLessonsRouter, "'Cache-Control', 'no-store'", 'T06 responses disable caching');

const baseLessonsSchema = await readText('apps/backend/src/base-lessons/schema.ts');
expectIncludes(baseLessonsSchema, ".uuid('lessonId", 'T06 validates lesson UUIDs');
expectIncludes(baseLessonsSchema, '.int(', 'T06 requires integer playback positions');
expectIncludes(baseLessonsSchema, '.min(0', 'T06 rejects negative progress');
expectIncludes(baseLessonsSchema, '.max(100', 'T06 caps completion at one hundred percent');
expectIncludes(baseLessonsSchema, '.strict()', 'T06 progress payload rejects unknown fields');

const baseLessonsRepository = await readText(
  'apps/backend/src/base-lessons/postgres-base-lessons.repository.ts',
);
expectIncludes(
  baseLessonsRepository,
  "video.type = 'base_lesson'",
  'T06 repository is scoped to base lessons',
);
expectIncludes(
  baseLessonsRepository,
  "video.status = 'published'",
  'T06 repository exposes only published lessons',
);
expectIncludes(
  baseLessonsRepository,
  'ORDER BY video.order_index',
  'T06 lessons have stable order',
);
expectIncludes(
  baseLessonsRepository,
  'ON CONFLICT (user_id, video_id) DO UPDATE',
  'T06 progress uses PostgreSQL upsert',
);
expectIncludes(baseLessonsRepository, 'GREATEST(', 'T06 stale progress cannot reduce completion');
expectIncludes(baseLessonsRepository, 'FOR UPDATE', 'T06 activation locks the user profile');
expectIncludes(
  baseLessonsRepository,
  'progress.completion_percent >= 90',
  'T06 activation counts server-side completed lessons',
);
expectIncludes(
  baseLessonsRepository,
  "SET onboarding_status = 'active'",
  'T06 activation persists the active onboarding status',
);

const baseLessonsService = await readText('apps/backend/src/base-lessons/service.ts');
expectIncludes(
  baseLessonsService,
  'BASE_LESSON_UNLOCK_THRESHOLD = 4',
  'T06 server owns the four-lesson unlock threshold',
);
expectIncludes(
  baseLessonsService,
  "'INSUFFICIENT_LESSONS'",
  'T06 rejects premature program completion',
);
expectIncludes(
  baseLessonsService,
  'this.objectUrlFor(lesson.storageKey)',
  'T06 returns a null video URL for placeholder lessons',
);
expectIncludes(
  baseLessonsService,
  'this.objectUrlFor(lesson.posterKey)',
  'T06 returns a null poster URL for placeholder lessons',
);
expectIncludes(
  baseLessonsService,
  'return key === null || key.trim().length === 0',
  'T06 keeps missing and empty object keys as null URLs',
);

const baseLessonsStorage = await readText('apps/backend/src/base-lessons/storage.ts');
expectIncludes(baseLessonsStorage, 'GetObjectCommand', 'T06 signs S3 object reads');
expectIncludes(baseLessonsStorage, 'getSignedUrl', 'T06 creates presigned media URLs');
expectIncludes(
  baseLessonsStorage,
  'presignedUrlTtlSeconds',
  'T06 presigned media URLs have a bounded TTL',
);

const backendEnvironment = await readText('apps/backend/src/config/env.ts');
expectIncludes(backendEnvironment, 'parseS3Environment', 'T06 validates S3 configuration');
expectIncludes(
  backendEnvironment,
  "'S3_PRESIGNED_URL_TTL_SECONDS'",
  'T06 validates the presigned URL TTL',
);

const baseLessonsDocumentation = await readText('docs/T06_BASE_LESSONS.md');
for (const contract of [
  'GET /api/v1/base-lessons',
  'PUT /api/v1/base-lessons/:lessonId/progress',
  'PUT /api/v1/base-lessons/complete-program',
  'INSUFFICIENT_LESSONS',
  'Видео скоро будет доступно',
  'KINETRA_T06_BACKEND_E2E=PASS',
  'KINETRA_T06_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T06_BROWSER_E2E=PASS',
]) {
  expectIncludes(baseLessonsDocumentation, contract, `T06 documented contract: ${contract}`);
}

expectIncludes(
  backendApp,
  "'/api/v1/program'",
  'T07 program router is mounted under /api/v1/program',
);

const programRouter = await readText('apps/backend/src/program/router.ts');
expectMatches(
  programRouter,
  /router\.get\(\s*['"]\/current-week['"]/u,
  'T07 GET current-week route exists',
);
expectMatches(
  programRouter,
  /router\.get\(\s*['"]\/weeks\/:weekNumber['"]/u,
  'T07 GET selected week route exists',
);
expectMatches(
  programRouter,
  /router\.put\(\s*['"]\/complete-workout['"]/u,
  'T07 PUT complete-workout route exists',
);
expectIncludes(programRouter, 'router.use(authMiddleware)', 'T07 routes require access JWT');
expectIncludes(programRouter, "'Cache-Control', 'no-store'", 'T07 responses disable caching');
expectIncludes(
  programRouter,
  'requireAuthenticatedPrincipal(request)',
  'T07 derives workout identity only from the JWT principal',
);

const programSchema = await readText('apps/backend/src/program/schema.ts');
expectIncludes(programSchema, 'video_id: z.uuid(', 'T07 validates workout video UUIDs');
expectIncludes(programSchema, 'program_week:', 'T07 validates the submitted program week');
expectIncludes(programSchema, '.int(', 'T07 requires integer week numbers');
expectIncludes(programSchema, '.min(1', 'T07 rejects non-positive week numbers');
expectIncludes(programSchema, '.strict()', 'T07 completion payload rejects unknown fields');

const programRepository = await readText('apps/backend/src/program/postgres-program.repository.ts');
expectIncludes(
  programRepository,
  'COUNT(DISTINCT day_of_week)',
  'T07 current-week progress counts distinct completed days',
);
expectIncludes(
  programRepository,
  'latestWeekDaysCompleted >= PROGRAM_DAYS_PER_WEEK',
  'T07 advances after all seven days in the latest started week',
);
expectIncludes(
  programRepository,
  'ORDER BY day.day_of_week',
  'T07 returns seven days in stable weekday order',
);
expectIncludes(
  programRepository,
  'video.media_available',
  'T07 reads explicit workout media availability',
);
expectIncludes(
  programRepository,
  'mediaAvailable: row.media_available',
  'T07 maps persisted workout media availability',
);
expectIncludes(
  programRepository,
  'completion.user_id = $1',
  'T07 completion joins are scoped to the authenticated user',
);
expectIncludes(
  programRepository,
  "SELECT user_id, video_id, $3, CURRENT_DATE, NOW(), 'player'",
  'T07 records player as the workout completion source',
);
expectIncludes(
  programRepository,
  'ON CONFLICT (user_id, video_id, program_week) DO NOTHING',
  'T07 workout completion is idempotent',
);

const programService = await readText('apps/backend/src/program/service.ts');
expectIncludes(
  programService,
  'programIconByDirection',
  'T07 backend maps stored icon keys to the public canonical emoji contract',
);
for (const icon of ['🧘', '💪', '🌿', '⚡', '🧘‍♂️', '🧠', '🍲']) {
  expectIncludes(programService, icon, `T07 backend workout icon: ${icon}`);
}
expectIncludes(
  programService,
  'parsedWeekNumber.data > progress.currentWeekNumber + 1',
  'T07 only previews at most the next program week',
);
expectIncludes(
  programService,
  'parsedBody.data.program_week !== progress.currentWeekNumber',
  'T07 distinguishes current, past, and locked future workout requests',
);
expectIncludes(
  programService,
  'existingCompletion.completedAt !== null',
  'T07 preserves idempotent retries after the current week advances',
);
expectIncludes(programService, "'PROGRAM_WEEK_LOCKED'", 'T07 rejects locked week access');
expectIncludes(programService, "'WORKOUT_NOT_FOUND'", 'T07 rejects mismatched workout IDs');
expectIncludes(
  programService,
  'snapshot.days.length !== PROGRAM_DAYS_PER_WEEK',
  'T07 fails closed if a program week is not seven days',
);
expectIncludes(programService, "return 'locked'", 'T07 marks the preview week as locked');
expectIncludes(
  programService,
  "status !== 'locked' && day.mediaAvailable",
  'T07 signs media only after upload confirmation and never for a locked week',
);

const programDocumentation = await readText('docs/T07_MAIN_SCREEN.md');
for (const contract of [
  'GET /api/v1/program/current-week',
  'GET /api/v1/program/weeks/:weekNumber',
  'PUT /api/v1/program/complete-workout',
  'PROGRAM_WEEK_LOCKED',
  'Видео скоро будет доступно',
  'KINETRA_T07_BACKEND_E2E=PASS',
  'KINETRA_T07_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T07_TAB_NAVIGATION=PASS',
  'KINETRA_T07_SYSTEM_BACK=PASS',
  'KINETRA_T07_PLAYER_TAB_HISTORY=PASS',
  'KINETRA_T07_BROWSER_E2E=PASS',
]) {
  expectIncludes(programDocumentation, contract, `T07 documented contract: ${contract}`);
}

const frontendApi = await readText('apps/frontend/src/lib/api.ts');
expectIncludes(frontendApi, "credentials: 'include'", 'frontend sends refresh cookies');
expectIncludes(frontendApi, "'/api/v1/auth/refresh'", 'frontend refreshes access tokens');
expectIncludes(frontendApi, 'refreshInFlight', 'frontend deduplicates concurrent refreshes');
expectIncludes(
  frontendApi,
  'response.status === 401',
  'frontend retries protected requests after 401',
);
expectIncludes(
  frontendApi,
  'private accessToken: string | null = null',
  'access token is kept in memory',
);
expectIncludes(
  frontendApi,
  "window.localStorage.removeItem('kinetra.accessToken')",
  'legacy localStorage access tokens are removed',
);
if (frontendApi.includes('localStorage.setItem')) {
  fail('frontend never writes access tokens to localStorage');
} else {
  pass('frontend never writes access tokens to localStorage');
}
expectIncludes(
  frontendApi,
  "'/api/v1/me/onboarding-complete'",
  'T05 frontend calls the protected completion endpoint',
);
expectIncludes(
  frontendApi,
  "'/api/v1/base-lessons'",
  'T06 frontend fetches the protected lesson list',
);
expectIncludes(
  frontendApi,
  '/api/v1/base-lessons/${encodeURIComponent(lessonId)}/progress',
  'T06 frontend updates progress for the selected lesson',
);
expectIncludes(
  frontendApi,
  "'/api/v1/base-lessons/complete-program'",
  'T06 frontend calls server-side program completion',
);
expectIncludes(
  frontendApi,
  "'/api/v1/program/current-week'",
  'T07 frontend fetches the current program week',
);
expectIncludes(
  frontendApi,
  '/api/v1/program/weeks/${encodeURIComponent(String(weekNumber))}',
  'T07 frontend fetches a selected program week',
);
expectIncludes(
  frontendApi,
  "'/api/v1/program/complete-workout'",
  'T07 frontend completes the selected workout',
);

const sharedContracts = await readText('packages/shared/src/index.ts');
for (const contract of [
  'ProgramDirection',
  'ProgramWeekStatus',
  'ProgramVideo',
  'ProgramDay',
  'ProgramWeek',
  'ProgramOverallProgress',
  'WeekResponse',
  'CompleteWorkoutRequest',
]) {
  expectIncludes(sharedContracts, contract, `T07 shared contract: ${contract}`);
}

const frontendApp = await readText('apps/frontend/src/App.tsx');
expectIncludes(frontendApp, '<LoginScreen', 'frontend has an access-token handoff from login');
expectIncludes(frontendApp, '<SystemState', 'frontend distinguishes network failure from logout');
expectIncludes(
  frontendApp,
  'routeForOnboardingStatus',
  'frontend routes by server onboarding status',
);
expectIncludes(
  frontendApi,
  "'/api/v1/auth/logout'",
  'frontend revokes the refresh session on logout',
);
expectIncludes(frontendApp, '<OnboardingCarousel', 'T05 route renders the onboarding carousel');
expectIncludes(frontendApp, '<BaseLessonsScreen', 'T06 route renders the base lessons screen');
expectIncludes(frontendApp, '<ProgramScreen', 'T07 active route renders the weekly program');
expectIncludes(frontendApp, '<TabBar', 'T07 active routes render the bottom tab bar');
expectIncludes(frontendApp, '<ProgressScreen', 'T09 progress route renders the real dashboard');

const baseLessonsModel = await readText('apps/frontend/src/features/base-lessons/model.ts');
expectIncludes(
  baseLessonsModel,
  'PROGRESS_SYNC_INTERVAL_MS = 10_000',
  'T06 progress sync interval is ten seconds',
);
expectIncludes(baseLessonsModel, "'Перейти к программе'", 'T06 model defines the unlocked CTA');
expectIncludes(
  baseLessonsModel,
  'LessonProgressReporter',
  'T06 serializes periodic and final progress writes',
);

const baseLessonsScreen = await readText(
  'apps/frontend/src/features/base-lessons/BaseLessonsScreen.tsx',
);
expectIncludes(baseLessonsScreen, 'getBaseLessons', 'T06 screen restores server lesson progress');
expectIncludes(
  baseLessonsScreen,
  'completeBaseProgram',
  'T06 screen completes the program through the API client',
);
expectIncludes(
  baseLessonsScreen,
  'loadLessons(controller.signal)',
  'T06 screen refetches aggregate progress in the background after closing a lesson',
);
expectIncludes(
  baseLessonsScreen,
  'mergeSavedLessonProgress',
  'T06 screen closes immediately with authoritative saved progress',
);
expectIncludes(
  baseLessonsScreen,
  'backgroundRefreshGuard',
  'T06 stale background responses cannot regress visible progress',
);
expectIncludes(
  baseLessonsScreen,
  'program_unlocked',
  'T06 screen respects the server unlock decision',
);

const baseLessonsView = await readText(
  'apps/frontend/src/features/base-lessons/BaseLessonsView.tsx',
);
for (const testId of [
  'base-lessons-screen',
  'base-lessons-progress',
  'base-lesson-card-',
  'base-lessons-complete',
]) {
  expectIncludes(baseLessonsView, testId, `T06 lesson list test hook: ${testId}`);
}
expectIncludes(baseLessonsView, 'Базовые движения', 'T06 renders the prescribed heading');
expectIncludes(
  baseLessonsView,
  'Изучите основы, чтобы тренировки были безопасными и эффективными',
  'T06 renders the prescribed subtitle',
);
expectIncludes(
  baseLessonsView,
  'disabled={!response.program_unlocked || isCompleting}',
  'T06 keeps the CTA disabled until the server unlocks it',
);

const lessonPlayer = await readText('apps/frontend/src/features/base-lessons/LessonPlayer.tsx');
for (const testId of [
  'base-lesson-player',
  'base-lesson-video-placeholder',
  'base-lesson-video',
  'base-lesson-back',
]) {
  expectIncludes(lessonPlayer, testId, `T06 player test hook: ${testId}`);
}
expectIncludes(
  lessonPlayer,
  'Видео скоро будет доступно',
  'T06 renders the missing-video placeholder',
);
expectIncludes(lessonPlayer, 'window.setInterval', 'T06 sends periodic playback progress');
expectIncludes(
  lessonPlayer,
  'PROGRESS_SYNC_INTERVAL_MS',
  'T06 player uses the ten-second progress interval',
);
expectIncludes(lessonPlayer, 'reporter.flush', 'T06 Back performs a final serialized progress PUT');
expectIncludes(lessonPlayer, "window.addEventListener('pagehide'", 'T06 saves before page exit');
expectIncludes(lessonPlayer, "window.addEventListener('popstate'", 'T06 handles system Back');
expectIncludes(frontendApi, 'keepalive: true', 'T06 exit progress PUT is keepalive-enabled');

const programModel = await readText('apps/frontend/src/features/program/model.ts');
expectIncludes(
  programModel,
  'WORKOUT_COMPLETION_THRESHOLD = 90',
  'T07 player completion threshold is ninety percent',
);
for (const presentation of [
  "breathing: { label: 'Дыхание', icon: '🧘' }",
  "strength: { label: 'Сила', icon: '💪' }",
  "body_therapy: { label: 'Тело мой дом', icon: '🌿' }",
  "functional: { label: 'Функционал', icon: '⚡' }",
  "stretching: { label: 'Растяжка', icon: '🧘‍♂️' }",
  "neuro: { label: 'Нейрогимнастика', icon: '🧠' }",
  "recovery: { label: 'Восстановление', icon: '🍲' }",
]) {
  expectIncludes(programModel, presentation, `T07 direction presentation: ${presentation}`);
}
expectIncludes(
  programModel,
  'Math.min(totalWeeks, currentWeekNumber + 1)',
  'T07 frontend cannot navigate beyond the next preview week',
);
expectIncludes(programModel, 'Intl.DateTimeFormat', 'T07 computes today in the profile timezone');
expectIncludes(
  programModel,
  "return day.completed ? 'completed' : 'available'",
  'T07 derives completed and available workout card states',
);

const tabBar = await readText('apps/frontend/src/features/navigation/TabBar.tsx');
for (const testId of ['tab-bar', 'tab-home', 'tab-schedule', 'tab-progress', 'tab-settings']) {
  expectIncludes(tabBar, testId, `T07 tab bar test hook: ${testId}`);
}
for (const label of ['Главная', 'Расписание', 'Прогресс', 'Настройки']) {
  expectIncludes(tabBar, label, `T07 tab bar label: ${label}`);
}
expectIncludes(
  tabBar,
  "aria-current={active ? 'page'",
  'T07 exposes the active tab to assistive tech',
);
expectIncludes(
  tabBar,
  'event.preventDefault()',
  'T07 tab links preserve standalone client routing',
);

const programWeekView = await readText('apps/frontend/src/features/program/ProgramWeekView.tsx');
for (const testId of [
  'main-screen',
  'week-heading',
  'week-progress',
  'week-previous',
  'week-next',
  'workout-card-',
  'workout-status-',
  'today-workout',
]) {
  expectIncludes(programWeekView, testId, `T07 main-screen test hook: ${testId}`);
}
expectIncludes(programWeekView, 'role="progressbar"', 'T07 exposes week progress semantics');
expectIncludes(
  programWeekView,
  'disabled={disabled}',
  'T07 locked workout cards are not interactive',
);
expectIncludes(
  programWeekView,
  "data-today={isToday ? 'true'",
  'T07 identifies the current day for browser and accessibility checks',
);
expectIncludes(programWeekView, "isToday ? 'is-today'", 'T07 applies the today highlight');
for (const status of ['Пройдено', 'Доступно', 'Заблокировано']) {
  expectIncludes(programWeekView, status, `T07 workout status copy: ${status}`);
}

const workoutPlayer = await readText('apps/frontend/src/features/program/WorkoutPlayer.tsx');
for (const testId of [
  'workout-player',
  'workout-video-placeholder',
  'workout-video',
  'workout-back',
]) {
  expectIncludes(workoutPlayer, testId, `T07 workout player test hook: ${testId}`);
}
expectIncludes(
  workoutPlayer,
  'Видео скоро будет доступно',
  'T07 renders the missing workout video placeholder',
);
expectIncludes(
  workoutPlayer,
  'completionPercent >= WORKOUT_COMPLETION_THRESHOLD',
  'T07 completes playback only at the ninety-percent threshold',
);
expectIncludes(
  workoutPlayer,
  'completeWorkout({',
  'T07 player sends the authenticated workout completion request',
);
expectIncludes(workoutPlayer, 'onTimeUpdate', 'T07 player observes HTML5 playback progress');
expectIncludes(workoutPlayer, 'window.setInterval', 'T07 player throttles progress checks');
expectIncludes(
  workoutPlayer,
  "window.addEventListener('popstate'",
  'T07 player handles system Back',
);

const programScreen = await readText('apps/frontend/src/features/program/ProgramScreen.tsx');
expectIncludes(programScreen, 'getCurrentWeek(controller.signal)', 'T07 restores the current week');
expectIncludes(programScreen, 'getWeek(weekNumber, controller.signal)', 'T07 navigates by week');
expectIncludes(programScreen, '<ProgramWeekView', 'T07 renders the seven-day week view');
expectIncludes(programScreen, '<WorkoutPlayer', 'T07 opens the workout player');
expectIncludes(
  programScreen,
  'dayOfWeekInTimeZone(new Date(), timezone)',
  'T07 highlights today in the profile timezone',
);
expectIncludes(
  programScreen,
  'handleWorkoutCompleted',
  'T07 applies the authoritative completion response to the card list',
);
expectIncludes(
  programScreen,
  'requestVersion.current',
  'T07 prevents stale week responses from replacing newer navigation',
);

const onboardingModel = await readText('apps/frontend/src/features/onboarding/model.ts');
expectIncludes(
  onboardingModel,
  "'kinetra.onboarding.slide'",
  'T05 slide position is scoped to session storage',
);
expectIncludes(
  onboardingModel,
  "'kinetra.onboarding.user'",
  'T05 slide position is isolated by authenticated user',
);
expectIncludes(
  onboardingModel,
  'ONBOARDING_SWIPE_THRESHOLD = 48',
  'T05 swipe threshold is defined',
);
expectIncludes(onboardingModel, "title: 'Готовы начать?'", 'T05 has the sixth completion slide');
expectIncludes(onboardingModel, "label: 'Нейрогимнастика'", 'T05 lists all weekly rhythms');
expectIncludes(
  onboardingModel,
  "ONBOARDING_COMPLETE_LABEL = 'К базовым урокам'",
  'T05 defines the final completion action',
);

const onboardingCarousel = await readText(
  'apps/frontend/src/features/onboarding/OnboardingCarousel.tsx',
);
expectIncludes(onboardingCarousel, 'window.sessionStorage.setItem', 'T05 persists slide progress');
expectIncludes(onboardingCarousel, 'onPointerMove', 'T05 supports pointer swipe navigation');
expectIncludes(onboardingCarousel, 'aria-current', 'T05 exposes the active progress dot');
expectIncludes(
  onboardingCarousel,
  'onSessionExpired',
  'T05 exits an expired authenticated session',
);
expectIncludes(
  onboardingCarousel,
  'ONBOARDING_COMPLETE_LABEL',
  'T05 renders the final completion action',
);

const surveyWizard = await readText('apps/frontend/src/features/survey/SurveyWizard.tsx');
expectIncludes(surveyWizard, 'Шаг {step + 1}', 'survey displays five-step progress');
expectIncludes(surveyWizard, 'disabled={!isValid}', 'survey blocks invalid forward navigation');
expectIncludes(surveyWizard, 'toggleSurveyInjury', 'survey makes none mutually exclusive');
expectIncludes(
  surveyWizard,
  'data-testid="injuries-detail"',
  'survey renders details for other injuries',
);

const surveyModel = await readText('apps/frontend/src/features/survey/model.ts');
expectIncludes(surveyModel, "injury === 'none'", 'survey model makes none mutually exclusive');
expectIncludes(surveyModel, 'detailLength <= 500', 'survey model bounds other injury details');

const routes = await readText('apps/frontend/src/routing.ts');
for (const [status, route] of [
  ['survey_pending', 'survey'],
  ['onboarding_pending', 'onboarding'],
  ['base_lessons', 'baseLessons'],
  ['active', 'home'],
]) {
  expectIncludes(routes, `case '${status}'`, `T04 route status: ${status}`);
  expectIncludes(routes, `return appRoutes.${route}`, `T04 route destination: ${route}`);
}
expectIncludes(routes, "schedule: '/schedule'", 'T07 schedule tab route exists');
expectIncludes(routes, "progress: '/progress'", 'T07 progress tab route exists');
expectIncludes(
  routes,
  'isActiveAppRoute',
  'T07 active-profile route guard includes all tab routes',
);

const frontendStyles = await readText('apps/frontend/src/styles.css');
for (const color of ['#080909', '#181c1c', '#c8f169', '#f4f6f2', '#a8b0ac']) {
  expectIncludes(frontendStyles.toLowerCase(), color, `T04 design color: ${color}`);
}
expectIncludes(frontendStyles, 'min-height: 48px', 'T04 controls exceed 44px touch target');
expectIncludes(frontendStyles, 'touch-action: pan-y', 'T05 preserves vertical touch scrolling');
expectIncludes(frontendStyles, 'env(safe-area-inset-bottom)', 'T05 respects mobile safe areas');
expectIncludes(frontendStyles, 'prefers-reduced-motion: reduce', 'T05 respects reduced motion');
for (const selectorFragment of [
  '.base-lesson-card',
  '.base-lessons-progress',
  '.base-lessons-fixed-action',
  '.base-lesson-video-placeholder',
]) {
  expectIncludes(frontendStyles, selectorFragment, `T06 style surface: ${selectorFragment}`);
}
expectMatches(
  frontendStyles,
  /\.base-lessons-fixed-action\s*\{[^}]*position:\s*fixed/isu,
  'T06 CTA is fixed to the viewport',
);
expectIncludes(
  frontendStyles,
  'calc(148px + env(safe-area-inset-bottom))',
  'T06 list reserves room for the fixed safe-area CTA',
);
expectMatches(
  frontendStyles,
  /\.base-lessons-complete:disabled\s*\{[^}]*color:\s*var\(--muted-strong\)/isu,
  'T06 disabled CTA uses the prescribed semantic text color',
);
expectIncludes(
  frontendStyles,
  'linear-gradient(135deg, var(--surface), var(--surface-raised))',
  'T06 poster uses the theme-aware placeholder gradient',
);
for (const selectorFragment of [
  '.program-shell',
  '.program-week-progress',
  '.workout-card',
  '.workout-card.is-completed',
  '.workout-card.is-today',
  '.workout-card.is-locked',
  '.tab-bar',
  '.tab-bar-link',
  '.workout-video-placeholder',
]) {
  expectIncludes(frontendStyles, selectorFragment, `T07 style surface: ${selectorFragment}`);
}
expectMatches(
  frontendStyles,
  /\.tab-bar\s*\{[^}]*position:\s*fixed/isu,
  'T07 tab bar is fixed to the viewport',
);
expectIncludes(
  frontendStyles,
  'height: calc(56px + env(safe-area-inset-bottom))',
  'T07 tab bar includes the bottom safe area',
);
expectIncludes(
  frontendStyles,
  'border-top: 1px solid var(--divider)',
  'T07 tab bar has the prescribed theme-aware border',
);
expectIncludes(
  frontendStyles,
  'background: var(--surface-inset)',
  'T07 tab bar has the prescribed theme-aware surface',
);
expectIncludes(
  frontendStyles,
  'color: var(--muted-strong)',
  'T07 inactive tabs use the prescribed semantic color',
);
expectIncludes(frontendStyles, 'min-height: 44px', 'T07 tab targets meet the minimum size');
expectIncludes(
  frontendStyles,
  'border-left: 3px solid var(--accent)',
  'T07 completed cards have a theme-aware accent',
);
expectIncludes(frontendStyles, 'opacity: 0.4', 'T07 locked cards use the prescribed opacity');
expectIncludes(
  frontendStyles,
  '.workout-card.is-today',
  'T07 today card receives an accent outline',
);
expectIncludes(frontendStyles, 'gap: 12px', 'T07 workout list uses the prescribed card gap');
expectIncludes(indexHtml, 'fonts.googleapis.com', 'Inter stylesheet is connected');
expectIncludes(indexHtml, 'family=Inter', 'Inter font family is requested');

const browserTest = await readText('scripts/test-frontend-browser.mjs');
expectIncludes(browserTest, 'KINETRA_T04_BROWSER_E2E=PASS', 'T04 browser acceptance test exists');
expectIncludes(browserTest, 'KINETRA_T05_BROWSER_E2E=PASS', 'T05 browser acceptance test exists');
expectIncludes(browserTest, 'KINETRA_T06_BROWSER_E2E=PASS', 'T06 browser acceptance test exists');
expectIncludes(browserTest, 'KINETRA_T07_BROWSER_E2E=PASS', 'T07 browser acceptance test exists');
expectIncludes(
  browserTest,
  'KINETRA_T06_PERIODIC_PROGRESS=PASS',
  'T06 browser scenario proves the ten-second periodic PUT',
);
expectIncludes(
  browserTest,
  'KINETRA_T06_CARD_STATES=PASS',
  'T06 browser scenario proves all three visual lesson-card states',
);
expectIncludes(
  browserTest,
  'KINETRA_T06_SYSTEM_BACK=PASS',
  'T06 browser scenario proves standalone-PWA system Back',
);
expectIncludes(browserTest, 'Input.dispatchTouchEvent', 'T05 browser test uses native touch input');
expectIncludes(browserTest, 'Input.dispatchMouseEvent', 'T05 browser test uses native mouse input');
expectIncludes(browserTest, 'mobile: true', 'T05 browser test uses a mobile viewport');
expectIncludes(
  browserTest,
  'login after expired onboarding session',
  'T05 browser test covers refresh-session expiry',
);
expectIncludes(
  browserTest,
  "localStorage.getItem('kinetra.accessToken')",
  'browser test checks token storage',
);
expectIncludes(
  browserTest,
  'server progress restored after reload',
  'browser test checks session restore',
);
expectIncludes(browserTest, 'base lessons route', 'browser test checks base-lessons routing');
expectIncludes(
  browserTest,
  'T07 main screen after base lesson completion',
  'browser test checks active routing to the T07 main screen',
);
expectIncludes(
  browserTest,
  "request.url === '/api/v1/base-lessons'",
  'T06 browser mock serves the base lesson list',
);
expectIncludes(
  browserTest,
  '/api/v1/base-lessons/complete-program',
  'T06 browser mock validates program completion',
);
expectIncludes(
  browserTest,
  'base-lesson-video-placeholder',
  'T06 browser scenario opens the missing-video placeholder',
);
expectIncludes(
  browserTest,
  "Object.defineProperty(video, 'currentTime'",
  'T06 browser scenario measures final playback progress',
);
expectIncludes(
  browserTest,
  'assertBaseLessonsLayout(320)',
  'T06 browser scenario covers the minimum mobile width',
);
expectIncludes(
  browserTest,
  'counters.lessonProgress, 6',
  'T06 browser scenario completes four distinct lessons',
);
expectIncludes(
  browserTest,
  "request.url === '/api/v1/program/current-week'",
  'T07 browser mock serves the current program week',
);
expectIncludes(
  browserTest,
  '/api/v1/program/complete-workout',
  'T07 browser mock validates workout completion',
);
expectIncludes(
  browserTest,
  'KINETRA_T07_WEEK_NAVIGATION=PASS',
  'T07 browser scenario proves week arrow navigation',
);
expectIncludes(
  browserTest,
  'KINETRA_T07_TAB_NAVIGATION=PASS',
  'T07 browser scenario proves schedule, progress, and home tab routing',
);
expectIncludes(
  browserTest,
  'KINETRA_T07_SYSTEM_BACK=PASS',
  'T07 browser scenario proves standalone-PWA system Back from a workout',
);
expectIncludes(
  browserTest,
  'KINETRA_T07_PLAYER_TAB_HISTORY=PASS',
  'T07 browser scenario proves player and tab navigation share one clean history stack',
);
expectIncludes(
  browserTest,
  'KINETRA_T07_WORKOUT_COMPLETION=PASS',
  'T07 browser scenario proves ninety-percent workout completion',
);
expectIncludes(
  browserTest,
  'workout-video-placeholder',
  'T07 browser scenario opens the missing-workout-video placeholder',
);
expectIncludes(
  browserTest,
  "video.dispatchEvent(new Event('timeupdate'",
  'T07 browser scenario drives real media progress events',
);
expectIncludes(
  browserTest,
  'belowThresholdProgress',
  'T07 browser scenario proves that eighty-nine percent does not complete a workout',
);
expectIncludes(
  browserTest,
  'assertMainScreenLayout(320)',
  'T07 browser scenario covers the minimum mobile width',
);
expectIncludes(
  browserTest,
  "attribute('workout-status-1', 'data-state')",
  'T07 browser scenario verifies the completed card state',
);
expectIncludes(
  browserTest,
  "attribute('tab-settings', 'aria-current')",
  'T07 browser scenario verifies active tab semantics',
);
expectIncludes(
  browserTest,
  'VITE_API_URL: browserApiOrigin',
  'browser test builds the frontend with the loopback mock API origin',
);
expectIncludes(
  browserTest,
  'await terminateChrome(chrome)',
  'browser test waits for Chrome termination before cleanup',
);
expectIncludes(
  browserTest,
  'profileCleanupAttempts = 3',
  'browser profile cleanup retries three times',
);
expectIncludes(
  browserTest,
  'KINETRA_BROWSER_TMP_CLEANUP=PASS',
  'browser test proves temporary profile cleanup',
);
expectIncludes(
  browserTest,
  "'--no-proxy-server'",
  'browser test forces loopback traffic to bypass proxies',
);
expectIncludes(
  browserTest,
  "'Access-Control-Allow-Private-Network', 'true'",
  'browser mock API permits private-network preflights',
);
expectIncludes(
  browserTest,
  'KINETRA_BROWSER_MOCK_API=PASS',
  'browser test verifies the mock API before launching Chrome',
);
expectIncludes(
  browserTest,
  'const frontendOrigin = browserApiOrigin',
  'browser test serves the frontend and mock API from one loopback origin',
);
expectIncludes(
  browserTest,
  'String(item.url).startsWith(frontendOrigin)',
  'browser test attaches only to the Kinetra frontend target',
);
if (browserTest.includes('about:blank')) {
  fail('browser test launches Chrome directly on the frontend instead of about:blank');
} else {
  pass('browser test launches Chrome directly on the frontend instead of about:blank');
}
if ((browserTest.match(/`\$\{frontendOrigin\}\/login`/gu) ?? []).length >= 2) {
  pass('browser test launches and navigates Chrome on the frontend login route');
} else {
  fail('browser test launches and navigates Chrome on the frontend login route');
}

for (const script of [
  'test:backend',
  'test:frontend:unit',
  'test:frontend:browser',
  'test:frontend',
]) {
  if (rootPackage.scripts?.[script]) {
    pass(`T04 root script: ${script}`);
  } else {
    fail(`T04 root script: ${script}`);
  }
}

const profileTests = await readText('apps/backend/test/profile.e2e.test.ts');
for (const scenario of [
  'invalidAge',
  'mixedNone',
  'otherWithoutDetail',
  'duplicateInjuries',
  'oversizedDetail',
  'creates a new current version',
]) {
  expectIncludes(profileTests, scenario, `T04 backend scenario: ${scenario}`);
}

const profilePostgresTests = await readText('apps/backend/test/profile.postgres.test.ts');
expectIncludes(
  profilePostgresTests,
  'survey_answers_injuries_unique',
  'T04 PostgreSQL test covers duplicate injuries',
);
expectIncludes(
  profilePostgresTests,
  'survey_answers_other_detail_valid',
  'T04 PostgreSQL test covers detail length',
);
expectIncludes(
  profilePostgresTests,
  "process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true'",
  'T04 PostgreSQL test fails closed when required by CI',
);
expectIncludes(
  profilePostgresTests,
  'KINETRA_T04_POSTGRES_INTEGRATION=PASS',
  'T04 PostgreSQL test emits an execution marker',
);
expectIncludes(
  profilePostgresTests,
  'KINETRA_T05_POSTGRES_INTEGRATION=PASS',
  'T05 PostgreSQL test emits an execution marker',
);

const onboardingTests = await readText('apps/frontend/test/onboarding.test.ts');
expectIncludes(
  onboardingTests,
  'onboardingSlides.length, 6',
  'T05 unit test fixes the slide count',
);
expectIncludes(onboardingTests, 'slideAfterSwipe', 'T05 unit test covers swipe boundaries');

const baseLessonsBackendTests = await readText('apps/backend/test/base-lessons.e2e.test.ts');
for (const scenario of [
  'require JWT',
  'seven ordered placeholder lessons',
  'completion is monotonic at 90 percent',
  'enforces four lessons',
  'cannot bypass an earlier onboarding state',
]) {
  expectIncludes(baseLessonsBackendTests, scenario, `T06 backend scenario: ${scenario}`);
}
expectIncludes(
  baseLessonsBackendTests,
  'KINETRA_T06_BACKEND_E2E=PASS',
  'T06 HTTP E2E emits an execution marker',
);

const baseLessonsPostgresTests = await readText('apps/backend/test/base-lessons.postgres.test.ts');
expectIncludes(
  baseLessonsPostgresTests,
  "process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true'",
  'T06 PostgreSQL test fails closed when required by CI',
);
expectIncludes(
  baseLessonsPostgresTests,
  'video_progress_completed_state_valid',
  'T06 PostgreSQL test proves the completion constraint',
);
expectIncludes(
  baseLessonsPostgresTests,
  'KINETRA_T06_POSTGRES_INTEGRATION=PASS',
  'T06 PostgreSQL test emits an execution marker',
);

const baseLessonsFrontendTests = await readText('apps/frontend/test/base-lessons.test.ts');
expectIncludes(
  baseLessonsFrontendTests,
  'renders all seven exact lesson cards in order',
  'T06 frontend test covers the seven-card list',
);
expectIncludes(
  baseLessonsFrontendTests,
  'button is disabled below four lessons',
  'T06 frontend test covers the locked CTA',
);
expectIncludes(
  baseLessonsFrontendTests,
  'button becomes active after four completed lessons',
  'T06 frontend test covers the unlocked CTA',
);
expectIncludes(
  baseLessonsFrontendTests,
  'Видео скоро будет доступно',
  'T06 frontend test covers the missing-video placeholder',
);
expectIncludes(
  baseLessonsFrontendTests,
  'PROGRESS_SYNC_INTERVAL_MS, 10_000',
  'T06 frontend test fixes the ten-second sync interval',
);
expectIncludes(
  baseLessonsFrontendTests,
  'serializes writes, coalesces pending updates',
  'T06 frontend test covers progress write ordering',
);
expectIncludes(
  baseLessonsFrontendTests,
  'renders completed, in-progress and not-started visual card states',
  'T06 frontend test renders every prescribed lesson-card state',
);
expectIncludes(
  baseLessonsFrontendTests,
  'flush waits until a late periodic write is fully drained',
  'T06 frontend test prevents final-progress/refetch races',
);

const baseLessonsFrontendApiTests = await readText('apps/frontend/test/base-lessons-api.test.ts');
expectIncludes(
  baseLessonsFrontendApiTests,
  'sends authenticated GET, progress PUT and complete-program PUT',
  'T06 frontend API test covers every base-lessons request',
);
expectIncludes(
  baseLessonsFrontendApiTests,
  "authorization: 'Bearer base-lessons-token'",
  'T06 frontend API test proves the access JWT is attached',
);
expectIncludes(
  baseLessonsFrontendApiTests,
  'preserves the INSUFFICIENT_LESSONS server error',
  'T06 frontend API test preserves the unlock failure contract',
);

const programBackendTests = await readText('apps/backend/test/program.e2e.test.ts');
for (const scenario of [
  'program endpoints require an access token',
  'current week defaults to week one and exposes seven ordered workout days',
  'specific week access allows only the current week and the next locked week',
  'workout media URLs require both availability and an unlocked week',
  'workout completion is strict, validates schedule membership, and is idempotent',
  'completing all seven workouts advances and caps the current program week',
]) {
  expectIncludes(programBackendTests, scenario, `T07 backend scenario: ${scenario}`);
}
expectIncludes(
  programBackendTests,
  'KINETRA_T07_BACKEND_E2E=PASS',
  'T07 HTTP E2E emits an execution marker',
);
expectIncludes(
  programBackendTests,
  "['🧘', '💪', '🌿', '⚡', '🧘‍♂️', '🧠', '🍲']",
  'T07 HTTP E2E fixes all seven canonical workout icons',
);

const programPostgresTests = await readText('apps/backend/test/program.postgres.test.ts');
expectIncludes(
  programPostgresTests,
  "process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true'",
  'T07 PostgreSQL test fails closed when required by CI',
);
expectIncludes(
  programPostgresTests,
  "COUNT(*) FILTER (WHERE source = 'player')",
  'T07 PostgreSQL test proves the completion source',
);
expectIncludes(
  programPostgresTests,
  'day.mediaAvailable === false',
  'T07 PostgreSQL test proves seeded workout media is unavailable',
);
expectIncludes(
  programPostgresTests,
  "{ kind: 'completed', inserted: false }",
  'T07 PostgreSQL test proves idempotent completion',
);
expectIncludes(
  programPostgresTests,
  'KINETRA_T07_POSTGRES_INTEGRATION=PASS',
  'T07 PostgreSQL test emits an execution marker',
);

const mainScreenFrontendTests = await readText('apps/frontend/test/main-screen.test.ts');
for (const scenario of ['seven', 'progress', 'arrow', 'tab', 'today']) {
  expectIncludes(
    mainScreenFrontendTests.toLowerCase(),
    scenario,
    `T07 frontend tests cover ${scenario}`,
  );
}

const programFrontendApiTests = await readText('apps/frontend/test/program-api.test.ts');
for (const path of [
  '/api/v1/program/current-week',
  '/api/v1/program/weeks/2',
  '/api/v1/program/complete-workout',
]) {
  expectIncludes(programFrontendApiTests, path, `T07 frontend API test: ${path}`);
}
expectIncludes(
  programFrontendApiTests,
  'authorization',
  'T07 frontend API tests prove access JWT attachment',
);

const scheduleMigration = await readText('apps/backend/migrations/006_schedule_copy.sql');
for (const copy of [
  'Дыхательная практика',
  'Настройка нервной системы, учимся дышать животом.',
  'Силовая тренировка',
  'Приседания, тяги, жимы. 3 круга.',
  'Тело мой дом',
  'Снимаем зажимы, работаем с телом.',
  'Функциональная тренировка',
  'Динамика, координация, баланс.',
  'Восстанавливаем длину мышц.',
  'Упражнения для мозга и координации.',
  'Самомассаж и полезное блюдо.',
]) {
  expectIncludes(scheduleMigration, copy, `T08 migration copy: ${copy}`);
  expectIncludes(contentSeed, copy, `T08 seed copy: ${copy}`);
  expectIncludes(contentVerifier, copy, `T08 database verifier copy: ${copy}`);
}
expectMatches(
  programRouter,
  /router\.get\(\s*['"]\/schedule['"]/u,
  'T08 GET schedule route exists',
);
expectIncludes(programService, 'getSchedule(userId: string)', 'T08 service exposes the schedule');
expectIncludes(
  programService,
  'progress.currentWeekNumber < PROGRAM_WEEK_COUNT',
  'T08 returns null after the final program week',
);
expectIncludes(
  programService,
  'getRequiredWeekSnapshot(userId, progress.currentWeekNumber)',
  'T08 reuses the authoritative current-week calculation',
);
expectIncludes(
  programService,
  'days.filter((day) => day.completed).length',
  'T08 derives completion totals from persisted day status',
);
for (const label of [
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
]) {
  expectIncludes(programService, label, `T08 backend weekday label: ${label}`);
}

for (const contract of [
  'ProgramDayLabel',
  'ProgramScheduleDay',
  'ProgramScheduleWeek',
  'ScheduleResponse',
  'current_week',
  'next_week',
]) {
  expectIncludes(sharedContracts, contract, `T08 shared contract: ${contract}`);
}
expectIncludes(
  frontendApi,
  "'/api/v1/program/schedule'",
  'T08 frontend fetches the protected schedule',
);
expectIncludes(frontendApp, '<ScheduleScreen', 'T08 schedule route renders the real screen');

const scheduleScreen = await readText('apps/frontend/src/features/schedule/ScheduleScreen.tsx');
for (const contract of [
  'getSchedule(controller.signal)',
  "error.kind === 'auth'",
  'requestControllerRef.current?.abort()',
  'schedule-retry',
]) {
  expectIncludes(scheduleScreen, contract, `T08 schedule loader contract: ${contract}`);
}

const scheduleView = await readText('apps/frontend/src/features/schedule/ScheduleView.tsx');
for (const testId of [
  'schedule-screen',
  'schedule-segment-current',
  'schedule-segment-next',
  'schedule-panel-${section}',
  'schedule-progress',
  'schedule-${section}-day-${day.day_of_week}',
  'schedule-final-message',
]) {
  expectIncludes(scheduleView, testId, `T08 schedule test hook: ${testId}`);
}
for (const contract of [
  'Текущая неделя',
  'Следующая неделя',
  'Выполнено ${week.days_completed} из ${week.total_days}',
  'Вы на финальной неделе программы!',
  'role="tablist"',
  'role="tab"',
  'role="progressbar"',
  'ArrowLeft',
  'ArrowRight',
  '✅',
]) {
  expectIncludes(scheduleView, contract, `T08 schedule view contract: ${contract}`);
}
for (const selector of [
  '.schedule-shell',
  '.schedule-segmented',
  '.schedule-day-card',
  '.schedule-day-description',
  '.schedule-final-message',
]) {
  expectIncludes(frontendStyles, selector, `T08 style surface: ${selector}`);
}
for (const style of [
  'background: var(--background)',
  'background: var(--surface)',
  'background: var(--accent)',
  'border-left: 3px solid transparent',
  '-webkit-line-clamp: 2',
  'min-height: 44px',
]) {
  expectIncludes(frontendStyles, style, `T08 prescribed style: ${style}`);
}

for (const scenario of [
  'schedule exposes canonical current and next weeks with completion state',
  'schedule omits the next week at the twelve-week program boundary',
  'KINETRA_T08_BACKEND_E2E=PASS',
]) {
  expectIncludes(programBackendTests, scenario, `T08 backend test: ${scenario}`);
}
const scheduleFrontendTests = await readText('apps/frontend/test/schedule.test.ts');
for (const scenario of [
  'current schedule renders seven canonical days, descriptions and completion state',
  'segmented next-week view renders seven days without completion status',
  'final week hides the next segment and displays the terminal program message',
]) {
  expectIncludes(scheduleFrontendTests, scenario, `T08 frontend test: ${scenario}`);
}
const scheduleFrontendApiTests = await readText('apps/frontend/test/schedule-api.test.ts');
expectIncludes(
  scheduleFrontendApiTests,
  '/api/v1/program/schedule',
  'T08 frontend API test fixes the endpoint path',
);
expectIncludes(
  scheduleFrontendApiTests,
  "authorization: 'Bearer schedule-token'",
  'T08 frontend API test proves access JWT attachment',
);

const scheduleDocumentation = await readText('docs/T08_SCHEDULE.md');
for (const contract of [
  'GET /api/v1/program/schedule',
  'Cache-Control: no-store',
  'next_week',
  'Вы на финальной неделе программы!',
  'KINETRA_T08_BACKEND_E2E=PASS',
  'KINETRA_T08_BROWSER_E2E=PASS',
]) {
  expectIncludes(scheduleDocumentation, contract, `T08 documented contract: ${contract}`);
}
for (const marker of [
  'KINETRA_T08_CARD_NAVIGATION=PASS',
  'KINETRA_T08_COMPLETION_STATE=PASS',
  'KINETRA_T08_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, marker, `T08 browser marker: ${marker}`);
}

// T09 — protected progress dashboard, data contract, lightweight charts and acceptance.
const progressMigration = await readText('apps/backend/migrations/007_progress_data_contract.sql');
for (const contract of [
  'weekly_metrics_note_length_valid',
  'char_length(note) <= 500',
  'NOT VALID',
  'VALIDATE CONSTRAINT weekly_metrics_note_length_valid',
]) {
  expectIncludes(progressMigration, contract, `T09 progress migration contract: ${contract}`);
}

const canonicalAchievements = [
  ['first_base_lesson', 'Первый шаг', 'Просмотрен первый базовый урок', '🎯'],
  ['base_unlocked', 'База пройдена', '4 базовых урока завершены', '🔓'],
  ['first_workout', 'Первая тренировка', 'Первая тренировка из программы', '💪'],
  ['week_complete', 'Неделя завершена', 'Все 7 дней за неделю', '🏆'],
  ['streak_3', 'Три подряд', '3 тренировки подряд', '🔥'],
];
for (const achievement of canonicalAchievements) {
  for (const field of achievement) {
    expectIncludes(progressMigration, field, `T09 migration achievement field: ${field}`);
    expectIncludes(contentSeed, field, `T09 seed achievement field: ${field}`);
    expectIncludes(contentVerifier, field, `T09 verifier achievement field: ${field}`);
  }
}
expectIncludes(
  contentVerifier,
  'convalidated',
  'T09 database verifier requires a validated weekly-note constraint',
);
expectIncludes(
  contentVerifier,
  'Expected 5 seeded achievements.',
  'T09 database verifier rejects extra achievement rows',
);

expectIncludes(
  backendApp,
  "app.use('/api/v1/progress'",
  'T09 backend mounts the protected progress router',
);
const progressRouter = await readText('apps/backend/src/progress/router.ts');
for (const routeContract of [
  'router.use(disableCaching)',
  'router.use(authMiddleware)',
  "router.get(\n    '/'",
  "'/weekly-metrics'",
  "'/goal'",
  "response.setHeader('Cache-Control', 'no-store')",
]) {
  expectIncludes(progressRouter, routeContract, `T09 router contract: ${routeContract}`);
}

const progressSchema = await readText('apps/backend/src/progress/schema.ts');
for (const validationContract of [
  'z.number().int().min(1).max(10)',
  'z.number().int().min(1).max(12)',
  'z.string().trim().max(500).optional()',
  'surveyGoalSchema',
  '.strict()',
]) {
  expectIncludes(
    progressSchema,
    validationContract,
    `T09 strict validation: ${validationContract}`,
  );
}

const progressRepository = await readText(
  'apps/backend/src/progress/postgres-progress.repository.ts',
);
for (const repositoryContract of [
  'ORDER BY program_week',
  'ON CONFLICT ON CONSTRAINT weekly_metrics_user_week_unique',
  'FOR UPDATE',
  'BEGIN ISOLATION LEVEL REPEATABLE READ',
  'INSERT INTO user_achievements',
  'ON CONFLICT (user_id, achievement_id) DO NOTHING',
  'ranked_base_lessons',
  'ranked_streak_dates',
  'COUNT(DISTINCT day_of_week)',
  'completion.workout_date <= CURRENT_DATE',
  'SUM(duration_seconds)',
]) {
  expectIncludes(
    progressRepository,
    repositoryContract,
    `T09 PostgreSQL repository contract: ${repositoryContract}`,
  );
}

const progressService = await readText('apps/backend/src/progress/service.ts');
for (const serviceContract of [
  'this.programRepository.getProgress(userId)',
  'pending_survey: !history.some',
  'SURVEY_REQUIRED',
  'INVALID_WEEKLY_METRICS',
  'INVALID_PROGRESS_GOAL',
  'goalLabels[survey.goal]',
]) {
  expectIncludes(progressService, serviceContract, `T09 service contract: ${serviceContract}`);
}

for (const contract of [
  'ProgressGoal',
  'ProgressParams',
  'WeeklyMetric',
  'ProgressMetrics',
  'UnlockedAchievement',
  'LockedAchievement',
  'ProgressAchievements',
  'ProgressStats',
  'ProgressResponse',
  'WeeklyMetricsInput',
  'MetricsResponse',
  'GoalResponse',
]) {
  expectIncludes(sharedContracts, contract, `T09 shared contract: ${contract}`);
}

for (const endpoint of [
  "'/api/v1/progress'",
  "'/api/v1/progress/weekly-metrics'",
  "'/api/v1/progress/goal'",
]) {
  expectIncludes(frontendApi, endpoint, `T09 frontend API endpoint: ${endpoint}`);
}

const progressScreen = await readText('apps/frontend/src/features/progress/ProgressScreen.tsx');
for (const screenContract of [
  'getProgress(controller.signal)',
  'requestControllerRef.current?.abort()',
  'submitWeeklyMetrics(input)',
  'updateGoal(goal)',
  'fetchMe()',
  "error.kind === 'auth'",
  '<ProgressView',
  '<GoalDialog',
  '<WeeklyMetricsDialog',
]) {
  expectIncludes(progressScreen, screenContract, `T09 progress screen contract: ${screenContract}`);
}

const progressView = await readText('apps/frontend/src/features/progress/ProgressView.tsx');
for (const viewContract of [
  'progress-goal-section',
  'progress-metrics-section',
  'progress-stats-section',
  'progress-achievements-section',
  'Моя цель',
  'Как вы себя чувствуете?',
  'Ваши достижения в цифрах',
  'Достижения',
  'aria-pressed',
  '<ProgressLineChart',
]) {
  expectIncludes(progressView, viewContract, `T09 progress view contract: ${viewContract}`);
}

const progressChart = await readText('apps/frontend/src/features/progress/ProgressLineChart.tsx');
for (const chartContract of [
  '<svg',
  'role="img"',
  '<title',
  '<desc',
  '<polyline',
  '<circle',
  'Заполните самооценку минимум за 2 недели, чтобы увидеть динамику',
  '((10 - metricValue(point, metric.key)) / 9)',
]) {
  expectIncludes(progressChart, chartContract, `T09 lightweight SVG chart: ${chartContract}`);
}

const progressDialogs = await readText('apps/frontend/src/features/progress/ProgressDialogs.tsx');
for (const dialogContract of [
  '<dialog',
  'dialog.showModal()',
  'type="radio"',
  'type="range"',
  'min={1}',
  'max={10}',
  'step={1}',
  'maxLength={500}',
  'aria-valuetext',
]) {
  expectIncludes(
    progressDialogs,
    dialogContract,
    `T09 accessible dialog contract: ${dialogContract}`,
  );
}

for (const styleContract of [
  '.progress-shell',
  '.progress-section',
  '.progress-chart-line',
  '.progress-achievement-row.is-locked',
  '.progress-dialog::backdrop',
  "input[type='range']",
  'min-height: 44px',
  'opacity: 0.3',
  'font-size: 28px',
  'env(safe-area-inset-bottom)',
]) {
  expectIncludes(frontendStyles, styleContract, `T09 prescribed style: ${styleContract}`);
}

const progressBackendTests = await readText('apps/backend/test/progress.e2e.test.ts');
const progressPostgresTests = await readText('apps/backend/test/progress.postgres.test.ts');
const progressFrontendTests = await readText('apps/frontend/test/progress.test.ts');
const progressFrontendApiTests = await readText('apps/frontend/test/progress-api.test.ts');
for (const testContract of [
  'weekly metrics validate strictly',
  'pending survey follows the authoritative current program week',
  'goal update creates a new current survey version',
  'KINETRA_T09_BACKEND_E2E=PASS',
]) {
  expectIncludes(progressBackendTests, testContract, `T09 backend E2E: ${testContract}`);
}
for (const testContract of [
  'weekly_metrics_note_length_valid',
  'Historical achievements must retain the source event time',
  'KINETRA_T09_POSTGRES_INTEGRATION=PASS',
]) {
  expectIncludes(progressPostgresTests, testContract, `T09 PostgreSQL test: ${testContract}`);
}
for (const testContract of [
  'exactly four dashboard sections',
  'accessible SVG',
  'native controls with canonical bounds',
]) {
  expectIncludes(progressFrontendTests, testContract, `T09 frontend unit test: ${testContract}`);
}
expectIncludes(
  progressFrontendApiTests,
  '/api/v1/progress/weekly-metrics',
  'T09 frontend API test fixes the metrics endpoint',
);
expectIncludes(
  progressFrontendApiTests,
  "authorization: 'Bearer progress-token'",
  'T09 frontend API test proves access JWT attachment',
);

const progressDocumentation = await readText('docs/T09_PROGRESS.md');
for (const documentationContract of [
  'GET /api/v1/progress',
  'PUT /api/v1/progress/weekly-metrics',
  'PUT /api/v1/progress/goal',
  'Cache-Control: no-store',
  'current_streak',
  'unlocked_at',
  'KINETRA_T09_BROWSER_E2E=PASS',
]) {
  expectIncludes(
    progressDocumentation,
    documentationContract,
    `T09 documented contract: ${documentationContract}`,
  );
}

for (const marker of [
  'KINETRA_T09_PROGRESS_CONTENT=PASS',
  'KINETRA_T09_GOAL_UPDATE=PASS',
  'KINETRA_T09_WEEKLY_METRICS=PASS',
  'KINETRA_T09_CHARTS=PASS',
  'KINETRA_T09_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, marker, `T09 browser marker: ${marker}`);
}

for (const marker of [
  'KINETRA_T09_BACKEND_E2E=PASS',
  'KINETRA_T09_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T09_PROGRESS_CONTENT=PASS',
  'KINETRA_T09_GOAL_UPDATE=PASS',
  'KINETRA_T09_WEEKLY_METRICS=PASS',
  'KINETRA_T09_CHARTS=PASS',
  'KINETRA_T09_BROWSER_E2E=PASS',
]) {
  expectIncludes(ciWorkflow, `grep -F '${marker}'`, `CI requires T09 marker: ${marker}`);
}
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T09_TEST_SUITE=PASS'",
  'CI emits the T09 suite completion marker',
);

// T10 — protected settings, notification preferences, destructive account flow and global theme.
const settingsMigration = await readText('apps/backend/migrations/008_notifications.sql');
for (const migrationContract of [
  'ADD COLUMN IF NOT EXISTS notification_preferences jsonb',
  'jsonb_build_object(',
  "ALTER COLUMN notification_preferences SET DEFAULT '{}'::jsonb",
  'ALTER COLUMN notification_preferences SET NOT NULL',
  'users_notification_preferences_object',
  "jsonb_typeof(notification_preferences) = 'object'",
  'VALIDATE CONSTRAINT users_notification_preferences_object',
  'ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false',
  'CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx',
  'CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx',
  'CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx',
]) {
  expectIncludes(
    settingsMigration,
    migrationContract,
    `T10 migration contract: ${migrationContract}`,
  );
}

expectIncludes(
  backendApp,
  "app.use(\n    '/api/v1/settings'",
  'T10 backend mounts the settings router',
);

const settingsRouter = await readText('apps/backend/src/settings/router.ts');
for (const routerContract of [
  'router.use(disableCaching)',
  'router.use(authMiddleware)',
  "router.get(\n    '/subscription'",
  "router.get(\n    '/profile'",
  "router.put(\n    '/notifications'",
  "router.delete(\n    '/account'",
  "response.setHeader('Cache-Control', 'no-store')",
  'clearRefreshTokenCookie(response, refreshCookie)',
  'response.status(204).send()',
]) {
  expectIncludes(settingsRouter, routerContract, `T10 settings router contract: ${routerContract}`);
}

const settingsSchema = await readText('apps/backend/src/settings/schema.ts');
for (const schemaContract of [
  '/^(?:[01]\\d|2[0-3]):[0-5]\\d$/u',
  'workout_reminders: z.boolean()',
  'reminder_time: reminderTimeSchema',
  'weekly_survey_reminder: z.boolean()',
  "confirm: z.literal('DELETE')",
]) {
  expectIncludes(settingsSchema, schemaContract, `T10 strict settings schema: ${schemaContract}`);
}
const strictSettingsSchemaCount = (settingsSchema.match(/\.strict\(\)/gu) ?? []).length;
if (strictSettingsSchemaCount === 2) {
  pass('T10 notification and account-deletion bodies are both strict');
} else {
  fail('T10 notification and account-deletion bodies are both strict');
}

const settingsRepository = await readText(
  'apps/backend/src/settings/postgres-settings.repository.ts',
);
for (const repositoryContract of [
  'LEFT JOIN LATERAL',
  "status = 'active'",
  'starts_at IS NULL OR starts_at <= $2',
  'expires_at IS NULL OR expires_at > $2',
  'created_at DESC',
  'id DESC',
  'SET notification_preferences = $2::jsonb',
  'notification_enabled = $3',
  'DELETE FROM users WHERE id = $1 RETURNING id',
]) {
  expectIncludes(
    settingsRepository,
    repositoryContract,
    `T10 PostgreSQL settings contract: ${repositoryContract}`,
  );
}

const settingsService = await readText('apps/backend/src/settings/service.ts');
for (const serviceContract of [
  "subscription.status === 'refunded'",
  "return 'cancelled'",
  "return 'expired'",
  "return 'pending'",
  'Math.max(0, Math.ceil(',
  "status: 'none'",
  'amount: subscription.amountMinor === null ? null : subscription.amountMinor / 100',
  'notificationPreferencesSchema.safeParse(body)',
  'deleteAccountSchema.safeParse(body)',
  'INVALID_NOTIFICATION_PREFERENCES',
  'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
]) {
  expectIncludes(
    settingsService,
    serviceContract,
    `T10 settings service contract: ${serviceContract}`,
  );
}

for (const sharedContract of [
  'SettingsSubscriptionStatus',
  'SubscriptionResponse',
  'NotificationPreferences',
  'SettingsProfileResponse',
  'DeleteAccountRequest',
]) {
  expectIncludes(sharedContracts, sharedContract, `T10 shared contract: ${sharedContract}`);
}

for (const endpoint of [
  "'/api/v1/settings/subscription'",
  "'/api/v1/settings/profile'",
  "'/api/v1/settings/notifications'",
  "'/api/v1/settings/account'",
]) {
  expectIncludes(frontendApi, endpoint, `T10 frontend API endpoint: ${endpoint}`);
}
for (const apiContract of [
  'getSubscription(signal?: AbortSignal)',
  'getSettingsProfile(signal?: AbortSignal)',
  'updateNotifications(data: NotificationPreferences)',
  'deleteAccount(confirm: string)',
  'authenticatedVoidRequest',
  'keepalive: true',
  'this.clearSession()',
]) {
  expectIncludes(frontendApi, apiContract, `T10 frontend API contract: ${apiContract}`);
}

const settingsScreen = await readText('apps/frontend/src/features/settings/SettingsScreen.tsx');
for (const screenContract of [
  'Promise.all([',
  'getSettingsProfile(controller.signal)',
  'getSubscription(controller.signal)',
  'requestControllerRef.current?.abort()',
  'SETTINGS_NOTIFICATION_DEBOUNCE_MS',
  'window.setTimeout(',
  'updateNotifications(snapshot)',
  'saveQueueRef.current',
  "window.addEventListener('pagehide', flushPendingNotifications)",
  "window.removeEventListener('pagehide', flushPendingNotifications)",
  'flushPendingNotifications()',
  "deleteConfirmation !== 'DELETE'",
  'deleteAccount(deleteConfirmation)',
  '.then(() => logout())',
  '.catch(() => undefined)',
  '.finally(onSignedOut)',
  '<SettingsView',
  '<SettingsDialogs',
]) {
  expectIncludes(settingsScreen, screenContract, `T10 settings screen contract: ${screenContract}`);
}

const settingsModel = await readText('apps/frontend/src/features/settings/model.ts');
for (const modelContract of [
  '{ length: 33 }',
  '6 * 60 + index * 30',
  'SETTINGS_NOTIFICATION_DEBOUNCE_MS = 450',
  "primaryActionLabel: 'Продлить подписку'",
  'showCancelAutoRenew: subscription.auto_renew === true',
]) {
  expectIncludes(settingsModel, modelContract, `T10 settings model contract: ${modelContract}`);
}

const settingsView = await readText('apps/frontend/src/features/settings/SettingsView.tsx');
for (const section of [
  'settings-subscription-section',
  'settings-notifications-section',
  'settings-profile-section',
  'settings-appearance-section',
  'settings-support-section',
  'settings-account-section',
]) {
  expectIncludes(settingsView, section, `T10 settings section: ${section}`);
}
for (const viewContract of [
  'role="switch"',
  'notificationTimeOptions.map',
  'name="kinetra-theme"',
  'themeOptions.map',
  'Редактировать анкету',
  'Сменить уровень',
  'Связаться с тренером',
  'О приложении',
  'Выйти из аккаунта',
  'Удалить аккаунт',
  'Отменить автопродление',
]) {
  expectIncludes(settingsView, viewContract, `T10 settings view contract: ${viewContract}`);
}

const settingsDialogs = await readText('apps/frontend/src/features/settings/SettingsDialogs.tsx');
for (const dialogContract of [
  '<dialog',
  'dialog.showModal()',
  'testId="settings-renewal-dialog"',
  'Мастерство',
  'Пик',
  'Политика конфиденциальности',
  "deleteStage === 1 ? 'Удалить аккаунт?' : 'Последнее подтверждение'",
  'data-testid="settings-delete-confirmation"',
  "deleteConfirmation !== 'DELETE'",
  'Удалить навсегда',
]) {
  expectIncludes(
    settingsDialogs,
    dialogContract,
    `T10 settings dialog contract: ${dialogContract}`,
  );
}

const themeModel = await readText('apps/frontend/src/features/theme/model.ts');
const themeProvider = await readText('apps/frontend/src/features/theme/ThemeProvider.tsx');
const themeInit = await readText('apps/frontend/public/theme-init.js');
const frontendIndex = await readText('apps/frontend/index.html');
const frontendMain = await readText('apps/frontend/src/main.tsx');
for (const themeContract of [
  "ThemePreference = 'system' | 'light' | 'dark'",
  "THEME_STORAGE_KEY = 'kinetra.theme.v1'",
  "window.matchMedia('(prefers-color-scheme: dark)')",
  'document.documentElement.dataset.theme = resolved',
  'document.documentElement.dataset.themePreference = preference',
  'document.documentElement.style.colorScheme = resolved',
  'querySelector(\'meta[name="theme-color"]\')',
]) {
  expectIncludes(themeModel, themeContract, `T10 theme model contract: ${themeContract}`);
}
for (const providerContract of [
  'applyThemePreference(preference, systemDark)',
  'writeStoredThemePreference(preference)',
  "media.addEventListener('change', updateFromSystem)",
  "media.removeEventListener('change', updateFromSystem)",
  "window.addEventListener('storage', syncAcrossTabs)",
  "window.removeEventListener('storage', syncAcrossTabs)",
]) {
  expectIncludes(
    themeProvider,
    providerContract,
    `T10 theme provider contract: ${providerContract}`,
  );
}
for (const earlyThemeContract of [
  "const storageKey = 'kinetra.theme.v1'",
  "new Set(['system', 'light', 'dark'])",
  "window.matchMedia('(prefers-color-scheme: dark)').matches",
  'root.dataset.theme = resolved',
  'root.dataset.themePreference = preference',
  'root.style.colorScheme = resolved',
]) {
  expectIncludes(themeInit, earlyThemeContract, `T10 early theme contract: ${earlyThemeContract}`);
}
const earlyThemeScriptPosition = frontendIndex.indexOf('<script src="/theme-init.js"></script>');
const reactEntryPosition = frontendIndex.indexOf(
  '<script type="module" src="/src/main.tsx"></script>',
);
if (
  earlyThemeScriptPosition >= 0 &&
  reactEntryPosition >= 0 &&
  earlyThemeScriptPosition < reactEntryPosition
) {
  pass('T10 theme initializer loads before the React entry');
} else {
  fail('T10 theme initializer loads before the React entry');
}
expectIncludes(frontendMain, '<ThemeProvider>', 'T10 wraps the full application in ThemeProvider');
expectIncludes(
  serviceWorker,
  "'/theme-init.js'",
  'T10 offline shell caches the early theme script',
);

for (const styleContract of [
  ":root[data-theme='light']",
  '--background: #080909',
  '--surface: #181c1c',
  '--accent: #c8f169',
  '--text: #f4f6f2',
  '--background: #f4f6f2',
  '--surface: #ffffff',
  '--focus-ring: #4e650d',
  'outline: 3px solid var(--focus-ring)',
  '.settings-section + .settings-section',
  '.settings-toggle-row input:checked + .settings-toggle',
  '.settings-theme-option.is-selected',
  '.settings-menu-button.is-danger',
  'min-height: 44px',
  'env(safe-area-inset-bottom)',
]) {
  expectIncludes(frontendStyles, styleContract, `T10 theme/settings style: ${styleContract}`);
}

const settingsBackendTests = await readText('apps/backend/test/settings.e2e.test.ts');
for (const testContract of [
  'all settings endpoints require a valid access JWT',
  'settings profile and an absent subscription use canonical defaults',
  'subscription response converts minor units and computes remaining days',
  'notification preferences validate strictly and persist as one object',
  'account deletion requires exact confirmation and removes the authenticated profile',
  'KINETRA_T10_BACKEND_E2E=PASS',
]) {
  expectIncludes(settingsBackendTests, testContract, `T10 backend E2E: ${testContract}`);
}
const settingsPostgresTests = await readText('apps/backend/test/settings.postgres.test.ts');
for (const testContract of [
  'PostgreSQL settings repository persists preferences and deletes account-owned data',
  'users_notification_preferences_object',
  'await authRepository.findUserByEmail(email), null',
  'KINETRA_T10_POSTGRES_INTEGRATION=PASS',
]) {
  expectIncludes(settingsPostgresTests, testContract, `T10 PostgreSQL test: ${testContract}`);
}
const settingsFrontendTests = await readText('apps/frontend/test/settings.test.ts');
for (const testContract of [
  'T10 settings view renders all six sections and canonical controls',
  'subscription card renders provider, amount, expiry and real T11 actions',
  'settings dialogs expose renewal cancellation and two-stage destructive deletion',
  'settings model fixes date, time, debounce and subscription-state contracts',
]) {
  expectIncludes(settingsFrontendTests, testContract, `T10 frontend unit test: ${testContract}`);
}
const settingsFrontendApiTests = await readText('apps/frontend/test/settings-api.test.ts');
expectIncludes(
  settingsFrontendApiTests,
  'settings API client uses four exact protected routes and handles 204 responses',
  'T10 frontend API test fixes authenticated void-response handling',
);
expectIncludes(
  settingsFrontendApiTests,
  "authorization: 'Bearer settings-token'",
  'T10 frontend API test proves access JWT attachment',
);
const themeFrontendTests = await readText('apps/frontend/test/theme.test.ts');
for (const testContract of [
  'theme preference accepts exactly system, light and dark',
  'system preference resolves from the current operating-system theme',
]) {
  expectIncludes(themeFrontendTests, testContract, `T10 theme unit test: ${testContract}`);
}

const settingsDocumentation = await readText('docs/T10_SETTINGS.md');
for (const documentationContract of [
  'GET /api/v1/settings/profile',
  'GET /api/v1/settings/subscription',
  'PUT /api/v1/settings/notifications',
  'DELETE /api/v1/settings/account',
  'Cache-Control: no-store',
  '008_notifications.sql',
  '004_base_lessons.sql',
  'не меняет',
  'system | light | dark',
  'kinetra.theme.v1',
  'KINETRA_T10_BROWSER_E2E=PASS',
]) {
  expectIncludes(
    settingsDocumentation,
    documentationContract,
    `T10 documented contract: ${documentationContract}`,
  );
}

for (const marker of [
  'KINETRA_T10_SETTINGS_CONTENT=PASS',
  'KINETRA_T10_NOTIFICATIONS=PASS',
  'KINETRA_T10_THEME_MODES=PASS',
  'KINETRA_T10_LOGOUT=PASS',
  'KINETRA_T10_ACCOUNT_DELETION=PASS',
  'KINETRA_T10_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, marker, `T10 browser marker: ${marker}`);
}

for (const marker of [
  'KINETRA_T10_BACKEND_E2E=PASS',
  'KINETRA_T10_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T10_SETTINGS_CONTENT=PASS',
  'KINETRA_T10_NOTIFICATIONS=PASS',
  'KINETRA_T10_THEME_MODES=PASS',
  'KINETRA_T10_LOGOUT=PASS',
  'KINETRA_T10_ACCOUNT_DELETION=PASS',
  'KINETRA_T10_BROWSER_E2E=PASS',
]) {
  expectIncludes(ciWorkflow, `grep -F '${marker}'`, `CI requires T10 marker: ${marker}`);
}
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T10_TEST_SUITE=PASS'",
  'CI emits the T10 suite completion marker',
);

const paymentsMigration = await readText('apps/backend/migrations/009_payments.sql');
for (const migrationContract of [
  'ADD COLUMN IF NOT EXISTS payment_method_id text',
  'CREATE TABLE IF NOT EXISTS subscription_payment_attempts',
  'CREATE TABLE IF NOT EXISTS payment_events',
  'subscription_payment_attempts_idempotency_unique_idx',
  'subscription_payment_attempts_open_initial_user_unique_idx',
  'subscription_payment_attempts_open_renewal_unique_idx',
  'payment_events_event_id_unique_idx',
  "WHERE status = 'active' AND auto_renew = true",
]) {
  expectIncludes(paymentsMigration, migrationContract, `T11 migration: ${migrationContract}`);
}

expectIncludes(
  backendApp,
  "app.use('/api/v1/payments', createPaymentsRouter(paymentsRuntime))",
  'T11 mounts the payments router at the exact API prefix',
);

const paymentsSchema = await readText('apps/backend/src/payments/schema.ts');
for (const schemaContract of [
  'return_url: z.string().url().max(2_048)',
  '.strict()',
  "type: z.literal('notification')",
  "z.enum(['payment.succeeded', 'payment.canceled', 'refund.succeeded'])",
  'payment_id: z.string().min(1)',
  'saved: z.boolean()',
]) {
  expectIncludes(paymentsSchema, schemaContract, `T11 payment schema: ${schemaContract}`);
}

const paymentsRouter = await readText('apps/backend/src/payments/router.ts');
for (const routerContract of [
  "router.post(\n    '/webhook'",
  'webhookSourceVerifier.isAllowed(request.ip)',
  'response.status(200).send()',
  "'/create'",
  'authMiddleware',
  'response.status(201).json(payment)',
  "'/cancel-subscription'",
  "response.setHeader('Cache-Control', 'no-store')",
]) {
  expectIncludes(paymentsRouter, routerContract, `T11 payments router: ${routerContract}`);
}

const webhookSource = await readText('apps/backend/src/payments/webhook-source.ts');
for (const sourceContract of [
  "this.allowed.addSubnet('185.71.76.0', 27, 'ipv4')",
  "this.allowed.addSubnet('185.71.77.0', 27, 'ipv4')",
  "this.allowed.addSubnet('77.75.153.0', 25, 'ipv4')",
  "this.allowed.addAddress('77.75.156.11', 'ipv4')",
  "this.allowed.addAddress('77.75.156.35', 'ipv4')",
  "this.allowed.addSubnet('77.75.154.128', 25, 'ipv4')",
  "this.allowed.addSubnet('2a02:5180::', 32, 'ipv6')",
  "withoutZone.startsWith('::ffff:')",
  'return false',
]) {
  expectIncludes(webhookSource, sourceContract, `T11 webhook source gate: ${sourceContract}`);
}

const yooKassaClient = await readText('apps/backend/src/payments/yookassa-client.ts');
for (const clientContract of [
  "'https://api.yookassa.ru/v3'",
  "headers: { 'Idempotence-Key': idempotencyKey }",
  'Authorization: this.authorization',
  'AbortSignal.timeout(this.options.requestTimeoutMs)',
  'response.status === 408 || response.status === 429 || response.status >= 500',
  'getPayment(paymentId: string)',
  'getRefund(refundId: string)',
]) {
  expectIncludes(
    yooKassaClient,
    clientContract,
    `T11 direct YooKassa REST client: ${clientContract}`,
  );
}

const paymentsService = await readText('apps/backend/src/payments/service.ts');
for (const serviceContract of [
  "export const SUBSCRIPTION_AMOUNT_VALUE = '799.00'",
  "export const SUBSCRIPTION_CURRENCY = 'RUB'",
  'this.allowedReturnUrls.has(requestedReturnUrl)',
  'capture: true',
  'save_payment_method: true',
  "type: 'redirect'",
  'await this.client.getPayment',
  'await this.client.getRefund',
  'eventId: `yukassa:${notification.event}:${providerObjectId}`',
  'payment.payment_method?.saved === true',
  "attached.kind === 'terminal'",
  'cancelAutoRenew(userId, now)',
]) {
  expectIncludes(paymentsService, serviceContract, `T11 payment service: ${serviceContract}`);
}

const paymentsRepository = await readText(
  'apps/backend/src/payments/postgres-payments.repository.ts',
);
for (const repositoryContract of [
  "status IN ('creating', 'pending')",
  'ON CONFLICT (event_id) DO NOTHING',
  'SET auto_renew = false',
  'FOR UPDATE SKIP LOCKED',
  "kind = 'renewal'",
  'subscription.payment_method_id IS NOT NULL',
  'executeRenewalClaim(',
  'FOR UPDATE OF attempt, subscription',
  'subscription.auto_renew = true',
  'starts_at = $3::timestamptz',
  "expires_at = $3::timestamptz + INTERVAL '30 days'",
  'row.provider_payment_id !== input.providerPaymentId',
  'isTerminalAttemptStatus(row.status)',
  "return { kind: 'terminal', status: row.status }",
]) {
  expectIncludes(
    paymentsRepository,
    repositoryContract,
    `T11 PostgreSQL payment contract: ${repositoryContract}`,
  );
}

const renewalService = await readText('apps/backend/src/payments/renewal-service.ts');
for (const renewalContract of [
  'claimDueRenewals(',
  'payment_method_id: validatedClaim.paymentMethodId',
  'capture: true',
  'validatedClaim.idempotencyKey',
  "execution.kind === 'skipped'",
  "reason: 'payment_cancelled'",
]) {
  expectIncludes(renewalService, renewalContract, `T11 renewal worker: ${renewalContract}`);
}

const subscriptionAccess = await readText('apps/backend/src/payments/subscription-access.ts');
for (const accessContract of [
  "status = 'active'",
  'starts_at IS NOT NULL',
  'starts_at <= $2',
  'expires_at IS NOT NULL',
  'expires_at > $2',
]) {
  expectIncludes(subscriptionAccess, accessContract, `T11 server entitlement: ${accessContract}`);
}
for (const accessContract of [
  'await this.requireActiveSubscription(userId)',
  "'SUBSCRIPTION_REQUIRED'",
  '403',
]) {
  expectIncludes(programService, accessContract, `T11 program paywall: ${accessContract}`);
}

for (const sharedPaymentContract of [
  'export interface CreatePaymentRequest',
  'readonly return_url: string',
  'export interface CreatePaymentResponse',
  'readonly confirmation_url: string',
  "readonly status: 'pending'",
]) {
  expectIncludes(
    sharedContracts,
    sharedPaymentContract,
    `T11 shared DTO: ${sharedPaymentContract}`,
  );
}

for (const frontendApiContract of [
  "'/api/v1/payments/create'",
  'const body: CreatePaymentRequest = { return_url: returnUrl }',
  "'/api/v1/payments/cancel-subscription'",
  'public async createPayment(returnUrl: string)',
  'public async cancelSubscription()',
]) {
  expectIncludes(frontendApi, frontendApiContract, `T11 frontend API: ${frontendApiContract}`);
}

for (const routeContract of [
  "payment: '/payment'",
  "paymentSuccess: '/payment/success'",
  "paymentCancel: '/payment/cancel'",
  'export const isPaymentRoute',
]) {
  expectIncludes(routes, routeContract, `T11 frontend route: ${routeContract}`);
}

const paymentModel = await readText('apps/frontend/src/features/payments/model.ts');
for (const pollingContract of [
  "export const PAYMENT_PRICE_LABEL = '799 ₽ / месяц'",
  'export const PAYMENT_POLL_INTERVAL_MS = 2_000',
  'export const PAYMENT_POLL_TIMEOUT_MS = 30_000',
  'while (!isSubscriptionActive(subscription, now()))',
  'const operationController = new AbortController()',
  'scheduleDeadline(timeoutMs, () => {',
  'withinDeadline(fetchSubscription(operationController.signal))',
  'operationController.abort()',
]) {
  expectIncludes(paymentModel, pollingContract, `T11 payment model: ${pollingContract}`);
}

const paymentScreen = await readText('apps/frontend/src/features/payments/PaymentScreen.tsx');
for (const paymentScreenContract of [
  'submissionInFlight.current',
  'new URL(appRoutes.paymentSuccess, window.location.origin).toString()',
  'window.location.assign(confirmationUrl)',
]) {
  expectIncludes(
    paymentScreen,
    paymentScreenContract,
    `T11 checkout screen: ${paymentScreenContract}`,
  );
}

const paymentView = await readText('apps/frontend/src/features/payments/PaymentView.tsx');
for (const paymentViewContract of [
  'data-testid="payment-screen"',
  'Kinetra Premium',
  'data-testid="payment-price"',
  'data-testid="payment-benefits"',
  'data-testid="create-payment"',
  'Подписка продлевается автоматически',
]) {
  expectIncludes(paymentView, paymentViewContract, `T11 checkout content: ${paymentViewContract}`);
}

const paymentSuccess = await readText(
  'apps/frontend/src/features/payments/PaymentSuccessScreen.tsx',
);
for (const successContract of [
  'pollForActiveSubscription',
  'data-testid="payment-success-screen"',
  'data-testid="payment-success-status"',
  'data-testid="retry-subscription-check"',
  'data-testid="start-training"',
  'onActivated(result.subscription)',
]) {
  expectIncludes(paymentSuccess, successContract, `T11 success verification: ${successContract}`);
}

const paymentCancel = await readText('apps/frontend/src/features/payments/PaymentCancelScreen.tsx');
for (const cancelContract of [
  'data-testid="payment-cancel-screen"',
  'data-testid="retry-payment"',
  'data-testid="payment-later"',
]) {
  expectIncludes(paymentCancel, cancelContract, `T11 cancel page: ${cancelContract}`);
}

const paywall = await readText('apps/frontend/src/features/payments/SubscriptionPaywallDialog.tsx');
for (const paywallContract of [
  'data-testid="subscription-paywall-dialog"',
  'data-testid="paywall-renew"',
  'data-testid="paywall-close"',
  "status === 'expired'",
]) {
  expectIncludes(paywall, paywallContract, `T11 premium paywall: ${paywallContract}`);
}

for (const appPaymentContract of [
  'route === appRoutes.paymentSuccess',
  'route === appRoutes.paymentCancel',
  'route === appRoutes.payment',
  'handleSubscriptionUpdated',
  'onSubscriptionRequired={loadSubscription}',
  'clearWorkoutHistorySentinel();',
]) {
  expectIncludes(frontendApp, appPaymentContract, `T11 App integration: ${appPaymentContract}`);
}

const programHistory = await readText('apps/frontend/src/features/program/history.ts');
for (const historyContract of [
  "['kinetraWorkoutVideoId', 'kinetraProgramWeek']",
  'delete nextState[key]',
  "window.history.replaceState(nextState, '', window.location.href)",
]) {
  expectIncludes(
    programHistory,
    historyContract,
    `T11 expired entitlement clears only workout history: ${historyContract}`,
  );
}

for (const settingsPaymentContract of [
  'cancelSubscription()',
  'onSubscriptionUpdated(subscription)',
  "onOpenRenewalInfo={() => openDialog('renewal')}",
]) {
  expectIncludes(
    settingsScreen,
    settingsPaymentContract,
    `T11 Settings integration: ${settingsPaymentContract}`,
  );
}
for (const settingsDialogContract of [
  'Отменить автопродление?',
  'data-testid="settings-cancel-auto-renew-confirm"',
  'до даты окончания',
]) {
  expectIncludes(
    settingsDialogs,
    settingsDialogContract,
    `T11 Settings cancellation: ${settingsDialogContract}`,
  );
}

for (const styleContract of [
  '/* T11 — payments, subscription verification and program paywall */',
  '.payment-card',
  '.payment-primary',
  '.payment-result-card',
  '.subscription-paywall',
  '.program-subscription-locked',
]) {
  expectIncludes(frontendStyles, styleContract, `T11 payment style: ${styleContract}`);
}

const paymentsFrontendTests = await readText('apps/frontend/test/payments.test.ts');
for (const frontendTestContract of [
  'T11 payment page renders the exact price, benefits and renewal disclosure',
  'success polling is non-overlapping and stops on active or at 30 seconds',
  'inactive subscription renders a locked T07 surface without rendering a player',
  'inactive entitlement removes both workout sentinels while preserving unrelated history',
]) {
  expectIncludes(
    paymentsFrontendTests,
    frontendTestContract,
    `T11 frontend test: ${frontendTestContract}`,
  );
}
const paymentsFrontendApiTests = await readText('apps/frontend/test/payments-api.test.ts');
expectIncludes(
  paymentsFrontendApiTests,
  'T11 API client creates a payment and cancels only auto-renewal with JWT auth',
  'T11 frontend API test fixes exact protected payment calls',
);

const paymentsBackendTests = await readText('apps/backend/test/payments.e2e.test.ts');
for (const backendTestContract of [
  'payment create and cancellation are protected while webhook is public and IP-guarded',
  'payment creation sends the exact subscription request and reuses an open attempt',
  'a canceled webhook before provider attachment cannot regress to pending',
  'a succeeded webhook before provider attachment cannot regress to pending',
  'an unsaved provider payment method is never persisted or enabled for renewal',
  'verified succeeded webhook activates exactly once and cancel preserves paid expiry',
  'canceled and full-refund webhooks use verified provider objects',
  'renewal worker retries a durable creating attempt with the same idempotency key',
  'KINETRA_T11_BACKEND_E2E=PASS',
  'KINETRA_T11_WEBHOOK_AUTH=PASS',
  'KINETRA_T11_WEBHOOK_IDEMPOTENCY=PASS',
  'KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS',
]) {
  expectIncludes(
    paymentsBackendTests,
    backendTestContract,
    `T11 backend E2E: ${backendTestContract}`,
  );
}

const paymentsPostgresTests = await readText('apps/backend/test/payments.postgres.test.ts');
for (const postgresTestContract of [
  'KINETRA_T11_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS',
  'claimDueRenewals',
  'SELECT COUNT(*)::text AS count FROM payment_events WHERE event_id = $1',
  'KINETRA_T11_ATTACH_MONOTONICITY=PASS',
]) {
  expectIncludes(
    paymentsPostgresTests,
    postgresTestContract,
    `T11 PostgreSQL test: ${postgresTestContract}`,
  );
}

const yooKassaClientTests = await readText('apps/backend/test/yookassa-client.test.ts');
for (const clientTestContract of [
  'native YooKassa client sends Basic auth/idempotency and validates provider objects',
  "request.headers['idempotence-key']",
  'request.headers.authorization',
  'KINETRA_T11_YOOKASSA_CLIENT=PASS',
]) {
  expectIncludes(
    yooKassaClientTests,
    clientTestContract,
    `T11 YooKassa client test: ${clientTestContract}`,
  );
}

const paymentsDocumentation = await readText('docs/T11_PAYMENTS.md');
for (const documentationContract of [
  'POST /api/v1/payments/create',
  'POST /api/v1/payments/webhook',
  'POST /api/v1/payments/cancel-subscription',
  'Idempotence-Key',
  '185.71.76.0/27',
  '2a02:5180::/32',
  'payment_method.saved',
  '54-ФЗ',
  'https://yookassa.ru/developers/using-api/webhooks',
]) {
  expectIncludes(
    paymentsDocumentation,
    documentationContract,
    `T11 documented contract: ${documentationContract}`,
  );
}

for (const marker of [
  'KINETRA_T11_PAYMENT_FLOW=PASS',
  'KINETRA_T11_PAYWALL=PASS',
  'KINETRA_T11_SETTINGS_SUBSCRIPTION=PASS',
  'KINETRA_T11_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, marker, `T11 browser marker: ${marker}`);
}

for (const marker of [
  'KINETRA_T11_YOOKASSA_CLIENT=PASS',
  'KINETRA_T11_BACKEND_E2E=PASS',
  'KINETRA_T11_WEBHOOK_AUTH=PASS',
  'KINETRA_T11_WEBHOOK_IDEMPOTENCY=PASS',
  'KINETRA_T11_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS',
  'KINETRA_T11_PAYMENT_FLOW=PASS',
  'KINETRA_T11_PAYWALL=PASS',
  'KINETRA_T11_SETTINGS_SUBSCRIPTION=PASS',
  'KINETRA_T11_BROWSER_E2E=PASS',
]) {
  expectIncludes(ciWorkflow, `grep -F '${marker}'`, `CI requires T11 marker: ${marker}`);
}
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T11_TEST_SUITE=PASS'",
  'CI emits the T11 suite completion marker',
);
for (const ciEnvironmentContract of [
  'YUKASSA_SHOP_ID: ci-test-shop-not-real',
  'YUKASSA_SECRET_KEY: ci-test-secret-not-real',
  'YUKASSA_RETURN_URL: http://localhost:5173/payment/success',
  "YUKASSA_REQUEST_TIMEOUT_MS: '10000'",
]) {
  expectIncludes(
    ciWorkflow,
    ciEnvironmentContract,
    `CI provides safe T11 test env: ${ciEnvironmentContract}`,
  );
}

// T13 — per-device Web Push lifecycle, durable claims and deterministic notification worker.
const pushMigration = await readText('apps/backend/migrations/010_push_notifications.sql');
for (const migrationContract of [
  'CREATE TABLE IF NOT EXISTS push_subscriptions',
  'user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE',
  'endpoint text NOT NULL',
  'p256dh text NOT NULL',
  'auth text NOT NULL',
  'expiration_time timestamptz NULL',
  'user_agent varchar(512) NULL',
  'last_success_at timestamptz NULL',
  'last_failure_at timestamptz NULL',
  'disabled_at timestamptz NULL',
  'push_subscriptions_endpoint_valid',
  "endpoint ~* '^https://'",
  'push_subscriptions_p256dh_valid',
  'push_subscriptions_auth_valid',
  'CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique_idx',
  'CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx',
  'WHERE disabled_at IS NULL',
  'CREATE TABLE IF NOT EXISTS push_notification_deliveries',
  'subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE',
  'occurrence_key varchar(512) NOT NULL',
  "notification_type IN ('workout_reminder', 'weekly_survey_reminder')",
  "status IN ('claimed', 'sent', 'failed', 'invalidated')",
  'push_notification_deliveries_terminal_state_valid',
  'CREATE UNIQUE INDEX IF NOT EXISTS push_notification_deliveries_occurrence_unique_idx',
  'CREATE INDEX IF NOT EXISTS push_notification_deliveries_claimed_idx',
  "WHERE status = 'claimed'",
]) {
  expectIncludes(pushMigration, migrationContract, `T13 migration: ${migrationContract}`);
}
expectMatches(
  pushMigration,
  /CREATE UNIQUE INDEX IF NOT EXISTS push_notification_deliveries_occurrence_unique_idx[\s\S]*?ON push_notification_deliveries \(\s*subscription_id,\s*user_id,\s*notification_type,\s*occurrence_key\s*\)/u,
  'T13 delivery uniqueness binds device, owner, notification type and occurrence',
);

expectIncludes(
  backendApp,
  "app.use('/api/v1/push', createPushRouter(pushRuntime))",
  'T13 backend mounts the push router at the exact API prefix',
);

const t13BackendEnvironment = await readText('apps/backend/src/config/env.ts');
for (const environmentContract of [
  'const parseVapidEnvironment = (',
  'const publicKey = trimmedOrNull(process.env.VAPID_PUBLIC_KEY)',
  'const privateKey = trimmedOrNull(process.env.VAPID_PRIVATE_KEY)',
  'const subject = trimmedOrNull(process.env.VAPID_SUBJECT)',
  "'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required in production.'",
  "'Web Push configuration is incomplete. Set public key, private key and subject.'",
  '/^[A-Za-z0-9_-]{80,128}$/u.test(publicKey)',
  '/^[A-Za-z0-9_-]{40,128}$/u.test(privateKey)',
  "!['mailto:', 'https:'].includes(subjectUrl.protocol)",
  'vapid: parseVapidEnvironment(nodeEnv)',
]) {
  expectIncludes(
    t13BackendEnvironment,
    environmentContract,
    `T13 fail-closed VAPID environment: ${environmentContract}`,
  );
}

const pushSchema = await readText('apps/backend/src/push/schema.ts');
for (const schemaContract of [
  "url.protocol !== 'https:'",
  'url.username.length > 0 || url.password.length > 0 || url.hash.length > 0',
  'isObviousLocalEndpoint(url)',
  'subscriptionKeySchema',
  '/^[A-Za-z0-9_-]+$/u',
  'pushSubscriptionSchema',
  'expirationTime: z',
  'pushUnsubscribeSchema',
]) {
  expectIncludes(pushSchema, schemaContract, `T13 strict push schema: ${schemaContract}`);
}
if ((pushSchema.match(/\.strict\(\)/gu) ?? []).length >= 3) {
  pass('T13 subscription, nested keys and unsubscribe payloads reject unknown fields');
} else {
  fail('T13 subscription, nested keys and unsubscribe payloads reject unknown fields');
}
if (/\buser_id\s*:/u.test(pushSchema)) {
  fail('T13 push schemas never accept a body-owned user_id');
} else {
  pass('T13 push schemas never accept a body-owned user_id');
}

const pushRouter = await readText('apps/backend/src/push/router.ts');
for (const routerContract of [
  "response.setHeader('Cache-Control', 'no-store')",
  'router.use(disableCaching)',
  'router.use(authMiddleware)',
  'readonly mutationRateLimiter: RequestHandler',
  "router.get(\n    '/public-key'",
  "router.post(\n    '/subscriptions'",
  "'/subscriptions',\n    mutationRateLimiter",
  "router.delete(\n    '/subscriptions'",
  'requireAuthenticatedPrincipal(request)',
  'response.status(200).json(configuration)',
  'response.status(200).json(subscription)',
  'response.status(204).send()',
]) {
  expectIncludes(pushRouter, routerContract, `T13 JWT/no-store push router: ${routerContract}`);
}

const pushService = await readText('apps/backend/src/push/service.ts');
for (const serviceContract of [
  "new HttpError(503, 'PUSH_NOT_CONFIGURED'",
  'return { public_key: this.publicKey }',
  'pushSubscriptionSchema.safeParse(body)',
  "'INVALID_PUSH_SUBSCRIPTION'",
  'this.repository.upsertSubscription({',
  'userId,',
  'userAgent: normalizeUserAgent(userAgent)',
  "'PUSH_SUBSCRIPTION_CONFLICT'",
  'return { subscribed: true }',
  'pushUnsubscribeSchema.safeParse(body)',
  "'INVALID_PUSH_UNSUBSCRIBE'",
  'this.repository.disableSubscription(userId, parsed.data.endpoint, now)',
]) {
  expectIncludes(pushService, serviceContract, `T13 push service: ${serviceContract}`);
}
if (/privateKey|VAPID_PRIVATE_KEY/u.test(pushService)) {
  fail('T13 push service response surface has no VAPID private key');
} else {
  pass('T13 push service response surface has no VAPID private key');
}

const pushRepositoryInterface = await readText('apps/backend/src/push/repository.ts');
expectIncludes(
  pushRepositoryInterface,
  'export const MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER = 10',
  'T13 bounds enabled device fan-out per user',
);

const pushRepository = await readText('apps/backend/src/push/postgres-push.repository.ts');
for (const repositoryContract of [
  'const user = await client.query(',
  'let existingResult = await client.query<ExistingSubscriptionRow>(',
  'const requiresEnabledSlot =',
  'existing.disabled_at !== null',
  "'enabled push subscription count'",
  'return enabledCount < MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER',
  'INSERT INTO push_subscriptions',
  'ON CONFLICT (endpoint)',
  'SET user_id = $1',
  'disabled_at = NULL',
  'WHERE user_id = $1',
  'AND endpoint = $2',
  "COALESCE(timezone_entry.name, 'Europe/Moscow') AS effective_timezone",
  'LEFT JOIN pg_timezone_names AS timezone_entry',
  '$1::timestamptz AT TIME ZONE normalized.effective_timezone AS local_now',
  "to_char(local_now, 'HH24:MI') = reminder_time",
  'EXTRACT(ISODOW FROM local_now)::integer = 7',
  'WITH eligible AS MATERIALIZED',
  'INSERT INTO push_notification_deliveries',
  'ON CONFLICT (',
  ') DO NOTHING',
  "delivery.status = 'claimed'",
  'FOR UPDATE OF delivery, subscription',
  "SET status = 'sent'",
  'SET last_success_at = $2',
  "SET status = 'invalidated'",
  'SET disabled_at = COALESCE(disabled_at, $2)',
  "SET status = 'failed'",
  'SET last_failure_at = $2',
]) {
  expectIncludes(
    pushRepository,
    repositoryContract,
    `T13 PostgreSQL push repository: ${repositoryContract}`,
  );
}

const webPushSender = await readText('apps/backend/src/push/webpush-sender.ts');
for (const senderContract of [
  'const MAX_PAYLOAD_BYTES = 3_072',
  'const DEFAULT_TTL_SECONDS = 60 * 60',
  'const DEFAULT_TIMEOUT_MS = 10_000',
  "readonly url: '/schedule' | '/progress'",
  "payload.type === 'workout_reminder' && payload.url === '/schedule'",
  "payload.type === 'weekly_survey_reminder' && payload.url === '/progress'",
  "Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES",
  "errorCode: 'payload_too_large'",
  'webPush.generateRequestDetails(subscription, payload',
  'deadlineState.timer = setTimeout(',
  'request.destroy(error)',
  'response.resume()',
  'const defaultTransport = createWebPushTransport()',
  'this.transport.sendNotification(',
  'vapidDetails: this.vapidDetails',
  'TTL: this.ttlSeconds',
  "urgency: 'normal'",
  'timeout: this.timeoutMs',
  'statusCode === 404 || statusCode === 410',
  "return { kind: 'failed', errorCode: safeFailureCode(error) }",
]) {
  expectIncludes(webPushSender, senderContract, `T13 bounded Web Push sender: ${senderContract}`);
}

const pushScheduler = await readText('apps/backend/src/push/scheduler-service.ts');
for (const schedulerContract of [
  'const DEFAULT_SEND_CONCURRENCY = 8',
  'sendConcurrency < 1 || sendConcurrency > 32',
  'await this.subscriptionAccess.hasActiveSubscription(dueUser.userId, now)',
  'this.programRepository.getProgress(dueUser.userId)',
  'this.programRepository.getWeek(dueUser.userId, program.currentWeekNumber)',
  'day.dayOfWeek === dueUser.localDayOfWeek',
  'workout.completedAt !== null || !workout.mediaAvailable',
  '`workout:${programWeek}:${workout.videoId}:${dueUser.localDate}`',
  "url: '/schedule'",
  'dueUser.localDayOfWeek !== 7',
  'this.progressRepository.getMetrics(dueUser.userId)',
  'metric.programWeek === programWeek',
  '`weekly-survey:${programWeek}`',
  "url: '/progress'",
  'this.pushRepository.claimDeliveries(candidate.event, now)',
  'this.pushRepository.executeDeliveryClaim(claim, now',
  'mapWithConcurrency(',
]) {
  expectIncludes(pushScheduler, schedulerContract, `T13 scheduler policy: ${schedulerContract}`);
}

const pushRuntime = await readText('apps/backend/src/push/runtime.ts');
for (const runtimeContract of [
  'env.vapid === null',
  'new UnavailablePushSender()',
  'new WebPushSender({',
  'privateKey: env.vapid.privateKey',
  'new PostgresSubscriptionAccessChecker(databasePool)',
  'mutationRateLimiter: createFixedWindowRateLimiter({',
  'windowMs: 60_000',
  'maximumRequests: 60',
  "errorCode: 'PUSH_RATE_LIMITED'",
  'configured: env.vapid !== null',
]) {
  expectIncludes(pushRuntime, runtimeContract, `T13 production push runtime: ${runtimeContract}`);
}
const notificationWorker = await readText('apps/backend/src/push/run-notifications.ts');
for (const workerContract of [
  'if (!runtime.configured)',
  "throw new Error('Web Push is not configured.')",
  'await runtime.schedulerService.run()',
  "console.log('Kinetra notification run completed.', summary)",
  'exitCode = 1',
  'await closeDatabasePool()',
  'process.exitCode = exitCode',
]) {
  expectIncludes(notificationWorker, workerContract, `T13 one-shot worker: ${workerContract}`);
}

for (const sharedPushContract of [
  'export interface PushPublicKeyResponse',
  'readonly public_key: string',
  'export interface PushSubscriptionRequest',
  'readonly endpoint: string',
  'readonly p256dh: string',
  'readonly auth: string',
  'readonly expirationTime: number | null',
  'export interface PushSubscriptionResponse',
  'readonly subscribed: true',
  'export interface PushUnsubscribeRequest',
]) {
  expectIncludes(
    sharedContracts,
    sharedPushContract,
    `T13 minimal shared DTO: ${sharedPushContract}`,
  );
}
expectMatches(
  sharedContracts,
  /export interface PushPublicKeyResponse \{\s*readonly public_key: string;\s*\}/u,
  'T13 public-key DTO contains only the public key',
);

for (const frontendPushApiContract of [
  'public async getPushPublicKey()',
  "'/api/v1/push/public-key'",
  'public async registerPushSubscription(',
  "'/api/v1/push/subscriptions'",
  "method: 'POST'",
  'public async deletePushSubscription(data: PushUnsubscribeRequest)',
  "method: 'DELETE'",
]) {
  expectIncludes(
    frontendApi,
    frontendPushApiContract,
    `T13 frontend API: ${frontendPushApiContract}`,
  );
}

const pushNotifications = await readText('apps/frontend/src/pwa/pushNotifications.ts');
for (const lifecycleContract of [
  'runtime.isSecureContext()',
  'runtime.hasNotificationApi()',
  'runtime.hasServiceWorkerApi()',
  'runtime.hasPushManagerApi()',
  'const getExistingPushSubscription = async',
  'runtime.getExistingRegistration()',
  'const subscribeToPush = async',
  "if (permission === 'default')",
  'permission = await runtime.requestPermission()',
  "if (permission === 'denied')",
  'runtime.getReadyRegistration()',
  'registration.pushManager.getSubscription()',
  'const publicKey = await runtime.getPublicKey()',
  'registration.pushManager.subscribe({',
  'userVisibleOnly: true',
  'applicationServerKey: runtime.decodeApplicationServerKey(publicKey.public_key)',
  'const response = await runtime.registerSubscription(',
  'requestFromBrowserSubscription(subscription)',
  'runtime.deleteSubscription({ endpoint: subscription.endpoint })',
  'await Promise.allSettled([',
  'const unsubscribeBrowserOnly = async',
]) {
  expectIncludes(
    pushNotifications,
    lifecycleContract,
    `T13 frontend permission/subscription lifecycle: ${lifecycleContract}`,
  );
}
if (/VAPID_PRIVATE_KEY|privateKey/u.test(pushNotifications)) {
  fail('T13 frontend push module has no private VAPID key surface');
} else {
  pass('T13 frontend push module has no private VAPID key surface');
}

for (const serviceWorkerRegistrationContract of [
  'getExistingServiceWorkerRegistration',
  "navigator.serviceWorker.getRegistration('/')",
  'getReadyServiceWorkerRegistration',
]) {
  expectIncludes(
    registration,
    serviceWorkerRegistrationContract,
    `T13 injectable service worker registration seam: ${serviceWorkerRegistrationContract}`,
  );
}

for (const settingsPushContract of [
  'getExistingPushSubscription',
  'void refreshPushDeviceState()',
  'const enablePushOnDevice = (): void =>',
  'void subscribeToPush()',
  'const disablePushOnDevice = (): void =>',
  'void unsubscribeFromPush()',
  'settleBestEffortWithin(bestEffortUnsubscribeFromPush())',
  '.then(() => logout())',
  'await settleBestEffortWithin(unsubscribeBrowserOnly())',
  'updateNotifications(snapshot)',
  'SETTINGS_NOTIFICATION_DEBOUNCE_MS',
]) {
  expectIncludes(
    settingsScreen,
    settingsPushContract,
    `T13 Settings lifecycle: ${settingsPushContract}`,
  );
}
expectIncludes(
  settingsModel,
  'SETTINGS_NOTIFICATION_DEBOUNCE_MS = 450',
  'T13 preserves the T10 450 ms notification debounce',
);
expectMatches(
  frontendApi,
  /public async updateNotifications\(data: NotificationPreferences\): Promise<void> \{[\s\S]*?authenticatedVoidRequest\('\/api\/v1\/settings\/notifications',[\s\S]*?method: 'PUT',[\s\S]*?body: JSON\.stringify\(data\),[\s\S]*?keepalive: true/u,
  'T13 preserves the full T10 notification object PUT',
);
for (const settingsPushTestId of [
  'settings-push-device',
  'settings-push-permission',
  'settings-push-browser-state',
  'settings-push-backend-state',
  'settings-push-error',
  'settings-push-enable',
  'settings-push-disable',
]) {
  expectIncludes(
    settingsView,
    settingsPushTestId,
    `T13 Settings device state: ${settingsPushTestId}`,
  );
}

for (const serviceWorkerPushContract of [
  "const PUSH_NOTIFICATION_TYPES = new Set(['workout_reminder', 'weekly_survey_reminder'])",
  "const PUSH_DEEP_LINKS = new Set(['/schedule', '/progress'])",
  "url: '/schedule'",
  "url: '/progress'",
  "url: '/'",
  "value.trimStart().startsWith('//')",
  'candidate.origin !== self.location.origin || candidate.pathname !== fallback',
  "self.addEventListener('push'",
  'self.registration.showNotification(notification.title',
  "self.addEventListener('notificationclick'",
  'event.notification.close()',
  ".matchAll({ type: 'window', includeUncontrolled: true })",
  'clientUrl.origin !== self.location.origin',
  'self.clients.openWindow(targetUrl)',
]) {
  expectIncludes(
    serviceWorker,
    serviceWorkerPushContract,
    `T13 Service Worker safety: ${serviceWorkerPushContract}`,
  );
}

const pushBackendTests = await readText('apps/backend/test/push.e2e.test.ts');
for (const testContract of [
  'all Push API endpoints require JWT and disable caching',
  'idempotently upserts the authenticated device',
  'caps enabled devices while rotation and disabling preserve capacity',
  'reactivatedAtLimit.status, 409',
  'validation is strict and rejects local literal endpoints',
  'cannot disable another user device',
  'fails safely when VAPID is not configured',
  'mutations have a bounded per-IP rate limit',
  "'PUSH_RATE_LIMITED'",
  'KINETRA_T13_BACKEND_E2E=PASS',
]) {
  expectIncludes(pushBackendTests, testContract, `T13 backend E2E: ${testContract}`);
}

const pushPostgresTests = await readText('apps/backend/test/push.postgres.test.ts');
for (const testContract of [
  'claims once and classifies delivery state',
  'atomically caps enabled devices and preserves rejected transfers',
  'concurrentResults.filter(Boolean).length, 1',
  'MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER',
  "effectiveTimezone: 'Europe/Moscow'",
  'Promise.all([',
  "kind: 'invalid'",
  "kind: 'failed'",
  'repeated.claims.length, 0',
  'KINETRA_T13_POSTGRES_INTEGRATION=PASS',
]) {
  expectIncludes(pushPostgresTests, testContract, `T13 PostgreSQL integration: ${testContract}`);
}

const webPushSenderTests = await readText('apps/backend/test/webpush-sender.test.ts');
for (const testContract of [
  'uses bounded options and sends only the compact public payload',
  'discards a streaming response and enforces a wall-clock deadline',
  'createWebPushTransport(localHttpRequestPrimitive(port))',
  'chunksSent < 200',
  'invalidates only 404/410',
  "errorCode: 'network_timeout'",
  'rejects mismatched deep links and oversized payloads before transport',
  'KINETRA_T13_WEBPUSH_SENDER=PASS',
]) {
  expectIncludes(webPushSenderTests, testContract, `T13 Web Push sender test: ${testContract}`);
}

const notificationSchedulerTests = await readText(
  'apps/backend/test/notification-scheduler.test.ts',
);
for (const testContract of [
  'sends each Sunday logical event once to every device',
  'skips unavailable/completed workouts, submitted metrics and inactive paywall',
  'honors disabled preferences and completed workout state',
  'isolates invalid and transient endpoints and never retries an occurrence',
  'KINETRA_T13_SCHEDULER=PASS',
]) {
  expectIncludes(notificationSchedulerTests, testContract, `T13 scheduler test: ${testContract}`);
}

const pushFrontendTests = await readText('apps/frontend/test/push-notifications.test.ts');
for (const testContract of [
  'hydration checks an existing browser subscription without prompting or fetching VAPID',
  'explicit subscribe requests permission first',
  'existing browser subscription is upserted without a new prompt or public-key request',
  'denied permission cannot loop a prompt',
  'unsupported environments remain read-only',
  'backend registration failure never removes or reports away the browser subscription',
  'explicit and best-effort unsubscribe preserve their different failure semantics',
  'KINETRA_T13_PERMISSION_LIFECYCLE=PASS',
]) {
  expectIncludes(pushFrontendTests, testContract, `T13 frontend lifecycle test: ${testContract}`);
}

const serviceWorkerTests = await readText('apps/frontend/test/service-worker.test.ts');
for (const testContract of [
  'shows bounded notifications and sends external URLs to the safe root',
  'notification click navigates and focuses an existing same-origin window',
  'malformed or external notification clicks never open an external origin',
  'KINETRA_T13_SERVICE_WORKER=PASS',
]) {
  expectIncludes(serviceWorkerTests, testContract, `T13 Service Worker VM test: ${testContract}`);
}
for (const testContract of [
  'T13 push API client uses exact protected public-key, upsert and delete contracts',
  "authorization: 'Bearer settings-token'",
]) {
  expectIncludes(settingsFrontendApiTests, testContract, `T13 frontend API test: ${testContract}`);
}
for (const testContract of [
  'T13 settings keeps permission, browser subscription and backend registration separate',
  'KINETRA_T13_SETTINGS_INTEGRATION=PASS',
]) {
  expectIncludes(settingsFrontendTests, testContract, `T13 Settings unit test: ${testContract}`);
}

for (const browserContract of [
  'Page.addScriptToEvaluateOnNewDocument',
  "Object.defineProperty(Notification, 'requestPermission'",
  "Object.defineProperty(PushManager.prototype, 'getSubscription'",
  "Object.defineProperty(PushManager.prototype, 'subscribe'",
  'permissionRequests: 0',
  'counters.pushPublicKeyGet, 0',
  'counters.pushSubscriptionPost, 0',
  'T13 explicit device push registration',
  'applicationServerKeyLength: 65',
  'T10 debounced notification preferences saved once',
  'workout_reminders: false',
  "reminder_time: '10:30'",
  'weekly_survey_reminder: false',
  'T13 existing browser subscription is re-registered without a new permission prompt',
  'T13 explicit device push removal',
  'T13 device is unsubscribed after account deletion',
  'T13 device is registered before logout cleanup',
  'KINETRA_T13_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, browserContract, `T13 browser acceptance: ${browserContract}`);
}
const t13BrowserMarkerPosition = browserTest.lastIndexOf(
  "console.log('KINETRA_T13_BROWSER_E2E=PASS')",
);
const t13BrowserFinalAssertionPosition = browserTest.lastIndexOf(
  'assert.equal(counters.logout, 1)',
);
if (
  t13BrowserMarkerPosition > t13BrowserFinalAssertionPosition &&
  t13BrowserFinalAssertionPosition >= 0
) {
  pass('T13 browser marker is emitted only after final lifecycle assertions');
} else {
  fail('T13 browser marker is emitted only after final lifecycle assertions');
}

const migrationRunCount = (ciWorkflow.match(/run: npm run db:migrate/gu) ?? []).length;
if (migrationRunCount >= 2) {
  pass('T13 CI runs the append-only migration twice to prove idempotency');
} else {
  fail('T13 CI runs the append-only migration twice to prove idempotency');
}
for (const ciEnvironmentContract of [
  'VAPID_PUBLIC_KEY: BG_wO5SSQc4drdQ1GeaWDgqFtBppoFwygQOqK84VlMoWPE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo',
  'VAPID_PRIVATE_KEY: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  'VAPID_SUBJECT: mailto:ci@kinetra.test',
]) {
  expectIncludes(
    ciWorkflow,
    ciEnvironmentContract,
    `CI provides deterministic T13 test env: ${ciEnvironmentContract}`,
  );
}
for (const marker of [
  'KINETRA_T13_WEBPUSH_SENDER=PASS',
  'KINETRA_T13_BACKEND_E2E=PASS',
  'KINETRA_T13_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T13_SCHEDULER=PASS',
  'KINETRA_T13_SERVICE_WORKER=PASS',
  'KINETRA_T13_PERMISSION_LIFECYCLE=PASS',
  'KINETRA_T13_SETTINGS_INTEGRATION=PASS',
  'KINETRA_T13_BROWSER_E2E=PASS',
]) {
  expectIncludes(ciWorkflow, `grep -F '${marker}'`, `CI requires T13 marker: ${marker}`);
}
expectIncludes(
  ciWorkflow,
  "echo 'KINETRA_T13_TEST_SUITE=PASS'",
  'CI emits the T13 suite completion marker only after marker greps',
);

const pushDocumentation = await readText('docs/T13_PUSH_NOTIFICATIONS.md');
for (const documentationContract of [
  'GET /api/v1/push/public-key',
  'POST /api/v1/push/subscriptions',
  'DELETE /api/v1/push/subscriptions',
  'Authorization: Bearer <access JWT>',
  'Cache-Control: no-store',
  '010_push_notifications.sql',
  'VAPID_PRIVATE_KEY=<server-only private base64url key>',
  'Notification.requestPermission()',
  '450 ms',
  '`/schedule`',
  '`/progress`',
  'каждую минуту',
  'Europe/Moscow',
  'в воскресенье по локальному календарю',
  'canonical program/paywall contract',
  'active',
  'Одно логическое событие разрешено на каждую активную device',
  '404/410',
  'PUSH_RATE_LIMITED',
  'Retry-After',
  'at-most-once policy',
  'stale',
  'ротация',
  'HTTPS',
  'secret manager',
  'Alerting',
  'не более 10 enabled subscriptions',
  'hard wall-clock deadline 10 seconds',
]) {
  expectIncludes(
    pushDocumentation,
    documentationContract,
    `T13 documented contract: ${documentationContract}`,
  );
}
const readmeDocumentation = await readText('README.md');
for (const readmeContract of [
  '## Web Push уведомления',
  '/api/v1/push/public-key',
  'npm run notifications:send -w @kinetra/backend',
  'current program week',
  'Sunday weekly policy',
  'не более 10',
  'docs/T13_PUSH_NOTIFICATIONS.md',
]) {
  expectIncludes(readmeDocumentation, readmeContract, `T13 README contract: ${readmeContract}`);
}
const validationReport = await readText('VALIDATION.md');
for (const [validationCheck, expectedStatus] of [
  ['Structural contracts T01–T13', 'PASS'],
  ['TypeScript production + tests', 'PASS'],
  ['ESLint', 'PASS'],
  ['Backend unit/API tests', 'PASS'],
  ['PostgreSQL migration/integration', 'CI REQUIRED'],
  ['Frontend unit/Service Worker tests', 'PASS'],
  ['Chrome browser acceptance', 'CI REQUIRED'],
  ['Production build', 'PASS'],
  ['Composite quality gate', 'CI REQUIRED'],
  ['Tracked source manifest', 'PASS'],
]) {
  const escapedValidationCheck = validationCheck.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  expectMatches(
    validationReport,
    new RegExp(`\\| ${escapedValidationCheck}\\s+\\| ${expectedStatus}\\s+\\|`, 'u'),
    `T13 validation records ${expectedStatus}: ${validationCheck}`,
  );
}

for (const temporaryArtifact of [
  '.github/workflows/apply-t04-fixes.yml',
  '.github/workflows/apply-t05.yml',
  '.github/workflows/apply-t06.yml',
  '.github/workflows/apply-t07.yml',
  '.github/workflows/apply-t08.yml',
  '.github/workflows/apply-t09.yml',
  '.github/workflows/apply-t10.yml',
  '.github/workflows/apply-t11.yml',
  '.github/workflows/apply-t13.yml',
  '.github/workflows/export-dev-env.yml',
  '.github/workflows/export-full-env.yml',
  '.github/workflows/export-source.yml',
  '.t05-bootstrap',
  '.t06-bootstrap',
  '.t07-bootstrap',
  '.t08-bootstrap',
  '.t09-bootstrap',
  '.t10-bootstrap',
  '.t11-bootstrap',
  '.t13-bootstrap',
  'docs/.probe',
  'docs/.t05-pr-trigger',
  'docs/.t06-pr-trigger',
  'docs/.t07-pr-trigger',
  'docs/.t08-pr-trigger',
  'docs/.t09-pr-trigger',
  'docs/.t10-pr-trigger',
  'docs/.t11-pr-trigger',
  'docs/.t13-pr-trigger',
]) {
  try {
    await access(resolve(root, temporaryArtifact));
    fail(`temporary bootstrap artifact is absent: ${temporaryArtifact}`);
  } catch {
    pass(`temporary bootstrap artifact is absent: ${temporaryArtifact}`);
  }
}

const collectProjectPaths = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }

    const absolutePath = resolve(directory, entry.name);
    paths.push(absolutePath);

    if (entry.isDirectory()) {
      paths.push(...(await collectProjectPaths(absolutePath)));
    }
  }

  return paths;
};

const suspiciousArtifactPatterns = [
  /(?:^|\/)[^/]*(?:bootstrap|payload)[^/]*(?:\/|$)/iu,
  /(?:^|\/)[^/]+\.(?:b64|base64|encoded)$/iu,
  /(?:^|\/)\.t\d+-pr-trigger$/iu,
  /^\.github\/workflows\/(?:apply-t\d+(?:-[^/]*)?|export-(?:dev-env|full-env|source))\.ya?ml$/iu,
];
const suspiciousArtifact = (await collectProjectPaths(root))
  .map((absolutePath) => relative(root, absolutePath))
  .find((relativePath) => suspiciousArtifactPatterns.some((pattern) => pattern.test(relativePath)));

if (suspiciousArtifact === undefined) {
  pass('no bootstrap, payload, encoded-source, or PR-trigger artifact paths exist');
} else {
  fail(`suspicious bootstrap/payload artifact path exists: ${suspiciousArtifact}`);
}

const rateLimiter = await readText('apps/backend/src/auth/rate-limit.ts');
expectIncludes(rateLimiter, 'response.status(429)', 'password-reset rate limiter returns HTTP 429');
expectIncludes(rateLimiter, "'Retry-After'", 'rate limiter returns Retry-After');

const envExample = await readText('.env.example');
for (const key of [
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_TTL_SECONDS',
  'AUTH_BCRYPT_COST',
  'AUTH_REFRESH_TTL_DAYS',
  'AUTH_PHONE_LOGIN_ENABLED',
  'AUTH_PHONE_ONLY_REGISTRATION_ENABLED',
  'AUTH_EMAIL_VERIFICATION_REQUIRED',
  'AUTH_PASSWORD_RESET_TTL_MINUTES',
  'AUTH_PASSWORD_RESET_RATE_LIMIT_MAX',
]) {
  expectMatches(envExample, new RegExp(`^${key}=`, 'mu'), `environment option: ${key}`);
}

for (const key of [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_PRESIGNED_URL_TTL_SECONDS',
]) {
  expectMatches(envExample, new RegExp(`^${key}=`, 'mu'), `T06 storage option: ${key}`);
}

for (const key of [
  'YUKASSA_SHOP_ID',
  'YUKASSA_SECRET_KEY',
  'YUKASSA_RETURN_URL',
  'YUKASSA_REQUEST_TIMEOUT_MS',
]) {
  expectMatches(envExample, new RegExp(`^${key}=`, 'mu'), `T11 YooKassa option: ${key}`);
}
expectIncludes(
  envExample,
  'YUKASSA_RETURN_URL=http://localhost:5173/payment/success',
  'T11 local return URL targets the exact success route',
);

for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
  expectMatches(envExample, new RegExp(`^${key}=`, 'mu'), `T13 Web Push option: ${key}`);
}
expectIncludes(
  envExample,
  '# Example subject after both keys are configured: mailto:coach@kinetra.app',
  'T13 VAPID subject example uses a documented controlled contact',
);
for (const blankLocalVapidOption of ['VAPID_PUBLIC_KEY=', 'VAPID_PRIVATE_KEY=', 'VAPID_SUBJECT=']) {
  expectMatches(
    envExample,
    new RegExp(`^${blankLocalVapidOption}$`, 'mu'),
    `T13 copied local env leaves VAPID disabled without a partial configuration: ${blankLocalVapidOption}`,
  );
}
if (/^VITE_.*VAPID_PRIVATE_KEY=/mu.test(envExample)) {
  fail('T13 VAPID private key is never exposed as frontend configuration');
} else {
  pass('T13 VAPID private key is never exposed as frontend configuration');
}

try {
  await access(resolve(root, '.env'));
  fail('real .env file is absent from the package');
} catch {
  pass('real .env file is absent from the package');
}

const tests = await readText('apps/backend/test/auth.e2e.test.ts');
for (const scenario of [
  'wrong password',
  'phone-only registration',
  'refresh rotation',
  'password reset is non-enumerating',
  'expired password-reset tokens',
  'optional email verification',
  'rate-limited',
]) {
  expectIncludes(tests, scenario, `test scenario: ${scenario}`);
}

const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);

const collectTextFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }

    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(absolutePath)));
    } else if (
      textExtensions.has(extname(entry.name).toLowerCase()) ||
      entry.name.startsWith('.env') ||
      entry.name === '.gitignore' ||
      entry.name === '.nvmrc'
    ) {
      files.push(absolutePath);
    }
  }

  return files;
};

const textFiles = await collectTextFiles(root);
const verifierPath = resolve(root, 'scripts/verify-project.mjs');
const legacyBrandPattern = new RegExp(['smart', 'fitt'].join(''), 'iu');
const forbiddenMessengerPattern = new RegExp(['tele', 'gram'].join(''), 'iu');
let forbiddenBrand = null;
let forbiddenMessengerReference = null;

for (const absolutePath of textFiles) {
  if (absolutePath === verifierPath) {
    continue;
  }
  const content = await readFile(absolutePath, 'utf8');
  const relativePath = relative(root, absolutePath);

  if (legacyBrandPattern.test(content)) {
    forbiddenBrand = relativePath;
  }

  if (forbiddenMessengerPattern.test(content)) {
    forbiddenMessengerReference = relativePath;
  }
}

if (forbiddenBrand === null) {
  pass('no legacy product branding remains');
} else {
  fail(`legacy product branding remains in ${forbiddenBrand}`);
}

// Documentation may name an explicitly out-of-scope messenger. Runtime and configuration must not
// contain its dependencies, SDK imports, endpoints, or environment variables.
const runtimeFiles = textFiles.filter(
  (absolutePath) =>
    extname(relative(root, absolutePath)).toLowerCase() !== '.md' &&
    relative(root, absolutePath) !== 'scripts/verify-project.mjs',
);
let forbiddenMessengerRuntimeReference = null;

for (const absolutePath of runtimeFiles) {
  const content = await readFile(absolutePath, 'utf8');

  if (forbiddenMessengerPattern.test(content)) {
    forbiddenMessengerRuntimeReference = relative(root, absolutePath);
    break;
  }
}

if (forbiddenMessengerRuntimeReference === null) {
  pass('no forbidden messenger runtime, dependency, endpoint, or environment variable');
} else {
  fail(`forbidden messenger runtime content found in ${forbiddenMessengerRuntimeReference}`);
}

if (forbiddenMessengerReference !== null) {
  pass('forbidden messenger is mentioned only as an out-of-scope documentation item');
}

for (const message of passes) {
  console.log(`PASS  ${message}`);
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`FAIL  ${message}`);
  }
  console.error(`\n${failures.length} structural check(s) failed; ${passes.length} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${passes.length} structural checks passed.`);
}
