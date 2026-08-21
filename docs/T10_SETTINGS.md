# T10 — настройки аккаунта и тема приложения

T10 заменяет частичный экран `/settings` полноценными настройками профиля, подписки,
уведомлений, оформления, поддержки и аккаунта. Все settings API принадлежат текущему пользователю:
`user_id` берётся только из проверенного access JWT, ответы не кешируются.

## Backend API

Базовый путь: `/api/v1/settings`. Все четыре endpoint требуют `Authorization: Bearer <access JWT>`
и устанавливают `Cache-Control: no-store`.

### `GET /api/v1/settings/profile`

Возвращает данные шапки и текущие настройки уведомлений:

```json
{
  "email": "user@example.com",
  "phone": "+79991234567",
  "created_at": "2026-01-10T10:00:00.000Z",
  "onboarding_status": "active",
  "notification_preferences": {
    "workout_reminders": true,
    "reminder_time": "09:00",
    "weekly_survey_reminder": true
  }
}
```

`email` и `phone` могут быть `null`, но действующий auth-контракт гарантирует хотя бы один
идентификатор. Legacy-профили без полного JSON нормализуются значениями из
`notification_enabled`, `09:00` и `true`.

### `GET /api/v1/settings/subscription`

```json
{
  "status": "active",
  "provider": "yukassa",
  "starts_at": "2026-01-15T00:00:00.000Z",
  "expires_at": "2026-02-15T00:00:00.000Z",
  "amount": 799,
  "currency": "RUB",
  "auto_renew": true,
  "days_remaining": 25
}
```

Контракт:

- `status`: `active | expired | cancelled | pending | none`;
- `provider`: `yukassa | tribute | null`;
- для отсутствующей подписки возвращается `status: "none"`, а все остальные поля равны `null`;
- PostgreSQL выбирает действующую active-подписку первой, затем самую новую по
  `created_at DESC, id DESC`;
- будущая active-подписка показывается как `pending`, завершившаяся — как `expired`, а legacy
  `refunded` отображается пользователю как `cancelled`;
- сумма хранится в `amount_minor`, API возвращает `amount_minor / 100`;
- `days_remaining` — неотрицательный `ceil((expires_at - now) / 24 часа)` или `null`, если даты
  окончания нет.

### `PUT /api/v1/settings/notifications`

Тело запроса содержит ровно три поля:

```json
{
  "workout_reminders": true,
  "reminder_time": "09:00",
  "weekly_survey_reminder": true
}
```

Объект валидируется строгой Zod-схемой. `reminder_time` должен соответствовать 24-часовому
`HH:MM` (`00:00`–`23:59`); неизвестные поля, отсутствующие значения и неверные типы дают `400
INVALID_NOTIFICATION_PREFERENCES`. Успешный полный upsert возвращает `204 No Content`.

### `DELETE /api/v1/settings/account`

Принимается только строгий объект:

```json
{ "confirm": "DELETE" }
```

Отсутствующее, отличающееся регистром или дополненное поле даёт `400
ACCOUNT_DELETION_CONFIRMATION_REQUIRED`. Успешное удаление пользователя возвращает `204 No
Content` и очищает refresh cookie. Связанные refresh/reset/verification tokens, ответы анкеты,
подписки и прогресс удаляются существующими `ON DELETE CASCADE`; после этого старый refresh token
и повторный login удалённого пользователя не работают.

## Миграция `008_notifications.sql`

В исходном задании указан файл `004_notifications.sql`, но номер `004` уже занят неизменяемой
миграцией `004_base_lessons.sql`. На `develop` перед T10 последовательно существуют миграции
`001`–`007`, поэтому единственный корректный append-only номер T10 —
`apps/backend/migrations/008_notifications.sql`. Переименование или перезапись применённой `004`
сломали бы SHA-256 журнал `schema_migrations`.

`008`:

- добавляет `users.notification_preferences jsonb`;
- переносит legacy `notification_enabled` в полный JSON;
- фиксирует `DEFAULT '{}'::jsonb`, `NOT NULL` и validated CHECK на JSON object;
- добавляет `subscriptions.auto_renew boolean NOT NULL DEFAULT false`;
- добавляет индексы по `user_id` для auth token tables, чтобы каскадное удаление было
  предсказуемым.

## Frontend `/settings`

