import { access, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const readOptionalText = async (relativePath) => {
  try {
    return await readText(relativePath);
  } catch {
    return '';
  }
};

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
  'docs/T12_TRAINER_CHAT.md',
  'docs/T13_PUSH_NOTIFICATIONS.md',
  'docs/T14_VIDEO_UPLOADS.md',
  'docs/TRAINER_VERIFICATION.md',
  'apps/frontend/index.html',
  'apps/frontend/src/features/auth/LoginScreen.tsx',
  'apps/frontend/src/features/auth/RegisterScreen.tsx',
  'apps/frontend/src/features/trainer-verification/TrainerVerificationScreen.tsx',
  'apps/frontend/src/features/survey/SurveyWizard.tsx',
  'apps/frontend/src/features/survey/model.ts',
  'apps/frontend/src/features/onboarding/OnboardingCarousel.tsx',
  'apps/frontend/src/features/onboarding/model.ts',
  'apps/frontend/src/features/base-lessons/BaseLessonsScreen.tsx',
  'apps/frontend/src/features/base-lessons/BaseLessonsView.tsx',
  'apps/frontend/src/features/base-lessons/BaseLessonsRequiredDialog.tsx',
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
  'apps/frontend/src/features/settings/accountLifecycle.ts',
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
  'apps/frontend/src/features/chat/ChatComposer.tsx',
  'apps/frontend/src/features/chat/ChatFloatingButton.tsx',
  'apps/frontend/src/features/chat/ChatPhotoThumbnail.tsx',
  'apps/frontend/src/features/chat/ClientChatScreen.tsx',
  'apps/frontend/src/features/chat/ConversationView.tsx',
  'apps/frontend/src/features/chat/MessageList.tsx',
  'apps/frontend/src/features/chat/PhotoViewer.tsx',
  'apps/frontend/src/features/chat/authError.ts',
  'apps/frontend/src/features/chat/composerAcknowledgement.ts',
  'apps/frontend/src/features/chat/draft.ts',
  'apps/frontend/src/features/chat/index.ts',
  'apps/frontend/src/features/chat/model.ts',
  'apps/frontend/src/features/chat/photoAccessLifecycle.ts',
  'apps/frontend/src/features/chat/photoUploadFailure.ts',
  'apps/frontend/src/features/chat/readAcknowledgementLifecycle.ts',
  'apps/frontend/src/features/chat/runtime.ts',
  'apps/frontend/src/features/chat/sessionRequestGate.ts',
  'apps/frontend/src/features/chat/types.ts',
  'apps/frontend/src/features/chat/usePhotoAccessLifecycle.ts',
  'apps/frontend/src/features/trainer-chat/TrainerChatsScreen.tsx',
  'apps/frontend/src/features/trainer-chat/selectedConversation.ts',
  'apps/frontend/src/features/trainer-chat/index.ts',
  'apps/frontend/src/features/trainer-shell/TrainerAdminShell.tsx',
  'apps/frontend/src/features/trainer-videos/TrainerVideosScreen.tsx',
  'apps/frontend/src/features/trainer-videos/model.ts',
  'apps/frontend/src/features/trainer-videos/program-polling.ts',
  'apps/frontend/src/features/trainer-videos/upload.ts',
  'apps/frontend/src/routing.ts',
  'apps/frontend/test/api-session.test.ts',
  'apps/frontend/test/registration-roles.test.ts',
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
  'apps/frontend/test/chat-draft.test.ts',
  'apps/frontend/test/chat-csp.test.ts',
  'apps/frontend/test/chat-lifecycle.test.ts',
  'apps/frontend/test/chat-model.test.ts',
  'apps/frontend/test/chat-photo-failure.test.ts',
  'apps/frontend/test/chat-realtime.test.ts',
  'apps/frontend/test/chat-ui.test.ts',
  'apps/frontend/test/trainer-selected-conversation.test.ts',
  'apps/frontend/test/trainer-videos.test.ts',
  'apps/frontend/test/trainer-video-upload.test.ts',
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
  'apps/backend/migrations/011_trainer_chat.sql',
  'apps/backend/migrations/012_video_uploads.sql',
  'apps/backend/migrations/013_trainer_verification.sql',
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
  'apps/backend/src/trainer-verification/schema.ts',
  'apps/backend/src/trainer-verification/repository.ts',
  'apps/backend/src/trainer-verification/postgres-trainer-verification.repository.ts',
  'apps/backend/src/trainer-verification/service.ts',
  'apps/backend/src/trainer-verification/router.ts',
  'apps/backend/src/trainer-verification/runtime.ts',
  'apps/backend/src/trainer-verification/reviewer-cli.ts',
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
  'apps/backend/src/chat/schema.ts',
  'apps/backend/src/chat/repository.ts',
  'apps/backend/src/chat/postgres-chat.repository.ts',
  'apps/backend/src/chat/service.ts',
  'apps/backend/src/chat/router.ts',
  'apps/backend/src/chat/runtime.ts',
  'apps/backend/src/chat/media.ts',
  'apps/backend/src/chat/s3-chat-media.store.ts',
  'apps/backend/src/chat/event-hub.ts',
  'apps/backend/src/chat/rate-limit.ts',
  'apps/backend/src/chat/realtime.ts',
  'apps/backend/src/chat/cleanup-service.ts',
  'apps/backend/src/chat/client-ip.ts',
  'apps/backend/src/chat/run-media-cleanup.ts',
  'apps/backend/src/chat/trainer-cli.ts',
  'apps/backend/src/video-admin/schema.ts',
  'apps/backend/src/video-admin/repository.ts',
  'apps/backend/src/video-admin/postgres-video.repository.ts',
  'apps/backend/src/video-admin/storage.ts',
  'apps/backend/src/video-admin/verifier.ts',
  'apps/backend/src/video-admin/service.ts',
  'apps/backend/src/video-admin/router.ts',
  'apps/backend/src/video-admin/runtime.ts',
  'apps/backend/src/video-admin/worker-service.ts',
  'apps/backend/src/video-admin/run-upload-worker.ts',
  'apps/backend/src/video-admin/run-media-cleanup.ts',
  'apps/backend/src/video-admin/trainer-access-cli.ts',
  'apps/backend/src/video-admin/upload-recovery-cli.ts',
  'apps/backend/test/auth.e2e.test.ts',
  'apps/backend/test/auth.postgres.test.ts',
  'apps/backend/test/env.test.ts',
  'apps/backend/test/profile.e2e.test.ts',
  'apps/backend/test/profile.postgres.test.ts',
  'apps/backend/test/trainer-verification.e2e.test.ts',
  'apps/backend/test/trainer-verification.postgres.test.ts',
  'apps/backend/test/trainer-verification-reviewer-cli.test.ts',
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
  'apps/backend/test/chat.e2e.test.ts',
  'apps/backend/test/chat.postgres.test.ts',
  'apps/backend/test/chat.socket.test.ts',
  'apps/backend/test/chat-trainer-cli.test.ts',
  'apps/backend/test/chat-photo-security.test.ts',
  'apps/backend/test/video-admin.e2e.test.ts',
  'apps/backend/test/video-admin.postgres.test.ts',
  'apps/backend/test/video-admin.test.ts',
  'apps/backend/test/video-s3.integration.test.ts',
  'apps/backend/test/video-verifier.test.ts',
  'apps/backend/test/video-trainer-cli.test.ts',
  'apps/backend/test/chat-merge-readiness.test.ts',
  'apps/backend/test/chat-multipart-timeout.test.ts',
  'apps/backend/test/chat-realtime-admission.test.ts',
  'apps/backend/test/chat-realtime-postgres.test.ts',
  'apps/backend/test/chat-cleanup.test.ts',
  'apps/backend/test/chat-client-ip.test.ts',
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
  'apps/backend/test/support/in-memory-chat.repository.ts',
  'apps/backend/test/support/fake-chat-media.ts',
  'scripts/test-frontend-browser.mjs',
  'scripts/check-changed-format.mjs',
  'packages/shared/src/index.ts',
];

await Promise.all(requiredFiles.map(expectFile));

const immutableMigrationHashes = [
  [
    'apps/backend/migrations/001_auth.sql',
    'a1dc8f7c0bfd1dbe0f2692349ec1f5fd66e8bfbebc7faf16ddd8bd4b481ac786',
  ],
  [
    'apps/backend/migrations/002_content.sql',
    '1cd2a247a646081b8eda1fc955c276a664c1820b47ce209aecbf6bfd3151cae6',
  ],
  [
    'apps/backend/migrations/003_survey.sql',
    '6b6373b47ab05a889ad4c86c1df1e61ccd49c44d2298393e6e1bb55bbc074739',
  ],
  [
    'apps/backend/migrations/004_base_lessons.sql',
    'fc1b1fb9184d937c8595f8ab878c34223e747726a01d092c58837e1adcdc0650',
  ],
  [
    'apps/backend/migrations/005_program_media_availability.sql',
    'a280daaf2196e86f66c4ff4c641177184f3ee3b6dbba28aff656b6208b34e5b2',
  ],
  [
    'apps/backend/migrations/006_schedule_copy.sql',
    'c479aceafcb111d2f637e8377bf5b8049a080c3241c893ae4e07661090cc1046',
  ],
  [
    'apps/backend/migrations/007_progress_data_contract.sql',
    '65bec10a6824bef011a1eb5ac888a2052c98877f235b9759f53618eab828b4fb',
  ],
  [
    'apps/backend/migrations/008_notifications.sql',
    '599ad4383afc97225c2f8a39d287267614e5f93e561f7a9787f736a8b10aa82a',
  ],
  [
    'apps/backend/migrations/009_payments.sql',
    '6f48c43099569c6e54559da68a1941283936a724b0a02f222ce07f64619a1cee',
  ],
  [
    'apps/backend/migrations/010_push_notifications.sql',
    '582e0bcdfa4c3936839f4a1e3d1bfe3322a05690b2b6e40ead506146602a1b8b',
  ],
  [
    'apps/backend/migrations/011_trainer_chat.sql',
    'c5ccefee1db3c5f545680448ce86601c90c017c7f10f387e5dc5c5da48f78d09',
  ],
  [
    'apps/backend/migrations/012_video_uploads.sql',
    'c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4',
  ],
];

for (const [migrationPath, expectedHash] of immutableMigrationHashes) {
  const migrationBytes = await readFile(resolve(root, migrationPath));
  const actualHash = createHash('sha256').update(migrationBytes).digest('hex');

  if (actualHash === expectedHash) {
    pass(`T12 immutable migration SHA-256: ${migrationPath}`);
  } else {
    fail(`T12 immutable migration SHA-256: ${migrationPath}`);
  }
}

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

for (const [script, command] of [
  ['chat:trainer:grant', 'node dist/chat/trainer-cli.js grant'],
  ['chat:trainer:reassign', 'node dist/chat/trainer-cli.js reassign'],
  ['chat:trainer:revoke', 'node dist/chat/trainer-cli.js revoke'],
  ['chat:media-cleanup', 'node dist/chat/run-media-cleanup.js'],
]) {
  if (backendPackage.scripts?.[script] === command) {
    pass(`T12 backend operator script: ${script}`);
  } else {
    fail(`T12 backend operator script: ${script}`);
  }
}

for (const [script, command] of [
  ['video:trainer:grant', 'node dist/video-admin/trainer-access-cli.js grant'],
  ['video:trainer:revoke', 'node dist/video-admin/trainer-access-cli.js revoke'],
  ['video:uploads:process', 'node dist/video-admin/run-upload-worker.js'],
  ['video:uploads:retry-quarantined', 'node dist/video-admin/upload-recovery-cli.js retry'],
  ['video:media-cleanup', 'node dist/video-admin/run-media-cleanup.js'],
]) {
  if (backendPackage.scripts?.[script] === command) {
    pass(`T14 backend operator script: ${script}`);
  } else {
    fail(`T14 backend operator script: ${script}`);
  }
}

