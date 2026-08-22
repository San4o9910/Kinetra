# T13 — Web Push уведомления

T13 добавляет Web Push для standalone PWA Kinetra без Telegram, email/SMS fallback и внешнего
push-провайдера. Браузер создаёт стандартную `PushSubscription`, backend хранит подписки
устройств и отправляет уведомления через VAPID, а отдельный worker выбирает due-события и
защищает каждую доставку от дублей.

Push не меняет T10 notification contract. `workout_reminders`, `reminder_time` и
`weekly_survey_reminder` по-прежнему сохраняются одним полным debounced PUT с задержкой 450 ms.
Настройка типа уведомления, browser permission, device subscription и успешная регистрация на
backend — четыре разных состояния.

## HTTP API

Базовый путь: `/api/v1/push`. Все endpoints требуют `Authorization: Bearer <access JWT>`, берут
`user_id` только из проверенного JWT и отвечают с `Cache-Control: no-store`.

### `GET /api/v1/push/public-key`

Возвращает только публичный VAPID key:

```json
{
  "public_key": "<base64url public key>"
}
```

Если Web Push не настроен, backend возвращает безопасную стабильную ошибку
`PUSH_NOT_CONFIGURED`. Private key, VAPID subject и диагностические детали в response не попадают.

### `POST /api/v1/push/subscriptions`

Строгий запрос:

```json
{
  "endpoint": "https://push-service.example/subscription-id",
  "keys": {
    "p256dh": "<base64url>",
    "auth": "<base64url>"
  },
  "expirationTime": null
}
```

`endpoint` обязан быть HTTPS URL длиной не более 4096 символов, без credentials/fragment,
`localhost` и явных private/link-local IP literals; ключи — непустые ограниченные base64url строки.
Неизвестные поля, включая `user_id`, отклоняются с `INVALID_PUSH_SUBSCRIPTION`. Повторная
регистрация endpoint тем же JWT-пользователем идемпотентно обновляет ключи, expiration, bounded
`User-Agent` и снимает `disabled_at`. Передача глобально уникального endpoint другому
JWT-пользователю разрешена только при точном совпадении сохранённых и присланных `p256dh` + `auth`;
иначе возвращается неэнумерирующий `409 PUSH_SUBSCRIPTION_CONFLICT`, а запись не изменяется.

Один пользователь может иметь не более 10 enabled subscriptions, где enabled означает строго
`disabled_at IS NULL`: истёкший, но ещё не отключённый endpoint тоже занимает слот. Новая запись,
реактивация disabled endpoint и подтверждённая передача endpoint другому пользователю требуют
свободного слота; ротация ключей уже enabled endpoint текущего владельца разрешена и при лимите.
При нехватке слота POST возвращает тот же неэнумерирующий `409 PUSH_SUBSCRIPTION_CONFLICT`.
Успешный DELETE освобождает слот.

Успешный минимальный ответ:

```json
{
  "subscribed": true
}
```

Полный endpoint, `p256dh`, `auth` и user agent обратно клиенту не возвращаются.

### `DELETE /api/v1/push/subscriptions`

Строгий запрос:

```json
{
  "endpoint": "https://push-service.example/subscription-id"
}
```

Операция идемпотентна и возвращает `204 No Content`. Она может деактивировать только endpoint,
принадлежащий текущему JWT-пользователю; наличие чужого endpoint не раскрывается. Невалидный body
даёт `INVALID_PUSH_UNSUBSCRIBE`.

POST и DELETE mutations используют общий fixed-window лимит: не более 60 запросов с одного IP за
60 секунд. Превышение возвращает `429`, `Retry-After` и стабильный код `PUSH_RATE_LIMITED`.
Счётчики находятся только в памяти текущего backend process: несколько replicas имеют независимые
окна, а рестарт обнуляет состояние. Лимит дополняет JWT и строгую валидацию, но для production
нужен централизованный edge/distributed limiter и корректный `TRUST_PROXY_HOPS`.

## Миграция `010_push_notifications.sql`

Append-only миграция создаёт две user-owned таблицы:

- `push_subscriptions` — несколько устройств пользователя: UUID, `user_id`, уникальный HTTPS
  `endpoint`, `p256dh`, `auth`, nullable `expiration_time`, bounded nullable `user_agent`,
  `created_at`, `updated_at`, `last_success_at`, `last_failure_at`, `disabled_at`;
- `push_notification_deliveries` — durable claim каждой попытки для конкретной subscription:
  пользователь, subscription, notification type, deterministic `occurrence_key`, состояние и
  timestamps безопасной диагностики.

