# T07 — Главная, недельная программа и нижняя навигация

T07 заменяет временный экран на основную оболочку программы. Она доступна и для `active`, и для
`base_lessons`: активный пользователь получает полный режим, а пользователь до завершения
базовой подготовки — безопасный режим знакомства без workout media и мутаций тренировочного
прогресса. Защищённый backend вычисляет доступную неделю только по данным
`workout_completions`, а frontend показывает семь дней, недельный прогресс, плеер/placeholder и
tab bar standalone PWA.

## HTTP API

Все маршруты требуют `Authorization: Bearer <access-token>` и отвечают с
`Cache-Control: no-store`.

### `GET /api/v1/program/current-week`

Возвращает текущую неделю пользователя. Если завершений нет, текущей считается неделя 1. Если
в последней начатой неделе завершены все семь тренировок, текущей становится следующая неделя
(но не позже последней недели программы).

```json
{
  "week": {
    "id": "00000000-0000-4000-8000-000000000101",
    "week_number": 1,
    "title": "Неделя 1",
    "status": "active",
    "days": [
      {
        "id": "00000000-0000-4000-8000-000000000201",
        "day_of_week": 1,
        "direction": "breathing",
        "title": "Дыхание",
        "description": "Практика дыхания и контроля тела.",
        "duration_minutes": 25,
        "icon": "🧘",
        "video": {
          "id": "00000000-0000-4000-8000-000000000301",
          "video_url": null,
          "poster_url": null
        },
        "completed": false,
        "completed_at": null
      }
    ],
    "days_completed": 0,
    "total_days": 7
  },
  "total_weeks": 12,
  "overall_progress": {
    "weeks_completed": 0,
    "total_workouts_done": 0
  }
}
```

Workout media keys проходят через тот же S3 signer, что и T06. Seed сохраняет будущие object
keys, но migration `005_program_media_availability.sql` добавляет явный флаг
`media_available = false`. Пока upload не подтверждён, API возвращает `video_url` и `poster_url`
как `null`, поэтому seed без реальных объектов показывает placeholder, а не битый подписанный
URL. После успешной загрузки uploader должен выставить `media_available = true`; constraint
запрещает доступное media без `storage_key`. Для locked-недели URL остаются `null` независимо от
флага.

Доступ к чтению зависит от статуса пользователя и подписки:

| `onboarding_status`         | Активная подписка | Программа и расписание | Workout media                                  |
| --------------------------- | ----------------- | ---------------------- | ---------------------------------------------- |
| `active`                    | да                | полный режим           | согласно `media_available` и блокировке недели |
| `base_lessons`              | да                | только метаданные      | `video_url: null`, `poster_url: null`          |
| `active` или `base_lessons` | нет               | существующий paywall   | недоступно                                     |

Даже при опубликованном media backend не вызывает S3 signer для ответа пользователю со статусом
`base_lessons`. Это исключает выдачу подписанного URL до завершения обязательной подготовки.

### `GET /api/v1/program/weeks/:weekNumber`

Возвращает тот же `WeekResponse` для выбранной недели. `weekNumber` — целое число в пределах
программы. Backend разрешает только недели `<= currentWeek + 1`; далёкая будущая неделя
отклоняется ошибкой `PROGRAM_WEEK_LOCKED`.

### `PUT /api/v1/program/complete-workout`

```json
{
  "video_id": "00000000-0000-4000-8000-000000000301",
  "program_week": 1
}
```

Тело строго валидируется Zod: `video_id` должен быть UUID, `program_week` — положительным целым
числом, неизвестные поля запрещены. Сервер проверяет, что опубликованное workout-видео
принадлежит указанной неделе, и создаёт completion только для JWT-пользователя:

```text
user_id, video_id, program_week, workout_date, source = 'player'
```

Запись идемпотентна (`ON CONFLICT DO NOTHING`). Ответ — обновлённый `WeekResponse` текущей
недели; повторный PUT не создаёт дубликат.

Completion разрешён только при `onboarding_status = active` и активной подписке. Проверка
подписки выполняется первой: при неактивной подписке endpoint отвечает `SUBSCRIPTION_REQUIRED`.
После успешного subscription gate статус `base_lessons` fail-closed получает HTTP `403`:

```json
{
  "error": {
    "code": "BASE_LESSONS_REQUIRED",
    "message": "Complete at least four base lessons before starting a workout."
  }
}
```

