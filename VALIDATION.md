# Kinetra T12 — план и отчёт проверки

**Дата:** 2026-08-24

**Ветка:** `feature/t12-trainer-chat`

**Base commit:** `75e74de5d077464d3be129f9ed4f344223a35c0d`

**Объём:** T01–T13, включая T12 trainer chat и сохранённый T13 Web Push lifecycle

## Текущий статус

Локальная проверка стабилизированного T12 working tree завершена 2026-08-24. Этот файл намеренно не
объявляет код готовым к merge до PostgreSQL/Chrome проверок и зелёного GitHub Actions run на exact
head draft PR. `PASS` разрешён только для фактически выполненной команды; наличие source file или
строки marker не считается прохождением suite.

Base `75e74de` — merge T13 PR #12 в `develop`; его exact GitHub Actions run #96 был зелёным до
создания T12 branch. Этот T13 baseline является precondition, но не доказывает качество
последующих T12 изменений.

В текущей local среде отсутствуют PostgreSQL client/server и Chrome/Chromium. Поэтому реальные
PostgreSQL 17 concurrency/migration tests и Chrome browser acceptance остаются `CI REQUIRED` до
зелёного GitHub Actions run на exact T12 commit. Skip не может печатать соответствующий PASS marker.

## Матрица T12

| Проверка                                 | Статус      | Фактический результат                                  |
| ---------------------------------------- | ----------- | ------------------------------------------------------ |
| T13 base exact-head GitHub CI            | PASS        | run #96 на merge `75e74de` до T12                      |
| Structural contracts T01–T13 + T12       | PASS        | 2 544/2 544 checks                                     |
| TypeScript production + backend tests    | PASS        | shared, backend src/tests и frontend без ошибок        |
| ESLint                                   | PASS        | `eslint apps packages scripts`                         |
| Backend unit/API tests                   | PASS        | 116 total: 103 pass, 13 PostgreSQL skips, 0 fail       |
| Real Socket.IO authorization/delivery    | PASS        | real ephemeral server + `socket.io-client`             |
| Real ImageMagick photo security          | PASS        | ImageMagick 6.9.12-98, complete malicious matrix       |
| PostgreSQL 17 migration/concurrency      | CI REQUIRED | PostgreSQL отсутствует локально                        |
| Frontend unit/API/Service Worker tests   | PASS        | 130/130, 0 fail                                        |
| Chrome client+trainer browser acceptance | CI REQUIRED | Chrome/Chromium отсутствует локально                   |
| Production build                         | PASS        | backend + Vite production/browser-test, 126 modules    |
| Changed-file Prettier                    | PASS        | 104/104 файлов, local и CI-base режимы                 |
| Tracked source manifest                  | PASS        | 289/289 tracked source hashes проверены последними     |
| Composite quality gate                   | CI REQUIRED | только exact-head CI может закрыть environment markers |

Локальный backend suite намеренно не печатал PostgreSQL PASS marker: `DATABASE_URL`, `psql`,
`postgres` и `pg_ctl` отсутствуют. Локальный browser suite дошёл до запуска acceptance, но не мог
продолжить без Chrome/Chromium. Оба набора остаются fail-closed требованиями CI. Реальный Socket.IO suite и реальный
ImageMagick decoder доступны локально и прошли; они не заменялись fake browser seam или fake image
processor.

## Что обязан доказать backend

- append-only `011_trainer_chat.sql`; SHA-256 и содержимое `001`–`010` не изменены;
- один active default trainer и один conversation на client;
- concurrent create/send дают одну conversation и уникальные монотонные sequence;
- text/caption canonicalization одинакова в schema, service, PostgreSQL и tests;
- same `client_message_id` + fingerprint возвращает replay, conflicting retry даёт `409`;
- client читает только own conversation, trainer — только assigned; чужой и nonexistent ID дают
  одинаковый `CHAT_RESOURCE_NOT_FOUND`;
- chat доступен active client без Premium entitlement;
- read cursor только растёт, future cursor отклоняется, server unread пересчитывается корректно;
- commit завершается до REST response/event; retry existing message не делает второй broadcast;
- account/session проверяются по server-side JWT `sub`/`sid`, role не принимается от клиента;
- trainer grant/reassign/revoke транзакционны, не раскрывают PII/secrets и обеспечивают deletion
  guard `TRAINER_ACCOUNT_MANAGED`;
- account deletion создаёт durable media jobs до cascade, а trigger страхует остальные delete
  paths.

## Что обязан доказать real Socket.IO suite

Тест поднимает настоящий ephemeral HTTP + Socket.IO server и подключает настоящий
`socket.io-client`; browser fake seam его не заменяет.