`push_subscriptions_endpoint_unique_idx` задаёт глобальную уникальность endpoint для всех записей,
включая disabled: это не partial index и не уникальность только внутри пользователя. `ON CONFLICT`
повторно использует одну запись и реактивирует её. Текущий владелец может ротировать ключи; смена
владельца требует совпадения обоих proof-of-possession ключей с сохранённой записью.
`push_notification_deliveries_occurrence_unique_idx` обеспечивает не более одной claim для
subscription + user + тип + occurrence. User/subscription foreign keys используют
`ON DELETE CASCADE`, поэтому удаление аккаунта удаляет device subscriptions и их delivery history.

Лимит 10 enabled subscriptions — транзакционный application invariant, а не SQL `CHECK`: каждый
upsert сначала блокирует строку целевого `users` через `FOR UPDATE`, затем проверяет endpoint и
считает `disabled_at IS NULL`. Это сериализует параллельные регистрации одного пользователя на
границе лимита; существующий partial index `push_subscriptions_user_active_idx` обслуживает count.

Файлы `001`–`009` неизменяемы: migration runner хранит их SHA-256, выполняется под PostgreSQL
advisory lock и отклоняет изменение уже применённого SQL.

### Ротация browser subscription

Повторный POST владельца того же endpoint обновляет одну глобально уникальную запись. Если браузер
заменил и ключи, и сам endpoint, новый URL является другой записью: backend не может доказуемо
связать её со старой, а frontend знает только текущую browser subscription и не может перечислить
прежние endpoints. Оставшаяся stale-запись исключается при истёкшем `expiration_time` либо
отключается только после `404/410` от push service; автоматического retention cleanup в T13 нет.

Пока старый endpoint остаётся активным, worker считает его отдельным устройством и может отправить
одно логическое событие и на старую, и на новую subscription. Per-device unique claim блокирует
повтор той же delivery на последующих worker runs, но не устраняет cross-subscription duplicate для
одного физического устройства после rotation. Это известное ограничение требует отдельной
inventory/retention policy или подтверждённого endpoint-replacement протокола.

## Endpoint trust и SSRF

API validation отсекает HTTP, credentials, fragments, `localhost`, loopback, private, link-local и
другие непубличные IP literals. Перед каждым transport connection отдельный HTTPS agent разрешает
hostname через собственный `lookup`, проверяет **все** полученные IPv4/IPv6-адреса и fail-closed
отклоняет соединение, если ответ пуст, некорректен либо содержит private, link-local, loopback,
documentation, benchmark, multicast, reserved или cloud-metadata address range. Проверенный адрес
передаётся непосредственно `https.request`; keep-alive выключен, поэтому новый connection проходит
проверку заново. Это закрывает validation-to-connect DNS rebinding внутри текущего sender path.

Provider allowlist в T13 не реализован. Production deployment всё равно должен ограничить outbound
Web Push traffic через независимый egress proxy/firewall: разрешать только необходимый HTTPS/443,
запрещать private/link-local/loopback и cloud metadata destinations, контролировать DNS/redirect
policy и мониторить необычные destination/status patterns. Это defence-in-depth сверх встроенной
connection-time DNS/IP проверки и защита на случай будущего альтернативного transport path.

## VAPID configuration

```dotenv
VAPID_PUBLIC_KEY=<public base64url key>
VAPID_PRIVATE_KEY=<server-only private base64url key>
VAPID_SUBJECT=mailto:coach@kinetra.app
```

Сгенерировать отдельную пару для local development можно установленной runtime dependency:

```bash
npm exec -w @kinetra/backend -- web-push generate-vapid-keys
```

Ключи переносятся в локальный `.env`; реальные значения не коммитятся. Private key запрещён в
`VITE_*`, browser bundle, API responses, logs и CI artifacts. Production runtime/worker fail-closed
завершается при отсутствующем или неполном VAPID configuration. Тесты используют injectable fake
sender или явно test-only deterministic configuration, а не production secrets.

Parser принимает base64url public key длиной 80–128 символов, private key длиной 40–128 и subject
только с `mailto:` или `https:`. Неполный набор отклоняется в любом окружении. Вне production
полностью отсутствующий набор допустим для запуска остальных функций: push API отвечает
`PUSH_NOT_CONFIGURED`, а one-shot worker завершается с ошибкой; в production обязательны все три
значения.

`VAPID_PUBLIC_KEY` следует считать стабильным идентификатором подписок. Его ротация требует
плана повторной подписки устройств; простая замена ключа может сделать существующие subscriptions
непригодными.

## Permission и device lifecycle

1. Первоначальный render/hydration `/settings` читает T10 preferences и может проверить уже
   существующую browser subscription. Он не вызывает `Notification.requestPermission()`,
   `PushManager.subscribe()`, public-key endpoint, backend registration или лишний PUT.