for (const [script, command] of [
  ['trainer-verification:reviewer:grant', 'node dist/trainer-verification/reviewer-cli.js grant'],
  ['trainer-verification:reviewer:revoke', 'node dist/trainer-verification/reviewer-cli.js revoke'],
]) {
  if (backendPackage.scripts?.[script] === command) {
    pass(`trainer verification reviewer operator script: ${script}`);
  } else {
    fail(`trainer verification reviewer operator script: ${script}`);
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
expectIncludes(
  backendApp,
  "'/api/v1/trainer-verification'",
  'trainer verification user router is mounted',
);
expectIncludes(
  backendApp,
  "'/api/v1/admin/trainer-verification'",
  'trainer verification reviewer router is mounted',
);

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
expectIncludes(router, "'requested_role'", 'registration requires a requested role');
expectIncludes(
  router,
  "'AUTHORITY_FIELD_NOT_ALLOWED'",
  'registration rejects client-supplied authority fields',
);
expectIncludes(router, "'UNKNOWN_REGISTRATION_FIELD'", 'registration rejects unknown fields');
expectIncludes(
  router,
  "response.setHeader('Cache-Control', 'no-store')",
  'auth responses disable caching',
);
expectIncludes(
  router,
  'clearRefreshTokenCookie',
  'invalid refresh/reset flows clear refresh cookie',
);
for (const subjectBoundLogoutContract of [
  'optionalVerifiedLogoutProof',
  'options.accessTokenVerifier',
  'verifier.verifyLogoutSubjectProof(parts[1])',
  'return { userId: claims.sub, sessionId: claims.sid }',
  'options.service.logout(refreshToken, proof)',
  "'LOGOUT_NOT_CONFIRMED'",
  'Bearerless legacy requests',
]) {
  expectIncludes(
    router,
    subjectBoundLogoutContract,
    `subject-bound logout contract: ${subjectBoundLogoutContract}`,
  );
}
const logoutRouter = router.slice(
  router.indexOf("router.post('/logout'"),
  router.indexOf("router.post(\n    '/password-reset/request'"),
);
if (logoutRouter.includes('clearRefreshTokenCookie')) {
  fail('logout responses never emit a clearing Set-Cookie header');
} else {
  pass('logout responses never emit a clearing Set-Cookie header');
}
expectIncludes(
  backendApp,
  'accessTokenVerifier: authRuntime.accessTokenVerifier',
  'auth composition injects the access-token verifier into logout',
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
expectIncludes(
  tokens,
  'verifyLogoutSubjectProof',
  'expired access JWT is verified through a logout-only subject-proof path',
);
expectIncludes(tokens, 'compactVerify', 'logout subject proof verifies the JWT signature');
for (const logoutProofContract of [
  "protectedHeader.alg !== 'HS256'",
  "protectedHeader.typ !== 'JWT'",
  'payload.iss === issuer',
  'payload.aud === audience',
  "payload.type === 'access'",
  'CANONICAL_UUID_PATTERN.test(payload.sub)',
  'CANONICAL_UUID_PATTERN.test(payload.sid)',
  'CANONICAL_UUID_PATTERN.test(payload.jti)',
  'Number.isSafeInteger(issuedAt)',
  'Number.isSafeInteger(expiresAt)',
  'expiresAt > issuedAt',
  'expiresAt - issuedAt === ttlSeconds',
  'issuedAt <= nowSeconds',
]) {
  expectIncludes(
    tokens,
    logoutProofContract,
    `strict logout subject-proof contract: ${logoutProofContract}`,
  );
}
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
expectIncludes(
  service,
  "'TRAINER_EMAIL_REQUIRED'",
  'trainer registration requires an email that can be verified',
);

const repository = await readText('apps/backend/src/auth/postgres-auth.repository.ts');
expectIncludes(repository, "await client.query('BEGIN')", 'PostgreSQL transactions implemented');
expectIncludes(repository, 'FOR UPDATE', 'one-time and refresh tokens are row-locked');
expectIncludes(repository, 'replaced_by_token_id', 'refresh replacement chain stored');
expectIncludes(
  repository,
  'trainer_verification_requests',
  'trainer registration creates its verification bridge in the user transaction',
);
expectIncludes(
  repository,
  'trainer_role_selected',
  'trainer registration appends its initial audit event',
);
expectMatches(
  repository,
  /WHERE user_id = \$1 AND revoked_at IS NULL/u,
  'all active refresh sessions can be revoked',
);
expectMatches(repository, /\$1/u, 'PostgreSQL repository uses parameterized queries');
expectIncludes(
  repository,
  "console.error('Failed to roll back PostgreSQL transaction.')",
  'auth rollback logging cannot expose PostgreSQL details or row values',
);
for (const familyBoundLogoutRepositoryContract of [
  'revokeRefreshSessionInFamily',
  'input.currentTokenHash',
  'input.expectedUserId',
  'input.ancestorSessionId',
  'refresh_replaced_by_token_id',
  'global auth lock order user -> refresh sessions',
  "await this.hooks.afterUserLocked?.('rotate', owner.user_id)",
  "await this.hooks.afterUserLocked?.('logout', input.expectedUserId)",
  'proof_family (id, replaced_by_token_id)',
  'target_family (id, replaced_by_token_id)',
  'target_session.id IN (SELECT id FROM target_family)',
  'proof_family.id = $3::uuid',
  'UNION',
  'FOR UPDATE',
]) {
  expectIncludes(
    repository,
    familyBoundLogoutRepositoryContract,
    `rotation-family-bound logout repository: ${familyBoundLogoutRepositoryContract}`,
  );
}
if (/\bUNION ALL\b/u.test(repository)) {
  fail('logout rotation-family traversal is cycle-safe');
} else {
  pass('logout rotation-family traversal is cycle-safe');
}
const earlyAuthE2eTests = await readText('apps/backend/test/auth.e2e.test.ts');
expectIncludes(
  earlyAuthE2eTests,
  'subject-bound logout never revokes or clears another tab account refresh cookie',
  'executable cross-tab subject-bound logout regression',
);
expectIncludes(
  earlyAuthE2eTests,
  'a late bearer-bound logout response must not clear a newer account cookie',
  'bearer-bound logout response cannot erase a later cross-tab login cookie',
);
expectIncludes(
  earlyAuthE2eTests,
  'day-zero logout proof revokes only its day-31 sliding refresh family',
  'old access proof can revoke its still-live sliding refresh descendant',
);
expectIncludes(
  earlyAuthE2eTests,
  'logout rejects tampered, future-issued, and noncanonical subject proofs',
  'invalid logout subject proofs remain fail-closed',
);
expectIncludes(
  earlyAuthE2eTests,
  'bearerless late logout is a no-op and never emits Set-Cookie',
  'legacy bearerless late logout cannot revoke or clear a newer cookie',
);
for (const slidingFamilyAssertion of [
  'harness.clock.advance(29 * DAY_IN_MILLISECONDS)',
  'harness.clock.advance(2 * DAY_IN_MILLISECONDS)',
  'unrelatedFamilySurvives.status, 200',
  'otherAccountSurvives.status, 200',
  'refreshAfterLogout.status, 401',
  'remoteRefreshWonRace.status, 200',
  'secondRemoteRefreshWonRace.status, 200',
  'a refresh-first replacement descendant must be revoked by the queued family logout',
  'family logout must follow and revoke replacement descendants beyond one hop',
]) {
  expectIncludes(
    earlyAuthE2eTests,
    slidingFamilyAssertion,
    `sliding logout-family E2E: ${slidingFamilyAssertion}`,
  );
}
const authPostgresTests = await readText('apps/backend/test/auth.postgres.test.ts');
for (const authPostgresContract of [
  "process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true'",
  'PostgreSQL logout revokes only the current session in the signed refresh rotation family',
  'an ancestor proof must reach the target and every replacement descendant',
  'the current session id itself must be accepted',
  'another login family for the same user must survive',
  'another account must survive',
  'KINETRA_AUTH_LOGOUT_FAMILY_POSTGRES=PASS',
  'PostgreSQL serializes refresh rotation and family logout in both lock orders',
  'waitForDatabaseLockWaiter',
  'refresh-first replacement must be revoked by the queued family logout',
  'logout-first must prevent a queued refresh replacement',
  'queued refresh must not insert a replacement',
  'KINETRA_AUTH_REFRESH_LOGOUT_SERIALIZATION=PASS',
]) {
  expectIncludes(
    authPostgresTests,
    authPostgresContract,
    `PostgreSQL logout-family integration: ${authPostgresContract}`,
  );
}

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
expectIncludes(ciWorkflow, 'fetch-depth: 0', 'CI fetches the PR base for changed-file formatting');
expectIncludes(ciWorkflow, 'run: npm run format:changed', 'CI verifies changed-file formatting');
expectIncludes(
  rootPackage.scripts?.check ?? '',
  'npm run format:changed',
  'composite local check verifies changed-file formatting',
);
const changedFormatScript = await readText('scripts/check-changed-format.mjs');
for (const changedFormatContract of [
  'refs/remotes/origin/${githubBaseRef}',
  'addDiff(`${reference}...HEAD`)',
  "const developReference = 'refs/remotes/origin/develop'",
  'addDiff(`${developReference}...HEAD`)',
  'newly created GitHub branch requires origin/develop and fetch-depth 0',
  'GitHub Actions formatting requires a resolved pull-request or push base',
  'resolveConfig(absolutePath, { editorconfig: true })',
]) {
  expectIncludes(
    changedFormatScript,
    changedFormatContract,
    `changed-file formatting fails closed: ${changedFormatContract}`,
  );
}
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
expectIncludes(
  programRepository,
  "authenticated_user.onboarding_status = 'active'",
  'exploration mode keeps the workout completion mutation gated by active onboarding',
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
  "'BASE_LESSONS_REQUIRED'",
  'exploration mode rejects workout completion before base lessons are complete',
);
expectIncludes(
  programService,
  "'ONBOARDING_REQUIRED'",
  'program preview stays closed before onboarding reaches base lessons',
);
expectIncludes(
  programService,
  'snapshot.days.length !== PROGRAM_DAYS_PER_WEEK',
  'T07 fails closed if a program week is not seven days',
);
expectIncludes(programService, "return 'locked'", 'T07 marks the preview week as locked');
expectIncludes(
  programService,
  "workoutMediaUnlocked && status !== 'locked' && day.mediaAvailable",
  'T07 signs media only for active onboarding after upload confirmation and never for a locked week',
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
expectIncludes(
  baseLessonsScreen,
  'base-lessons-loading-back-to-app',
  'T06 loading state keeps an explicit exit to app exploration',
);

const baseLessonsView = await readText(
  'apps/frontend/src/features/base-lessons/BaseLessonsView.tsx',
);
for (const testId of [
  'base-lessons-screen',
  'base-lessons-progress',
  'base-lesson-card-',
  'base-lessons-complete',
  'base-lessons-back-to-app',
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
for (const testId of [
  'tab-bar',
  'tab-home',
  'tab-schedule',
  'tab-progress',
  'tab-chat',
  'tab-settings',
]) {
  expectIncludes(tabBar, testId, `T07 tab bar test hook: ${testId}`);
}
for (const label of ['Сегодня', 'Расписание', 'Прогресс', 'Чат', 'Настройки']) {
  expectIncludes(tabBar, label, `T07 tab bar label: ${label}`);
}
for (const chatTabContract of [
  "{ route: appRoutes.chat, label: 'Чат', testId: 'tab-chat', icon: 'chat' }",
  'readonly showChat: boolean',
  'readonly chatUnreadCount: number',
  'tabItems.filter((item) => item.route !== appRoutes.chat)',
  'chatUnreadBadge(chatUnreadCount)',
  'chatFabAccessibleName(chatUnreadCount)',
  'data-testid="tab-chat-badge"',
]) {
  expectIncludes(tabBar, chatTabContract, `T12 client chat tab contract: ${chatTabContract}`);
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
  'today-heading',
  'week-progress',
  'week-progress-copy',
  'workout-card-',
  'workout-status-',
  'today-workout',
  'today-rest-day',
  'next-workout',
  'today-open-schedule',
]) {
  expectIncludes(programWeekView, testId, `T07 main-screen test hook: ${testId}`);
}
for (const todayContract of [
  'aria-labelledby="program-today-heading"',
  'const TodayHeading = (): ReactNode =>',
  "{ id: 'program-today-heading', 'data-testid': 'today-heading' }",
  'Тренировка на сегодня',
  'Следующая тренировка',
  'Прогресс недели',
  'Сегодня по плану отдых',
  'Открыть полное расписание',
  'week.week_number === currentWeekNumber',
  'week.days.find(({ day_of_week: dayOfWeek }) => dayOfWeek === todayDayOfWeek)',
  'onClick={onOpenSchedule}',
]) {
  expectIncludes(programWeekView, todayContract, `T07 Today dashboard contract: ${todayContract}`);
}
if (
  programWeekView.includes('data-testid="week-previous"') ||
  programWeekView.includes('data-testid="week-next"')
) {
  fail('T07 Today dashboard does not duplicate week navigation from Schedule');
} else {
  pass('T07 Today dashboard does not duplicate week navigation from Schedule');
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
expectIncludes(
  programScreen,
  'getWeek(programWeek, controller.signal)',
  'T07 resolves a workout selected from another program week',
);
expectIncludes(programScreen, '<ProgramWeekView', 'T07 renders the Today dashboard');
expectIncludes(programScreen, '<WorkoutPlayer', 'T07 opens the workout player');
expectIncludes(
  programScreen,
  'onOpenSchedule={onOpenSchedule}',
  'T07 Today dashboard opens the full schedule',
);
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
expectIncludes(
  programScreen,
  '<BaseLessonsRequiredDialog',
  'exploration mode explains the preparation gate instead of opening a workout player',
);
expectIncludes(
  programScreen,
  'trainingLocked',
  'exploration mode keeps the workout player locked until onboarding becomes active',
);

const appWorkoutHistoryPopStateStart = frontendApp.indexOf('const handlePopState = (): void => {');
const appWorkoutHistoryPopStateEnd = frontendApp.indexOf(
  "window.addEventListener('popstate', handlePopState)",
  appWorkoutHistoryPopStateStart,
);
const appWorkoutHistoryPopState =
  appWorkoutHistoryPopStateStart >= 0 &&
  appWorkoutHistoryPopStateEnd > appWorkoutHistoryPopStateStart
    ? frontendApp.slice(appWorkoutHistoryPopStateStart, appWorkoutHistoryPopStateEnd)
    : '';
const appWorkoutHistoryFence = appWorkoutHistoryPopState.indexOf('if (historyFenceRef.current)');
const appWorkoutHistoryRouteWrite = appWorkoutHistoryPopState.indexOf(
  'setRoute(normalizeAppRoute(window.location.pathname))',
);
if (
  appWorkoutHistoryFence >= 0 &&
  appWorkoutHistoryRouteWrite > appWorkoutHistoryFence &&
  appWorkoutHistoryPopState
    .slice(appWorkoutHistoryFence, appWorkoutHistoryRouteWrite)
    .includes('return;')
) {
  pass('T07 saving-time history fence blocks App route reconciliation before its route write');
} else {
  fail('T07 saving-time history fence blocks App route reconciliation before its route write');
}

const appWorkoutBusyCallbackStart = frontendApp.indexOf(
  'const handleWorkoutCompletionBusyChange = useCallback(',
);
const appWorkoutBusyCallbackEnd = frontendApp.indexOf(
  'const navigateActiveTab = useCallback(',
  appWorkoutBusyCallbackStart,
);
const appWorkoutBusyCallback =
  appWorkoutBusyCallbackStart >= 0 && appWorkoutBusyCallbackEnd > appWorkoutBusyCallbackStart
    ? frontendApp.slice(appWorkoutBusyCallbackStart, appWorkoutBusyCallbackEnd)
    : '';
const appWorkoutBusyRefWrite = appWorkoutBusyCallback.indexOf(
  'workoutCompletionBusyRef.current = busy',
);
const appWorkoutBusyStateWrite = appWorkoutBusyCallback.indexOf('setWorkoutCompletionBusy(busy)');
if (appWorkoutBusyRefWrite >= 0 && appWorkoutBusyStateWrite > appWorkoutBusyRefWrite) {
  pass('T07 completion callback closes the popstate race before the React state update');
} else {
  fail('T07 completion callback closes the popstate race before the React state update');
}
expectIncludes(
  frontendApp,
  'onWorkoutCompletionBusyChange={handleWorkoutCompletionBusyChange}',
  'T07 ProgramScreen uses the synchronous App history-fence callback',
);

const programWorkoutHistoryFenceStart = programScreen.indexOf('completionBusyRef.current &&');
const programWorkoutHistoryFenceEnd = programScreen.indexOf(
  '\n\n      if (',
  programWorkoutHistoryFenceStart,
);
const programWorkoutHistoryFence =
  programWorkoutHistoryFenceStart >= 0 &&
  programWorkoutHistoryFenceEnd > programWorkoutHistoryFenceStart
    ? programScreen.slice(programWorkoutHistoryFenceStart, programWorkoutHistoryFenceEnd)
    : '';
for (const historyFenceContract of [
  'window.history.pushState(',
  'kinetraWorkoutVideoId: selectedVideoIdRef.current',
  'kinetraProgramWeek: selectedProgramWeekRef.current',
  'appRoutes.home',
]) {
  expectIncludes(
    programWorkoutHistoryFence,
    historyFenceContract,
    `T07 saving-time workout history fence: ${historyFenceContract}`,
  );
}
if (programWorkoutHistoryFence.includes('window.location.href')) {
  fail('T07 saving-time workout history fence never adopts the popped destination pathname');
} else {
  pass('T07 saving-time workout history fence never adopts the popped destination pathname');
}

const baseLessonsRequiredDialog = await readText(
  'apps/frontend/src/features/base-lessons/BaseLessonsRequiredDialog.tsx',
);
for (const contract of [
  'base-lessons-required-dialog',
  'Пройти базовые уроки',
  'Вернуться к изучению приложения',
]) {
  expectIncludes(
    baseLessonsRequiredDialog,
    contract,
    `exploration preparation dialog contract: ${contract}`,
  );
}

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
  "ONBOARDING_COMPLETE_LABEL = 'Открыть Kinetra'",
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
  ['base_lessons', 'home'],
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
expectIncludes(
  routes,
  'isExplorationAppRoute',
  'exploration route guard includes the app tabs and explicit base-lessons page',
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
  '.training-preparation-card',
  '.base-lessons-required-dialog',
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
for (const [contract, description] of [
  ['T14 two slots expose independent intermediate progress', 'parallel slot progress'],
  ['T14 cancelling one slot leaves the sibling upload active', 'per-slot cancellation'],
  ['T14 sibling slot reaches publication', 'sibling upload completion'],
  ['T14 fatal part failure aborts an active sibling XHR', 'fatal sibling-worker abort'],
  ['fatalRecord.stats.completes, 0', 'no completion after fatal part failure'],
  ['T14 resume rejects a same-size different file', 'resume checksum identity'],
  ['T14 exact-file resume skips the accepted part', 'accepted-part resume'],
  ['T14 actual browser aborts before the first video XHR send', 'pre-aborted XHR'],
  [
    '(await trainer.videoXhrState()).sendCalls, xhrSendCallsBeforeAbort',
    'pre-aborted XHR send fencing',
  ],
  ["await trainer.cdp.send('Page.reload'", 'real reload during verification'],
  [
    'T14 reload restores the processing slot and resumes durable status polling',
    'reload polling recovery',
  ],
  ['X-Amz-Algorithm=AWS4-HMAC-SHA256', 'SigV4-shaped preview capability'],
  [
    'T14 closing preview removes the signed capability from browser-owned state',
    'preview capability cleanup',
  ],
  [
    'T14 logout keeps preview capability and access token out of storage',
    'logout capability cleanup',
  ],
]) {
  expectIncludes(browserTest, contract, `T14 browser acceptance: ${description}`);
}
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
expectIncludes(
  browserTest,
  'KINETRA_ONBOARDING_EXPLORATION_NAVIGATION=PASS',
  'browser test checks free tab navigation before base lessons are complete',
);
expectIncludes(
  browserTest,
  'KINETRA_BASE_LESSONS_OPTIONAL_ROUTE=PASS',
  'browser test checks voluntary entry to and return from base lessons',
);
expectIncludes(
  browserTest,
  'KINETRA_EXPLORATION_CHAT_LOCK=PASS',
  'browser test proves chat remains inaccessible during exploration',
);
expectIncludes(
  browserTest,
  'KINETRA_EXPLORATION_PAYWALL_PRECEDENCE=PASS',
  'browser test proves subscription gating precedes the lesson gate',
);
expectIncludes(
  browserTest,
  'KINETRA_BASE_LESSONS_STANDALONE=PASS',
  'browser test proves the explicit base-lessons route has no app shell',
);
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
  'KINETRA_T07_TODAY_DASHBOARD=PASS',
  'T07 browser scenario proves the focused Today dashboard',
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
const savingWorkoutBackAssertionAnchor = browserTest.indexOf(
  'system Back is held on the single player entry while completion is saving',
);
const savingWorkoutBackAssertionStart = browserTest.lastIndexOf(
  "await cdp.evaluate('window.history.back()')",
  savingWorkoutBackAssertionAnchor,
);
const savingWorkoutBackAssertionEnd = browserTest.indexOf(
  'releaseWorkoutCompletionResponse();',
  savingWorkoutBackAssertionAnchor,
);
const savingWorkoutBackAssertion =
  savingWorkoutBackAssertionAnchor >= 0 &&
  savingWorkoutBackAssertionStart >= 0 &&
  savingWorkoutBackAssertionEnd > savingWorkoutBackAssertionAnchor
    ? browserTest.slice(savingWorkoutBackAssertionStart, savingWorkoutBackAssertionEnd)
    : '';
for (const browserHistoryFenceContract of [
  'system Back is held on the single player entry while completion is saving',
  "exists('workout-player')",
  "attribute('workout-player', 'aria-busy')",
  'window.history.state?.kinetraWorkoutVideoId === ${JSON.stringify(workoutVideoId(1, 1))}',
  "await cdp.evaluate('window.history.forward()')",
  'assert.deepEqual(playerAfterBlockedForward, {',
  'visible: true',
  "busy: 'true'",
  'videoId: workoutVideoId(1, 1)',
  'programWeek: 1',
]) {
  expectIncludes(
    savingWorkoutBackAssertion,
    browserHistoryFenceContract,
    `T07 browser saving-time history assertion remains strict: ${browserHistoryFenceContract}`,
  );
}
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
for (const testScript of ['test:backend', 'test:frontend:unit']) {
  expectIncludes(
    rootPackage.scripts?.[testScript] ?? '',
    'npm run build -w @kinetra/shared',
    `${testScript} builds the ignored shared runtime before a clean test run`,
  );
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
  'base-lessons users can explore metadata but cannot start or complete workouts',
  'program preview remains closed until onboarding reaches base lessons',
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
  "{ kind: 'onboarding_required' }",
  'PostgreSQL test proves the workout mutation is gated before active onboarding',
);
expectIncludes(
  programPostgresTests,
  'KINETRA_T07_POSTGRES_INTEGRATION=PASS',
  'T07 PostgreSQL test emits an execution marker',
);

const mainScreenFrontendTests = await readText('apps/frontend/test/main-screen.test.ts');
for (const scenario of [
  'today dashboard renders only the current and next workout',
  'week progress exposes',
  'today dashboard delegates full week browsing to schedule',
  'today is highlighted only in the actual current week',
  'tab bar renders today and a fifth active chat tab with its unread badge',
  'system back keeps the saving workout on its canonical history entry',
]) {
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
  'readonly onOpenWorkout: (programWeek: number, dayOfWeek: number) => void',
  'onOpenWorkout={onOpenWorkout}',
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
  'readonly onOpenWorkout: (programWeek: number, dayOfWeek: number) => void',
  'onOpenWorkout(week.week_number, selectedDay.day_of_week)',
  'type="button"',
  'Открыть тренировку',
  'onClick={() => onOpen(day)}',
]) {
  expectIncludes(scheduleView, contract, `T08 schedule view contract: ${contract}`);
}
for (const appScheduleContract of [
  'const openScheduledWorkout = useCallback(',
  'kinetraWorkoutDayOfWeek: dayOfWeek',
  'kinetraProgramWeek: programWeek',
  'onOpenWorkout={openScheduledWorkout}',
]) {
  expectIncludes(
    frontendApp,
    appScheduleContract,
    `T08 selected workout routing contract: ${appScheduleContract}`,
  );
}
const scheduledWorkoutHandlerStart = frontendApp.indexOf(
  'const openScheduledWorkout = useCallback(',
);
const scheduledWorkoutHandler = frontendApp.slice(
  scheduledWorkoutHandlerStart,
  frontendApp.indexOf(
    'const handleTrainerVerificationProfileUpdated',
    scheduledWorkoutHandlerStart,
  ),
);
for (const failClosedInputContract of [
  '!Number.isInteger(programWeek)',
  'programWeek < 1',
  'programWeek > 12',
  '!Number.isInteger(dayOfWeek)',
  'dayOfWeek < 1',
  'dayOfWeek > 7',
]) {
  expectIncludes(
    scheduledWorkoutHandler,
    failClosedInputContract,
    `T08 selected workout input gate: ${failClosedInputContract}`,
  );
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
for (const selectedWorkoutBrowserContract of [
  'T08 schedule card opens the exact current-week workout',
  'window.history.state?.kinetraWorkoutVideoId === ${JSON.stringify(workoutVideoId(1, 4))}',
  'window.history.state?.kinetraProgramWeek === 1',
  'window.history.state?.kinetraWorkoutDayOfWeek === undefined',
]) {
  expectIncludes(
    browserTest,
    selectedWorkoutBrowserContract,
    `T08 browser selected-workout contract: ${selectedWorkoutBrowserContract}`,
  );
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
  'prepareAccountDeletion(confirm: string)',
  'requestWithAccessToken(',
  'authenticatedVoidRequest',
  'keepalive: true',
  'this.clearSession()',
]) {
  expectIncludes(frontendApi, apiContract, `T10 frontend API contract: ${apiContract}`);
}

const settingsScreen = await readText('apps/frontend/src/features/settings/SettingsScreen.tsx');
const accountDeletionLifecycle = await readText(
  'apps/frontend/src/features/settings/accountLifecycle.ts',
);
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
  'runAccountDeletionLifecycle(deleteConfirmation',
  'prepareLogout()',
  'onChatSessionSuspend()',
  '.then(() => preparedAttempt.execute())',
  'onChatSessionRestart()',
  'onChatSessionEnd()',
  'onSignedOut()',
  '<SettingsView',
  '<SettingsDialogs',
]) {
  expectIncludes(settingsScreen, screenContract, `T10 settings screen contract: ${screenContract}`);
}

const accountDeletionLifecycleSteps = [
  'const deleteAccount = lifecycle.prepareAccountDeletion(confirmation);',
  'const subscription = await lifecycle.captureBrowserSubscription();',
  'await lifecycle.unsubscribeBrowserSubscription(subscription);',
  'await deleteAccount();',
  'lifecycle.onSignedOut();',
];
for (const lifecycleStep of accountDeletionLifecycleSteps) {
  expectIncludes(
    accountDeletionLifecycle,
    lifecycleStep,
    `T10 account deletion lifecycle: ${lifecycleStep}`,
  );
}
const accountDeletionLifecyclePositions = accountDeletionLifecycleSteps.map((step) =>
  accountDeletionLifecycle.indexOf(step),
);
if (
  accountDeletionLifecyclePositions.every((position) => position >= 0) &&
  accountDeletionLifecyclePositions.every(
    (position, index) => index === 0 || position > accountDeletionLifecyclePositions[index - 1],
  )
) {
  pass(
    'T10 account deletion binds the session, then captures and awaits browser cleanup before delete and navigation',
  );
} else {
  fail(
    'T10 account deletion binds the session, then captures and awaits browser cleanup before delete and navigation',
  );
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
const apiSessionFrontendTests = await readText('apps/frontend/test/api-session.test.ts');
for (const testContract of [
  'prepared account deletion stays bound to the token that confirmed it',
  'prepared account deletion never refreshes or retries with another subject',
  'prepared logout push cleanup stays bound to account A and never refreshes as account B',
]) {
  expectIncludes(
    apiSessionFrontendTests,
    testContract,
    `T13 account deletion session-binding test: ${testContract}`,
  );
}
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
  "'kinetraWorkoutVideoId'",
  "'kinetraWorkoutDayOfWeek'",
  "'kinetraProgramWeek'",
  'delete nextState[key]',
  "window.history.replaceState(nextState, '', window.location.href)",
]) {
  expectIncludes(
    programHistory,
    historyContract,
    `T11 expired entitlement clears only workout history: ${historyContract}`,
  );
}
for (const selectedWorkoutContract of [
  'const programDayFromHistory = (value: unknown): number | null =>',
  'dayOfWeek: programDayFromHistory(dayOfWeek)',
  'const canonicalizeWorkoutHistorySelection = (videoId: string, programWeek: number): void =>',
  'delete nextState.kinetraWorkoutDayOfWeek',
  'nextState.kinetraWorkoutVideoId = videoId',
  'selectedVideoIdRef.current === null && selectedDayOfWeekRef.current !== null',
  'canonicalizeWorkoutHistorySelection(selectedDay.video.id, response.week.week_number)',
  'isProgramWeekLocked(response, currentResponse.week.week_number)',
  'isProgramWeekLocked(response, currentWeekNumber)',
  'Эта тренировка откроется, когда начнётся выбранная неделя.',
]) {
  expectIncludes(
    programScreen,
    selectedWorkoutContract,
    `T08 selected workout history contract: ${selectedWorkoutContract}`,
  );
}
const canonicalSelectionStart = programScreen.indexOf(
  'const canonicalizeWorkoutHistorySelection = (videoId: string, programWeek: number): void =>',
);
const canonicalSelection = programScreen.slice(
  canonicalSelectionStart,
  programScreen.indexOf('const workoutSelectionFromHistory', canonicalSelectionStart),
);
const daySentinelRemoval = canonicalSelection.indexOf('delete nextState.kinetraWorkoutDayOfWeek');
const videoSentinelWrite = canonicalSelection.indexOf('nextState.kinetraWorkoutVideoId = videoId');
const canonicalStateWrite = canonicalSelection.indexOf('window.history.replaceState');
if (
  daySentinelRemoval >= 0 &&
  videoSentinelWrite > daySentinelRemoval &&
  canonicalStateWrite > videoSentinelWrite
) {
  pass('T08 selected workout history is canonicalized from day to exact video before rendering');
} else {
  fail('T08 selected workout history is canonicalized from day to exact video before rendering');
}
for (const lockedWeekExpression of [
  'isProgramWeekLocked(response, currentResponse.week.week_number)',
  'isProgramWeekLocked(response, currentWeekNumber)',
]) {
  const lockedWeekStart = programScreen.indexOf(lockedWeekExpression);
  const lockedWeekGuard = programScreen.slice(lockedWeekStart, lockedWeekStart + 1_800);

  for (const failClosedContract of [
    'clearWorkoutHistorySentinel();',
    'selectedVideoIdRef.current = null',
    'selectedDayOfWeekRef.current = null',
    'selectedProgramWeekRef.current = null',
    'setSelectedVideoId(null)',
    'Эта тренировка откроется, когда начнётся выбранная неделя.',
    'return;',
  ]) {
    expectIncludes(
      lockedWeekGuard,
      failClosedContract,
      `T08 locked-week selection fails closed: ${lockedWeekExpression} -> ${failClosedContract}`,
    );
  }
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
  'inactive entitlement removes every workout sentinel while preserving unrelated history',
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
  'this.programRepository.getWeek(',
  'await mapWithConcurrency(dueUsers, this.sendConcurrency',
  'runFailures.push(error)',
  'throw new AggregateError(',
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
  'public async deletePushSubscription(',
  'options: PushSubscriptionDeleteOptions = {}',
  'public preparePushSubscriptionDeletion()',
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
  'signal?.aborted ?? false',
  'allowRefresh: false',
  'control?.beginSideEffects?.() === false',
  'Promise.race([backendCleanup, waitForAbort(signal)])',
  'const backendCleanup = Promise.resolve()',
  'const browserCleanup = Promise.resolve()',
  'const unsubscribeBrowserSubscription = async',
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
  'preparePushSubscriptionDeletion()',
  'bestEffortUnsubscribeFromPush({',
  'deleteSubscription: preparedDeleteSubscription',
  'PUSH_BEST_EFFORT_TIMEOUT_MS',
  '.then(() => preparedAttempt.execute())',
  'runAccountDeletionLifecycle(deleteConfirmation',
  'prepareAccountDeletion,',
  'captureBrowserSubscription: getExistingPushSubscription',
  'unsubscribeBrowserSubscription,',
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
  'isolates a late-user failure without losing or duplicating other due users',
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
  'a captured browser subscription can be removed after the live lookup loses it',
  'timed-out logout cleanup cannot mutate a later session after delayed service worker resolution',
  'logout waits for a browser unsubscribe that started before the timeout',
  'logout bounds a hung account-A backend after browser unsubscribe completes',
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
  'T13 account deletion retains and awaits the browser subscription before destructive cleanup',
  'KINETRA_T13_SETTINGS_INTEGRATION=PASS',
]) {
  expectIncludes(settingsFrontendTests, testContract, `T13 Settings unit test: ${testContract}`);
}

for (const browserContract of [
  'Page.addScriptToEvaluateOnNewDocument',
  "Object.defineProperty(Notification, 'requestPermission'",
  "Object.defineProperty(PushManager.prototype, 'getSubscription'",
  "Object.defineProperty(PushManager.prototype, 'subscribe'",
  'kinetra.browser-acceptance.push-state.v1',
  'subscriptionExists: state.subscription !== null',
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
  'subscriptionExists: true',
  'unsubscribeCalls: 1',
  'T13 device is unsubscribed after account deletion',
  'T13 device is registered before logout cleanup',
  'KINETRA_T13_BROWSER_E2E=PASS',
]) {
  expectIncludes(browserTest, browserContract, `T13 browser acceptance: ${browserContract}`);
}
expectIncludes(
  browserTest,
  "assert.equal(await cdp.evaluate('window.__kinetraPushTest.unsubscribeCalls'), 2)",
  'T13 browser acceptance retains the strict account-deletion unsubscribe assertion',
);
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
for (const [validationCheck, allowedStatuses] of [
  ['T13 base exact-head GitHub CI', ['PASS']],
  ['Structural contracts T01–T13 + T12', ['NOT RUN', 'PASS']],
  ['TypeScript production + backend tests', ['NOT RUN', 'PASS']],
  ['ESLint', ['NOT RUN', 'PASS']],
  ['Backend unit/API tests', ['NOT RUN', 'PASS']],
  ['Real Socket.IO authorization/delivery', ['NOT RUN', 'PASS']],
  ['Real ImageMagick photo security', ['NOT RUN', 'PASS']],
  ['PostgreSQL 17 migration/concurrency', ['CI REQUIRED']],
  ['Frontend unit/API/Service Worker tests', ['NOT RUN', 'PASS']],
  ['Chrome client+trainer browser acceptance', ['CI REQUIRED']],
  ['Production build', ['NOT RUN', 'PASS']],
  ['Changed-file Prettier', ['NOT RUN', 'PASS']],
  ['Tracked source manifest', ['NOT RUN', 'PASS']],
  ['Composite quality gate', ['CI REQUIRED']],
]) {
  const escapedValidationCheck = validationCheck.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const allowedStatusPattern = allowedStatuses.join('|');
  expectMatches(
    validationReport,
    new RegExp(`\\| ${escapedValidationCheck}\\s+\\| (?:${allowedStatusPattern})\\s+\\|`, 'u'),
    `T12 validation records an honest status: ${validationCheck}`,
  );
}
for (const correctionValidationContract of [
  'Correction branch:** `fix/t12-merge-readiness`',
  'Correction PR base:** `feature/t12-trainer-chat`',
  'Closure matrix F1–F7',
  'F1 / K13-RT-002',
  'F2 / K13-RT-001',
  'F3 / K13-BECORE-001',
  'F4 / K13-BECORE-002',
  'F5 / K13-FECHAT-001',
  'F6 / W3-CHAT-001',
  'F7 / KPR13-MEDIA-001',
  'dynamic SHA/run/attempt evidence',
  'GitHub Check Run/job summary',
  'mutable Draft correction PR',
  'Merge-ref run нельзя называть exact-head run',
  'KINETRA_T12_MULTIPART_TIMEOUT=PASS',
]) {
  expectIncludes(
    validationReport,
    correctionValidationContract,
    `T12 correction validation policy: ${correctionValidationContract}`,
  );
}
if (/https?:\/\/[^\s)]*actions\/runs/iu.test(validationReport)) {
  fail('T12 tracked validation does not embed a self-referential final Actions run URL');
} else {
  pass('T12 tracked validation does not embed a self-referential final Actions run URL');
}

// T12 — durable client/trainer chat, authenticated realtime and private photo lifecycle.
const chatMigration = await readText('apps/backend/migrations/011_trainer_chat.sql');
for (const table of [
  'trainer_profiles',
  'chat_conversations',
  'chat_photos',
  'chat_messages',
  'chat_media_deletion_jobs',
]) {
  expectMatches(
    chatMigration,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'u'),
    `T12 append-only migration creates ${table}`,
  );
}
for (const migrationContract of [
  'trainer_profiles_one_active_default_idx',
  'client_user_id uuid NOT NULL UNIQUE',
  'next_sequence bigint NOT NULL DEFAULT 1',
  'chat_messages_conversation_sequence_unique',
  'chat_messages_sender_idempotency_unique',
  'request_fingerprint char(64) NOT NULL',
  "sender_role IN ('client', 'trainer')",
  "kind IN ('text', 'photo')",
  "body !~ U&'[\\0001-\\0008\\000B-\\001F\\007F]'",
  'chat_photos_owner_upload_unique',
  "mime_type = 'image/webp'",
  'chat_media_deletion_jobs_pending_idx',
  'CREATE OR REPLACE FUNCTION enqueue_chat_photo_deletion()',
  'CREATE TRIGGER chat_photos_enqueue_deletion',
  'ON CONFLICT (object_key) DO NOTHING',
]) {
  expectIncludes(chatMigration, migrationContract, `T12 migration contract: ${migrationContract}`);
}
if (chatMigration.includes('[[:cntrl:]]')) {
  fail('T12 database text constraint does not broaden the shared C0/DEL policy');
} else {
  pass('T12 database text constraint does not broaden the shared C0/DEL policy');
}

