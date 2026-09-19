# T12 — встроенный чат с тренером

T12 добавляет в standalone PWA Kinetra приватный диалог один-на-один между клиентом и
назначенным тренером. PostgreSQL остаётся источником истины для conversation, порядка сообщений,
идемпотентности, unread/read state и авторизации. Socket.IO используется только для realtime
fan-out после commit; потерянное событие восстанавливается через REST delta sync.

Чат не зависит от Kinetra Premium: клиент с `onboarding_status=active` может читать и отправлять
сообщения независимо от состояния подписки. T12 не добавляет Telegram, push о сообщениях,
присутствие «тренер онлайн», typing indicator, звонки, произвольные файлы, редактирование,
удаление отдельных сообщений, поиск по тексту или экспорт переписки.

## Клиентский интерфейс

Диалог открывается нижней вкладкой «Тренер», сохраняет `/chat`, unread badge и правила доступа.
Поле ввода занимает свободную ширину: без фото-доступа используются две колонки
`minmax(0, 1fr) auto`; с фото-доступом — `44px minmax(0, 1fr) auto`. Это устраняет сжатие
textarea до 44 px при отключённой загрузке фото. Верхняя шапка профиля учитывается в высоте
чата, чтобы composer оставался над нижней навигацией. Текст ввода — 16 px, touch targets — 44 px.

При действующем серверном photo flag доступны только JPEG, PNG и WebP с прежними приватной
загрузкой, обработкой и авторизацией. Произвольные файлы и короткие видео не добавляются:
это отдельная T15 с миграцией и собственными PostgreSQL 17/S3/browser gates.

## Роли и маршруты

Публичная регистрация по-прежнему создаёт только обычный client account и не принимает `role`.
Роль вычисляется backend по актуальной active записи `trainer_profiles`; frontend, JWT body и
Socket.IO client не могут назначить `trainer_id`, `user_id`, room или role.

- `client` видит только свой единственный conversation. Он может открыть `/chat` только после
  завершения onboarding.
- `trainer` — отдельная, заранее созданная и подтверждённая auth account с active trainer profile.
  Он видит только conversations, где `trainer_user_id` равен JWT `sub`, и после входа попадает на
  `/trainer/chats`.
- `/trainer/chats/:conversationId` открывает конкретный назначенный диалог. Frontend guard нужен
  для UX; security boundary всегда находится в backend.

Conversation создаётся идемпотентно после первого явного открытия `/chat` клиентом и закрепляется
за текущим active default trainer. Смена default trainer не переназначает существующие диалоги.
После создания даже пустой conversation появляется в inbox назначенного тренера, и тренер может
написать первым.

Профиль `/api/v1/me` содержит `account_role: "client" | "trainer"`; для тренера дополнительно
возвращается безопасный `trainer_profile` с display name и avatar URL. Avatar читается из
`users.avatar_url`, а не дублируется в chat tables.

## Миграция и durable state

Append-only migration `apps/backend/migrations/011_trainer_chat.sql` добавляет:

- `trainer_profiles` с одним active default trainer;
- `chat_conversations` с уникальным `client_user_id`, назначенным trainer, server sequence,
  отдельными read cursor и unread count для обеих ролей;
- `chat_messages` с immutable sequence, sender snapshot, `client_message_id`, request fingerprint
  и необязательной ссылкой на одно фото;
- `chat_photos` с committed processing reservation, lifecycle lease, normalized metadata и
  уникальным `client_upload_id` на uploader;
- `chat_media_deletion_jobs` — durable очередь физического удаления private objects без foreign
  key на удаляемого пользователя или photo row.

Удаление `chat_photos` запускает защитный trigger, который до исчезновения metadata идемпотентно
ставит `object_key` в deletion queue. Миграции `001`–`010` не изменяются; rollback T12 выполняется
feature flags или новой forward-fix migration, но не переписыванием применённого SQL.

## REST API