Проверка выполняется в service до вызова mutation, а SQL записи дополнительно требует
`users.onboarding_status = 'active'`. Поэтому прямой запрос к endpoint, устаревший frontend или
гонка статуса не могут создать `workout_completions` раньше допуска.

## Главный экран

Маршрут `/` для профиля с `onboarding_status = active` показывает:

- заголовок `Неделя X`, стрелки доступных недель и прогресс `X/7`;
- семь карточек Пн–Вс в стабильном порядке с иконкой, направлением и длительностью;
- состояния `completed`, `available`, `locked`, а также обводку текущего дня;
- кнопку «Сегодня», открывающую доступную тренировку текущего дня;
- HTML5 player для подписанного `video_url` и текст `Видео скоро будет доступно` для `null`;
- четыре fixed-вкладки: Главная, Расписание, Прогресс и Настройки.

Для профиля с `onboarding_status = base_lessons` тот же маршрут и tab bar доступны в режиме
знакомства. Главная и Расписание показывают только разрешённые подпиской метаданные, а попытка
открыть карточку тренировки показывает диалог с действиями «Пройти базовые уроки» и «Вернуться к
изучению приложения». Явная страница `/base-lessons` содержит обратное действие «Вернуться в
приложение».
Прогресс и Настройки остаются доступны; чат остаётся заблокированным до статуса `active`.

Для пользователя без активной подписки сохраняется существующий paywall. Tab bar отображается
для `active` и `base_lessons`. Высота tab bar учитывает `env(safe-area-inset-bottom)`, а список
резервирует место под фиксированную навигацию.

Плеер ограничивает обработку progress-событий и вызывает completion только после достижения
90%. После успешного `PUT` экран использует серверный ответ; при возврате к неделе карточка уже
показывается как «Пройдено». Кнопка «Назад» и системный Back возвращают к списку. Переход через tab
bar закрывает открытый плеер и заменяет его same-URL history sentinel, поэтому следующий Back
возвращает ровно на предыдущий экран. Reload и Forward восстанавливают плеер и выбранную неделю
по history state;
пока completion сохраняется, вкладки временно получают `aria-disabled`, а системный Back
удерживает единственную player-запись, чтобы не потерять ответ и не отправить повторный `PUT`.

## Проверки

Backend E2E и PostgreSQL integration покрывают JWT 401, неделю 1 по умолчанию, конкретную
неделю, запрет далёкого будущего, идемпотентный completion, переход после семи завершений,
read-only metadata для `base_lessons` с активной подпиской, отсутствие подписанных media URL,
HTTP 403 `BASE_LESSONS_REQUIRED` и SQL-защиту `onboarding_status = active`. Frontend unit/API
тесты фиксируют семь направлений и иконок, границы стрелок, прогресс, текущий день, четыре вкладки,
authenticated API paths, режим знакомства и переход к явной странице базовых уроков.

Chrome browser acceptance проходит полный путь T04–T07, открывает будущую неделю, возвращается
на текущую, переключает Schedule/Progress/Home, закрывает тренировку системным Back, проверяет
placeholder и восстановление правильной недели через reload/Forward/history, доказывает отсутствие completion на 89%, затем имитирует
playback 95%, блокирует tab navigation и Back/Forward на время задержанного completion-запроса и
проверяет статус `completed` после возврата. Отдельный сценарий для `base_lessons` подтверждает
канонический маршрут `/`, доступность tab bar, read-only метаданные, отсутствие workout media,
диалог вместо плеера, возврат между обзором и `/base-lessons`, сохранение paywall и блокировку
чата. Сценарий отдельно проверяет приоритет paywall для `base_lessons`, отсутствие chat FAB и
запросов `/chat/session`, redirect прямого `/chat` на `/`, а также отсутствие tab bar/FAB на
standalone-странице уроков.

Fail-closed маркеры CI:

```text
KINETRA_T07_BACKEND_E2E=PASS
KINETRA_T07_POSTGRES_INTEGRATION=PASS
KINETRA_T07_TAB_NAVIGATION=PASS
KINETRA_T07_SYSTEM_BACK=PASS
KINETRA_T07_PLAYER_TAB_HISTORY=PASS
KINETRA_T07_WEEK_NAVIGATION=PASS
KINETRA_T07_WORKOUT_COMPLETION=PASS
KINETRA_T07_BROWSER_E2E=PASS
KINETRA_T07_TEST_SUITE=PASS
```

Структурный verifier рекурсивно отклоняет bootstrap/payload/encoded/PR-trigger артефакты, а CI
сравнивает полный tracked path list с `MANIFEST.sha256` перед проверкой SHA-256.