const chatSchema = await readText('apps/backend/src/chat/schema.ts');
for (const schemaContract of [
  "z.discriminatedUnion('kind'",
  '.strict()',
  'before_sequence',
  'after_sequence',
  'through_sequence',
  'canonicalizeChatTextValue',
  'unsupported control characters',
]) {
  expectIncludes(chatSchema, schemaContract, `T12 strict/canonical schema: ${schemaContract}`);
}
if (/\b(?:user_id|trainer_id|sender_role|room)\s*:/u.test(chatSchema)) {
  fail('T12 public request schemas never accept identity, role or room authority');
} else {
  pass('T12 public request schemas never accept identity, role or room authority');
}

const chatRouter = await readText('apps/backend/src/chat/router.ts');
for (const [method, route] of [
  ['get', '/session'],
  ['post', '/conversations'],
  ['get', '/conversations'],
  ['get', '/conversations/:conversationId'],
  ['get', '/conversations/:conversationId/messages'],
  ['post', '/conversations/:conversationId/messages'],
  ['put', '/conversations/:conversationId/read'],
  ['post', '/conversations/:conversationId/photos'],
  ['get', '/photos/:photoId/status'],
  ['get', '/photos/:photoId/access'],
]) {
  expectMatches(
    chatRouter,
    new RegExp(
      `router\\.${method}\\(\\s*['"]${route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`,
      'u',
    ),
    `T12 REST route: ${method.toUpperCase()} ${route}`,
  );
}
for (const routerContract of [
  'router.use(authMiddleware)',
  "'Cache-Control', 'no-store'",
  "'Pragma', 'no-cache'",
  'requireAuthenticatedPrincipal(request)',
  'parseStrictly(emptyObjectSchema, request.query)',
  "request.get('idempotency-key')",
  "response.setHeader('Retry-After', '2')",
  'const admission = await service.preflightPhotoUpload(context)',
  'service.accountPhotoUploadBytes(admission, bytes)',
  'upload.bytes,\n        admission',
]) {
  expectIncludes(
    chatRouter,
    routerContract,
    `T12 authenticated/no-store router: ${routerContract}`,
  );
}

