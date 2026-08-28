# Trainer verification MVP

## Назначение

Регистрация принимает публичный выбор `requested_role`: `trainer` или
`trainee`. Это намерение пользователя, а не доступ. До одобрения заявитель с
ролью `trainer` остаётся обычным `account_role="client"` и не получает
`trainer_profile`, trainer chat или управление видео.

Данные добавляются migration `013_trainer_verification.sql`. Миграции 001–012
не изменяются.

## Модель данных

- `users.requested_role` — обязательное additive-поле с допустимыми значениями
  `trainer` и `trainee`.
- `trainer_verification_requests` — неизменяемая история заявок пользователя.
  Для новой trainer-регистрации атомарно создаётся одна bridge-заявка:
  `status=pending`, `submitted_at=NULL`. Прямое удаление заявки запрещено;
  cascade разрешён только вместе с удалением владеющего аккаунта.
- `trainer_verification_documents` — только метаданные и HTTPS-ссылки. Backend
  не скачивает файл, не делает upload и не обращается к S3.
- `trainer_verification_events` — append-only audit trail.
- `trainer_verification_reviewers` — отдельный список reviewer-полномочий.

Допустимые виды материалов: `professional_profile`, `certificate`, `diploma`,
`portfolio`, `other`. URL должен использовать HTTPS, не содержать credentials и
проходит строгую валидацию. На одну заявку допускается от 1 до 20 уникальных
URL.

## Пользовательские endpoints

Все маршруты требуют Bearer access token, отключают HTTP caching и не принимают
`userId` из body.

### `GET /api/v1/trainer-verification/me`

Возвращает:

```json
{
  "requested_role": "trainer",
  "trainer_verification_state": "not_started",
  "request": null
}
```

`not_started` соответствует отсутствующей заявке либо bridge-заявке
`pending + submitted_at=NULL`. Активный `trainer_profile` всегда даёт публичное
состояние `approved`, включая существующих trainer-пользователей без
искусственной истории заявок.

### `POST /api/v1/trainer-verification`

Первая отправка заполняет существующую bridge-заявку. После `rejected` или
`withdrawn` создаётся новая заявка, а прежняя остаётся в истории. При чтении
текущего состояния live-заявка имеет приоритет над историческими заявками даже
при одинаковых timestamps.

```json
{
  "display_name": "Trainer Name",
  "specialization": "Mobility",
  "experience_years": 7,
  "bio": "Professional biography with enough detail.",
  "city": "Moscow",
  "timezone": "Europe/Moscow",
  "materials": [
    {
      "kind": "professional_profile",
      "url": "https://example.com/trainer/profile",
      "title": "Professional profile",
      "issued_at": "2020-01-01"
    }
  ]
}
```

Успех — `201`, состояние `pending`. Для `requested_role=trainee` ответ —
`409 TRAINER_ROLE_NOT_REQUESTED`.

### `PATCH /api/v1/trainer-verification/me`

Разрешён только для состояния `needs_more_info`. Полностью заменяет поля заявки
и ссылки, возвращает заявку в `pending`.

### `POST /api/v1/trainer-verification/me/withdraw`

Body должен быть ровно `{}`. Переход возможен из submitted `pending` и
`needs_more_info` в `withdrawn`.

## Reviewer endpoints

Reviewer authority проверяется в PostgreSQL при каждом запросе. HTTP endpoint
для self-grant отсутствует.

- `GET /api/v1/admin/trainer-verification?status=pending`
- `POST /api/v1/admin/trainer-verification/:id/request-info`
- `POST /api/v1/admin/trainer-verification/:id/reject`
- `POST /api/v1/admin/trainer-verification/:id/approve`

`request-info` и `reject` требуют непустой `reason`. Self-review запрещён.
Approval требует подтверждённый email и отсутствие client chat history. Он
использует общий advisory lock `kinetra:chat:trainer-administration:v1`, создаёт
или активирует `trainer_profile`, но не выдаёт `can_manage_videos`. При
существующем профиле `is_default` и `can_manage_videos` сохраняются. Повторный
approval уже одобренной заявки идемпотентен: второй profile или audit event не
создаются.

До approval заявитель может пользоваться общими функциями клиента. Но если он
создаст client chat conversation, approval остановится с
`409 CLIENT_CHAT_HISTORY_REQUIRES_RESOLUTION`. Текущий chat scope намеренно не
меняется: дальнейшее разрешение истории требует решения владельца/support либо
отдельного аккаунта, а не автоматического переноса данных.

### Переходы

| Из состояния                    | Разрешённое действие | В состояние                  |
| ------------------------------- | -------------------- | ---------------------------- |
| bridge `pending` без submission | submit               | `pending`                    |
| `pending`                       | request-info         | `needs_more_info`            |
| `pending`                       | approve              | `approved`                   |
| `pending`                       | reject               | `rejected`                   |
| `pending`                       | withdraw             | `withdrawn`                  |
| `needs_more_info`               | update/resubmit      | `pending`                    |
| `needs_more_info`               | withdraw             | `withdrawn`                  |
| `rejected`                      | new submit           | новая `pending`              |
| `withdrawn`                     | new submit           | новая `pending`              |
| `approved`                      | repeat approve       | `approved` без новой мутации |

Другие переходы возвращают fail-closed `409`.

## Reviewer CLI

После локального build:

```bash
npm --workspace @kinetra/backend run trainer-verification:reviewer:grant -- \
  --user-id 00000000-0000-4000-8000-000000000001

npm --workspace @kinetra/backend run trainer-verification:reviewer:revoke -- \
  --user-id 00000000-0000-4000-8000-000000000001
```

CLI принимает ровно один UUID и пишет только безопасный operator audit без
секретов. Grant/revoke меняют только таблицу reviewer-ов.

## PostgreSQL 17 gate

Integration tests нельзя заменять mock/in-memory базой. Они применяют реальные
SQL migrations, проверяют server major 17, атомарную trainer-регистрацию,
переходы, concurrency/idempotency, reviewer revoke, approval guards,
append-only events и account-deletion cascades.

В окружении с PostgreSQL 17:

```bash
export DATABASE_URL='postgresql://kinetra:kinetra@127.0.0.1:5432/kinetra_test'
export KINETRA_REQUIRE_POSTGRES_TEST=true

npm --workspace @kinetra/backend run db:migrate
npm --workspace @kinetra/backend test -- \
  test/auth.postgres.test.ts \
  test/profile.postgres.test.ts \
  test/trainer-verification.postgres.test.ts
```

Без `DATABASE_URL` эти tests имеют статус `SKIP`. При
`KINETRA_REQUIRE_POSTGRES_TEST=true` отсутствие URL является ошибкой, а не
ложным PASS.

## Безопасность и границы MVP

- Нет upload, S3, внешней верификации или фоновой загрузки URL.
- Нет назначения reviewer-а через публичный API.
- Нет trainer authority до успешного approval.
- Нет реальных secrets или production schema в тестах.
- PostgreSQL error logger сохраняет только безопасный SQLSTATE и request ID;
  `detail`, `query`, row values и приватные данные не логируются.
