# Kinetra T13 — план и отчёт проверки

**Дата:** 2026-08-22

**Ветка:** `feature/t13-push-notifications`

**Base commit:** `4852bab67af2db9f309b0719b61d89d5d77537e6`

**Объём:** T01–T11 и T13, standalone PWA monorepo

## Текущий статус

T13 реализован обычными TypeScript/TSX/JavaScript/SQL/CSS/Markdown исходниками. Scope включает
device Web Push subscriptions, VAPID, JWT/no-store API, Service Worker `push`/`notificationclick`,
permission lifecycle в T10 settings и отдельный идемпотентный notification worker.

Матрица фиксирует фактический локальный прогон итогового дерева. `PASS` ставится только после
выполненной команды; проверки, которым необходимы отсутствующие локально PostgreSQL или Chrome,
помечены `CI REQUIRED` и не выдаются за локально пройденные.

## Матрица T13

| Проверка                           | Статус      | Фактический результат                                        |
| ---------------------------------- | ----------- | ------------------------------------------------------------ |
| Structural contracts T01–T13       | PASS        | `node scripts/verify-project.mjs` — 1828 checks              |
| TypeScript production + tests      | PASS        | `npm run typecheck` — shared/backend/tests/frontend          |
| ESLint                             | PASS        | `npm run lint`                                               |
| Backend unit/API tests             | PASS        | 76 pass, 0 fail, 9 PostgreSQL skips                          |
| PostgreSQL migration/integration   | CI REQUIRED | нет локальной БД; CI требует реальный PostgreSQL 17 marker   |
| Frontend unit/Service Worker tests | PASS        | 75 pass, 0 fail                                              |
| Chrome browser acceptance          | CI REQUIRED | Chrome/Chromium отсутствует; обязательный CI marker          |
| Production build                   | PASS        | shared/backend/frontend, Vite 71 module                      |
| Composite quality gate             | CI REQUIRED | доступные фазы PASS; полный `npm run check` завершается в CI |
| Tracked source manifest            | PASS        | полный sorted SHA-256 inventory без самого manifest          |

## Фактический локальный прогон

- `git fetch --all --prune` подтвердил `origin/develop` на base commit `4852bab`.
- `git diff --check` и Prettier check всех 41 изменённых/новых файлов прошли.
- `npm run typecheck`, `npm run lint` и `npm run build` прошли без ошибок.
- Backend выполнил 85 тестов: 76 прошли, 9 PostgreSQL tests честно пропущены только из-за
  отсутствующего `DATABASE_URL`; failed tests нет.
- Frontend unit/API/Service Worker suite: 75 прошли, failed/skipped tests нет.
- Sender test с реальным непрерывным локальным HTTP stream подтвердил hard wall-clock deadline,
  отсутствие накопления provider body и сохранение классификации `410`/`503`.
- API test подтвердил лимит 10 enabled devices, ротацию на границе, освобождение слота и
  fail-closed реактивацию; PostgreSQL test дополнительно фиксирует конкурентную границу и transfer
  в заполненного владельца, но его фактический запуск принадлежит CI.
- Миграции `001`–`009` не отличаются от base commit.
- Принудительный PostgreSQL test с `KINETRA_REQUIRE_POSTGRES_TEST=true` fail-closed требует
  `DATABASE_URL`; локально также отсутствуют `psql`, `postgres`, Docker и Podman.
- Browser runner не может завершить acceptance без Chrome/Chromium; ни один поддерживаемый
  executable локально не установлен. GitHub Actions остаётся обязательным владельцем обоих
  environment-dependent markers.
- `MANIFEST.sha256` сформирован последним из точного tracked path list и проверен через
  `sha256sum -c`.

## Сохранённый baseline T11

T13 начинается строго от merge T11 `4852bab`. Зафиксированный T11 baseline до изменений:

- structure — 1434 checks;
- backend — 58 pass и 7 PostgreSQL skips в локальной среде без БД;
- frontend — 61 pass;
- production build — shared/backend/frontend;
- manifest — 208 tracked-файлов без самого `MANIFEST.sha256`;
- exact GitHub Actions run T11 прошёл с PostgreSQL и Chrome markers.

T13 не заменяет этот baseline новым PASS. CI продолжает требовать все markers T04–T11 до проверки
новых T13 markers.

## Что обязана доказать структура

`scripts/verify-project.mjs` должен fail-closed проверить:

- append-only `010_push_notifications.sql`, не меняя `001`–`009`;
- `push_subscriptions` и durable per-device occurrence claims с cascade/unique/index contracts;
- backend feature-папку `push` с strict schema, repository, PostgreSQL repository, injectable
  sender, service, scheduler, router, runtime и built worker command;
- JWT/no-store `GET /public-key`, `POST/DELETE /subscriptions`, отсутствие `user_id` из body и
  минимальные shared DTO;
- server-only VAPID private key, public endpoint, safe payload/deep-link allowlist, bounded
  timeout/concurrency и status-specific invalidation;
- scheduler preference/timezone/entitlement/completion/weekly-metrics filters и уникальный claim;
- frontend permission/subscription module, явное settings действие, отсутствие prompt на
  hydration, logout best-effort и раздельные UI states;