Базовый путь — `/api/v1/chat`. Каждый endpoint требует
`Authorization: Bearer <access JWT>`, проверяет текущего пользователя и refresh session по
server-side `sub`/`sid`, использует strict schemas и отвечает с `Cache-Control: no-store` и
`Pragma: no-cache`. Неизвестные и недоступные IDs возвращают одинаковый
`404 CHAT_RESOURCE_NOT_FOUND`.

| Метод | Путь                                      | Роль            | Назначение                                       |
| ----- | ----------------------------------------- | --------------- | ------------------------------------------------ |
| GET   | `/api/v1/chat/session`                    | client/trainer  | Role-specific bootstrap и server unread          |
| POST  | `/api/v1/chat/conversations`              | client          | Идемпотентно создать/получить personal dialog    |
| GET   | `/api/v1/chat/conversations`              | trainer         | Assigned inbox, filter/search/keyset cursor      |
| GET   | `/api/v1/chat/conversations/:id`          | trainer         | Exact assigned summary для безопасного deep link |
| GET   | `/api/v1/chat/conversations/:id/messages` | participant     | Latest, older или reconnect delta history        |
| POST  | `/api/v1/chat/conversations/:id/messages` | participant     | Durable text/photo send                          |
| PUT   | `/api/v1/chat/conversations/:id/read`     | participant     | Монотонно подтвердить read cursor                |
| POST  | `/api/v1/chat/conversations/:id/photos`   | participant     | Подготовить один normalized photo attachment     |
| GET   | `/api/v1/chat/photos/:photoId/status`     | uploader        | Восстановить upload после timeout/`202`          |
| GET   | `/api/v1/chat/photos/:photoId/access`     | authorized user | Получить короткий private signed GET URL         |

`POST /conversations` принимает строго `{}` и возвращает `201` для новой записи или `200` для
существующей. При отсутствии active default trainer возвращается
`503 CHAT_TRAINER_UNAVAILABLE`; feature flag off даёт `503 CHAT_DISABLED`.
Обе role-specific формы bootstrap также возвращают server-authoritative
`photo_uploads_enabled`; frontend не показывает действие загрузки, пока backend flag и private
storage не готовы.

Trainer inbox принимает `filter=all|unread`, `limit=1..50`, opaque cursor и server-side `query`
длиной 2–100 символов. Поиск выполняется только по разрешённым profile fields внутри assigned
conversations, но не по message text. Порядок —
`COALESCE(last_message_at, created_at) DESC`, затем conversation ID как стабильный tie-breaker.
Response использует display name и masked secondary label; survey, medical data, полный email,
телефон, session IDs и storage key не возвращаются.

Trainer deep link получает identity через один exact
`GET /api/v1/chat/conversations/:id`, поэтому разрешённый диалог открывается независимо от его
позиции и количества страниц inbox. Endpoint возвращает summary только текущему назначенному
trainer; отсутствующий или чужой conversation даёт тот же `404 CHAT_RESOURCE_NOT_FOUND`, а
client-вызов trainer-only endpoint — `403 CHAT_NOT_AVAILABLE`. Пока exact lookup не завершён,
frontend не подставляет generic identity и не монтирует composer.

History без cursor возвращает последние 30 сообщений. `before_sequence` загружает старые страницы,
`after_sequence` — пропущенный reconnect delta; оба cursor одновременно запрещены. Страница всегда
отсортирована по server sequence по возрастанию и содержит canonical `conversation_state`, поэтому
own/counterpart read state восстанавливается после reload без WebSocket event.

Стабильные публичные ошибки не содержат чужой UUID, object key или decoder/provider details:

| HTTP | Код                                | Смысл                                           |
| ---: | ---------------------------------- | ----------------------------------------------- |
|  400 | `CHAT_INVALID_REQUEST`             | malformed body/query/cursor                     |
|  401 | `AUTHENTICATION_REQUIRED`          | access JWT/session отсутствует или невалиден    |
|  403 | `CHAT_NOT_AVAILABLE`               | onboarding/feature policy                       |
|  404 | `CHAT_RESOURCE_NOT_FOUND`          | resource отсутствует или не авторизован         |
|  409 | `CHAT_IDEMPOTENCY_CONFLICT`        | message key повторён с другим payload           |
|  409 | `CHAT_UPLOAD_IDEMPOTENCY_CONFLICT` | upload key повторён с другими bytes             |
|  202 | `CHAT_PHOTO_PROCESSING`            | upload с тем же key ещё обрабатывается          |
|  409 | `CHAT_PHOTO_NOT_READY`             | attachment ещё не готов                         |
|  409 | `CHAT_PHOTO_ALREADY_ATTACHED`      | attachment уже использован                      |
|  409 | `CHAT_PHOTO_RETRY_EXHAUSTED`       | исчерпаны bounded attempts                      |
|  409 | `TRAINER_ACCOUNT_MANAGED`          | trainer имеет assigned или historical chat data |
|  413 | `CHAT_PHOTO_TOO_LARGE`             | source превышает 10 MiB                         |
|  415 | `CHAT_PHOTO_UNSUPPORTED`           | формат/animation не поддерживается              |
|  422 | `CHAT_MESSAGE_INVALID`             | canonical text/caption не проходит ограничения  |
|  422 | `CHAT_PHOTO_INVALID`               | corrupt/dimension/pixel/decoder failure         |
|  429 | `CHAT_RATE_LIMITED`                | запрос или processing queue превысили лимит     |
|  503 | `CHAT_DISABLED`                    | feature flag выключен                           |
|  503 | `CHAT_TRAINER_UNAVAILABLE`         | active default trainer отсутствует              |
|  503 | `CHAT_PHOTO_STORAGE_UNAVAILABLE`   | private storage/processor недоступен            |

## Текст, порядок и идемпотентность

Текстовое сообщение содержит `client_message_id`, `kind="text"` и `text`. Photo message содержит
тот же client id, `kind="photo"`, готовый `photo_id` и необязательную подпись в `text`.

- plain text: 1–2 000 Unicode code points;
- photo caption: отсутствует либо 1–1 000 Unicode code points;
- whitespace-only body, NUL и C0 controls кроме TAB/LF отклоняются;
- HTML, Markdown, link previews и executable content не поддерживаются;
- сообщение после commit неизменно и не имеет edit/delete API.

Canonicalization одинакова в schema, service и tests: CRLF/lone CR становятся LF, строка
нормализуется в NFC, Unicode White_Space удаляется только по краям, внутренние tabs/spaces/newlines
сохраняются, длина считается по Unicode code points.

В transaction отправки conversation блокируется `FOR UPDATE`, участник проверяется из JWT,
sequence берётся из `next_sequence`, увеличивается только counterpart unread, затем выполняется
commit. Только после commit event hub публикует canonical domain event. `client_message_id`
является idempotency key: тот же key и fingerprint возвращает существующее сообщение без нового
broadcast (`200`), а другой canonical payload даёт `409 CHAT_IDEMPOTENCY_CONFLICT`. Новая запись
возвращает `201`.

Read cursor также обновляется под lock через `GREATEST`. Future cursor отклоняется, повторный
запрос идемпотентен, unread пересчитывается только по входящим сообщениям после cursor. Получение
Socket event само по себе не помечает сообщение прочитанным: frontend отправляет read только при
открытом conversation, `document.visibilityState=visible` и фактически загруженной странице.

## Socket.IO realtime

Realtime использует namespace `/chat`, только WebSocket transport и
`maxHttpBufferSize=32 KiB`. Access JWT передаётся исключительно как
`socket.auth.accessToken`; token в URL, query, cookie, localStorage или room name запрещён.

Handshake выполняет:

1. exact Origin allowlist;
2. pinned JWT algorithm, issuer, audience, type и expiry;
3. проверку существования `sub` и active refresh session `sid`;
4. актуальное определение client/trainer role из PostgreSQL;
5. присоединение только к server-derived room `account:<user-id>`;
6. connection limit и disconnect не позже JWT expiry с clock tolerance.