2. Public VAPID key запрашивается только после отдельного действия пользователя.
3. При `default` UI предлагает осознанно разрешить уведомления; при `denied` показывает инструкцию
   браузера и повторно prompt не вызывает; `unsupported` не обещает поддержку.
4. После `granted` frontend ждёт готовую registration `/service-worker.js`, выполняет
   `subscribe({ userVisibleOnly: true, applicationServerKey })` и POST на backend.
5. Успех browser subscribe без успеха backend POST не отображается как «устройство подключено».
   Состояние остаётся recoverable, чтобы пользователь мог повторить регистрацию.
6. Явное отключение устройства сначала best-effort удаляет endpoint на backend, затем вызывает
   browser `unsubscribe()`. T10 toggles сами device subscription не удаляют.
7. Logout выполняет best-effort unregister текущего endpoint до очистки access-сессии, но ошибка
   push backend не блокирует переход на `/login`. Account deletion дополнительно защищён
   `ON DELETE CASCADE`.

Access token остаётся только в памяти и никогда не сохраняется в `localStorage`.

## Service Worker и deep links

Существующий `apps/frontend/public/service-worker.js` сохраняет install/activate/offline/fetch
поведение и добавляет `push` и `notificationclick`.

Push payload — компактный JSON с `type`, `title`, `body`, `url` и `occurrence_key`. Service Worker
безопасно обрабатывает пустой/malformed payload, применяет локальные defaults и никогда не пишет
payload в production console. Разрешены только same-origin маршруты:

- workout reminder → `/schedule`;
- weekly survey reminder → `/progress`;
- всё неизвестное, внешнее, protocol-relative, `javascript:` или malformed → `/`.

При клике notification закрывается; Service Worker фокусирует подходящую открытую Kinetra window
и навигирует её на разрешённый URL либо открывает новую window. Обычные auth, onboarding и
subscription/paywall guards продолжают определять фактический доступ после открытия.

## Scheduler

Worker собирается вместе с backend и запускается отдельно от Express:

```bash
npm run build -w @kinetra/backend
npm run notifications:send -w @kinetra/backend
```

Production scheduler вызывает команду **каждую минуту**. В HTTP process нет бесконечного
`setInterval`. Один запуск завершается агрегированным результатом `selected`, `claimed`, `sent`,
`invalidated`, `skipped`, `failed`, `duplicated` и ненулевым exit code при инфраструктурной
ошибке. Ошибка отдельной subscription не останавливает обработку остальных. Send pool использует
concurrency 8 по умолчанию; constructor принимает только целое значение 1–32. В текущем production
runtime это не env-настройка.

### Timezone и DST

Источник timezone — `users.timezone`. Значение проверяется как IANA timezone; отсутствующее или
невалидное значение использует явно зафиксированный fallback `Europe/Moscow`. Timezone по IP не
угадывается.

Событие due, когда локальные часы и минуты пользователя совпадают с T10 `reminder_time`.
Повторившаяся при осеннем DST минута не создаёт второй push благодаря occurrence key. Если
локальное время не существует при весеннем переходе, событие в этот день пропускается; worker не
угадывает другое время. Смена timezone влияет только на ещё не claimed occurrences.

### Workout reminder

Worker использует canonical current program week и локальный weekday пользователя. Due workout —
day текущей program week, чей `day_of_week` совпадает с локальным днём недели. Он пропускается,
если T10 toggle выключен, доступ не разрешён canonical program/paywall contract с active
entitlement, workout уже завершён или доменная программа недоступна.

Body не содержит premium workout description/video URL. Deep link всегда `/schedule`.
Occurrence key стабилен для пользователя, program week, workout/day и локальной ISO-даты.

### Weekly survey reminder

T10 не хранит отдельный день недели, поэтому T13 фиксирует минимальную совместимую политику:
напоминание due **в воскресенье по локальному календарю** в общем `reminder_time`. Payload ведёт
на `/progress`. Worker использует canonical current program week/progress state и пропускает
событие, если `weekly_survey_reminder` выключен или weekly metrics этой недели уже заполнены.
Occurrence key включает current program week; user, notification type и device subscription входят
в уникальную delivery identity отдельно.

### Claim и ambiguous delivery

Перед provider call worker атомарно создаёт delivery claim. Unique constraint защищает два
параллельных или повторных запуска. Одно логическое событие разрешено на каждую активную device
subscription пользователя, но не дважды на одну subscription.

Успешный send фиксирует `last_success_at`. `404/410` означает permanently invalid subscription и
идемпотентно устанавливает `disabled_at`. `401/403/429/5xx` и timeout фиксируют безопасный failure
state, но subscription не удаляют.

