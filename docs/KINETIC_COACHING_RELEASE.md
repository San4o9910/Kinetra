# Kinetra: Vulcanico / Noturno and coaching

This change builds on `feature/onboarding-exploration-mode` (73b6650). It does not deploy itself or merge the earlier feature stack.

## Product behavior

- Shared dark/light themes use #FF4103 and #001621. The K mark draws once on entry and confirmed workout completion; reduced-motion preferences disable motion.
- Main navigation: Сегодня, Расписание, Прогресс, Чат. Existing seven base lessons, four-lesson unlock and 12-week/84-workout program remain the source of progression.
- Workout position persists per account, video and week. A visible action resumes playback. Trainers with video-management rights can enter equipment, technique notes and ordered chapters. No invented exercise content is seeded.
- Workout questions create a chat draft containing week, title and playback time; the user sends it. Post-completion difficulty, wellbeing and notes appear to the assigned active trainer.
- `/admin/trainer-applications` provides a reviewer-only queue, status filters, search, qualifications/materials, and approve / request-information / reject actions. Approval grants the existing trainer role, not reviewer or video-management rights. Existing server-side audit and self-review/email guards remain authoritative.
- Short MP4/MOV clips can be sent through the conversation's video panel. The limit is 32 MiB / 3 minutes / 4K input; the server re-encodes to at most 1280px H.264/AAC, removes metadata, and signs private playback URLs for five minutes. The participant must still be assigned when uploading or reading. Video deletion uses the existing durable media cleanup queue.
- The AI assistant is separate from the human trainer. It is unavailable until its server provider is configured. It uses program content; progress and wellbeing are included only with the user's checkbox consent. It does not alter training plans. History is account-scoped; identical request retries do not call the provider twice. Limits: 20 attempts/user/day, 200 attempts total/day, one pending request/user and a 25-second provider timeout. Provider failures consume an attempt; there is no simulated fallback answer.
- New passwords require at least six characters, including password recovery. Longer passwords and bcrypt's existing byte limit remain supported. Login attempts are limited per normalized account and IP. These login limits are process-local; multiple API replicas require a shared limiter before scaling.

## Deployment preparation

1. Build and validate the full preceding branch stack and this branch. Take the normal database checkpoint. Run migrations 014 and 015 with the migration role, then reapply `deploy/postgres/runtime-grants.sql`. The cleanup role now needs SELECT/DELETE on `chat_video_assets`.
2. Set `AUTH_PASSWORD_MIN_LENGTH=6` in the actual API environment. An existing explicit value of 12 overrides the new default until changed. Redeploy the matching frontend and API together.
3. Existing reviewer accounts automatically see the admin entry. To designate the owner account, use the existing `trainer-verification:reviewer:grant` CLI with the verified account ID according to its runbook. No account is silently promoted by this release.
4. Video sending requires `CHAT_ENABLED=true`, `CHAT_PHOTO_UPLOADS_ENABLED=true` and configured private S3 storage. Deploy the updated Nginx route: its 32 MiB limit is restricted to chat video uploads. The backend image already includes ffmpeg/ffprobe. Run the regular chat cleanup job; uploading records older than one hour are removed and enqueued. Two concurrent transcodes are admitted per process; review capacity before adding replicas.
5. Optional AI: configure a dedicated `KINETRA_AI_API_KEY` and a model available to that project in `KINETRA_AI_MODEL`. Both remain server-only. Verify model compatibility with Chat Completions and the configured completion budget before enabling. Keep both empty to leave the assistant explicitly unavailable. No provider call or spend is made by this change itself.
6. Smoke-check the installed PWA, mobile/desktop views, real email recovery, reviewer access, trainer approval, workout resume and feedback, video upload/playback/deletion with real storage, and configured AI responses before production release.

## Validation record

Local checks use Node's `--import tsx` loader because the tsx executable's IPC listener is blocked in this environment. The authenticated HTTP tests themselves run successfully. CI retains the normal scripts, PostgreSQL 17 and private MinIO integration gates. New PostgreSQL coverage exercises ownership, locked workouts, feedback completion, reviewer-independent trainer permissions, assigned-client context, AI consent/idempotency/quotas and cascading video cleanup.

Local browser navigation to the preview is blocked with `net::ERR_BLOCKED_BY_CLIENT`; visual QA is not claimed. PostgreSQL integration and the complete browser suite must pass in CI before release. A mocked preview is not production evidence. Consult the PR checks for final validation status.

Local result: production build and typecheck pass; 204 frontend tests pass, 26 targeted auth/reviewer/coaching tests pass, 9 deployment-environment tests pass, and 3,134 structural checks pass. The existing 36-test video worker suite passes after replacing a wall-clock-dependent deadline test with controlled timers; the worker behavior is unchanged. The full backend run requires 29 unavailable PostgreSQL/S3 checks. The owner explicitly authorized publishing the feature branch and opening a draft PR on 2026-09-15. Remote PostgreSQL/S3/browser results are tracked in that PR; deployment remains a separate step.

The private S3 CI fixture uses the same MinIO release from its official GitHub release asset, pinned by SHA-256, and listens only on loopback. This replaces the unavailable Docker Hub image; PostgreSQL, S3, browser and zero-skipped-tests gates remain required.