const chatService = await readText('apps/backend/src/chat/service.ts');
const chatPostgresRepository = await readText('apps/backend/src/chat/postgres-chat.repository.ts');
const chatEventHub = await readText('apps/backend/src/chat/event-hub.ts');
for (const serviceContract of [
  'isSessionActive(context.userId, context.sessionId',
  'canonicalizeChatText(input.text, 2000, false)',
  'canonicalizeChatText(input.text, 1000, true)',
  'messageFingerprint(',
  "result.kind === 'idempotency_conflict'",
  "kind: 'message_created'",
  "kind: 'read_updated'",
  'this.eventPublisher.publish(event)',
  'this.mediaUrlTtlSeconds',
  'CHAT_RESOURCE_NOT_FOUND',
  'public async getConversationSummary(',
  'this.repository.findTrainerConversation(',
  'class PhotoUploadAdmission',
  'public accountPhotoUploadBytes(admission: PhotoUploadAdmission, bytes: number)',
  'admission.streamedBytes = streamedBytes',
  'this.consumePhotoByteLimit(admission.userId, bytes)',
  'admission.streamedBytes < input.length',
  'admission.claimedByUpload = true',
]) {
  expectIncludes(chatService, serviceContract, `T12 service contract: ${serviceContract}`);
}
if (/premium|subscription|entitlement/iu.test(chatService)) {
  fail('T12 active client chat has no Premium/subscription gate');
} else {
  pass('T12 active client chat has no Premium/subscription gate');
}
for (const repositoryContract of [
  "await client.query('BEGIN')",
  "await client.query('COMMIT')",
  'FOR UPDATE',
  'FOR UPDATE SKIP LOCKED',
  'client_message_id',
  'request_fingerprint',
  'next_sequence',
  'client_unread_count',
  'trainer_unread_count',
  'findTrainerConversation(',
  'markRead(',
  'grantTrainer(',
  'reassignTrainer(',
  'revokeTrainer(',
]) {
  expectIncludes(
    chatPostgresRepository,
    repositoryContract,
    `T12 transactional PostgreSQL repository: ${repositoryContract}`,
  );
}
for (const photoIdempotencyLockContract of [
  'await this.lockPhotoIdempotency(client, input.uploaderUserId, input.clientUploadId)',
  'private async lockPhotoIdempotency(',
  'SELECT pg_advisory_xact_lock(',
  "'kinetra:chat:photo-idempotency:v1:' || $1::uuid::text || ':' || $2::uuid::text",
  '[uploaderUserId, clientUploadId]',
]) {
  expectIncludes(
    chatPostgresRepository,
    photoIdempotencyLockContract,
    `T12 global uploader/upload-key serialization: ${photoIdempotencyLockContract}`,
  );
}
expectIncludes(chatEventHub, 'publish(event:', 'T12 commit-after-persist event publisher exists');

