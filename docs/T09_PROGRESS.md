# T09 — прогресс

T09 заменяет заглушку `/progress` на защищённый dashboard: цель, еженедельная самооценка,
статистика и достижения. Идентичность во всех запросах берётся только из access JWT; ответы
помечены `Cache-Control: no-store`.

## API

### `GET /api/v1/progress`

Возвращает один `ProgressResponse`:

```json
{
  "goal": {
    "current_goal": "general_health",
    "goal_label": "Хочу поддерживать форму и здоровье",
    "set_at": "2026-08-01T10:00:00.000Z"
  },
  "params": {
    "gender": "male",
    "age_range": "26-35",
    "experience": "novice",
    "injuries": ["knees"],
    "survey_updated_at": "2026-08-01T10:00:00.000Z"
  },
  "metrics": {
    "current_week": 3,
    "history": [],
    "pending_survey": true
  },
  "achievements": {
    "unlocked": [],
    "locked": [],
    "total_unlocked": 0,
    "total_available": 5
  },
  "stats": {
    "total_workouts": 0,
    "total_weeks_completed": 0,
    "current_streak": 0,
    "best_streak": 0,
    "total_minutes_trained": 0
  }
}
```

`goal` и `params` читаются из единственной текущей версии `survey_answers`. `current_week`
вычисляется существующей серверной логикой T07, а `pending_survey` равен `true` только при
отсутствии `weekly_metrics` для этой авторитетной недели. История сортируется по
`program_week`.

Во время GET сервер идемпотентно материализует уже заработанные canonical-достижения через
`INSERT ... ON CONFLICT DO NOTHING`. Для backfill поле `unlocked_at` берётся из фактического
события: просмотра базового урока, завершения N-й тренировки, седьмого разного дня недели или
третьего последовательного тренировочного дня. Повторный GET не меняет дату.

### `PUT /api/v1/progress/weekly-metrics`

```json
{
  "program_week": 3,
  "energy": 8,
  "sleep": 7,
  "mood": 8,
  "body_satisfaction": 7,
  "note": "Чувствую прилив сил"
}
```

Body строгий: неделя — целое число `1–12`, все четыре оценки — целые `1–10`, заметка
опциональна и не длиннее 500 символов. Запись обновляется по
`UNIQUE (user_id, program_week)`; исходный `created_at` при upsert сохраняется. Ответ — прямой
обновлённый объект `MetricsResponse`, а не wrapper.

### `PUT /api/v1/progress/goal`

```json
{ "goal": "strength" }
```

Допустимы `flexibility`, `strength`, `awareness`, `general_health`. Сервер блокирует пользователя
и текущую анкету, помечает прежнюю версию неактуальной и создаёт следующую версию, копируя пол,
возраст, травмы, пояснение и опыт. Ответ — прямой `GoalResponse` с server-owned русским label.

Ошибки используют общий формат `{ "error": { "code", "message" } }`:

- `401 AUTHENTICATION_REQUIRED` — нет действительного access JWT;
- `400 INVALID_WEEKLY_METRICS` — неверная неделя, оценка, заметка или лишнее поле;
- `400 INVALID_PROGRESS_GOAL` — неизвестная цель или лишнее поле;
- `409 SURVEY_REQUIRED` — у пользователя нет текущей анкеты;
- `404 PROFILE_NOT_FOUND` — JWT-пользователь больше не существует.

## Статистика

В агрегаты входят только завершения опубликованных workout-видео, у которых неделя completion
совпадает с неделей видео; будущие даты и записи с base-lesson video игнорируются.

- `total_workouts` — число валидных завершений;
- `total_weeks_completed` — недели с семью разными `day_of_week`;
- `total_minutes_trained` — `floor(sum(duration_seconds) / 60)`;
- серии считаются по разным календарным `workout_date`;
- `best_streak` — самый длинный исторический непрерывный ряд;
- `current_streak` — последний ряд, только если его конец сегодня или вчера, иначе `0`.

## Достижения

Миграция и идемпотентный seed фиксируют ровно пять строк:

| Код                 | Иконка | Название          | Условие                         |
| ------------------- | ------ | ----------------- | ------------------------------- |
| `first_base_lesson` | 🎯     | Первый шаг        | 1 базовый урок не менее 90%     |
| `base_unlocked`     | 🔓     | База пройдена     | 4 разных базовых урока          |
| `first_workout`     | 💪     | Первая тренировка | 1 валидная тренировка           |
| `week_complete`     | 🏆     | Неделя завершена  | 7 разных дней в одной неделе    |
| `streak_3`          | 🔥     | Три подряд        | 3 последовательные даты занятий |

Locked-ответ содержит прогресс `current/target`; unlocked-ответ содержит стабильный
`unlocked_at`. Неизвестные legacy-строки не попадают в API, а content verifier запрещает extra,
missing или изменённые canonical rows.

## Frontend

Экран содержит ровно четыре прокручиваемые секции:

1. «Моя цель» и модалка с четырьмя radio-вариантами.
2. «Как вы себя чувствуете?» с одним лёгким SVG-графиком и переключателем четырёх метрик.
3. «Ваши достижения в цифрах» с пятью агрегатами.
4. «Достижения» с unlocked/locked состояниями и aggregate-счётчиком.

При истории короче двух недель SVG заменяется точным placeholder-текстом. Ось Y всегда `1–10`,
ось X сохраняет реальные номера недель. Самооценка использует четыре native range `1–10`,
textarea до 500 символов и native `<dialog>` с Escape, backdrop и восстановлением фокуса.

Интерфейс сохраняет touch targets не меньше 44 px, видимый keyboard focus, `role="img"` и
`title`/`desc` у графика, доступные labels у sliders/radios, user timezone для даты достижения,
safe-area и отсутствие горизонтального overflow на 320 и 428 px. После смены цели frontend
обновляет dashboard сразу и затем синхронизирует профиль через `/api/v1/me`, чтобы edit survey не
использовал старую версию.

## Проверки

```bash
npm run verify:structure
npm run typecheck
npm run lint
npm run test
npm run build
```

Fail-closed маркеры:

```text
KINETRA_T09_BACKEND_E2E=PASS
KINETRA_T09_POSTGRES_INTEGRATION=PASS
KINETRA_T09_PROGRESS_CONTENT=PASS
KINETRA_T09_GOAL_UPDATE=PASS
KINETRA_T09_WEEKLY_METRICS=PASS
KINETRA_T09_CHARTS=PASS
KINETRA_T09_BROWSER_E2E=PASS
KINETRA_T09_TEST_SUITE=PASS
```