Server events:

- `chat:message:new` — recipient-specific message DTO; `is_mine` вычисляется отдельно для каждого
  room;
- `chat:conversation:updated` — canonical summary и recipient-specific unread count, включая
  событие создания пустого conversation;
- `chat:read:updated` — reader role и монотонный `through_sequence`;
- `chat:session:invalidated` — безопасный сигнал завершить session/reconnect без token details.

Client event `chat:sync` сообщает только последний известный sequence; history не передаётся
unbounded event. Admission по подтверждённым handshake `userId` и IP выполняется синхронно до
первого `await` и DB query. Одновременно допускается не более одного sync для пары
socket/conversation, четырёх для socket и восьми для principal на всех его sockets; guards
освобождаются после success/error. Disconnect немедленно снимает socket ownership и запрещает ACK,
но уже начатая storage operation остаётся учтённой в principal cap до её terminal settlement, чтобы
reconnect churn не обходил aggregate limit. После reconnect клиент получает свежий in-memory token,
подключается и повторяет `GET messages?after_sequence=...` до `has_more_after=false`.

Persisted canonical messages merge/dedupe-ятся только по server `message.id`.
`client_message_id` применяется исключительно для замены собственного optimistic message при
совпадении conversation, own role и payload/photo fingerprint; одинаковый client key разных
senders не объединяет сообщения. PostgreSQL, а не delivery event, остаётся доказательством
отправки.

Realtime fanout сначала получает короткий согласованный conversation/recipient snapshot, затем
commit/rollback и release PostgreSQL client. Socket/session validation и emit выполняются только
после release. Перед delivery repository повторно проверяет актуальное участие и assignment, так
что reassigned/inactive trainer, revoked session и stale participant snapshot не получают event.

Без Socket.IO Redis adapter backend с realtime запускается только в одной replica. Sticky sessions
не обеспечивают cross-instance broadcast. Перед масштабированием обязательны Redis pub/sub
adapter, distributed limiter, общий connection accounting и monitoring; REST history/delta остаётся
authoritative.

## Фото и ImageMagick runtime

Multipart endpoint принимает ровно один file field `photo` и header
`Idempotency-Key: <UUID>`. Raw input ограничен 10 MiB; filename, extension и declared Content-Type
не считаются доказательством формата. Допускаются только один статический JPEG, PNG или WebP,
не более 20 megapixels и 8 192 px по стороне. SVG, GIF, animated PNG/WebP, AVIF, TIFF, PDF,
HEIC/HEIF, corrupt и ambiguous/polyglot content отклоняются. UI явно сообщает, что HEIC нужно
заменить на JPEG/PNG/WebP и не обещает конвертацию.

До захвата одного из десяти process-wide multipart slots backend выполняет authenticated upload
preflight. Чтение body ограничено application-level idle deadline 15 секунд и total deadline
120 секунд по умолчанию. Timeout активно прекращает чтение, выполняет exactly-once cleanup и
release slot, возвращает `408 CHAT_PHOTO_UPLOAD_TIMEOUT` с `Connection: close`, когда JSON response
ещё возможен, и не запускает reserve, ImageMagick или S3. HTTP server request timeout установлен
немного выше application total. Ingress body/idle timeout обязателен как defense in depth, но не
заменяет эти application controls.
Любой другой terminal reject до полного чтения body (включая streamed `413`/`429` или failed
preflight при уже начатой отправке) также отвечает с `Connection: close`; unread bytes не остаются
на keep-alive transport, а поздний stream error безопасно поглощается только до фактического close.

В текущем repository dependency snapshot недоступен переносимый native Node image package, поэтому
production adapter использует реальные OS binaries ImageMagick `identify` и `convert`, запуская их
без shell и передавая bytes только через stdin/stdout. Container/host обязан предоставить
поддерживаемую и регулярно обновляемую ImageMagick build с JPEG, PNG и WebP coders. Отсутствующий
binary или codec даёт контролируемую недоступность; fake decoder не допускается в acceptance.