const chatRuntime = await readText('apps/backend/src/chat/runtime.ts');
const backendServer = await readText('apps/backend/src/server.ts');
const backendSocketServer = await readText('apps/backend/src/realtime/socket.ts');
const chatRealtime = await readText('apps/backend/src/chat/realtime.ts');
const chatClientIp = await readText('apps/backend/src/chat/client-ip.ts');
for (const appContract of ['ChatRuntime', 'chatRuntime', 'createChatRouter', "'/api/v1/chat'"]) {
  expectIncludes(backendApp, appContract, `T12 Express composition: ${appContract}`);
}
for (const compositionContract of [
  'createProductionAuthRuntime',
  'createProductionChatRuntime',
  'authRuntime.accessTokenVerifier',
  'chatRuntime',
  'attachChatRealtime',
]) {
  expectIncludes(
    backendServer,
    compositionContract,
    `T12 shared REST/Socket composition root: ${compositionContract}`,
  );
}
for (const runtimeContract of [
  'PostgresChatRepository',
  'ImageMagickChatImageProcessor',
  'S3ChatMediaStore',
  'ChatMediaCleanupService',
  'photoUploadsEnabled',
  'mediaUrlTtlSeconds',
]) {
  expectIncludes(
    chatRuntime,
    runtimeContract,
    `T12 injectable production runtime: ${runtimeContract}`,
  );
}
const socketComposition = `${backendSocketServer}\n${chatRealtime}`;
expectMatches(
  socketComposition,
  /maxHttpBufferSize\s*:\s*32\s*\*\s*1024/u,
  'T12 Socket.IO payload cap is 32 KiB',
);
expectMatches(
  socketComposition,
  /transports\s*:\s*\[\s*['"]websocket['"]\s*\]/u,
  'T12 Socket.IO server accepts WebSocket transport only',
);
for (const realtimeContract of [
  "socketServer.of('/chat')",
  "entries[0]?.[0] !== 'accessToken'",
  "Object.hasOwn(socket.handshake.query, 'accessToken')",
  'socket.handshake.headers.origin',
  'allowedOrigins.includes(origin)',
  'getSocketActor(claims.sub, claims.sid)',
  '`account:${userId}`',
  "'chat:sync'",
  "'chat:message:new'",
  "'chat:conversation:updated'",
  "'chat:read:updated'",
  "'chat:session:invalidated'",
  "invalidateSocket(socket, 'token_expired')",
  'accessTokenExpired(identity.claims)',
  'socket.disconnect(true)',
]) {
  expectIncludes(
    chatRealtime,
    realtimeContract,
    `T12 Socket authorization/fan-out: ${realtimeContract}`,
  );
}
expectIncludes(
  chatRealtime,
  'identity.claims.exp * 1000 - Date.now()',
  'T12 realtime socket expires at the exact JWT exp boundary',
);
if (/claims\.exp\s*\*\s*1_?000\s*\+/u.test(chatRealtime)) {
  fail('T12 realtime socket has no post-expiry delivery grace period');
} else {
  pass('T12 realtime socket has no post-expiry delivery grace period');
}
for (const clientIpContract of [
  "import { isIP } from 'node:net'",
  'MAX_FORWARDED_HEADER_LENGTH = 2_048',
  'MAX_FORWARDED_ADDRESSES = 64',
  "typeof input.xForwardedFor !== 'string'",
  'forwarded.length < trustedProxyHops',
  'forwarded.some((entry) => entry === null)',
  'forwarded[forwarded.length - trustedProxyHops]',
]) {
  expectIncludes(
    chatClientIp,
    clientIpContract,
    `T12 exact trusted-proxy client-IP resolver: ${clientIpContract}`,
  );
}
for (const trustedIpCompositionContract of [
  'request.socket.remoteAddress',
  "request.headers['x-forwarded-for']",
  'trustedProxyHops: options.trustedProxyHops ?? env.trustProxyHops',
  'createChatRouter(chatRuntime)',
  'socket.conn.remoteAddress',
  'trustedProxyHops: chatRuntime.trustedProxyHops',
]) {
  expectIncludes(
    `${chatRouter}\n${chatRuntime}\n${backendApp}\n${backendServer}\n${backendSocketServer}\n${chatRealtime}`,
    trustedIpCompositionContract,
    `T12 REST/Socket client-IP composition: ${trustedIpCompositionContract}`,
  );
}

const chatEnvExample = await readText('.env.example');
const environmentTests = await readText('apps/backend/test/env.test.ts');
for (const corsContract of [
  'parseCorsOrigins',
  "!['http:', 'https:'].includes(parsed.protocol)",
  "parsed.pathname !== '/'",
  'parsed.username.length > 0',
  "nodeEnvironment === 'production'",
  "parsed.protocol !== 'https:'",
  'return Object.freeze([...new Set(normalized)])',
]) {
  expectIncludes(
    backendEnvironment,
    corsContract,
    `T12 exact CORS/Socket origin configuration: ${corsContract}`,
  );
}
for (const corsTestContract of [
  'normalizes and deduplicates exact HTTP(S) origins',
  'rejects wildcards, credentials and non-origin URL components',
  'production CORS allowlist requires HTTPS',
]) {
  expectIncludes(
    environmentTests,
    corsTestContract,
    `T12 executable origin configuration test: ${corsTestContract}`,
  );
}
for (const environmentContract of [
  'VITE_API_URL=',
  'VITE_PRIVATE_MEDIA_ORIGIN=',
  'CHAT_ENABLED=false',
  'CHAT_PHOTO_UPLOADS_ENABLED=false',
  'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS=15',
  'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS=120',
  'CHAT_MEDIA_URL_TTL_SECONDS=300',
]) {
  expectMatches(
    chatEnvExample,
    new RegExp(`^${environmentContract}$`, 'mu'),
    `T12 safe environment default: ${environmentContract}`,
  );
}
for (const environmentContract of [
  "parseBoolean('CHAT_ENABLED'",
  "'CHAT_PHOTO_UPLOADS_ENABLED'",
  "'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS'",
  "'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS'",
  'idleSeconds >= totalSeconds',
  'if (chatPhotoUploadsEnabled && !chatEnabled)',
  'if (chatPhotoUploadsEnabled && s3 === null)',
  "'CHAT_MEDIA_URL_TTL_SECONDS'",
  '300,\n      60,\n      900',
]) {
  expectIncludes(
    backendEnvironment,
    environmentContract,
    `T12 fail-closed environment contract: ${environmentContract}`,
  );
}

const chatMedia = await readText('apps/backend/src/chat/media.ts');
for (const mediaContract of [
  'CHAT_PHOTO_INPUT_MAX_BYTES = 10 * 1024 * 1024',
  'CHAT_PHOTO_OUTPUT_MAX_BYTES = 4 * 1024 * 1024',
  'CHAT_PHOTO_MAX_PIXELS = 20_000_000',
  'CHAT_PHOTO_MAX_SIDE = 8192',
  'CHAT_PHOTO_NORMALIZED_MAX_SIDE = 2048',
  'CHAT_PHOTO_WEBP_QUALITY = 82',
  'CHAT_IMAGE_MAX_CONCURRENCY = 2',
  'CHAT_IMAGE_MAX_QUEUE_LENGTH = 8',
  'spawn(command, arguments_',
  "'identify'",
  "'convert'",
  "'-auto-orient'",
  "'-strip'",
  "'-quality'",
  'String(CHAT_PHOTO_WEBP_QUALITY)',
  "'webp:-'",
  'maximumConcurrency = CHAT_IMAGE_MAX_CONCURRENCY',
  'maximumQueueLength = CHAT_IMAGE_MAX_QUEUE_LENGTH',
  "child.kill('SIGKILL')",
  "'-limit'",
  'accountStreamedBytes: (bytes: number) => void',
  'accountStreamedBytes(chunk.length)',
]) {
  expectIncludes(chatMedia, mediaContract, `T12 bounded real image decoder: ${mediaContract}`);
}
if (/shell\s*:\s*true/u.test(chatMedia)) {
  fail('T12 ImageMagick subprocess never invokes a shell');
} else {
  pass('T12 ImageMagick subprocess never invokes a shell');
}

const chatMediaStore = await readText('apps/backend/src/chat/s3-chat-media.store.ts');
for (const storageContract of [
  'PutObjectCommand',
  'GetObjectCommand',
  'DeleteObjectCommand',
  "ContentType: 'image/webp'",
  "CacheControl: 'private, no-store'",
  "ResponseCacheControl: 'private, no-store'",
  "ServerSideEncryption: 'AES256'",
  'getSignedUrl(',
]) {
  expectIncludes(chatMediaStore, storageContract, `T12 private S3 adapter: ${storageContract}`);
}
if (/\bACL\s*:|public-read/iu.test(chatMediaStore)) {
  fail('T12 photo storage never grants public ACL access');
} else {
  pass('T12 photo storage never grants public ACL access');
}

const chatCleanup = await readText('apps/backend/src/chat/cleanup-service.ts');
const chatCleanupRunner = await readText('apps/backend/src/chat/run-media-cleanup.ts');
for (const cleanupContract of [
  'deleteObject(job.objectKey)',
  'completeMediaDeletion',
  'retryMediaDeletion',
]) {
  expectIncludes(chatCleanup, cleanupContract, `T12 durable media cleanup: ${cleanupContract}`);
}
expectIncludes(
  chatCleanupRunner,
  'summary.deletionsFailed > 0',
  'T12 cleanup worker exits non-zero when physical deletion fails',
);
expectIncludes(
  chatCleanupRunner,
  'process.exitCode = 1',
  'T12 cleanup worker exposes failure to the scheduler',
);

const trainerCli = await readText('apps/backend/src/chat/trainer-cli.ts');
for (const cliContract of [
  "command === 'grant'",
  "['--user-id', '--display-name']",
  "['--default']",
  "command === 'reassign'",
  "['--from-user-id', '--to-user-id', '--conversation-id']",
  "['--all']",
  'Provide exactly one of --all or repeated --conversation-id.',
  "command === 'revoke'",
  "['--user-id']",
  'between 1 and 120 characters',
]) {
  expectIncludes(trainerCli, cliContract, `T12 operator CLI contract: ${cliContract}`);
}

for (const sharedChatContract of [
  "export type AccountRole = 'client' | 'trainer'",
  'readonly account_role: AccountRole',
  'readonly trainer_profile: TrainerProfile | null',
  'export type ChatSessionResponse',
  'export interface ChatMessageDto',
  'export interface ChatConversationStateDto',
  'export interface ChatConversationSummaryResponse',
  "'chat:message:new'",
  "'chat:conversation:updated'",
  "'chat:read:updated'",
  "'chat:session:invalidated'",
  "'chat:sync'",
]) {
  expectIncludes(
    sharedContracts,
    sharedChatContract,
    `T12 shared DTO/event contract: ${sharedChatContract}`,
  );
}
if (
  /object_key|storage_key/iu.test(
    sharedContracts.slice(sharedContracts.indexOf('export type ChatRole')),
  )
) {
  fail('T12 shared chat DTOs never expose private object keys');
} else {
  pass('T12 shared chat DTOs never expose private object keys');
}

for (const routeContract of [
  "chat: '/chat'",
  "trainerChats: '/trainer/chats'",
  '/^\\/trainer\\/chats\\/([^/]+)$/u',
  'trainerConversationIdFromRoute',
  'isTrainerRoute',
]) {
  expectIncludes(routes, routeContract, `T12 frontend route contract: ${routeContract}`);
}
for (const apiContract of [
  "'/api/v1/chat/session'",
  "'/api/v1/chat/conversations'",
  'getChatConversationSummary(',
  '/api/v1/chat/conversations/${encodeURIComponent(conversationId)}`',
  '/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages',
  '/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/read',
  '/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/photos',
  '/api/v1/chat/photos/${encodeURIComponent(photoId)}/status',
  '/api/v1/chat/photos/${encodeURIComponent(photoId)}/access',
]) {
  expectIncludes(frontendApi, apiContract, `T12 frontend REST client: ${apiContract}`);
}
for (const appContract of [
  'useChatRuntime',
  'ClientChatScreen',
  'TrainerChatsScreen',
  'isTrainerRoute',
  'trainerConversationIdFromRoute',
  'profile.account_role',
  'onChatSessionEnd',
]) {
  expectIncludes(frontendApp, appContract, `T12 client/trainer app integration: ${appContract}`);
}
for (const appChatTabContract of [
  "showChat={profile.user.onboardingStatus === 'active'}",
  'chatUnreadCount={chatRuntime.unreadCount}',
  'route === appRoutes.chat',
  'return withActiveNavigation(',
]) {
  expectIncludes(
    frontendApp,
    appChatTabContract,
    `T12 client chat tab integration: ${appChatTabContract}`,
  );
}
const clientChatRouteStart = frontendApp.indexOf('if (route === appRoutes.chat)');
const clientChatRoute = frontendApp.slice(
  clientChatRouteStart,
  frontendApp.indexOf('const activeContent =', clientChatRouteStart),
);
for (const chatRouteShellContract of ['return withActiveNavigation(', '<ClientChatScreen']) {
  expectIncludes(
    clientChatRoute,
    chatRouteShellContract,
    `T12 dedicated Chat tab retains active navigation: ${chatRouteShellContract}`,
  );
}
if (frontendApp.includes('ChatFloatingButton')) {
  fail('T12 App exposes client chat through the dedicated tab, not a floating button');
} else {
  pass('T12 App exposes client chat through the dedicated tab, not a floating button');
}

const frontendChatSources = (
  await Promise.all(
    [
      'apps/frontend/src/features/chat/ChatComposer.tsx',
      'apps/frontend/src/features/chat/ChatFloatingButton.tsx',
      'apps/frontend/src/features/chat/ChatPhotoThumbnail.tsx',
      'apps/frontend/src/features/chat/ClientChatScreen.tsx',
      'apps/frontend/src/features/chat/ConversationView.tsx',
      'apps/frontend/src/features/chat/MessageList.tsx',
      'apps/frontend/src/features/chat/PhotoViewer.tsx',
      'apps/frontend/src/features/chat/authError.ts',
      'apps/frontend/src/features/chat/composerAcknowledgement.ts',
      'apps/frontend/src/features/chat/draft.ts',
      'apps/frontend/src/features/chat/model.ts',
      'apps/frontend/src/features/chat/photoAccessLifecycle.ts',
      'apps/frontend/src/features/chat/photoUploadFailure.ts',
      'apps/frontend/src/features/chat/readAcknowledgementLifecycle.ts',
      'apps/frontend/src/features/chat/runtime.ts',
      'apps/frontend/src/features/chat/sessionRequestGate.ts',
      'apps/frontend/src/features/chat/types.ts',
      'apps/frontend/src/features/chat/usePhotoAccessLifecycle.ts',
      'apps/frontend/src/features/trainer-chat/TrainerChatsScreen.tsx',
      'apps/frontend/src/features/trainer-chat/selectedConversation.ts',
    ].map(readOptionalText),
  )
).join('\n');
for (const canonicalTextContract of [
  'canonicalizeChatTextValue',
  'chatBoundaryWhitespacePattern',
  'isForbiddenChatControl',
  'hasForbiddenControl: codePoints.some(isForbiddenChatControl)',
]) {
  expectIncludes(
    sharedContracts,
    canonicalTextContract,
    `T12 shared canonical text algorithm: ${canonicalTextContract}`,
  );
}
expectIncludes(
  chatSchema,
  "import { canonicalizeChatTextValue } from '@kinetra/shared'",
  'T12 backend uses the shared canonical text algorithm',
);
expectIncludes(
  frontendChatSources,
  "import { canonicalizeChatTextValue } from '@kinetra/shared'",
  'T12 frontend uses the shared canonical text algorithm',
);
expectIncludes(frontendChatSources, 'window.sessionStorage', 'T12 draft storage is session-scoped');
expectIncludes(
  frontendChatSources,
  'clearAccountChatDrafts',
  'T12 draft is cleared on account lifecycle changes',
);
for (const frontendLifecycleContract of [
  'class ChatSessionRequestGate',
  'isTerminalChatAuthError',
  'this.controller?.abort()',
  'this.version += 1',
  'shouldClearAcknowledgedComposerDraft',
  'pendingRequestRef.current = null',
  'CHAT_PHOTO_ACCESS_MAX_IMAGE_ERROR_RENEWALS = 1',
  "this.request('expiry')",
  'handleImageError',
  'usePhotoAccessLifecycle',
  'class ChatReadAcknowledgementLifecycle',
  'CHAT_READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]',
  'pendingSequence = Math.max',
  'retryNow()',
]) {
  expectIncludes(
    frontendChatSources,
    frontendLifecycleContract,
    `T12 fenced frontend chat lifecycle: ${frontendLifecycleContract}`,
  );
}
for (const trainerIdentityLifecycleContract of [
  'class TrainerSelectedConversationStore',
  'recoverAuthorizedTrainerConversationSummary',
  'api.getConversationSummary',
  'signal.throwIfAborted()',
  "selectedState.kind === 'ready'",
  'data-testid="trainer-chat-detail-resolving"',
  'data-testid="trainer-chat-detail-unavailable"',
]) {
  expectIncludes(
    frontendChatSources,
    trainerIdentityLifecycleContract,
    `T12 selected trainer identity lifecycle: ${trainerIdentityLifecycleContract}`,
  );
}
if (/TRAINER_SELECTED_CONVERSATION_MAX_RECOVERY_PAGES|pageNumber\s*</u.test(frontendChatSources)) {
  fail('T12 exact trainer deep-link identity lookup has no client-side inbox pagination cap');
} else {
  pass('T12 exact trainer deep-link identity lookup has no client-side inbox pagination cap');
}
for (const frontendPhotoFailureContract of [
  'readonly failure_code?: string',
  'readonly retry_allowed?: boolean',
  'chatPhotoFailurePresentation',
  'canRetryChatPhotoUpload',
  'photo.retry_allowed === true',
  'ChatPhotoRetryButton',
  "error.code === 'CHAT_PHOTO_RETRY_EXHAUSTED'",
  'canAttemptChatComposerPhotoUpload',
  'class ChatComposerPhotoUploadAttemptGate',
  'private readonly exhaustedKeys = new Set<string>()',
  'uploadAttemptGateRef.current.beginAttempt',
]) {
  expectIncludes(
    frontendChatSources,
    frontendPhotoFailureContract,
    `T12 fail-closed photo retry presentation: ${frontendPhotoFailureContract}`,
  );
}
expectIncludes(
  frontendChatSources,
  'URL.revokeObjectURL',
  'T12 frontend revokes local photo object URLs',
);
if (
  /dangerouslySetInnerHTML|\.innerHTML\s*=|\blocalStorage\b|\bindexedDB\b|\bcaches\./u.test(
    frontendChatSources,
  )
) {
  fail('T12 chat content avoids HTML injection and persistent browser storage/cache APIs');
} else {
  pass('T12 chat content avoids HTML injection and persistent browser storage/cache APIs');
}

const frontendChatSocket = await readText('apps/frontend/src/realtime/socket.ts');
for (const socketClientContract of [
  'io(`${this.options.url ?? apiBaseUrl}/chat`',
  "transports: ['websocket']",
  'auth: { accessToken }',
  "'chat:sync'",
  "'chat:message:new'",
  "'chat:conversation:updated'",
  "'chat:read:updated'",
  "'chat:session:invalidated'",
  'classifyChatTokenFailure',
  'scheduleTokenRetry',
  'clearTokenRetryTimer',
]) {
  expectIncludes(
    frontendChatSocket,
    socketClientContract,
    `T12 in-memory WebSocket client contract: ${socketClientContract}`,
  );
}
if (/query\s*:\s*\{[^}]*accessToken/su.test(frontendChatSocket)) {
  fail('T12 frontend never sends the access token in the Socket.IO query string');
} else {
  pass('T12 frontend never sends the access token in the Socket.IO query string');
}
const frontendViteConfig = await readText('apps/frontend/vite.config.ts');
for (const cspContract of [
  'VITE_API_URL',
  'normalizeApiOrigin',
  'VITE_PRIVATE_MEDIA_ORIGIN',
  'normalizePrivateMediaOrigin',
  'buildNormalizedFrontendEnv',
  'define: buildNormalizedFrontendEnv(apiOrigin, privateMediaOrigin)',
  'buildImageContentSecurityPolicy',
  "img-src 'self' blob:",
  'allowInsecureLoopback',
  "(command === 'serve' && mode === 'development') || mode === 'browser-test'",
  'VITE_PRIVATE_MEDIA_ORIGIN must use HTTPS except for an explicit local loopback build.',
  'VITE_API_URL must use HTTPS except for an explicit local loopback build.',
  "'http-equiv': 'Content-Security-Policy'",
  "'Referrer-Policy': 'no-referrer'",
  "'X-Content-Type-Options': 'nosniff'",
]) {
  expectIncludes(frontendViteConfig, cspContract, `T12 frontend CSP contract: ${cspContract}`);
}
for (const frontendApiOriginContract of [
  'export const resolveApiBaseUrl',
  'normalized === undefined || normalized.length === 0 ? fallbackUrl : normalized',
  'apiBaseUrl = resolveApiBaseUrl(configuredApiUrl, defaultApiUrl)',
]) {
  expectIncludes(
    frontendApi,
    frontendApiOriginContract,
    `T12 normalized REST/Socket API origin: ${frontendApiOriginContract}`,
  );
}
for (const authSubjectContract of [
  'private logoutAccessToken: string | null = null',
  'private authSubjectId: string | null = null',
  'private terminalSubjectMismatch = false',
  'this.authSubjectId = session.user.id',
  'this.logoutAccessToken = session.accessToken',
  'this.authSubjectId !== null && this.authSubjectId !== session.user.id',
  'this.terminalSubjectMismatchError()',
  "error.code === 'AUTH_SESSION_CHANGED' &&",
  "error.kind === 'auth'",
  "'AUTH_COORDINATION_UNAVAILABLE'",
  'navigator.locks.request(',
]) {
  expectIncludes(
    frontendApi,
    authSubjectContract,
    `T12 subject-bound in-memory authentication: ${authSubjectContract}`,
  );
}
expectIncludes(
  frontendApi,
  'Authorization: `Bearer ${accessToken}`',
  'T12 frontend binds logout revocation to the captured in-memory subject',
);
const frontendLogoutPreparation = frontendApi.slice(
  frontendApi.indexOf('public prepareLogout(): PreparedLogoutAttempt'),
  frontendApi.indexOf('public async fetchMe('),
);
expectIncludes(
  frontendLogoutPreparation,
  'const accessToken = this.logoutAccessToken',
  'T12 logout captures the current bearer before local invalidation',
);
if (frontendLogoutPreparation.includes('requestRefreshSession')) {
  fail('T12 logout never rotates the origin-wide refresh cookie');
} else {
  pass('T12 logout never rotates the origin-wide refresh cookie');
}
expectIncludes(
  browserTest,
  "[viteCli, 'build', '--mode', 'browser-test']",
  'T12 browser acceptance uses the explicit loopback-only frontend build mode',
);
expectIncludes(
  browserTest,
  "typeof navigator.locks?.request === 'function'",
  'T12 browser acceptance proves origin-wide auth mutation locking',
);
for (const styleContract of ['.chat-fab', '.chat-conversation', '.trainer-inbox']) {
  expectIncludes(frontendStyles, styleContract, `T12 frontend styles: ${styleContract}`);
}
expectMatches(
  frontendStyles,
  /@media\s*\((?:min-width:\s*960px|max-width:\s*959px)\)/u,
  'T12 trainer inbox switches to split-pane at 960 px',
);

const accountDeletionRepository = await readText(
  'apps/backend/src/settings/postgres-settings.repository.ts',
);
const deletionTransactionOrder = [
  accountDeletionRepository.indexOf("await client.query('BEGIN')"),
  accountDeletionRepository.indexOf('INSERT INTO chat_media_deletion_jobs'),
  accountDeletionRepository.indexOf('DELETE FROM users WHERE id = $1 RETURNING id'),
  accountDeletionRepository.lastIndexOf("await client.query('COMMIT')"),
];
if (
  deletionTransactionOrder.every((position) => position >= 0) &&
  deletionTransactionOrder.every(
    (position, index) => index === 0 || position > deletionTransactionOrder[index - 1],
  )
) {
  pass('T12 account deletion queues media before the user cascade in one transaction');
} else {
  fail('T12 account deletion queues media before the user cascade in one transaction');
}
expectIncludes(
  settingsService,
  'TRAINER_ACCOUNT_MANAGED',
  'T12 assigned trainer account deletion is operator-managed',
);
for (const deletionRecoveryContract of [
  'lifecycle.onChatSessionSuspend?.()',
  'lifecycle.onChatSessionRestart?.()',
  'lifecycle.onChatSessionEnd?.()',
]) {
  expectIncludes(
    accountDeletionLifecycle,
    deletionRecoveryContract,
    `T12 recoverable account-deletion chat lifecycle: ${deletionRecoveryContract}`,
  );
}
for (const runtimeRecoveryContract of [
  'const suspendNow',
  'const restartNow',
  'realtime.subscribe(handleRealtimeEvent)',
  'loadSession(true)',
]) {
  expectIncludes(
    frontendChatSources,
    runtimeRecoveryContract,
    `T12 full chat runtime restart after failed deletion: ${runtimeRecoveryContract}`,
  );
}
expectIncludes(
  settingsFrontendTests,
  'failed account deletion preserves auth and restarts chat after every suspended failure',
  'T12 failed account deletion preserves drafts and resumes realtime chat',
);
expectIncludes(
  frontendApp,
  'preparePushSubscriptionDeletion',
  'T12 preserves the T13 captured-token deletion lifecycle',
);

expectIncludes(
  serviceWorker,
  "const PUSH_NOTIFICATION_TYPES = new Set(['workout_reminder', 'weekly_survey_reminder'])",
  'T12 preserves the exact T13 push notification taxonomy',
);
expectIncludes(
  serviceWorker,
  "const PUSH_DEEP_LINKS = new Set(['/schedule', '/progress'])",
  'T12 preserves the exact T13 push deep-link allowlist',
);
expectIncludes(
  serviceWorker,
  "url.pathname.startsWith('/api/v1/chat')",
  'T12 Service Worker explicitly bypasses private chat resources',
);
if (/chat_message|chat-message/iu.test(serviceWorker)) {
  fail('T12 does not add chat push notifications');
} else {
  pass('T12 does not add chat push notifications');
}

const chatDocumentation = await readText('docs/T12_TRAINER_CHAT.md');
for (const documentationContract of [
  'GET   | `/api/v1/chat/session`',
  'POST  | `/api/v1/chat/conversations`',
  'GET   | `/api/v1/chat/conversations/:id`',
  'GET   | `/api/v1/chat/conversations/:id/messages`',
  'POST  | `/api/v1/chat/conversations/:id/messages`',
  'PUT   | `/api/v1/chat/conversations/:id/read`',
  'POST  | `/api/v1/chat/conversations/:id/photos`',
  'GET   | `/api/v1/chat/photos/:photoId/status`',
  'GET   | `/api/v1/chat/photos/:photoId/access`',
  'namespace `/chat`',
  '`chat:message:new`',
  '`chat:conversation:updated`',
  '`chat:read:updated`',
  '`chat:session:invalidated`',
  '`chat:sync`',
  'ImageMagick `identify` и `convert`',
  'private encrypted bucket',
  'npm run chat:media-cleanup -w @kinetra/backend',
  'npm run chat:trainer:grant -w @kinetra/backend',
  'npm run chat:trainer:reassign -w @kinetra/backend',
  'npm run chat:trainer:revoke -w @kinetra/backend',
  'CHAT_ENABLED=false',
  'CHAT_PHOTO_UPLOADS_ENABLED=false',
  'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS=15',
  'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS=120',
  'CHAT_MEDIA_URL_TTL_SECONDS=300',
  'VITE_PRIVATE_MEDIA_ORIGIN',
  "img-src 'self' blob:",
  '`navigator.locks`',
  'одной replica',
  'Redis adapter',
  'MFA либо',
  'authenticated access gateway',
  'не является end-to-end encrypted',
  'push о сообщениях',
  'Rollback',
]) {
  expectIncludes(
    chatDocumentation,
    documentationContract,
    `T12 documented operations/security contract: ${documentationContract}`,
  );
}
for (const readmeContract of [
  '## Встроенный чат с тренером',
  'CHAT_ENABLED=false',
  'npm run chat:media-cleanup -w @kinetra/backend',
  'docs/T12_TRAINER_CHAT.md',
]) {
  expectIncludes(readmeDocumentation, readmeContract, `T12 README contract: ${readmeContract}`);
}

const readFlatTests = async (directory) => {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
        .map((entry) => readText(`${directory}/${entry.name}`)),
    )
  ).join('\n');
};
const backendTestSources = await readFlatTests('apps/backend/test');
const frontendTestSources = await readFlatTests('apps/frontend/test');
const chatBackendTests = await readOptionalText('apps/backend/test/chat.e2e.test.ts');
const chatPostgresTests = await readOptionalText('apps/backend/test/chat.postgres.test.ts');
const chatSocketTests = await readOptionalText('apps/backend/test/chat.socket.test.ts');
const chatTrainerCliTests = await readOptionalText('apps/backend/test/chat-trainer-cli.test.ts');
const chatPhotoTests = await readOptionalText('apps/backend/test/chat-photo-security.test.ts');
const chatMultipartTimeoutTests = await readOptionalText(
  'apps/backend/test/chat-multipart-timeout.test.ts',
);
const chatRealtimeAdmissionTests = await readOptionalText(
  'apps/backend/test/chat-realtime-admission.test.ts',
);
const chatRealtimePostgresTests = await readOptionalText(
  'apps/backend/test/chat-realtime-postgres.test.ts',
);
const chatMergeReadinessTests = await readOptionalText(
  'apps/backend/test/chat-merge-readiness.test.ts',
);
const chatClientIpTests = await readOptionalText('apps/backend/test/chat-client-ip.test.ts');
const chatCspTests = await readOptionalText('apps/frontend/test/chat-csp.test.ts');
const chatLifecycleTests = await readOptionalText('apps/frontend/test/chat-lifecycle.test.ts');
const chatRealtimeFrontendTests = await readOptionalText(
  'apps/frontend/test/chat-realtime.test.ts',
);
const chatPhotoFrontendTests = await readOptionalText(
  'apps/frontend/test/chat-photo-failure.test.ts',
);
const trainerSelectedConversationTests = await readOptionalText(
  'apps/frontend/test/trainer-selected-conversation.test.ts',
);
const chatUiTests = await readOptionalText('apps/frontend/test/chat-ui.test.ts');
const chatModelSource = await readOptionalText('apps/frontend/src/features/chat/model.ts');
const chatConversationViewSource = await readOptionalText(
  'apps/frontend/src/features/chat/ConversationView.tsx',
);
const chatComposerAcknowledgementSource = await readOptionalText(
  'apps/frontend/src/features/chat/composerAcknowledgement.ts',
);
const allT12TestSources = `${backendTestSources}\n${frontendTestSources}\n${browserTest}`;