- Service Worker `push`/`notificationclick`, same-origin route allowlist и сохранность offline/API
  cache policy;
- backend/frontend/PostgreSQL/browser tests, документацию и fail-closed CI markers;
- отсутствие `.t13-bootstrap`, apply/export workflow, encoded payload и PR-trigger artifacts.

## Backend acceptance

API/unit/PostgreSQL tests обязаны подтвердить:

- public key, register и delete требуют access JWT и отдают `Cache-Control: no-store`;
- public response не раскрывает private key, subscription keys или endpoint;
- strict HTTPS/base64url/length validation отклоняет missing/extra/oversized/user-owned fields;
- endpoint upsert идемпотентен, может принадлежать только authenticated user, delete не раскрывает
  и не меняет чужую запись;
- удаление аккаунта каскадно очищает subscriptions/deliveries;
- multi-device пользователь получает одно occurrence на каждую active subscription;
- повторный/параллельный worker не создаёт duplicate delivery;
- `404/410` отключают endpoint, а `401/403/429/5xx/timeout` не удаляют его;
- ошибка одной subscription не прерывает остальные;
- invalid timezone использует `Europe/Moscow`, fall-back DST occurrence не дублируется;
- workout reminder использует current program week + local weekday, active entitlement и
  completed state; weekly reminder отправляется только pending week в воскресенье local time;
- ambiguous send не получает автоматический retry в том же occurrence.

## Frontend и browser acceptance

Unit/API/Service Worker/browser tests обязаны подтвердить:

1. hydration `/settings` не вызывает permission prompt, subscribe или лишний T10 PUT;
2. T10 full payload и debounce 450 ms не изменены;
3. `unsupported`, `default`, `denied`, `granted` отображаются раздельно от browser subscription и
   backend registration;
4. VAPID public key читается только после явного действия;
5. failed backend registration не становится success и допускает retry;
6. logout делает best-effort push unregister до очистки access-сессии, но не блокирует `/login`;
7. Service Worker применяет defaults к malformed push и не принимает внешний/protocol-relative/
   `javascript:` URL;
8. notification click закрывает notification, фокусирует открытую вкладку либо открывает новую;
9. разрешены canonical `/schedule` и `/progress`, а auth/onboarding/paywall guards сохраняются;
10. settings остаётся доступным на 320/428px, touch targets не меньше 44px, theme/safe-area и все
    browser journeys T04–T11 не деградируют.

Browser acceptance использует deterministic native/injectable seams и не зависит от внешнего push
service. `KINETRA_T13_BROWSER_E2E=PASS` печатается только после фактических assertions.

## Обязательные CI markers

```text
KINETRA_T13_WEBPUSH_SENDER=PASS
KINETRA_T13_BACKEND_E2E=PASS
KINETRA_T13_POSTGRES_INTEGRATION=PASS
KINETRA_T13_SCHEDULER=PASS
KINETRA_T13_SERVICE_WORKER=PASS
KINETRA_T13_PERMISSION_LIFECYCLE=PASS
KINETRA_T13_SETTINGS_INTEGRATION=PASS
KINETRA_T13_BROWSER_E2E=PASS
KINETRA_T13_TEST_SUITE=PASS
```

CI выполняет tests с `tee`, отдельно grep-ит первые восемь markers и печатает suite marker только
после их наличия. PostgreSQL skip не печатает integration marker. Старые markers T04–T11 остаются
обязательными.

## Команды полной проверки

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:migrate
npm run db:seed
npm run db:seed
npm run db:verify-content
npm run verify:structure
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend:unit
npm run test:frontend:browser
npm run build
npm run check
diff -u \
  <(git ls-files | sed '/^MANIFEST\.sha256$/d' | sed 's#^#./#' | LC_ALL=C sort) \
  <(awk '{ print $2 }' MANIFEST.sha256 | LC_ALL=C sort)
sha256sum -c MANIFEST.sha256
```

Worker отдельно проверяется только с test configuration/injectable sender, без обращения к
реальному push service:

```bash
npm run notifications:send -w @kinetra/backend
```

## Manifest policy

`MANIFEST.sha256` содержит каждый tracked-файл кроме самого manifest. Формат строки — SHA-256,
два пробела и путь `./relative/path`; полный path list отсортирован `LC_ALL=C`. Manifest обновляется
последним, после форматирования и всех source/test/docs изменений. CI сначала сравнивает path list
с `git ls-files`, затем выполняет `sha256sum -c`.

## Production границы

До rollout нужны HTTPS, production VAPID pair в secret manager, controlled subject, минутный
external scheduler, non-zero exit alerts, metrics по send/invalidation/temporary failure/duplicate/
backlog и проверенная redaction policy. Public key нельзя ротировать без re-subscription plan.

Нужно отдельно проверить installed PWA/desktop/iOS permission UX, Service Worker update,
notification click, DST/timezone changes, toggles, logout/account deletion и повторную
авторизацию. Push body не содержит premium content и не обходит T11 server-enforced paywall.
Stale endpoint после полной browser rotation может существовать до `404/410`, потому что frontend
не может перечислить прежние subscriptions устройства.

Подробный контракт: [`docs/T13_PUSH_NOTIFICATIONS.md`](docs/T13_PUSH_NOTIFICATIONS.md).