Перед полной обработкой проверяются magic/container markers, число frames, width, height и pixels.
Для subprocess установлены `memory=128MiB`, `map=256MiB`, `disk=0`, один thread, hard timeout
15 секунд, bounded stderr и bounded output. Process-wide processor допускает не более двух
одновременных jobs и восемь ожидающих; переполнение возвращает контролируемый `429`.

`convert` выполняет auto-orient, fit-inside resize до `2048×2048` без upscale, `-strip` metadata и
кодирует WebP quality 82. Результат повторно проверяется реальным decoder, обязан иметь
`image/webp`, одну frame, стороны не более 2 048 и размер 1 byte–4 MiB. EXIF, GPS, XMP, original
filename и raw input не сохраняются.

Production ImageMagick policy должна дополнительно отключать ненужные coders/delegates
(PDF/PS/SVG/URL и другие), запрещать disk cache, ограничивать CPU/memory/processes и обновляться
при security advisories. Application checks не заменяют hardened `policy.xml` и container limits.

## Upload reservation и private S3

Upload idempotency key равен `client_upload_id`. Backend сначала вычисляет SHA-256 исходных bytes и
committed reserve: создаёт `chat_photos(status=processing)` с заранее сгенерированным random
`object_key`, lease, expiry и hash. Только после reserve commit выполняются normalization и PUT;
ready metadata сохраняются отдельной transaction. Объект поэтому не возникает без durable metadata.

Тот же key + bytes возвращает существующий processing/ready/attached state. Live processing lease
даёт `202 CHAT_PHOTO_PROCESSING` и `Retry-After`; stale lease допускает bounded recovery. Тот же key
с другими bytes даёт `409 CHAT_UPLOAD_IDEMPOTENCY_CONFLICT`, retry ограничен тремя attempts. Photo
message может атомарно перевести только собственный ready attachment того же conversation в
terminal `attached`.

S3-compatible bucket обязан быть private и encrypted. Adapter сохраняет только normalized WebP:

- server-generated key без PII, текста и original filename;
- `Content-Type: image/webp`;
- `Cache-Control: private, no-store`;
- server-side AES-256 encryption;
- без public ACL;
- HTTPS endpoint и server-only credentials в production.

Cleanup role должна иметь `ListBucketVersions`, `DeleteObject` и `DeleteObjectVersion`: adapter
удаляет все versions/delete markers точного server-generated key. Это сохраняет physical-deletion
SLO и для bucket с включённым versioning; lifecycle policy остаётся дополнительной страховкой, а
не заменой durable queue.

`GET /photos/:photoId/access` проверяет state и участника до подписи. Processing/ready доступен
только uploader; attached photo — обоим участникам после связи с message. Signed URL живёт по
умолчанию 300 секунд, object key и provider details не возвращаются и не логируются. Frontend не
сохраняет URL постоянно и запрашивает новый после expiry.

Если S3 не настроен, text chat продолжает работать, а photo upload возвращает
`503 CHAT_PHOTO_STORAGE_UNAVAILABLE`. Запуск с `CHAT_PHOTO_UPLOADS_ENABLED=true` и неполной S3
configuration fail-closed.

## Cleanup и удаление аккаунта

Ready photo без message истекает через 24 часа. Worker также обрабатывает stale processing leases,
failed metadata и `chat_media_deletion_jobs`. Object DELETE идемпотентен; missing object считается
success, provider failure получает bounded exponential backoff. Рекомендуемый production schedule
— не реже одного запуска каждые 15 минут:

```bash
npm run chat:media-cleanup -w @kinetra/backend
```

Non-zero exit должен вызывать alert. Отдельный alert обязателен, если oldest pending deletion job
старше 24 часов; metrics должны показывать backlog, oldest age и delete failures.