- namespace `/chat`, WebSocket-only и 32 KiB payload cap;
- valid auth, missing/malformed/expired token и disallowed Origin;
- query token и spoofed role/room не дают authority;
- active refresh session и существование account проверяются на handshake;
- room выводится сервером, user A не получает user B, trainer видит только assigned updates;
- active socket limits и server disconnect на точной JWT `exp` границе; тест допускает только
  500 ms scheduling tolerance и доказывает отсутствие private event после expiry;
- `chat:message:new`, `chat:conversation:updated` и unread/`is_mine` имеют отдельную recipient
  projection;
- `chat:read:updated` не откатывает cursor;
- duplicate retry не rebroadcast-ится;
- reconnect с новым in-memory token и REST `after_sequence` восстанавливает missed event.

## Что обязан доказать photo security suite

Acceptance использует реальные ImageMagick `identify`/`convert`, а не fake decoder. Fake object
store разрешён для CI, внешний S3 не требуется.

- валидные JPEG, PNG, WebP и ошибочный declared Content-Type;
- rejection SVG, GIF, animated PNG/WebP, HEIC/HEIF, AVIF, PDF, corrupt, polyglot и extension spoof;
- hard 10 MiB input, 20 MP и 8 192 px limits до полной нормализации;
- subprocess memory/map/disk/thread/time/output limits, process concurrency 2 и bounded queue;
- auto-orient, strip EXIF/GPS/XMP, WebP quality 82, стороны ≤2 048, output ≤4 MiB;
- random non-PII object key и отсутствие raw/original filename;
- committed processing reservation до PUT; PUT success + ready update failure восстанавливается;
- same upload key/bytes, conflict bytes, `202` status polling, lease recovery и максимум 3 attempts;
- каждый фактически прочитанный multipart chunk списывается до size/parse checks, включая malformed
  и streamed-too-large requests; валидный upload не получает второе списание, direct service call
  без streamed admission остаётся учтён;
- global `(uploader, client_upload_id)` сериализуется между разными assigned conversations;
  real-PG barrier проверяет одинаковые/разные SHA и UUID key в разном регистре без raw `23505`;
- ready draft доступен только uploader, attached photo — только обоим участникам;
- stale/unattached cleanup, idempotent delete retry и durable backlog;
- missing S3 сохраняет text chat, но photo upload fail-closed.

Production smoke дополнительно обязан подтвердить закреплённую ImageMagick version, наличие только
нужных JPEG/PNG/WebP coders, hardened `policy.xml`, container CPU/memory/process limits и отсутствие
shell/original filename в subprocess invocation.

## Что обязан доказать frontend/browser

- role redirects и direct/reload/Back для `/chat`, `/trainer/chats` и parameterized detail route;
- FAB видна только на `/`, `/schedule`, `/progress`, `/settings`, скрыта в chat и blocking dialog;
- server badge 0/1/99/99+, safe-area и отсутствие overlap на 320/428/768 px;
- Settings открывает `/chat`; email fallback появляется только при controlled disabled/unavailable,
  но не при обычной network error;
- initial 30, older prepend без scroll jump, reconnect delta, dedupe/reorder и optimistic retry;
- hidden tab не отправляет read; visible opened conversation сбрасывает server badge после ack;
- draft только в user-scoped `sessionStorage`; logout/delete/account switch очищают draft и object
  URLs; chat content отсутствует в localStorage, IndexedDB и Cache API;
- offline разрешает редактировать draft, но блокирует send/upload и не создаёт background queue;
- trainer split pane ≥960 px и list/detail ≤959 px, assigned search/filter/sort/realtime update;
- selected trainer identity хранится независимо от текущего filter page; direct detail восстанавливает
  только точный authorized summary одним exact backend lookup независимо от глубины inbox и не
  рендерит composer/generic identity до успешного разрешения;
- photo preview/progress/retry/remove, short signed URL lifecycle и accessible fullscreen viewer;
- exhausted photo processing/terminal `409` скрывает retry и навсегда блокирует stale/double
  attempt для того же idempotency key до явного удаления файла;
- cross-tab subject switch не может повторить JSON/void/multipart request с токеном другого
  аккаунта; bearer-bound logout не очищает более новую origin-wide refresh cookie;
- login/refresh/logout требуют origin-wide Web Lock; browser без него fail-closed не отправляет
  cookie mutation, а logout никогда не делает предварительный rotating refresh;
- истёкший access допускается только как signed logout subject proof для его `sid` или потомка в той
  же refresh rotation chain; age limit отсутствует из-за sliding TTL, но tampered, future-issued и
  noncanonical proofs дают `401`, а unrelated family/account остаются активны;
