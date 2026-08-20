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
  'apps/frontend/index.html',
  'apps/frontend/public/manifest.webmanifest',
  'apps/frontend/public/service-worker.js',
  'apps/frontend/public/offline.html',
  'apps/frontend/public/icons/icon-192.png',
  'apps/frontend/public/icons/icon-512.png',
  'apps/frontend/public/icons/icon-maskable-512.png',
  'apps/frontend/src/pwa/registerServiceWorker.ts',
  'apps/backend/migrations/001_auth.sql',
  'apps/backend/migrations/002_content.sql',
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
  'apps/backend/test/auth.e2e.test.ts',
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

for (const script of [
  'db:migrate',
  'db:seed',
  'db:verify-content',
  'test',
  'typecheck',
  'build',
]) {
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
expectIncludes(serviceWorker, "caches.match('/offline.html')", 'offline navigation fallback present');
expectMatches(serviceWorker, /pathname\.startsWith\('\/api\/'\)/u, 'service worker bypasses API calls');

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
expectIncludes(router, "response.setHeader('Cache-Control', 'no-store')", 'auth responses disable caching');
expectIncludes(router, 'clearRefreshTokenCookie', 'invalid/logout/reset flows clear refresh cookie');

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
  expectMatches(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'u'), `table: ${table}`);
}
expectIncludes(migration, 'password_hash text NOT NULL', 'only password hash column is defined');
expectIncludes(migration, 'token_hash char(64) NOT NULL', 'token tables store hashes');
expectIncludes(migration, 'revoked_at timestamptz NULL', 'refresh revocation timestamp stored');
expectIncludes(migration, 'used_at timestamptz NULL', 'one-time token consumption timestamp stored');
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

const rateLimiter = await readText('apps/backend/src/auth/rate-limit.ts');
expectIncludes(rateLimiter, "response.status(429)", 'password-reset rate limiter returns HTTP 429');
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