Backend account deletion выполняется одной transaction: собирает chat object keys, делает
`INSERT ... ON CONFLICT DO NOTHING` в deletion queue, удаляет user и каскадные chat rows, затем
commit. После commit chat API уже не видит данные; physical private objects удаляются worker с
целевым SLO до 24 часов. DB trigger страхует cascade и другие штатные delete paths.

Trainer account с assigned conversations или сохранённой sender history нельзя удалить через
Settings: backend возвращает `409 TRAINER_ACCOUNT_MANAGED`. Сначала operator переносит
conversations и отзывает trainer role; дальнейшее удаление требует отдельной безопасной процедуры
анонимизации вне T12.

T13 destructive lifecycle не меняется: frontend до первого `await` связывает push cleanup и
account DELETE с captured access token, дожидается уже начатого browser unsubscribe, синхронно
disconnect chat socket и очищает user-scoped draft/object URLs. Frontend не делает отдельные
DELETE chat/photo calls и не расширяет captured-token await boundary.

## Operator-only trainer lifecycle

Trainer profile нельзя создать или изменить через HTTP. Команды работают только с существующими
accounts и не принимают/не выводят password, JWT, email, телефон или secrets.

Создать/реактивировать verified trainer и при необходимости атомарно назначить default:

```bash
npm run chat:trainer:grant -w @kinetra/backend -- \
  --user-id <UUID> \
  --display-name "Тренер Kinetra" \
  --default
```

Account с уже существующим client conversation отклоняется: для trainer нужна отдельная учётная
запись.

Перенести все или выбранные conversations между двумя active trainers:

```bash
npm run chat:trainer:reassign -w @kinetra/backend -- \
  --from-user-id <UUID> \
  --to-user-id <UUID> \
  --all
```

Для выборочного переноса вместо `--all` один или несколько раз передаётся
`--conversation-id <UUID>`:

```bash
npm run chat:trainer:reassign -w @kinetra/backend -- \
  --from-user-id <UUID> \
  --to-user-id <UUID> \
  --conversation-id <UUID> \
  --conversation-id <UUID>
```

`--all` и `--conversation-id` взаимоисключающие. Reassign не меняет sender history и
`sender_name_snapshot`.

Отозвать trainer profile после reassignment:

```bash
npm run chat:trainer:revoke -w @kinetra/backend -- --user-id <UUID>
```

Revoke отказывается работать при assigned conversations. Active default нельзя деактивировать,
пока другой trainer не назначен default. CLI запускаются транзакционно и печатают только
безопасный audit result с internal UUID/count/status.

## Rate limits

Single-process MVP применяет server-side in-memory limits:

| Поверхность          | Лимит                                |
| -------------------- | ------------------------------------ |
| Socket handshake     | 20/min/IP                            |
| Active sockets       | 5/client account, 10/trainer account |
| Conversation create  | 20/min/principal и IP                |
| Message send         | 30/min/principal и IP                |
| History/read         | 120/min/principal                    |
| Photo upload         | 5/min и 20/hour/principal            |
| Photo source bytes   | 100 MiB/hour/principal               |
| Trainer search       | 60/min/principal                     |
| Socket event payload | 32 KiB                               |
| Image processing     | 2 active + 8 queued jobs/backend     |

`Retry-After` и `CHAT_RATE_LIMITED` используются для контролируемого отказа. Counters одного
процесса сбрасываются после restart и не координируются между replicas; перед scale их заменяет
Redis/edge limiter.

## Configuration

```dotenv
CHAT_ENABLED=false
CHAT_PHOTO_UPLOADS_ENABLED=false
CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS=15
CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS=120
CHAT_MEDIA_URL_TTL_SECONDS=300
```

Upload timeout ranges проверяются fail-closed: idle `1–30`, total `10–120` секунд и
`idle < total`. `CHAT_MEDIA_URL_TTL_SECONDS` ограничен диапазоном 60–900. Оба feature flags по
умолчанию false, включая production. Фото требуют полного private S3 configuration:

