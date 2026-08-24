# Kinetra T12 correction — validation contract

**Дата:** 2026-08-24

**Correction branch:** `fix/t12-merge-readiness`

**Correction PR base:** `feature/t12-trainer-chat`

**Проверенный исходный T12 head:** `4468b52bf34669e6dba63ac3bcad75e666b81c01`

**Develop baseline:** `75e74de5d077464d3be129f9ed4f344223a35c0d`

## Статус

Correction head остаётся **CI REQUIRED**, пока внешний authoritative GitHub Actions run не завершит
весь suite успешно и не зафиксирует фактически проверенные checkout SHAs. Этот tracked документ не
содержит final head SHA, merge SHA, run URL или attempt: добавление таких данных изменило бы
проверяемый commit и создало циклическую ссылку.

Run #96 на develop baseline был зелёным до T12 и записан только как precondition. Он не является
доказательством исправленного correction head. Старый run PR #13 также не является evidence для
этой ветки.

| Проверка                                 | Статус      | Требование                                         |
| ---------------------------------------- | ----------- | -------------------------------------------------- |
| T13 base exact-head GitHub CI            | PASS        | baseline `75e74de`; не evidence correction         |
| Structural contracts T01–T13 + T12       | PASS        | 2 669/2 669 checks                                 |
| TypeScript production + backend tests    | PASS        | shared, backend production/tests и frontend        |
| ESLint                                   | PASS        | `eslint apps packages scripts`                     |
| Backend unit/API tests                   | PASS        | 132 total: 118 pass, 14 PostgreSQL skips, 0 fail   |
| Real Socket.IO authorization/delivery    | PASS        | real HTTP + `socket.io-client`                     |
| Real ImageMagick photo security          | PASS        | complete real-decoder matrix                       |
| PostgreSQL 17 migration/concurrency      | CI REQUIRED | migrations, seed, content и real-PG F1–F4/F7 tests |
| Frontend unit/API/Service Worker tests   | PASS        | 146/146, 0 fail                                    |
| Chrome client+trainer browser acceptance | CI REQUIRED | Chrome/Chromium отсутствует локально               |
| Production build                         | PASS        | backend + Vite production, 126 modules             |
| Changed-file Prettier                    | PASS        | 109 changed files                                  |
| Tracked source manifest                  | PASS        | 293/293 tracked source hashes                      |
| Composite quality gate                   | CI REQUIRED | authoritative final GitHub Actions run             |

Локальные targeted tests: F1–F4 — 13 total, 10 pass и 3 PostgreSQL skips; F5–F6 — 54/54; F7 —
4/4. Полный backend набор выполнен эквивалентной командой
`node --import tsx --test apps/backend/test/*.test.ts`: стандартный `tsx --test` wrapper в этой
sandbox не может создать IPC pipe `/tmp/tsx-0/*.pipe` (`EPERM`). `npm run test:frontend:browser`
успешно строит browser-test bundle и mock API, затем fail-closed останавливается с
`Chrome/Chromium was not found for the frontend browser test.` Docker, `psql`, `pg_isready` и
`DATABASE_URL` локально отсутствуют. Стандартные Node 22/PostgreSQL 17/Chrome команды остаются
обязательными в authoritative CI.

## Closure matrix F1–F7

| Finding              | Runtime closure                                                                                                                                                                    | Обязательное regression evidence                                                                                                                            | До final CI |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| F1 / K13-RT-002      | Короткий authorized snapshot освобождает PostgreSQL client до socket/session validation и emit; recipient assignment повторно авторизуется после release.                          | pool `max=1` и `max=10`, unrelated query, reassignment/revocation fence, isolated validation failure                                                        | CI REQUIRED |
| F2 / K13-RT-001      | Principal+IP admission выполняется синхронно до await/DB; guards: 1 на canonical socket/conversation, 4 на socket, 8 на principal; disconnected DB work учитывается до settlement. | burst с zero repository calls сверх лимита, UUID case/reconnect churn, cross-conversation/socket caps, release после terminal settlement, 401/403 semantics | CI REQUIRED |
| F3 / K13-BECORE-001  | `POST /conversations` имеет early principal+IP limiter и cheap replay fast path до global advisory lock; create повторно проверяет state под lock.                                 | zero DB/lock при 429, replay без global lock, concurrent create даёт одну conversation/event, lifecycle recheck                                             | CI REQUIRED |
| F4 / K13-BECORE-002  | Search predicate использует только фактически видимые `display_name` и masked secondary label; raw contacts не участвуют.                                                          | hidden email/phone/username fragments, visible/masked/Unicode search, LIKE escaping, trainer isolation, JSON redaction                                      | CI REQUIRED |
| F5 / K13-FECHAT-001  | Prepared logout захватывает subject/bearer/epoch/nonce до async; failure остаётся signed in и сохраняет retry proof/drafts; только ACK завершает logout.                           | network/500/Web Locks failure, same-bearer retry, pending privacy screen, late A ACK fenced from B, browser failure→retry→204                               | CI REQUIRED |
| F6 / W3-CHAT-001     | Canonical identity — только `message.id`; client key связывает лишь собственный optimistic item с совпадающим payload fingerprint.                                                 | cross-sender collision в обоих realtime orders и после full history reload, same server ID dedupe, read/photo/order preservation                            | CI REQUIRED |
| F7 / KPR13-MEDIA-001 | Slot берётся после preflight; application idle/total deadlines 15/120 s активно останавливают body и exactly-once освобождают slot.                                                | no-byte/pause/drip/boundary/abort, 10 partial + 11th 429, recovery, zero post-timeout processing, marker                                                    | CI REQUIRED |