for (const releaseFirstContract of [
  'public async getRealtimeConversation(',
  'findRealtimeRecipientConversation(',
]) {
  expectIncludes(
    `${chatService}\n${chatPostgresRepository}\n${chatRealtime}`,
    releaseFirstContract,
    `T12 F1 release-first realtime contract: ${releaseFirstContract}`,
  );
}
if (
  `${chatService}\n${chatPostgresRepository}\n${chatRealtime}`.includes('withCurrentConversation')
) {
  fail('T12 F1 removes the reentrant withCurrentConversation callback path');
} else {
  pass('T12 F1 removes the reentrant withCurrentConversation callback path');
}
for (const releaseFirstAcceptance of [
  'realtime fan-out releases its conversation snapshot before recipient validation',
  'reassignment and session revocation during fan-out suppress stale recipients',
  'one recipient validation failure cannot block delivery to another active socket',
  'PostgreSQL realtime fan-out releases pool slots before validation at max=1 and max=10',
  "pool.query<{ readonly available: number }>('SELECT 1 AS available')",
]) {
  expectIncludes(
    `${chatRealtimeAdmissionTests}\n${chatRealtimePostgresTests}`,
    releaseFirstAcceptance,
    `T12 F1 executable release-first acceptance: ${releaseFirstAcceptance}`,
  );
}

for (const syncAdmissionContract of [
  'public admitSocketSync(context: ChatRequestContext): ChatSocketSyncAdmission',
  'MAX_ACTIVE_SYNCS_PER_SOCKET = 4',
  'MAX_ACTIVE_SYNCS_PER_PRINCIPAL = 8',
  'socketAttempts.has(conversationId)',
  'releaseSocketSyncAttempts(socket)',
]) {
  expectIncludes(
    `${chatService}\n${chatRealtime}`,
    syncAdmissionContract,
    `T12 F2 bounded synchronous sync admission: ${syncAdmissionContract}`,
  );
}
const socketSyncHandler = chatRealtime.slice(
  chatRealtime.indexOf("socket.on(\n      'chat:sync'"),
  chatRealtime.indexOf("socket.once('disconnect'"),
);
const syncAdmissionPosition = socketSyncHandler.indexOf('admitSocketSync({');
const syncAuthorizationPosition = socketSyncHandler.indexOf('.authorizeSocketSync(');
if (
  syncAdmissionPosition >= 0 &&
  syncAuthorizationPosition >= 0 &&
  syncAdmissionPosition < syncAuthorizationPosition
) {
  pass('T12 F2 consumes sync admission before async repository authorization');
} else {
  fail('T12 F2 consumes sync admission before async repository authorization');
}
for (const syncAdmissionAcceptance of [
  'chat:sync enforces one conversation attempt and the four-attempt socket cap',
  'chat:sync keeps disconnected storage work inside the eight-attempt principal cap',
  'chat:sync invalidates sockets on 401 and 403 authorization failures',
  'chat:sync principal and IP admission rejects before repository work without disconnecting peers',
  'chat:sync shares the real principal history burst limit across sockets before repository work',
]) {
  expectIncludes(
    chatRealtimeAdmissionTests,
    syncAdmissionAcceptance,
    `T12 F2 executable sync admission acceptance: ${syncAdmissionAcceptance}`,
  );
}

for (const conversationCreationContract of [
  "scope: 'conversation_create'",
  'this.consumeConversationCreationLimits(context);',
  'const fastPathConversation = await this.findConversationForClient(clientUserId);',
  'const existing = await this.loadConversationByClient(client, clientUserId);',
]) {
  expectIncludes(
    `${chatService}\n${chatPostgresRepository}`,
    conversationCreationContract,
    `T12 F3 bounded conversation creation: ${conversationCreationContract}`,
  );
}
for (const conversationCreationAcceptance of [
  'conversation creation consumes principal and IP admission before any repository work',
  'two genuinely overlapping admitted creates serialize and publish one canonical event',
  'existing conversation replay must bypass the global trainer-administration lock',
]) {
  expectIncludes(
    `${chatMergeReadinessTests}\n${chatPostgresTests}`,
    conversationCreationAcceptance,
    `T12 F3 executable conversation creation acceptance: ${conversationCreationAcceptance}`,
  );
}

for (const safeSearchContract of [
  'CLIENT_DISPLAY_NAME_SQL',
  'CLIENT_SECONDARY_LABEL_SQL',
  "ILIKE ${parameter} ESCAPE '\\\\'",
]) {
  expectIncludes(
    chatPostgresRepository,
    safeSearchContract,
    `T12 F4 visible-only trainer search projection: ${safeSearchContract}`,
  );
}
for (const safeSearchAcceptance of [
  'hiddenUsername',
  'hiddenPhoneFragment',
  'safeProjectionJson.includes(hiddenUsername)',
  "await listFor(trainerId, '%')",
]) {
  expectIncludes(
    chatPostgresTests,
    safeSearchAcceptance,
    `T12 F4 executable hidden-contact search acceptance: ${safeSearchAcceptance}`,
  );
}

for (const durableLogoutContract of [
  'public prepareLogout(): PreparedLogoutAttempt',
  'const subjectId = this.authSubjectId',
  'const accessToken = this.logoutAccessToken',
  'const authEpoch = this.authEpoch',
  'const attemptNonce = `${authEpoch}:${this.logoutAttemptSequence}`',
  'response.status !== 204',
  "redirect: 'error'",
  'isCompletionCurrent:',
]) {
  expectIncludes(
    frontendApi,
    durableLogoutContract,
    `T12 F5 prepared logout contract: ${durableLogoutContract}`,
  );
}
for (const durableLogoutAcceptance of [
  'prepared logout keeps auth proof across network and 500 failures, then retries with bearer A',
  'prepared logout reports unavailable Web Locks without clearing the signed-in session',
  'prepared logout accepts only the exact 204 terminal response',
  'late account-A logout ACK cannot clear a newly logged-in account B',
  'a failed prepared logout can be restored on reload without false signed-out state',
]) {
  expectIncludes(
    apiSessionFrontendTests,
    durableLogoutAcceptance,
    `T12 F5 executable prepared logout acceptance: ${durableLogoutAcceptance}`,
  );
}
for (const durableLogoutBrowserAcceptance of [
  'trainer logout failure remains explicitly signed in and retryable',
  'trainer retry confirms logout before route and draft teardown',
  'logoutAuthorizations.trainer',
]) {
  expectIncludes(
    browserTest,
    durableLogoutBrowserAcceptance,
    `T12 F5 browser logout acceptance: ${durableLogoutBrowserAcceptance}`,
  );
}

for (const senderAwareContract of [
  'const byId = new Map<string, ChatTimelineMessage>();',
  'canonical.is_mine',
  'message.id === event.message.id',
  'message.is_mine &&',
  'nextRealtimeUnreadCount(',
]) {
  expectIncludes(
    `${chatModelSource}\n${chatConversationViewSource}\n${chatComposerAcknowledgementSource}`,
    senderAwareContract,
    `T12 F6 sender-aware reconciliation: ${senderAwareContract}`,
  );
}
for (const senderAwareAcceptance of [
  'T12 counterpart client_message_id collision does not replace an own optimistic message',
  'T12 only a same-context own canonical payload reconciles an optimistic message',
  'T12 canonical identity remains message.id across senders, reassignment and reload',
  'T12 cross-sender collision reconciles both arrival orders without corrupting unread or photos',
  'cross-sender collision remains intact after canonical history reload',
]) {
  expectIncludes(
    `${frontendTestSources}\n${browserTest}`,
    senderAwareAcceptance,
    `T12 F6 executable sender collision acceptance: ${senderAwareAcceptance}`,
  );
}

for (const multipartDeadlineContract of [
  'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_MS = 15_000',
  'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_MS = 120_000',
  "'CHAT_PHOTO_UPLOAD_TIMEOUT'",
  "request.removeListener('data', onData)",
  "request.on('error', ignoreLateStreamError)",
  'releaseMultipartSlot = acquireMultipartSlot();',
  'httpServer.requestTimeout = env.chat.photoUploadTotalTimeoutMs + 5_000',
]) {
  expectIncludes(
    `${chatMedia}\n${chatRouter}\n${backendServer}`,
    multipartDeadlineContract,
    `T12 F7 multipart deadline contract: ${multipartDeadlineContract}`,
  );
}
const photoPreflightPosition = chatRouter.indexOf(
  'const admission = await service.preflightPhotoUpload(context)',
);
const multipartSlotPosition = chatRouter.indexOf('releaseMultipartSlot = acquireMultipartSlot()');
if (
  photoPreflightPosition >= 0 &&
  multipartSlotPosition >= 0 &&
  photoPreflightPosition < multipartSlotPosition
) {
  pass('T12 F7 acquires the multipart slot only after authenticated preflight');
} else {
  fail('T12 F7 acquires the multipart slot only after authenticated preflight');
}
for (const multipartDeadlineAcceptance of [
  'multipart reader enforces idle deadlines before the first byte and between chunks',
  'multipart reader enforces total deadline against drip feeds and accepts bounded slow bodies',
  'multipart reader settles once across client abort and an end/deadline boundary',
  'real HTTP multipart slots time out, close connections and recover capacity',
  'post-body service errors release the multipart slot',
  'waitForClientRequestClose',
]) {
  expectIncludes(
    chatMultipartTimeoutTests,
    multipartDeadlineAcceptance,
    `T12 F7 executable multipart deadline acceptance: ${multipartDeadlineAcceptance}`,
  );
}
for (const exactTrainerConversationAcceptanceContract of [
  'active client chat is available without any Premium subscription',
  'trainer exact conversation summary is authorized without paginating the inbox',
  '/api/v1/chat/conversations/${conversationId}?unexpected=true',
  'trainer inbox combines search and unread filters with canonical activity ordering',
  'trainer conversation summary client performs one exact authenticated GET',
]) {
  expectIncludes(
    `${chatBackendTests}\n${apiSessionFrontendTests}`,
    exactTrainerConversationAcceptanceContract,
    `T12 executable exact trainer-conversation acceptance: ${exactTrainerConversationAcceptanceContract}`,
  );
}
for (const canonicalVector of ['\\u0085', '\\uFEFF', '\\u000b', '\\u007f']) {
  expectIncludes(
    `${chatBackendTests}\n${frontendTestSources}`,
    canonicalVector,
    `T12 executable canonical text vector: ${canonicalVector}`,
  );
}
expectIncludes(
  chatPostgresTests,
  'до\\u0085после',
  'T12 PostgreSQL permits internal U+0085 exactly like the shared canonicalizer',
);
for (const photoIdempotencyAcceptanceContract of [
  'PostgreSQL serializes a trainer photo upload key across assigned conversations',
  'the second conversation must wait on the global photo idempotency lock',
  'exactly one reservation wins without exposing a unique-constraint error',
  'clientUploadId.toUpperCase()',
  "await assertRace('a'.repeat(64), 'a'.repeat(64))",
  "await assertRace('b'.repeat(64), 'c'.repeat(64))",
]) {
  expectIncludes(
    chatPostgresTests,
    photoIdempotencyAcceptanceContract,
    `T12 executable global photo-idempotency acceptance: ${photoIdempotencyAcceptanceContract}`,
  );
}
for (const streamedPhotoByteAcceptanceContract of [
  'multipart stream bytes are charged once for valid and malformed photo requests',
  'a valid request at the exact byte ceiling must not be charged again by the service',
  'assert.equal(malformed.status, 400)',
  'assert.equal(exhausted.status, 429)',
  'the chunk crossing the streamed size limit must be charged before the 413 response',
  'direct service callers without a streamed admission must still pay the byte cost',
]) {
  expectIncludes(
    `${chatBackendTests}\n${chatPhotoTests}`,
    streamedPhotoByteAcceptanceContract,
    `T12 executable streamed photo-byte acceptance: ${streamedPhotoByteAcceptanceContract}`,
  );
}
for (const clientIpAcceptanceContract of [
  'exact-hop resolver ignores spoofing and fails closed on malformed or short chains',
  'HTTP chat contexts use the same exact-hop resolver for IP rate-limit keys',
  'trusted proxy clients receive distinct real Socket.IO handshake buckets',
  "xForwardedFor: ['198.51.100.10']",
  "'CHAT_RATE_LIMITED'",
]) {
  expectIncludes(
    chatClientIpTests,
    clientIpAcceptanceContract,
    `T12 executable trusted-proxy client-IP acceptance: ${clientIpAcceptanceContract}`,
  );
}
for (const lifecycleAcceptanceContract of [
  'a deferred stale chat session GET cannot overwrite a newer local read ACK',
  'failed read ACK retries automatically and clears authoritative unread state',
  'reconnect retries a retained monotonic read ACK immediately',
  'chat treats only auth-kind subject changes as terminal',
  'a delayed acknowledgement for failed draft A does not clear edited draft B',
  'the A → B → A edit must remain a distinct draft',
  'photo access renews on expiry and one image error, then cleans up deterministically',
  'the same broken URL must not create an unbounded retry loop',
]) {
  expectIncludes(
    chatLifecycleTests,
    lifecycleAcceptanceContract,
    `T12 executable frontend lifecycle acceptance: ${lifecycleAcceptanceContract}`,
  );
}
for (const trainerIdentityAcceptanceContract of [
  'selected trainer summary survives unread-to-read filtered-page omission',
  'deep-linked trainer detail resolves exact authorized identity with one direct lookup',
  'unassigned deep-linked conversation never produces a fabricated summary',
  'aborted deep-link lookup fails closed before making a request',
]) {
  expectIncludes(
    trainerSelectedConversationTests,
    trainerIdentityAcceptanceContract,
    `T12 executable selected-trainer identity acceptance: ${trainerIdentityAcceptanceContract}`,
  );
}
for (const originAcceptanceContract of [
  'frontend API and private media config share an exact secure origin policy',
  "normalizeOrigin('http://localhost:3000', true)",
  'https://user:secret@api.kinetra.test',
]) {
  expectIncludes(
    chatCspTests,
    originAcceptanceContract,
    `T12 executable frontend origin acceptance: ${originAcceptanceContract}`,
  );
}
for (const authSubjectAcceptanceContract of [
  'T12 cross-tab refresh subject mismatch is terminal and cannot authorize account B',
  'T12 JSON 401 subject mismatch never retries the protected request as account B',
  'T12 void 401 subject mismatch never retries the mutation as account B',
  'T12 multipart 401 subject mismatch never uploads a second time as account B',
  'T12 account-A logout cannot revoke an externally switched account-B cookie',
  'T12 browser auth mutations fail closed when Web Locks are unavailable',
  'an unsupported browser must not mutate the shared auth cookie',
  'T12 origin-wide Web Lock serializes two clients before a competing login',
  'createDeterministicExclusiveLockManager',
  'value: { locks: createDeterministicExclusiveLockManager() }',
  'the later account-B login must own the final cookie',
  "assert.equal(refreshCalls, 0, 'logout must never rotate the shared refresh cookie')",
  "error.code === 'AUTH_SESSION_CHANGED' &&",
  "error.kind === 'auth'",
  'assert.equal(chatCalls, 0)',
]) {
  expectIncludes(
    apiSessionFrontendTests,
    authSubjectAcceptanceContract,
    `T12 executable subject-binding acceptance: ${authSubjectAcceptanceContract}`,
  );
}
for (const socketLifecycleAcceptanceContract of [
  'T12 socket token failure classification preserves auth lifecycle boundaries',
  'T12 initial transient token failures retry to connected without invalidating the session',
  'T12 initial terminal and stale token failures never leave an unhandled socket lifecycle',
  'T12 transient refresh failure retries with backoff and recovers without logout',
]) {
  expectIncludes(
    chatRealtimeFrontendTests,
    socketLifecycleAcceptanceContract,
    `T12 executable socket lifecycle acceptance: ${socketLifecycleAcceptanceContract}`,
  );
}
for (const photoFailureAcceptanceContract of [
  'T12 failed photo API preserves failure metadata exactly',
  'T12 exhausted photo failure offers no fourth attempt and tells the user to replace it',
  'T12 retryable photo failure keeps one same-key retry available',
  'T12 composer treats retry-exhausted 409 as terminal and cannot issue another upload',
  "assert.equal(uploadPosts, 1, 'a repeated action must not issue a fourth upload POST')",
]) {
  expectIncludes(
    chatPhotoFrontendTests,
    photoFailureAcceptanceContract,
    `T12 executable photo retry acceptance: ${photoFailureAcceptanceContract}`,
  );
}
for (const [source, marker] of [
  [chatBackendTests, 'KINETRA_T12_BACKEND_E2E=PASS'],
  [chatSocketTests, 'KINETRA_T12_SOCKET_AUTHORIZATION=PASS'],
  [backendTestSources, 'KINETRA_T12_MESSAGE_DELIVERY=PASS'],
  [chatPostgresTests, 'KINETRA_T12_POSTGRES_INTEGRATION=PASS'],
  [chatMultipartTimeoutTests, 'KINETRA_T12_MULTIPART_TIMEOUT=PASS'],
  [chatPhotoTests, 'KINETRA_T12_PHOTO_SECURITY=PASS'],
  [frontendTestSources, 'KINETRA_T12_CLIENT_UI=PASS'],
  [frontendTestSources, 'KINETRA_T12_TRAINER_ADMIN=PASS'],
  [allT12TestSources, 'KINETRA_T12_T13_COEXISTENCE=PASS'],
  [browserTest, 'KINETRA_T12_BROWSER_E2E=PASS'],
]) {
  expectIncludes(source, marker, `T12 executable acceptance marker: ${marker}`);
}
for (const socketTestContract of ['socket.io-client', 'createServer', 'attachChatRealtime']) {
  expectIncludes(
    chatSocketTests,
    socketTestContract,
    `T12 real Socket.IO integration test: ${socketTestContract}`,
  );
}
for (const exactExpiryAcceptanceContract of [
  'const expiresAtMilliseconds = expiringClaims.exp * 1_000',
  'invalidatedAtMilliseconds <= expiresAtMilliseconds + 500',
  'const noPostExpiryPrivateEvent = expectNoEvent',
  'holdExpiringClientValidation',
  'while (Date.now() < expiresAtMilliseconds)',
  'releaseIdentityValidation()',
  'Сообщение на границе истечения access token',
]) {
  expectIncludes(
    chatSocketTests,
    exactExpiryAcceptanceContract,
    `T12 executable exact socket expiry acceptance: ${exactExpiryAcceptanceContract}`,
  );
}
for (const operatorAcceptanceContract of [
  'trainer operator CLI exposes strict grant, reassign and revoke argument contracts',
  'client_conversation',
  "revokeTrainer(trainerId, now), 'assigned'",
  "'default'",
  "'revoked'",
]) {
  expectIncludes(
    `${chatTrainerCliTests}\n${chatPostgresTests}`,
    operatorAcceptanceContract,
    `T12 executable trainer operator lifecycle: ${operatorAcceptanceContract}`,
  );
}
expectIncludes(
  chatPhotoTests,
  'ImageMagickChatImageProcessor',
  'T12 photo security suite uses the real ImageMagick decoder',
);
for (const metadataStripAcceptanceContract of [
  'METADATA_RICH_JPEG',
  "'GPSLatitude'",
  "'x:xmpmeta'",
  "'ICC_PROFILE'",
  'metadata fixture must contain ${metadataMarker}',
  'normalized WebP must strip ${metadataMarker}',
]) {
  expectIncludes(
    chatPhotoTests,
    metadataStripAcceptanceContract,
    `T12 executable metadata stripping acceptance: ${metadataStripAcceptanceContract}`,
  );
}
for (const photoAcceptanceContract of [
  'ORIENTED_EXIF_JPEG',
  'ANIMATED_WEBP',
  'ANIMATED_PNG',
  'grayscalePng(4473, 4473)',
  'grayscalePng(8193, 1)',
  "Object.hasOwn(parsed, 'filename')",
  'CHAT_IMAGE_COMMAND_TIMEOUT_MS',
  'CHAT_IMAGE_STDERR_MAX_BYTES',
  'CHAT_UPLOAD_IDEMPOTENCY_CONFLICT',
  'CHAT_PHOTO_RETRY_EXHAUSTED',
]) {
  expectIncludes(
    chatPhotoTests,
    photoAcceptanceContract,
    `T12 photo executable acceptance contract: ${photoAcceptanceContract}`,
  );
}
const photoMarker = 'KINETRA_T12_PHOTO_SECURITY=PASS';
const photoMarkerPosition = chatPhotoTests.indexOf(photoMarker);
const photoMarkerOccurrences = chatPhotoTests.split(photoMarker).length - 1;
const finalPhotoAssertionPosition = chatPhotoTests.lastIndexOf('CHAT_PHOTO_RETRY_EXHAUSTED');
if (
  photoMarkerOccurrences === 1 &&
  finalPhotoAssertionPosition >= 0 &&
  photoMarkerPosition > finalPhotoAssertionPosition
) {
  pass('T12 photo marker is emitted once and only after the complete executable matrix');
} else {
  fail('T12 photo marker is emitted once and only after the complete executable matrix');
}
const multipartMarker = 'KINETRA_T12_MULTIPART_TIMEOUT=PASS';
const multipartMarkerPosition = chatMultipartTimeoutTests.indexOf(multipartMarker);
const multipartMarkerOccurrences = chatMultipartTimeoutTests.split(multipartMarker).length - 1;
const finalMultipartAssertionPosition = chatMultipartTimeoutTests.lastIndexOf(
  'failed preflight must not acquire a multipart slot',
);
if (
  multipartMarkerOccurrences === 1 &&
  finalMultipartAssertionPosition >= 0 &&
  multipartMarkerPosition > finalMultipartAssertionPosition
) {
  pass('T12 multipart marker is emitted once and only after the real-HTTP timeout matrix');
} else {
  fail('T12 multipart marker is emitted once and only after the real-HTTP timeout matrix');
}
expectIncludes(
  chatPostgresTests,
  'KINETRA_REQUIRE_POSTGRES_TEST',
  'T12 PostgreSQL PASS cannot be emitted by an optional skip',
);
for (const uiAcceptanceContract of [
  'T12 client and trainer UI executable acceptance',
  'assertFloatingButtonAcceptance();',
  'assertMessageListAcceptance();',
  'assertClientConversationAcceptance();',
  'assertTrainerAdminAcceptance();',
]) {
  expectIncludes(
    chatUiTests,
    uiAcceptanceContract,
    `T12 frontend marker executable acceptance contract: ${uiAcceptanceContract}`,
  );
}
const trainerUiAssertionPosition = chatUiTests.indexOf('assertTrainerAdminAcceptance();');
const clientUiMarkerPosition = chatUiTests.indexOf('KINETRA_T12_CLIENT_UI=PASS');
const trainerUiMarkerPosition = chatUiTests.indexOf('KINETRA_T12_TRAINER_ADMIN=PASS');
if (
  trainerUiAssertionPosition >= 0 &&
  clientUiMarkerPosition > trainerUiAssertionPosition &&
  trainerUiMarkerPosition > clientUiMarkerPosition
) {
  pass('T12 frontend markers are emitted only after all client and trainer UI assertions');
} else {
  fail('T12 frontend markers are emitted only after all client and trainer UI assertions');
}
if (allT12TestSources.includes('KINETRA_T12_TEST_SUITE=PASS')) {
  fail('T12 suite completion marker is emitted by CI only');
} else {
  pass('T12 suite completion marker is emitted by CI only');
}