```dotenv
S3_ENDPOINT=https://private-s3.example
S3_REGION=<region>
S3_BUCKET=<private-bucket>
S3_ACCESS_KEY_ID=<server-only-id>
S3_SECRET_ACCESS_KEY=<server-only-secret>
S3_FORCE_PATH_STYLE=false
```

Secrets не коммитятся и не попадают во frontend `VITE_*` variables.
Состояние photo UI берётся из `GET /api/v1/chat/session.photo_uploads_enabled`, поэтому frontend
fail-closed остаётся выключенным вместе с backend flag.

`VITE_API_URL` и `VITE_PRIVATE_MEDIA_ORIGIN` содержат только точные HTTP(S) origins без credentials,
path, query, fragment или wildcard. Production-сборка требует HTTPS для обоих значений; локальный
HTTP разрешён только для явного loopback development/browser-test режима. Нормализованный
`VITE_API_URL` используется и для REST, и для Socket.IO, поэтому production-клиент не может
собраться с mixed-content API или `ws://` target.

`VITE_PRIVATE_MEDIA_ORIGIN` задаёт публичный origin private media gateway/S3
(без path, query или wildcard). Vite встраивает его в документную CSP
`img-src 'self' blob: <private-media-origin>`; при пустом значении разрешены только app origin и
локальный `blob:` preview. Production static host должен отдавать ту же CSP header, а также
`Referrer-Policy: no-referrer` и `X-Content-Type-Options: nosniff`; несовпадение deploy header с
встроенной meta-policy считается rollout blocker.

## Frontend durability и privacy

Первичная загрузка получает последние 30 сообщений, older pages используют keyset pagination, а
reconnect — delta cursor. Optimistic item получает состояния `sending`, `sent`, `read`, `failed`;
retry использует тот же `client_message_id`. Duplicate/reordered persisted REST и Socket results
схлопываются только по server `message.id`, а client key связывает только собственный optimistic
item с его canonical response при совпадении payload fingerprint. Поэтому одинаковый client key
counterpart или прежнего trainer после reassignment сохраняется как отдельное сообщение. Порядок
задаёт server sequence.

Draft хранится только в user-scoped `sessionStorage` и очищается после success, logout, account
deletion или account switch. Message history, captions, signed URLs и upload bytes не сохраняются
в `localStorage`, IndexedDB, Cache API или Service Worker background queue. Offline можно менять
draft, но send/upload выключены; автоматической persistent queue нет.

Photo preview использует revocable object URL. Fullscreen viewer закрывается кнопкой, Escape и
browser Back, удерживает focus и возвращает его к исходной thumbnail. Signed media requests
используют `Referrer-Policy: no-referrer`; content не рендерится через `dangerouslySetInnerHTML`.

## Security и observability

- TLS/WSS, exact CORS/Origin и точный `TRUST_PROXY_HOPS` обязательны в production.
- Login/refresh/logout mutations сериализуются origin-wide через Web Locks. Browser без
  `navigator.locks` fail-closed не отправляет cookie mutation и показывает незавершённый logout:
  session остаётся явно signed in, а private chat скрыт до Retry или отмены blocking state.
  Prepared logout до async работы захватывает subject, bearer, auth epoch и nonce; network/timeout,
  coordination failure и server error не очищают auth session, draft или retry proof. Retry в том
  же epoch использует тот же bearer, а только подтверждённая server revocation завершает logout и
  очищает session. Subject/epoch fence не позволяет позднему ACK аккаунта A затронуть уже
  смонтированный аккаунт B. Logout никогда не запускает refresh: он использует captured bearer, а backend
  атомарно отзывает cookie только при совпадении signed subject и принадлежности её session ID к
  rotation chain signed `sid`. Другая login family не затрагивается, и ответ никогда не содержит
  `Set-Cookie`; bearerless legacy logout является server-side no-op. Valid proof получает `204`
  только после подтверждённой revocation (повтор уже отозванной proven family также terminal);
  несовпавшая cookie/family даёт `409 LOGOUT_NOT_CONFIRMED`, поэтому frontend не показывает ложный
  success. У expired logout-only proof нет
  age limit, потому что sliding refresh chain может жить дольше исходного cookie, но signature,
  canonical claims, точный access TTL и запрет future-issued proof обязательны. Normal API и
  Socket.IO verification не ослабляются. Последующий refresh намеренно logout-revoked token без
  rotation replacement даёт `401`, но не запускает reuse-cascade на другие login families.
  PostgreSQL сериализует refresh/logout в lock order `user → refresh`: refresh-first replacements
  рекурсивно отзываются в той же proven chain, logout-first блокирует создание replacement.
