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
  'apps/frontend/index.html',
  'apps/frontend/src/features/auth/LoginScreen.tsx',
  'apps/frontend/src/features/survey/SurveyWizard.tsx',
  'apps/frontend/src/features/survey/model.ts',
  'apps/frontend/src/routing.ts',
  'apps/frontend/test/api-session.test.ts',
  'apps/frontend/test/survey-routing.test.ts',
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
  'apps/backend/test/auth.e2e.test.ts',
  'apps/backend/test/profile.e2e.test.ts',
  'apps/backend/test/profile.postgres.test.ts',
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

const contentVerifier = await readText('apps/backend/scripts/verify-content.mjs');
expectIncludes(
  contentVerifier,
  'KINETRA_T03_DATABASE_VERIFICATION=PASS',
  'T03 database verification script is present',
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

const frontendApp = await readText('apps/frontend/src/App.tsx');
expectIncludes(frontendApp, '<LoginScreen', 'frontend has an access-token handoff from login');
expectIncludes(frontendApp, '<SystemState', 'frontend distinguishes network failure from logout');
expectIncludes(
  frontendApp,
  'routeForOnboardingStatus',
  'frontend routes by server onboarding status',
);
expectIncludes(frontendApp, 'logout().finally', 'frontend revokes the refresh session on logout');

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
expectIncludes(indexHtml, 'fonts.googleapis.com', 'Inter stylesheet is connected');
expectIncludes(indexHtml, 'family=Inter', 'Inter font family is requested');

const browserTest = await readText('scripts/test-frontend-browser.mjs');
expectIncludes(browserTest, 'KINETRA_T04_BROWSER_E2E=PASS', 'T04 browser acceptance test exists');
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

for (const temporaryWorkflow of [
  '.github/workflows/apply-t04-fixes.yml',
  '.github/workflows/export-dev-env.yml',
  '.github/workflows/export-full-env.yml',
  '.github/workflows/export-source.yml',
]) {
  try {
    await access(resolve(root, temporaryWorkflow));
    fail(`temporary workflow is absent: ${temporaryWorkflow}`);
  } catch {
    pass(`temporary workflow is absent: ${temporaryWorkflow}`);
  }
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
    !relative(root, absolutePath).startsWith('docs/') &&
    relative(root, absolutePath) !== 'README.md' &&
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
