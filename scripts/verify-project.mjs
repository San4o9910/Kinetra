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
  'apps/frontend/src/routing.ts',
  'apps/frontend/test/api-session.test.ts',
  'apps/frontend/test/survey-routing.test.ts',
  'apps/frontend/test/onboarding.test.ts',
  'apps/frontend/test/base-lessons-api.test.ts',
  'apps/frontend/test/base-lessons.test.ts',
  'apps/frontend/public/manifest.webmanifest',
  'apps/frontend/public/service-worker.js',
  'apps/frontend/public/offline.html',
  'apps/frontend/public/icons/icon-192.png',
  'apps/frontend/public/icons/icon-512.png',
  'apps/frontend/public/icons/icon-maskable-512.png',
  'apps/frontend/src/pwa/registerServiceWorker.ts',
  'apps/backend/migrations/001_auth.sql',
  'apps/backend/migrations/002_content.sql',
  'apps/backend/migrations/003_survey.sql',
  'apps/backend/migrations/004_base_lessons.sql',
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
  'apps/backend/test/auth.e2e.test.ts',
  'apps/backend/test/profile.e2e.test.ts',
  'apps/backend/test/profile.postgres.test.ts',
  'apps/backend/test/base-lessons.e2e.test.ts',
  'apps/backend/test/base-lessons.postgres.test.ts',
  'apps/backend/test/support/fake-object-url-signer.ts',
  'apps/backend/test/support/in-memory-base-lessons.repository.ts',
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

const frontendApp = await readText('apps/frontend/src/App.tsx');
expectIncludes(frontendApp, '<LoginScreen', 'frontend has an access-token handoff from login');
expectIncludes(frontendApp, '<SystemState', 'frontend distinguishes network failure from logout');
expectIncludes(
  frontendApp,
  'routeForOnboardingStatus',
  'frontend routes by server onboarding status',
);
expectIncludes(frontendApp, 'logout().finally', 'frontend revokes the refresh session on logout');
expectIncludes(frontendApp, '<OnboardingCarousel', 'T05 route renders the onboarding carousel');
expectIncludes(frontendApp, '<BaseLessonsScreen', 'T06 route renders the base lessons screen');

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
expectIncludes(frontendStyles, 'color: #6b7370', 'T06 disabled CTA uses the prescribed text color');
expectIncludes(
  frontendStyles,
  'background: linear-gradient(135deg, #181c1c, #202525)',
  'T06 poster uses the prescribed placeholder gradient',
);
expectIncludes(indexHtml, 'fonts.googleapis.com', 'Inter stylesheet is connected');
expectIncludes(indexHtml, 'family=Inter', 'Inter font family is requested');

const browserTest = await readText('scripts/test-frontend-browser.mjs');
expectIncludes(browserTest, 'KINETRA_T04_BROWSER_E2E=PASS', 'T04 browser acceptance test exists');
expectIncludes(browserTest, 'KINETRA_T05_BROWSER_E2E=PASS', 'T05 browser acceptance test exists');
expectIncludes(browserTest, 'KINETRA_T06_BROWSER_E2E=PASS', 'T06 browser acceptance test exists');
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
expectIncludes(browserTest, 'active route', 'browser test checks active routing');
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

for (const temporaryArtifact of [
  '.github/workflows/apply-t04-fixes.yml',
  '.github/workflows/apply-t05.yml',
  '.github/workflows/apply-t06.yml',
  '.github/workflows/export-dev-env.yml',
  '.github/workflows/export-full-env.yml',
  '.github/workflows/export-source.yml',
  '.t05-bootstrap',
  '.t06-bootstrap',
  'docs/.probe',
  'docs/.t05-pr-trigger',
  'docs/.t06-pr-trigger',
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