- Foreign и nonexistent resources имеют одинаковый ответ; trainer queries всегда ограничены
  `trainer_user_id=JWT sub`.
- Message body, caption, photo bytes, JWT/cookie, email/phone, signed URL и object key запрещено
  писать в logs, metrics или error response.
- Допустимая telemetry: internal actor/conversation UUID, role, action, safe status/error code,
  request/event ID, duration и timestamp.
- Reverse proxy поддерживает WebSocket Upgrade, а idle timeout превышает Socket.IO heartbeat.
- PostgreSQL использует TLS, bucket private/encrypted, credentials находятся в secret manager.
- T12 не является end-to-end encrypted. Privacy copy не должна обещать E2EE или device delivery;
  «Отправлено» означает только durable server commit.

До production enablement trainer account должен иметь verified email, уникальный сильный пароль и
MFA либо находиться за внешним authenticated access gateway. Shared trainer accounts запрещены;
provision/reassign/revoke и emergency revoke должны быть аудируемыми.

## Rollout и rollback

Безопасный rollout:

1. применить additive migration `011` с обоими flags off;
2. provision отдельный verified trainer account;
3. настроить private encrypted bucket, hardened ImageMagick runtime и cleanup scheduler;
4. выполнить trainer internal smoke и HTTPS/WSS proxy smoke;
5. проверить metrics, redaction, deletion backlog и account deletion proof;
6. включить `CHAT_ENABLED=true` только после owner approval;
7. проверить text chat и realtime;
8. отдельно включить `CHAT_PHOTO_UPLOADS_ENABLED=true` после photo load/security test.

Rollback выполняется flags off. Таблицы и migration не удаляются, durable data сохраняются, а
media cleanup worker продолжает исполнять deletion jobs. Drop/rewrite migration и автоматический
reassign conversations не являются rollback.

## Production checklist

- Migration `011` и неизменность `001`–`010` доказаны PostgreSQL 17 CI.
- Exact-head CI содержит backend, real Socket.IO, PostgreSQL, real ImageMagick, frontend, T13
  coexistence и Chrome browser markers.
- HTTPS/WSS, WebSocket Upgrade, heartbeat timeout, exact CORS и `TRUST_PROXY_HOPS` проверены.
- Backend работает в одной replica либо настроены Redis adapter/distributed limits/accounting.
- ImageMagick version/coders/policy/container limits закреплены и прошли malicious/load tests.
- Private encrypted S3, short signed URLs, server-only credentials и version-aware permanent
  delete permissions проверены.
- Cleanup запускается каждые 15 минут; non-zero exit и backlog старше 24 часов alert-ятся.
- Structured logs прошли redaction review; dashboards покрывают API/socket/photo/cleanup.
- Trainer MFA/external gateway, unique account, provisioning audit и emergency revoke готовы.
- Privacy notice и live/backup retention/deletion policies утверждены; E2EE не обещается.
- Desktop, iOS и Android installed-PWA smoke пройден на 320, 428, 768 и 1440 px во всех темах.
- На каждом поддерживаемом browser подтверждены secure-context Web Locks и fail-closed UX при их
  недоступности; параллельные account mutations не меняют refresh cookie другого аккаунта.
- T13 push permission/settings/logout/account-deletion lifecycle не регрессировал; chat push не
  добавлен и Service Worker deep-link allowlist не расширен.
- Включение flags и rollout отдельно разрешены владельцем.