## Security и coexistence invariants

- JWT `sub`/`sid`, current role, participant assignment, reassignment и session revocation остаются
  server-authoritative; один failed realtime recipient не ослабляет остальные проверки.
- Message idempotency остаётся sender-scoped; `client_message_id` не становится глобально уникальным.
- Photo access, short signed URLs, private-cache bypass, size/type limits и storage isolation
  сохраняются; ingress timeout является только defense in depth.
- Logout не делает bearerless request, refresh-before-logout, JavaScript cookie deletion или
  persistent bearer storage. Pending немедленно скрывает private trainer chat, failure явно
  показывает `Выход не завершен / Повторить`, success требует server-confirmed revocation;
  mismatched cookie/family возвращает `409 LOGOUT_NOT_CONFIRMED` без `Set-Cookie`.
- T13 push taxonomy, Service Worker deep-link allowlist, account deletion token capture и cookie
  lineage не меняются.
- `CHAT_ENABLED=false` и `CHAT_PHOTO_UPLOADS_ENABLED=false` остаются defaults.

## Обязательные T12 CI markers

Каждый marker печатается только после соответствующих assertions. PostgreSQL skip, отсутствие
Chrome или fake decoder не могут печатать PASS. Multipart marker проверяется раньше общего suite
marker.

```text
KINETRA_T12_BACKEND_E2E=PASS
KINETRA_T12_SOCKET_AUTHORIZATION=PASS
KINETRA_T12_MESSAGE_DELIVERY=PASS
KINETRA_T12_POSTGRES_INTEGRATION=PASS
KINETRA_T12_PHOTO_SECURITY=PASS
KINETRA_T12_CLIENT_UI=PASS
KINETRA_T12_TRAINER_ADMIN=PASS
KINETRA_T12_T13_COEXISTENCE=PASS
KINETRA_T12_BROWSER_E2E=PASS
KINETRA_T12_MULTIPART_TIMEOUT=PASS
KINETRA_T12_TEST_SUITE=PASS
```

Все прежние T04–T11 и T13 markers также обязательны.

## Полная последовательность проверки

Targeted regression commands выполняются перед полным suite:

```bash
node --import tsx --test \
  apps/backend/test/chat-realtime-admission.test.ts \
  apps/backend/test/chat-realtime-postgres.test.ts \
  apps/backend/test/chat-merge-readiness.test.ts \
  apps/backend/test/chat.postgres.test.ts
node --import tsx --test apps/backend/test/chat-multipart-timeout.test.ts
node --import tsx --test \
  apps/frontend/test/api-session.test.ts \
  apps/frontend/test/settings.test.ts \
  apps/frontend/test/chat-model.test.ts \
  apps/frontend/test/chat-lifecycle.test.ts
```

```bash
npm ci
docker compose up -d postgres
npm run db:migrate
npm run db:migrate
npm run db:seed
npm run db:seed
npm run db:verify-content
npm run verify:structure
npm run typecheck
npm run lint
npm run format:changed
npm run test
npm run build
npm run check
node --check scripts/test-frontend-browser.mjs
node --check scripts/verify-project.mjs
node --check scripts/check-changed-format.mjs
git diff --check
diff -u \
  <(git ls-files | sed '/^MANIFEST\.sha256$/d' | sed 's#^#./#' | LC_ALL=C sort) \
  <(awk '{ print $2 }' MANIFEST.sha256 | LC_ALL=C sort)
sha256sum -c MANIFEST.sha256
git status --short
```

Локальная среда без PostgreSQL 17 или Chrome не получает PASS за эти gates. Точная команда и
ошибка фиксируются в mutable correction PR evidence, а задача остаётся `CI REQUIRED` до зелёного
authoritative run.
После commit `git status --short` обязан быть пустым; незакоммиченный manifest или generated output
считается blocker.

## Checkout identity и внешнее evidence

Каждый authoritative job выводит и проверяет checkout identity:

- explicit head run: `HEAD == github.event.pull_request.head.sha` либо push `HEAD == GITHUB_SHA`;
- merge-ref run: `HEAD` является test merge commit, `HEAD^1` равен ожидаемому base SHA, а `HEAD^2`
  равен ожидаемому correction head SHA.

Merge-ref run нельзя называть exact-head run. После финального code/docs/manifest commit динамические
`head SHA`, `base SHA`, tested merge SHA, run URL, attempt, checkout semantics, job results и точные
test counts сохраняются только в GitHub Check Run/job summary, mutable Draft correction PR
body/comment и CI artifact при наличии. `VALIDATION.md` после этого не изменяется.
Иными словами, dynamic SHA/run/attempt evidence всегда находится вне tracked final head.

## Manifest policy

`MANIFEST.sha256` содержит каждый tracked file кроме самого manifest. Формат — SHA-256, два пробела
и `./relative/path`; полный список сортируется `LC_ALL=C`. Manifest обновляется последним после
source, tests, docs, formatting и validation.

## Production границы

Зелёный correction CI разрешает только owner review. Он не разрешает merge, Ready transition,
deployment, migration вне CI, включение flags или rollout. До production отдельно требуются
HTTPS/WSS и proxy checks, одна realtime replica либо Redis adapter/distributed accounting, private
encrypted S3, hardened ImageMagick, cleanup/alerts, trainer MFA/gateway, privacy approval и
installed-PWA smoke.

Подробный контракт: [`docs/T12_TRAINER_CHAT.md`](docs/T12_TRAINER_CHAT.md).