for (const ciEnvironmentContract of [
  "CHAT_ENABLED: 'true'",
  "CHAT_PHOTO_UPLOADS_ENABLED: 'false'",
  "CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS: '15'",
  "CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS: '120'",
  "CHAT_MEDIA_URL_TTL_SECONDS: '300'",
]) {
  expectIncludes(
    ciWorkflow,
    ciEnvironmentContract,
    `CI provides deterministic T12 environment: ${ciEnvironmentContract}`,
  );
}
for (const correctionCiContract of [
  'fix/t12-merge-readiness',
  'feature/t14-video-upload-s3',
  'feature/registration-roles-verification',
  'feature/onboarding-exploration-mode',
  '[main, develop, feature/t12-trainer-chat, feature/registration-roles-verification]',
  'EXPECTED_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
  'EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
  'test "$(git rev-parse HEAD^1)" = "$EXPECTED_BASE_SHA"',
  'test "$(git rev-parse HEAD^2)" = "$EXPECTED_HEAD_SHA"',
  'test "$checkout_sha" = "$GITHUB_SHA"',
  'Checkout semantics: $semantics',
  'tee -a "$GITHUB_STEP_SUMMARY"',
]) {
  expectIncludes(
    ciWorkflow,
    correctionCiContract,
    `T12 correction CI checkout identity: ${correctionCiContract}`,
  );
}
for (const repeatedCheckoutContract of [
  '- name: Verify checkout identity',
  'EXPECTED_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
  'EXPECTED_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
  'tee -a "$GITHUB_STEP_SUMMARY"',
]) {
  const occurrences = ciWorkflow.split(repeatedCheckoutContract).length - 1;

  if (occurrences === 3) {
    pass(`CI verifies checkout identity in all three jobs: ${repeatedCheckoutContract}`);
  } else {
    fail(`CI verifies checkout identity in all three jobs: ${repeatedCheckoutContract}`);
  }
}
const t12RequiredMarkers = [
  'KINETRA_T12_BACKEND_E2E=PASS',
  'KINETRA_T12_SOCKET_AUTHORIZATION=PASS',
  'KINETRA_T12_MESSAGE_DELIVERY=PASS',
  'KINETRA_T12_POSTGRES_INTEGRATION=PASS',
  'KINETRA_T12_MULTIPART_TIMEOUT=PASS',
  'KINETRA_T12_PHOTO_SECURITY=PASS',
  'KINETRA_T12_CLIENT_UI=PASS',
  'KINETRA_T12_TRAINER_ADMIN=PASS',
  'KINETRA_T12_T13_COEXISTENCE=PASS',
  'KINETRA_T12_BROWSER_E2E=PASS',
];
const t12MarkerPositions = t12RequiredMarkers.map((marker) => {
  const grep = `grep -F '${marker}'`;
  const occurrences = ciWorkflow.split(grep).length - 1;

  if (occurrences === 1) {
    pass(`CI requires the T12 marker exactly once: ${marker}`);
  } else {
    fail(`CI requires the T12 marker exactly once: ${marker}`);
  }

  return ciWorkflow.indexOf(grep);
});
const t12SuiteEcho = "echo 'KINETRA_T12_TEST_SUITE=PASS'";
const t12SuiteOccurrences = ciWorkflow.split(t12SuiteEcho).length - 1;
const t12SuitePosition = ciWorkflow.indexOf(t12SuiteEcho);
if (
  t12SuiteOccurrences === 1 &&
  t12MarkerPositions.every((position) => position >= 0) &&
  t12MarkerPositions.every(
    (position, index) => index === 0 || position > t12MarkerPositions[index - 1],
  ) &&
  t12SuitePosition > Math.max(...t12MarkerPositions)
) {
  pass('CI greps all ten T12 markers in order before the single suite marker');
} else {
  fail('CI greps all ten T12 markers in order before the single suite marker');
}
for (const priorSuiteMarker of [
  'KINETRA_T04_TEST_SUITE=PASS',
  'KINETRA_T05_TEST_SUITE=PASS',
  'KINETRA_T06_TEST_SUITE=PASS',
  'KINETRA_T07_TEST_SUITE=PASS',
  'KINETRA_T08_TEST_SUITE=PASS',
  'KINETRA_T09_TEST_SUITE=PASS',
  'KINETRA_T10_TEST_SUITE=PASS',
  'KINETRA_T11_TEST_SUITE=PASS',
  'KINETRA_T13_TEST_SUITE=PASS',
]) {
  expectIncludes(
    ciWorkflow,
    `echo '${priorSuiteMarker}'`,
    `CI preserves prior suite marker: ${priorSuiteMarker}`,
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
  '.github/workflows/apply-t12.yml',
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
  '.t12-bootstrap',
  '.t13-bootstrap',
  'docs/.probe',
  'docs/.t05-pr-trigger',
  'docs/.t06-pr-trigger',
  'docs/.t07-pr-trigger',
  'docs/.t08-pr-trigger',
  'docs/.t09-pr-trigger',
  'docs/.t10-pr-trigger',
  'docs/.t11-pr-trigger',
  'docs/.t12-pr-trigger',
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

for (const key of [
  'TRAINER_VIDEO_UPLOADS_ENABLED',
  'VIDEO_UPLOAD_MAX_BYTES',
  'VIDEO_UPLOAD_PART_SIZE_BYTES',
  'VIDEO_UPLOAD_PART_URL_TTL_SECONDS',
  'VIDEO_UPLOAD_SESSION_TTL_SECONDS',
  'VIDEO_UPLOAD_MAX_ACTIVE_PER_TRAINER',
  'VIDEO_VERIFY_FFPROBE_PATH',
  'VIDEO_VERIFY_LEASE_SECONDS',
  'VIDEO_VERIFY_DEADLINE_SECONDS',
  'VIDEO_VERIFY_MAX_ATTEMPTS',
  'VIDEO_WORKER_MAX_STALE_SECONDS',
  'VIDEO_MEDIA_DELETE_GRACE_SECONDS',
  'VIDEO_S3_SERVER_SIDE_ENCRYPTION',
  'VIDEO_S3_KMS_KEY_ID',
]) {
  expectMatches(envExample, new RegExp(`^${key}=`, 'mu'), `T14 video option: ${key}`);
}
expectMatches(
  envExample,
  /^TRAINER_VIDEO_UPLOADS_ENABLED=false$/mu,
  'T14 feature flag defaults off',
);

const t14Migration = await readText('apps/backend/migrations/012_video_uploads.sql');
for (const contract of [
  'can_manage_videos boolean NOT NULL DEFAULT false',
  'media_revision bigint NOT NULL DEFAULT 0',
  'CREATE TABLE IF NOT EXISTS trainer_video_uploads',
  'CREATE TABLE IF NOT EXISTS trainer_video_upload_parts',
  'CREATE TABLE IF NOT EXISTS video_media_deletion_jobs',
  'CREATE TABLE IF NOT EXISTS video_worker_heartbeats',
  'trainer_video_uploads_one_live_per_video_idx',
  'verification_next_attempt_at',
  'verification_quarantined',
  'quarantined_at',
  'video_upload_rate_events_retention_idx',
  'ON video_upload_rate_events (occurred_at, id)',
  "encode(decode(checksum_sha256_base64, 'base64'), 'base64') = checksum_sha256_base64",
]) {
  expectIncludes(t14Migration, contract, `T14 migration contract: ${contract}`);
}

const t14Storage = await readText('apps/backend/src/video-admin/storage.ts');
for (const contract of [
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'ListObjectVersionsCommand',
  'ChecksumSHA256',
  'ServerSideEncryption',
  'videos\\/workouts\\/',
  'S3 multipart abort could not be confirmed.',
  'probeAccess(signal?: AbortSignal)',
  'kmsKeyId: result.SSEKMSKeyId ?? null',
  'head.encryption === expected.serverSideEncryption',
  "expected.serverSideEncryption === 'aws:kms'",
  'videos/workouts/week-01/day-1/${randomUUID()}.mp4',
]) {
  expectIncludes(t14Storage, contract, `T14 private S3 contract: ${contract}`);
}
const t14Verifier = await readText('apps/backend/src/video-admin/verifier.ts');
for (const contract of [
  'shell: false',
  "prefix.subarray(4, 8).toString('ascii') !== 'ftyp'",
  "video.codec_name !== 'h264'",
  'fps <= 0 || fps > 60',
  'head.uploadId !== upload.id',
  'head.versionId !== upload.s3VersionId',
  'streams.length !== videos.length + audios.length',
  'object_changed_during_verification',
  'ffprobe_process_failed',
  'VideoVerificationRuntimeError',
  'head.etag !== upload.s3Etag',
  'pipeline(Readable.from(object.body)',
  "killSignal: 'SIGKILL'",
  "child.kill('SIGKILL')",
  'assertVideoVerifierRuntimeAvailable',
  'VideoVerificationInfrastructureError',
  'ffprobe_invalid_output',
  'MP4_MAJOR_BRANDS',
  'const rawDuration = finiteNumber',
  'if (rawDuration < 10 || rawDuration > 10_800)',
  'const duration = Math.round(rawDuration)',
  'verification_object_metadata_unconfirmed',
]) {
  expectIncludes(t14Verifier, contract, `T14 verifier contract: ${contract}`);
}
const t14Mp4Brands = /const MP4_MAJOR_BRANDS = new Set\(\[([\s\S]*?)\]\);/u.exec(t14Verifier)?.[1];
if (
  t14Mp4Brands !== undefined &&
  !t14Mp4Brands.includes('3gp') &&
  !t14Mp4Brands.includes("'qt  '")
) {
  pass('T14 verifier MP4 brand allowlist excludes 3GP and QuickTime containers');
} else {
  fail('T14 verifier MP4 brand allowlist excludes 3GP and QuickTime containers');
}

const t14Worker = await readText('apps/backend/src/video-admin/worker-service.ts');
for (const contract of [
  'Object version cleanup was not confirmed.',
  'Exact object version cleanup was not confirmed.',
  'renewVerificationLease',
  'verification_transient_failure',
  'quarantineVerification',
  'finalizeVerificationRun',
  'finalizeCleanupRun',
  'assertVideoVerifierRuntimeAvailable(probeController.signal)',
  'this.storage.probeAccess(probeController.signal)',
  'Video verifier recovery probe timed out.',
  'renewed && !controller.signal.aborted',
  'verification_infrastructure_exhausted',
  'awaitWithSignal',
  'private readonly deadlineSeconds = 300',
  'this.storage.abortMultipart(job.objectKey, multipartUploadId, controller.signal)',
  'this.storage.listExactObjectVersions(job.objectKey, controller.signal)',
  'this.storage.headObject(job.objectKey, null, controller.signal)',
  'this.storage.deleteObject(job.objectKey, null, controller.signal)',
]) {
  expectIncludes(t14Worker, contract, `T14 cleanup reconciliation contract: ${contract}`);
}

const t14PostgresRepository = await readText(
  'apps/backend/src/video-admin/postgres-video.repository.ts',
);
for (const contract of [
  "event_type='sign'",
  '>= 30',
  'previousVersionId',
  "upload.status='uploading' OR",
  "['completing', 'verification_pending', 'verifying', 'published']",
  "SET status='uploading', lease_token=NULL, lease_expires_at=NULL",
  "upload.status='verifying' AND upload.lease_token=$2",
  'locked_at IS NOT NULL',
  'last_started_at IS NULL OR last_succeeded_at >= last_started_at',
  'verification_quarantined',
  'requeueQuarantinedVerification',
  'last_succeeded_at > last_failed_at',
  'renewCompletionLease',
  'clock_timestamp()',
  'SET LOCAL statement_timeout',
  'lockVideoTrainerAuthority',
  'SELECT id FROM users WHERE id=$1 FOR UPDATE',
  'RATE_EVENT_PRUNE_LIMIT',
  'LIMIT $3\n         FOR UPDATE SKIP LOCKED',
  'completionAmbiguityGraceSeconds',
  "upload.status <> 'completing'",
  "parts.last_url_expires_at + INTERVAL '60 seconds'",
  'completed_at=NULL',
]) {
  expectIncludes(t14PostgresRepository, contract, `T14 PostgreSQL safety contract: ${contract}`);
}
const t14Service = await readText('apps/backend/src/video-admin/service.ts');
for (const contract of [
  'completionLeaseGuard(',
  'renewCompletionLease(',
  'this.storage.listParts(upload.objectKey, multipartUploadId, lease.signal)',
  'storedParts,\n          lease.signal',
  'await lease.fence()',
  'renewed && !controller.signal.aborted && !stopped',
  'head.etag !== object.etag',
  'Published video identity no longer matches the verified object.',
]) {
  expectIncludes(t14Service, contract, `T14 completion lease contract: ${contract}`);
}
const databasePool = await readText('apps/backend/src/db/pool.ts');
expectIncludes(databasePool, 'query_timeout: 10_000', 'T14 PostgreSQL queries are bounded');
if (/100\s*\*\s*365|365\s*\*\s*100/u.test(t14Worker)) {
  fail('T14 verifier exhaustion has no century-scale retry delay');
} else {
  pass('T14 verifier exhaustion has no century-scale retry delay');
}

const t14BackendE2e = await readText('apps/backend/test/video-admin.e2e.test.ts');
const t14BackendUnit = await readText('apps/backend/test/video-admin.test.ts');
const t14Postgres = await readText('apps/backend/test/video-admin.postgres.test.ts');
const t14S3 = await readText('apps/backend/test/video-s3.integration.test.ts');
const t14VideoVerification = await readText('apps/backend/test/video-verifier.test.ts');
const t14TrainerUi = await readText('apps/frontend/test/trainer-videos.test.ts');
const t14UploadLifecycle = await readText('apps/frontend/test/trainer-video-upload.test.ts');
const t14ProgramPolling = await readText(
  'apps/frontend/src/features/trainer-videos/program-polling.ts',
);
for (const contract of [
  "new Set(['completing', 'verification_pending', 'verifying'])",
  'TRAINER_VIDEO_PROGRAM_POLL_INTERVAL_MS = 2_000',
  'TRAINER_VIDEO_PROGRAM_POLL_MAX_DURATION_MS = 15 * 60 * 1_000',
  'requestController?.abort()',
  'generation === candidateGeneration',
  'setOnline: (nextOnline)',
]) {
  expectIncludes(t14ProgramPolling, contract, `T14 reload polling contract: ${contract}`);
}
for (const scenario of [
  'T14 cancel losing the verifier publish race returns an explicit conflict',
  'T14 completion requires the configured SSE mode and exact KMS key',
  'T14 unversioned preview refuses a current object that no longer matches published ETag',
  'T14 cleanup acknowledges an already absent versioned object without creating a marker',
  'T14 cleanup deadline bounds every storage operation and durably records failure',
  'T14 verifier metadata drift is retryable and never enters the deletion path',
  'T14 stalled verifier body is aborted by the deadline and safely rescheduled',
]) {
  expectIncludes(t14BackendUnit, scenario, `T14 backend regression: ${scenario}`);
}
for (const scenario of [
  'T14 PostgreSQL account deletion and upload reservation use users-before-profile lock order',
  'T14 PostgreSQL expiration fences live completion and reopens cleanup for late materialization',
]) {
  expectIncludes(t14Postgres, scenario, `T14 PostgreSQL regression: ${scenario}`);
}
for (const scenario of [
  'T14 mount after reload resumes bounded polling for an upload already verifying',
  'T14 program polling fences a stale response even when its aborted request resolves late',
]) {
  expectIncludes(t14TrainerUi, scenario, `T14 frontend regression: ${scenario}`);
}
const t14AllExecutableTests = [
  t14BackendE2e,
  t14Postgres,
  t14S3,
  t14VideoVerification,
  t14TrainerUi,
  t14UploadLifecycle,
  browserTest,
].join('\n');
const t14Markers = [
  ['KINETRA_T14_BACKEND_E2E=PASS', t14BackendE2e],
  ['KINETRA_T14_UPLOAD_AUTHORIZATION=PASS', t14Postgres],
  ['KINETRA_T14_S3_MULTIPART=PASS', t14S3],
  ['KINETRA_T14_VIDEO_VERIFICATION=PASS', t14VideoVerification],
  ['KINETRA_T14_POSTGRES_INTEGRATION=PASS', t14Postgres],
  ['KINETRA_T14_TRAINER_UI=PASS', t14TrainerUi],
  ['KINETRA_T14_UPLOAD_LIFECYCLE=PASS', t14UploadLifecycle],
  ['KINETRA_T14_REPLACE_UNPUBLISH=PASS', t14Postgres],
  ['KINETRA_T14_T07_T12_T13_COEXISTENCE=PASS', browserTest],
  ['KINETRA_T14_BROWSER_E2E=PASS', browserTest],
];
for (const [marker, owner] of t14Markers) {
  const totalOccurrences = t14AllExecutableTests.split(marker).length - 1;
  const ownerOccurrences = owner.split(marker).length - 1;
  if (totalOccurrences === 1 && ownerOccurrences === 1) {
    pass(`T14 executable marker has one asserted owner: ${marker}`);
  } else {
    fail(`T14 executable marker has one asserted owner: ${marker}`);
  }
}
if (t14AllExecutableTests.includes('KINETRA_T14_TEST_SUITE=PASS')) {
  fail('T14 suite marker is emitted only by CI');
} else {
  pass('T14 suite marker is emitted only by CI');
}

const t14CiMarkerPositions = t14Markers.map(([marker]) => {
  const grep = `grep -F '${marker}'`;
  const occurrences = ciWorkflow.split(grep).length - 1;
  if (occurrences === 1) pass(`CI requires the T14 marker exactly once: ${marker}`);
  else fail(`CI requires the T14 marker exactly once: ${marker}`);
  return ciWorkflow.indexOf(grep);
});
const t14SuiteEcho = "echo 'KINETRA_T14_TEST_SUITE=PASS'";
const t14SuitePosition = ciWorkflow.indexOf(t14SuiteEcho);
if (
  t14CiMarkerPositions.every((position) => position >= 0) &&
  t14CiMarkerPositions.every(
    (position, index) => index === 0 || position > t14CiMarkerPositions[index - 1],
  ) &&
  t14SuitePosition > t14CiMarkerPositions.at(-1) &&
  ciWorkflow.split(t14SuiteEcho).length - 1 === 1
) {
  pass('CI greps all ten T14 markers in order before the single suite marker');
} else {
  fail('CI greps all ten T14 markers in order before the single suite marker');
}
for (const contract of [
  "KINETRA_REQUIRE_S3_TEST: 'true'",
  "KINETRA_REQUIRE_POSTGRES_TEST: 'true'",
  'minio/minio:RELEASE.2025-06-13T11-33-47Z',
  'sudo apt-get install --yes --no-install-recommends ffmpeg imagemagick',
]) {
  expectIncludes(ciWorkflow, contract, `T14 fail-closed CI contract: ${contract}`);
}

const registrationMigration = await readText(
  'apps/backend/migrations/013_trainer_verification.sql',
);
for (const contract of [
  'ADD COLUMN IF NOT EXISTS requested_role',
  "CHECK (requested_role IN ('trainer', 'trainee'))",
  'CREATE TABLE IF NOT EXISTS trainer_verification_requests',
  'CREATE TABLE IF NOT EXISTS trainer_verification_documents',
  'CREATE TABLE IF NOT EXISTS trainer_verification_events',
  'CREATE TABLE IF NOT EXISTS trainer_verification_reviewers',
  'trainer_verification_requests_one_live_per_user_idx',
  'prevent_direct_trainer_verification_request_delete',
  'trainer_verification_requests_delete_guard',
  'prevent_trainer_verification_event_mutation',
  "USING ERRCODE = '55000'",
  'trainer_profiles_align_requested_role',
]) {
  expectIncludes(
    registrationMigration,
    contract,
    `trainer verification additive migration contract: ${contract}`,
  );
}

const trainerVerificationRepository = await readText(
  'apps/backend/src/trainer-verification/postgres-trainer-verification.repository.ts',
);
for (const contract of [
  'kinetra:chat:trainer-administration:v1',
  'email_verified',
  "return { status: 'email_not_verified' }",
  "return { status: 'self_review' }",
  "return { status: 'client_chat_history' }",
  "action === 'approve' && request.status === 'approved'",
  'FOR UPDATE',
]) {
  expectIncludes(
    trainerVerificationRepository,
    contract,
    `trainer verification PostgreSQL safety contract: ${contract}`,
  );
}
for (const contract of [
  "(status IN ('pending', 'needs_more_info', 'approved')) DESC",
  'created_at DESC,\n         updated_at DESC,\n         id DESC',
]) {
  expectIncludes(
    trainerVerificationRepository,
    contract,
    `trainer verification latest request prioritizes live state: ${contract}`,
  );
}

const profilePostgresRepository = await readText(
  'apps/backend/src/profile/postgres-profile.repository.ts',
);
for (const contract of [
  "(request.status IN ('pending', 'needs_more_info', 'approved')) DESC",
  'request.created_at DESC,\n            request.updated_at DESC,\n            request.id DESC',
]) {
  expectIncludes(
    profilePostgresRepository,
    contract,
    `profile latest verification state prioritizes live request: ${contract}`,
  );
}

const trainerProfileApprovalSection = trainerVerificationRepository.slice(
  trainerVerificationRepository.indexOf('private async ensureTrainerProfile'),
  trainerVerificationRepository.indexOf('private async loadUserSnapshot'),
);
const trainerProfileConflictClause = trainerProfileApprovalSection.slice(
  trainerProfileApprovalSection.indexOf('ON CONFLICT (user_id) DO UPDATE'),
);
if (
  trainerProfileConflictClause.includes('is_default =') ||
  trainerProfileConflictClause.includes('can_manage_videos =')
) {
  fail('trainer verification approval preserves existing trainer authority flags');
} else {
  pass('trainer verification approval preserves existing trainer authority flags');
}

const trainerVerificationRouter = await readText('apps/backend/src/trainer-verification/router.ts');
for (const endpoint of [
  "'/me'",
  "'/me/withdraw'",
  "'/:id/approve'",
  "'/:id/request-info'",
  "'/:id/reject'",
]) {
  expectIncludes(
    trainerVerificationRouter,
    endpoint,
    `trainer verification endpoint is present: ${endpoint}`,
  );
}

const trainerVerificationSchema = await readText('apps/backend/src/trainer-verification/schema.ts');
expectIncludes(
  trainerVerificationSchema,
  "url.protocol !== 'https:'",
  'trainer verification accepts only HTTPS material links',
);
expectIncludes(
  trainerVerificationSchema,
  '.strict()',
  'trainer verification request objects reject unknown fields',
);

const trainerVerificationPostgresTests = await readText(
  'apps/backend/test/trainer-verification.postgres.test.ts',
);
const trainerVerificationReviewerCliTests = await readText(
  'apps/backend/test/trainer-verification-reviewer-cli.test.ts',
);
for (const contract of [
  'postgresTestRequired && databaseUrl === undefined',
  'serverVersion >= 170_000 && serverVersion < 180_000',
  'migration 013 backfills roles, applies defaults and is rerunnable',
  'KINETRA_TRAINER_VERIFICATION_MIGRATION_POSTGRES17=PASS',
  "'email_not_verified'",
  "'client_chat_history'",
  "'self_review'",
  "'55000'",
  'DELETE FROM trainer_verification_requests WHERE id = $1',
  'latest request favors a live reapplication when timestamps are identical',
  'concurrent approval must be idempotent',
]) {
  expectIncludes(
    trainerVerificationPostgresTests,
    contract,
    `trainer verification PostgreSQL executable gate: ${contract}`,
  );
}
const registrationPostgresMarkers = [
  ['KINETRA_TRAINER_VERIFICATION_MIGRATION_POSTGRES17=PASS', trainerVerificationPostgresTests],
  ['KINETRA_REGISTRATION_ROLES_POSTGRES17=PASS', authPostgresTests],
  ['KINETRA_SQLSTATE_42804_REGRESSION_POSTGRES17=PASS', authPostgresTests],
  ['KINETRA_REGISTRATION_PROFILE_POSTGRES17=PASS', profilePostgresTests],
  [
    'KINETRA_TRAINER_VERIFICATION_REVIEWER_CLI_POSTGRES17=PASS',
    trainerVerificationReviewerCliTests,
  ],
  ['KINETRA_TRAINER_VERIFICATION_LIFECYCLE_POSTGRES17=PASS', trainerVerificationPostgresTests],
  [
    'KINETRA_TRAINER_VERIFICATION_APPROVAL_GUARDS_POSTGRES17=PASS',
    trainerVerificationPostgresTests,
  ],
  ['KINETRA_TRAINER_VERIFICATION_AUDIT_CASCADE_POSTGRES17=PASS', trainerVerificationPostgresTests],
  ['KINETRA_TRAINER_VERIFICATION_LATEST_REQUEST_POSTGRES17=PASS', trainerVerificationPostgresTests],
];
const allRegistrationPostgresTests = [
  authPostgresTests,
  profilePostgresTests,
  trainerVerificationPostgresTests,
  trainerVerificationReviewerCliTests,
].join('\n');
for (const [marker, owner] of registrationPostgresMarkers) {
  const totalOccurrences = allRegistrationPostgresTests.split(marker).length - 1;
  const ownerOccurrences = owner.split(marker).length - 1;
  if (totalOccurrences === 1 && ownerOccurrences === 1) {
    pass(`registration PostgreSQL marker has one asserted owner: ${marker}`);
  } else {
    fail(`registration PostgreSQL marker has one asserted owner: ${marker}`);
  }
}
const registrationCiMarkerPositions = registrationPostgresMarkers.map(([marker]) => {
  const grep = `grep -F '${marker}'`;
  const occurrences = ciWorkflow.split(grep).length - 1;
  if (occurrences === 1) pass(`CI requires the registration marker exactly once: ${marker}`);
  else fail(`CI requires the registration marker exactly once: ${marker}`);
  return ciWorkflow.indexOf(grep);
});
if (
  registrationCiMarkerPositions.every((position) => position >= 0) &&
  registrationCiMarkerPositions.every(
    (position, index) => index === 0 || position > registrationCiMarkerPositions[index - 1],
  )
) {
  pass('CI greps all nine registration PostgreSQL markers in fail-closed order');
} else {
  fail('CI greps all nine registration PostgreSQL markers in fail-closed order');
}
expectIncludes(
  ciWorkflow,
  'image: postgres:17-alpine',
  'CI provides PostgreSQL 17 for the mandatory integration gate',
);
expectIncludes(
  ciWorkflow,
  "KINETRA_REQUIRE_POSTGRES_TEST: 'true'",
  'CI fails closed when PostgreSQL integration tests cannot run',
);

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