Экран одновременно загружает profile и subscription, отменяет устаревший запрос при unmount/retry
и переводит auth-ошибку в общий сценарий завершения сессии.

Отображаются шесть секций:

1. **Подписка** — статус, провайдер, сумма и доступные действия.
2. **Уведомления** — два accessible switch и время с 33 вариантами от `06:00` до `22:00` с шагом
   30 минут. Изменения автоматически схлопываются debounce `450 ms` и отправляются одним полным
   PUT payload; первоначальная гидратация PUT не вызывает. Последний ещё не отправленный snapshot
   best-effort сохраняется с `keepalive` при `pagehide` или уходе со страницы настроек.
3. **Профиль** — существующий переход на `/settings/survey` и информационная модалка будущих
   уровней «Мастерство»/«Пик».
4. **Оформление** — системная, светлая и тёмная тема.
5. **Поддержка** — `mailto:` тренеру и модалка «О приложении» с версией и ссылкой на политику
   конфиденциальности.
6. **Аккаунт** — подтверждаемый logout и danger-flow удаления.

Logout вызывает `POST /api/v1/auth/logout`, очищает клиентскую access-сессию и переводит на
`/login`, даже если удалённый logout недоступен. Удаление требует два осознанных шага: danger
dialog, затем точный ввод `DELETE`; только после успешного `204` локальная сессия очищается и
пользователь переходит на `/login`.

URL оплаты, поддержки и политики конфиденциальности задаются соответственно
`VITE_PAYMENT_URL`, `VITE_SUPPORT_EMAIL` и `VITE_PRIVACY_URL`. Значения по умолчанию являются
явными pre-production ссылками Kinetra.

### Честный placeholder отмены автопродления

T10 не добавляет backend endpoint отмены и не вызывает API провайдера. Поэтому кнопка «Отменить
автопродление» **не меняет** `auto_renew`: она открывает информационную модалку, которая прямо
сообщает, что кабинет провайдера появится позже, и предлагает связаться с тренером. Реальную
отмену можно подключить только отдельным платежным контрактом с ЮKassa/Tribute и проверяемым
webhook-состоянием.

## Тема: точный контракт

Preference имеет ровно три значения: `system | light | dark`. Оно не является персональными
данными и хранится локально под ключом `kinetra.theme.v1`; неизвестное или недоступное значение
нормализуется в `system`.

- `/theme-init.js` загружается в `<head>` до React и сразу выставляет `data-theme`,
  `data-theme-preference`, CSS `color-scheme` и `<meta name="theme-color">`, предотвращая вспышку
  неверной темы;
- `ThemeProvider` применяет ручной выбор сразу, синхронизирует preference между вкладками и в
  режиме `system` слушает `matchMedia('(prefers-color-scheme: dark)')`;
- `system` динамически следует теме ОС без перезагрузки; `light` и `dark` остаются явными до
  следующего выбора;
- глобальные semantic CSS tokens распространяют тему на auth, survey, onboarding, уроки,
  программу, расписание, прогресс, settings, dialog и tab bar, а не только на `/settings`;
- dark сохраняет канонические `#080909`, `#181C1C`, `#C8F169`, `#F4F6F2`; light использует
  `#F4F6F2` фон, белые surfaces, тёмный текст и контрастный лаймовый акцент.

Обе темы сохраняют Inter, 12px cards, 24px межсекционные отступы, минимум 44px для touch targets,
safe-area padding и danger semantics.

## Проверки и fail-closed markers

```text
KINETRA_T10_BACKEND_E2E=PASS
KINETRA_T10_POSTGRES_INTEGRATION=PASS
KINETRA_T10_SETTINGS_CONTENT=PASS
KINETRA_T10_NOTIFICATIONS=PASS
KINETRA_T10_THEME_MODES=PASS
KINETRA_T10_LOGOUT=PASS
KINETRA_T10_ACCOUNT_DELETION=PASS
KINETRA_T10_BROWSER_E2E=PASS
KINETRA_T10_TEST_SUITE=PASS
```

CI принимает T10 только при наличии backend, реального PostgreSQL и полного Chrome journey;
PostgreSQL skip не печатает integration marker. Browser acceptance проверяет шесть секций,
debounced PUT, три theme preference (включая смену системной темы), survey/support/about,
подтверждённый logout, двойное удаление, 320/428px layout и сохранность сценариев T04–T09.