- logout никогда не отдаёт `Set-Cookie`; bearerless legacy request — server-side no-op, поэтому
  поздний запрос старой вкладки не отзывает cookie нового аккаунта;
- refresh намеренно logout-revoked token без rotation replacement даёт `401` без reuse-cascade;
  theft-response revoke-all сохраняется для повторного использования реально rotated token;
- PostgreSQL refresh/logout используют общий lock order `user → refresh`; refresh-first logout
  отзывает target и все replacement descendants в proven family, logout-first не допускает
  replacement, unrelated family/account остаются активны;
- keyboard/touch/accessibility, light/dark/system и reduced motion;
- два независимых authenticated browser contexts client/trainer проходят realtime journey;
- non-trainer и cross-user IDs не раскрывают trainer/chat data.

## T13 coexistence

T12 не добавляет chat notification type, push preference или `/chat` в Service Worker push
deep-link allowlist. Существующие T13 markers и permission/settings/scheduler tests остаются
обязательными.

Logout синхронно disconnect-ит chat socket и очищает chat memory/draft/object URLs, но T13
best-effort push cleanup не получает unbounded дополнительный await. Account deletion сохраняет
captured-token strict unsubscribe→DELETE sequence: frontend не отправляет отдельные DELETE chat или
photo requests, а backend transaction создаёт media cleanup jobs. Browser acceptance должен
повторно доказать этот порядок после T12 integration.

## Обязательные T12 CI markers

Первые девять markers должны появиться только после фактических assertions. CI grep-ит их и лишь
затем печатает suite marker:

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
KINETRA_T12_TEST_SUITE=PASS
```

PostgreSQL skip не печатает `KINETRA_T12_POSTGRES_INTEGRATION=PASS`; отсутствие Chrome не печатает
browser marker; fake decoder не печатает photo marker; browser seam не печатает Socket
authorization marker. Все старые markers T04–T11 и T13 остаются обязательными.

## Полная последовательность проверки

```bash
cp .env.example .env
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

Operator/worker entrypoints дополнительно проверяются на built backend:

```bash
npm run chat:trainer:grant -w @kinetra/backend -- --help
npm run chat:trainer:reassign -w @kinetra/backend -- --help
npm run chat:trainer:revoke -w @kinetra/backend -- --help
```

`chat:media-cleanup` не является help/smoke-командой: worker изменяет photo rows/deletion jobs и
удаляет private objects через настроенные `DATABASE_URL`/S3 credentials. Его запускают только
scheduler-ом либо вручную против явно выбранного изолированного окружения после проверки target;
в локальном quality gate выше он намеренно не выполняется.

Локальное отсутствие infrastructure записывается как `CI REQUIRED`, а не заменяется ручным PASS.
После публикации draft PR нужно дождаться GitHub Actions на exact commit и перенести URL/run ID и
фактические результаты в эту матрицу.

## Manifest policy

`MANIFEST.sha256` содержит каждый tracked file кроме самого manifest. Формат строки — SHA-256, два
пробела и `./relative/path`; полный список сортируется `LC_ALL=C`. Manifest обновляется только
после source, tests, docs, formatting и validation, затем CI сравнивает path inventory и hashes.

## Production границы

Зелёный CI доказывает кодовые контракты, но не является разрешением включить T12. До rollout нужны:

- отдельное owner approval на merge и отдельное approval на production enablement;
- production HTTPS/WSS, proxy Upgrade/heartbeat, exact CORS и `TRUST_PROXY_HOPS`;
- одна realtime replica либо Redis Socket.IO adapter + distributed limits/accounting;
- private encrypted S3, server-only secrets, five-minute signed access и hardened ImageMagick;
- cleanup каждые ≤15 минут, non-zero exit alert и oldest backlog >24h alert;
- structured redacted logs, metrics/dashboard/alerts и physical-delete proof;
- отдельный verified trainer account с уникальным сильным паролем и MFA либо authenticated
  access gateway; shared account запрещён;
- privacy notice без обещания E2EE/device delivery, live/backup retention/deletion policy;
- desktop/iOS/Android installed-PWA smoke и photo load/malicious security test.

Flags остаются false до выполнения checklist. Rollback выполняется flags off без drop migration;
cleanup worker продолжает удалять уже поставленные objects. T12 не добавляет E2EE, chat push,
Telegram, presence или SLA ответа тренера.

Подробный контракт: [`docs/T12_TRAINER_CHAT.md`](docs/T12_TRAINER_CHAT.md).