Timeout или разрыв соединения может означать, что provider уже принял сообщение. Поэтому T13
выбирает at-most-once policy: ambiguous send автоматически не повторяется с новой claim в том же
occurrence. Это сознательно предпочитает возможный пропуск дублирующему уведомлению. Отдельный
операторский replay без новой формальной idempotency policy не предусмотрен.

## Payload и observability

Sender принимает title длиной 1–100, body 1–240 и `occurrence_key` 1–512 символов; весь
serialized payload ограничен 3072 bytes. Transport options фиксированы: TTL 3600 seconds, urgency
`normal`, hard wall-clock deadline 10 seconds. Непрерывный streaming response не продлевает
deadline; provider response body не накапливается и отбрасывается. Payload не содержит JWT,
refresh cookie, email, телефон, payment
metadata, VAPID private key, `p256dh`, `auth`, полный endpoint или premium content. Type/URL проходит
server-side allowlist до отправки.

Текущая реализация выводит агрегированный worker summary при успехе. При инфраструктурной ошибке
она пишет общий prefix вместе с пойманным error object; это не заменяет production structured
logging/redaction review. Delivery table хранит status, bounded error code и timestamps, а
subscription — `last_success_at`/`last_failure_at`. Sender нормализует provider status в
`http_<status>`, timeout в `network_timeout`, остальные transport errors в `network_error` и сам не
логирует provider response. Subscription JSON, endpoint, keys, credentials и PII логировать
запрещено; возможные infrastructure errors должны проходить redaction на уровне logger/collector.

Metrics exporter, dashboard, alert transport и отдельный backlog gauge в T13 не реализованы.
Production observability должна экспортировать selected/claimed/sent, 404/410 invalidation,
429/5xx/timeouts, skipped by preference/entitlement/completion, duplicate claims и backlog; alerts
должны покрывать non-zero worker exit, отсутствие минутных runs, рост failures/invalidations и
застрявшие claims. Request/run correlation и log redaction требуют отдельной deployment-настройки.

## Local development и проверки

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:migrate
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
sha256sum -c MANIFEST.sha256
```

Frontend browser acceptance не обращается к внешнему push service: permission/subscription seams
и Service Worker события проверяются детерминированно, а marker печатается только после реальных
assertions. PostgreSQL integration может skip-нуться локально без `DATABASE_URL`, но CI задаёт
`KINETRA_REQUIRE_POSTGRES_TEST=true` и требует настоящий marker.

## Production checklist

- Frontend и backend работают по HTTPS; Service Worker scope и production origin проверены.
- Отдельная production VAPID pair хранится в secret manager; subject принадлежит контролируемому
  адресу; private key отсутствует в git, frontend bundle, logs и artifacts.
- Для ротации public key подготовлен rollout/re-subscription plan.
- Migration `010` проверена на пустой и существующей базе; `001`–`009` не изменены; rollback
  выполняется forward-fix миграцией, а не переписыванием истории.
- Внешний scheduler запускает worker каждую минуту, контролирует non-zero exit и не создаёт
  конкурирующие незащищённые retries.
- Централизованный limiter заменяет per-process counters; `TRUST_PROXY_HOPS` проверен на реальной
  proxy topology.
- Встроенный connection-time DNS/IP guard и независимая egress policy блокируют
  private/link-local/metadata destinations; Web Push HTTPS traffic/redirects контролируются как
  SSRF defence-in-depth.
- Alerting/metrics integration покрывает отсутствие runs, failures, invalidations, duplicate
  claims, stuck claims и backlog; logs прошли redaction review.
- Проверены rate/body/field limits, JWT, CORS и `Cache-Control: no-store` push endpoints.
- Проверены default/granted/denied/unsupported, installed PWA, desktop, Service Worker update,
  открытая/закрытая вкладка и notification click.
- Проверены DST, invalid timezone fallback, смена timezone, оба выключенных toggle, logout,
  account deletion и повторная авторизация.
- Push body не раскрывает premium content и не обходит server-enforced paywall.

## Известные browser limitations

Web Push зависит от браузера, ОС, permission policy и режима установки PWA. На iOS доступность
может требовать установленную на Home Screen PWA и поддерживаемую версию системы. В private mode,
корпоративной политике или при запрете notification permission API может быть недоступен. Kinetra
показывает честное unsupported/denied состояние и не реализует скрытый email/SMS fallback.

Технические ориентиры: [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API),
[PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe),
[push event](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event),
[notificationclick](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event),
[showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)
и [web-push](https://www.npmjs.com/package/web-push).
