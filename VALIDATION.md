# Kinetra T08 — отчёт проверки

**Дата локальной проверки:** 2026-08-21

**Ветка:** `feature/t08-schedule` от `develop@01f9c49`

**Объём:** T01–T08, standalone PWA monorepo

## Результат

T08 реализован обычными исходными файлами TypeScript/TSX/SQL/CSS/Markdown. Заглушка
`/schedule` заменена защищённым расписанием: текущая и следующая недели, семь полных карточек,
канонический текст, completion state, сегментированное переключение и финальное состояние недели 12. Нажатие карточки возвращает пользователя на главную вкладку.

Backend вычисляет текущую неделю той же логикой, что T07, читает завершения из
`workout_completions`, не выдаёт video IDs/S3 URLs и возвращает `next_week: null` только на
финальной неделе. Миграция `006_schedule_copy.sql` обновляет существующие базы, seed остаётся
идемпотентным, а content verifier фиксирует точный текст во всех 12 неделях.

В репозитории нет bootstrap, encoded payload, временных apply-workflows и запрещённых runtime
интеграций.

## Локально пройдено

### Структура и защита исходников

```text
node scripts/verify-project.mjs
770 structural checks passed.
```

Verifier проверяет API/SQL/UI-контракты T01–T08, route `/schedule`, JWT/no-store, русские weekday
labels, канонический seed/migration, schedule DTO, screen states, ARIA, responsive CSS, unit/browser
markers и отсутствие подозрительных путей `bootstrap`, `payload`, `*.b64`, `*.base64`,
`*.encoded`, apply-workflows и `.tNN-pr-trigger`.

### TypeScript, ESLint и форматирование

```text
npm run typecheck    PASS
npm run lint         PASS
```

Проверены shared, backend production/test и frontend TypeScript projects, а также ESLint для
`apps`, `packages` и `scripts`.

### Backend tests

```text
tests 28
pass 25
fail 0
skipped 3 (PostgreSQL: DATABASE_URL не настроен локально)
KINETRA_T08_BACKEND_E2E=PASS
```

T08 HTTP E2E проверяет:

- `401 AUTHENTICATION_REQUIRED` и `Cache-Control: no-store`;
- текущую неделю 1 и следующую неделю 2;
- семь упорядоченных дней с точными weekday/title/description/icon/duration/direction;
- persisted completion и `days_completed`;
- отсутствие S3 signing и video identity в компактном ответе;
- `next_week: null` после перехода на неделю 12.

### Frontend unit/API tests

```text
tests 39
pass 39
fail 0
```

Пять T08-тестов фиксируют authenticated `GET /api/v1/program/schedule`, семь текущих карточек,
полные описания, `Выполнено X из 7`, `✅`, следующую неделю без completion status и финальное
сообщение недели 12.

### Production builds

```text
@kinetra/shared    PASS
@kinetra/backend   PASS
@kinetra/frontend  PASS
```

Frontend Vite build: 49 modules, JS около 265 kB (80 kB gzip), CSS около 36 kB (7 kB gzip).

### Browser acceptance

`scripts/test-frontend-browser.mjs` расширен единым T04–T08 journey и проходит syntax,
Prettier/ESLint, production build, mock health и cleanup. Сценарий проверяет:

- семь текущих карточек и точный текст каждого дня;
- segmented Current → Next → Current и ARIA selected state;
- отсутствие completion status у следующей недели;
- 320/428 px без horizontal overflow, touch targets не меньше 44 px и отсутствие перекрытия
  фиксированной tab bar;
- переход с карточки расписания на `/`;
- обновление `0/7 → 1/7`, `✅` и лаймовую границу после реального T07 workout completion.

Локальный контейнер не содержит Chrome/Chromium, а облачный браузер не открывает loopback preview,
поэтому полный CDP journey и visual runtime остаются обязательной fail-closed проверкой CI, где
Chrome устанавливается workflow. В обоих локальных путях cleanup выполнен безопасно.

## Обязательные CI-проверки

CI поднимает PostgreSQL 17, применяет migrations `001`–`006`, запускает seed дважды,
`db:verify-content`, требует реальные PostgreSQL integration markers, затем выполняет полный
Chrome journey. Source manifest сравнивается с `git ls-files` до проверки SHA-256.

Fail-closed маркеры T08:

```text
KINETRA_T08_BACKEND_E2E=PASS
KINETRA_T08_SCHEDULE_CONTENT=PASS
KINETRA_T08_CARD_NAVIGATION=PASS
KINETRA_T08_COMPLETION_STATE=PASS
KINETRA_T08_BROWSER_E2E=PASS
KINETRA_T08_TEST_SUITE=PASS
```

## Команды воспроизведения

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run check
sha256sum -c MANIFEST.sha256
```

Для production нужны собственные JWT secrets, HTTPS, secure refresh-cookie и реальные S3
credentials. Workout media остаётся недоступным, пока uploader явно не подтвердит загрузку.
