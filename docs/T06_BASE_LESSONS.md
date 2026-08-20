# T06 — Базовые уроки

T06 реализует обязательный этап между онбординг-каруселью и тренировочной программой.
Пользователь со статусом `base_lessons` видит семь вводных уроков, сохраняет прогресс просмотра
и может перейти к программе после завершения как минимум четырёх уроков.

## Маршрутизация

Канонический frontend-маршрут — `/base-lessons`. Он доступен только для профиля, у которого
сервер вернул `onboardingStatus: "base_lessons"`. После успешного завершения этапа сервер меняет
статус на `active`, а frontend переходит на `/`.

Источник истины для маршрута и разблокировки — ответы backend. Клиент не сохраняет статус
онбординга локально и не может самостоятельно открыть программу.

## API

Все маршруты расположены под `/api/v1/base-lessons`, требуют access JWT в заголовке
`Authorization: Bearer <token>` и возвращают `Cache-Control: no-store`.

### `GET /api/v1/base-lessons`

Возвращает опубликованные базовые уроки в порядке `order_index` и прогресс текущего
пользователя:

```json
{
  "lessons": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "slug": "base-lesson-01-breathing-check",
      "title": "Как понять правильно ли я дышу?",
      "description": "Базовый урок о дыхании и самопроверке.",
      "duration_seconds": 600,
      "order_index": 1,
      "poster_url": null,
      "video_url": null,
      "progress": {
        "completion_percent": 0,
        "completed": false
      }
    }
  ],
  "total_completed": 0,
  "unlock_threshold": 4,
  "program_unlocked": false
}
```

`total_completed` учитывает только уроки с `completion_percent >= 90`.
`program_unlocked` становится `true`, когда `total_completed >= unlock_threshold`.
Прогресс другого пользователя в ответ не попадает.

Если у видео есть `storage_key` или `poster_key`, backend формирует короткоживущий presigned S3
URL. Если ключ равен `null`, соответствующее поле URL также равно `null`. Seed T06 намеренно
оставляет ключи семи базовых уроков пустыми: настоящие медиафайлы будут загружены позднее.

### `PUT /api/v1/base-lessons/:lessonId/progress`

Тело запроса:

```json
{
  "position_seconds": 570,
  "completion_percent": 95
}
```

`position_seconds` — неотрицательное целое число в диапазоне PostgreSQL `integer`,
`completion_percent` — число от 0 до 100. Схема строгая: неизвестные поля, некорректный UUID и
попытка передать идентификатор пользователя отклоняются. Личность всегда берётся из JWT.

Запись сохраняется через PostgreSQL upsert по `(user_id, video_id)`. При первом достижении 90%
сервер заполняет `completed_at`; последующие обновления не меняют исходное время завершения.
Ответ содержит сохранённое состояние:

```json
{
  "position_seconds": 570,
  "completion_percent": 95,
  "completed": true,
  "completed_at": "2026-08-20T12:00:00.000Z"
}
```

Прогресс можно записывать только для видео с `type = 'base_lesson'`.

### `PUT /api/v1/base-lessons/complete-program`

Endpoint повторно считает завершённые уроки на сервере. Если их меньше четырёх, ответ имеет
статус `400`:

```json
{
  "error": {
    "code": "INSUFFICIENT_LESSONS",
    "message": "Complete at least 4 base lessons before opening the program."
  }
}
```

При выполненном пороге транзакция меняет только допустимый статус `base_lessons` на `active` и
возвращает `MeResponse`. Для уже активного профиля запрос идемпотентен и возвращает профиль без
повторного перехода.

## Placeholder и плеер

При `poster_url: null` карточка показывает тёмный градиент. При `video_url: null` вместо
`<video>` отображается сообщение «Видео скоро будет доступно». Такой placeholder не отправляет
фиктивный прогресс.

Для доступного видео используется нативный HTML5-плеер. Во время воспроизведения клиент каждые
десять секунд отправляет progress PUT, а также сохраняется при pause/end. Кнопка «Назад» и
системный Back выполняют принудительный финальный PUT с текущей позицией. Перед `pagehide` клиент
также best-effort запускает маленький keepalive PUT, уменьшая риск потери последних секунд при
закрытии standalone PWA; гарантированным подтверждённым выходом остаётся Back.

Запросы сериализованы, а final flush ждёт полного опустошения очереди. Список закрывается сразу с
authoritative ответом PUT; последующий GET выполняется в фоне. Предыдущий GET отменяется при
открытии следующего урока, а version guard не позволяет позднему ответу откатить видимый прогресс.
Поэтому временная ошибка GET не запирает пользователя в плеере и не отменяет уже сохранённый
результат.

Нижняя CTA использует серверные `unlock_threshold` и `program_unlocked`:

- до порога она disabled и показывает «Пройдите ещё N уроков»;
- после четырёх уроков она активна и показывает «Перейти к программе»;
- успешный `complete-program` обновляет профиль и переводит пользователя на `/`.

## Хранилище

Для presigned URL используются параметры из `.env`:

```dotenv
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
S3_PRESIGNED_URL_TTL_SECONDS=900
```

Создание presigned URL не выполняет сетевой запрос к S3. В тестах используется детерминированный
адаптер, поэтому suite не зависит от внешнего хранилища или реальных секретов.
В production пользовательский `S3_ENDPOINT` обязан использовать HTTPS; HTTP допустим только для
локального S3-совместимого хранилища вне production.

## Проверка

```bash
npm run verify:structure
npm run typecheck
npm run lint
npm run test
npm run build
sha256sum -c MANIFEST.sha256
```

CI сначала сравнивает пути manifest с полным `git ls-files` (кроме самого manifest), а затем
проверяет SHA-256. Структурный verifier рекурсивно отклоняет bootstrap/payload/encoded artifacts,
включая `.t06-bootstrap`, `*.b64`, `*.base64` и временные apply-workflows.

Покрытие T06 включает:

- HTTP E2E: JWT-защита, список из семи уроков, валидация и upsert прогресса, порог и
  идемпотентность;
- PostgreSQL integration: реальный `video_progress`, изоляция пользователей и транзакционный
  переход `base_lessons -> active`;
- frontend unit: семь названий, три отрендеренных состояния карточки, динамическая CTA,
  placeholder, сериализация и ожидание final flush;
- browser acceptance: список, placeholder, system Back, реальный десятисекундный PUT на 45%,
  отдельный финальный PUT, три визуальных состояния карточки, четыре завершённых урока,
  последовательное обновление CTA, переход на `/` и восстановление активного профиля после
  reload.

Успешные обязательные проверки печатают маркеры:

```text
KINETRA_T06_BACKEND_E2E=PASS
KINETRA_T06_POSTGRES_INTEGRATION=PASS
KINETRA_T06_PERIODIC_PROGRESS=PASS
KINETRA_T06_CARD_STATES=PASS
KINETRA_T06_SYSTEM_BACK=PASS
KINETRA_T06_BROWSER_E2E=PASS
```

CI проверяет эти маркеры вместе с T04/T05 и отдельно проверяет отсутствие временных профилей
Chrome. Runtime и конфигурация остаются standalone PWA и не содержат Telegram SDK, endpoints или
environment variables.
