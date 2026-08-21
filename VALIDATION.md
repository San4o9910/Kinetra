# Kinetra T09 — отчёт проверки

**Дата локальной проверки:** 2026-08-21

**Ветка:** `feature/t09-progress` от `develop@5b49c33`

**Объём:** T01–T09, standalone PWA monorepo

## Результат

T09 реализован обычными исходными файлами TypeScript/TSX/SQL/CSS/Markdown. Заглушка «Скоро»
удалена; `/progress` теперь показывает цель, самооценку с лёгким SVG-графиком, пять статистических
агрегатов и пять достижений. Две native-модалки обновляют цель и метрики без перезагрузки.

Backend добавляет три JWT-защищённых no-store endpoint, строгую Zod-валидацию, upsert метрик,
транзакционную версию анкеты и агрегаты из валидных workout completion. Миграция `007` безопасно
нормализует legacy-заметки до 500 символов, валидирует constraint и фиксирует canonical copy
достижений. Идемпотентный achievement backfill сохраняет время фактического события.

В репозитории нет bootstrap, encoded payload, временных apply-workflows и запрещённых runtime
интеграций.

## Локально пройдено

### Структура и защита исходников

```text
node scripts/verify-project.mjs
977 structural checks passed.
```

Verifier проверяет T01–T09 API/SQL/UI-контракты, migration/seed, canonical achievements,
JWT/no-store, три progress route, shared DTO, четыре секции, SVG и dialogs, тестовые/CI-маркеры и
отсутствие путей `bootstrap`, `payload`, `*.b64`, `*.base64`, `*.encoded`, apply-workflows и
`.tNN-pr-trigger`.

### TypeScript и ESLint

```text
npm run typecheck    PASS
npm run lint         PASS
```

Проверены shared, backend production/tests, frontend и все scripts.

### Backend tests

```text
tests 37
pass 33
fail 0
skipped 4 (PostgreSQL: DATABASE_URL не настроен локально)
KINETRA_T09_BACKEND_E2E=PASS
```

T09 HTTP E2E проверяет `401`, `Cache-Control: no-store`, пустую историю, строгую матрицу
невалидных payload, upsert, authoritative `pending_survey`, версионирование цели, статистику,
unlocked/locked achievements и идемпотентность materialization.

PostgreSQL и Docker CLI в рабочем контейнере отсутствуют, поэтому migrations `001–007`, двойной
seed, `db:verify-content` и четыре PostgreSQL integration suite остаются обязательной проверкой CI
с `KINETRA_REQUIRE_POSTGRES_TEST=true`.

### Frontend unit/API tests

```text
tests 45
pass 45
fail 0
```

Шесть новых T09-тестов фиксируют три authenticated API request, четыре секции, точные goal labels,
SVG с двумя и более точками, placeholder при короткой истории, пять stats, unlocked/locked
состояния, aggregate counter, четыре radio, четыре range `1–10`, textarea 500 и чистые model
helpers.

### Production builds

```text
@kinetra/shared    PASS
@kinetra/backend   PASS
@kinetra/frontend  PASS
```

Frontend Vite build: 53 modules, JS `281.04 kB` (`84.82 kB` gzip), CSS `46.01 kB` (`8.53 kB`
gzip).

### Browser acceptance

`scripts/test-frontend-browser.mjs` проходит syntax, Prettier и ESLint. Локальный запуск успешно
выполнил production build, mock API health и полный cleanup:

```text
KINETRA_BROWSER_MOCK_API=PASS
KINETRA_BROWSER_PROFILE_CLEANUP=PASS
KINETRA_BROWSER_TMP_CLEANUP=PASS
```

Полный CDP journey не стартовал: в контейнере нет Chrome/Chromium. Дополнительная попытка через
облачный Chrome не смогла открыть ни `127.0.0.1:4173`, ни `localhost:4173` и вернула
`net::ERR_BLOCKED_BY_CLIENT`. Это ограничение loopback-инфраструктуры, а не ошибка приложения.

Сценарий остаётся fail-closed в CI и проверяет:

- четыре progress-секции, точные stats/copy и unlocked/locked presentation;
- лёгкий SVG, две исходные и три точки после сохранения, все четыре metric switch;
- goal PUT и точную смену label;
- четыре sliders, note и точный weekly-metrics PUT payload;
- отсутствие CTA после сохранения;
- 320/428 px без horizontal overflow, touch targets не меньше 44 px и fixed tab bar;
- возврат Home перед неизменённым продолжением T07/T08 journey;
- GET не менее одного раза и оба mutation PUT ровно по одному разу.

## Обязательные CI-проверки

CI поднимает PostgreSQL 17, применяет migrations `001`–`007`, запускает seed дважды,
`db:verify-content`, требует реальный T09 PostgreSQL marker и выполняет Chrome journey. Source
manifest сравнивается с `git ls-files` до проверки SHA-256.

Fail-closed маркеры T09:

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

## Команды воспроизведения

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run db:seed
npm run db:verify-content
npm run check
sha256sum -c MANIFEST.sha256
```

Для production нужны собственные JWT secrets, HTTPS, secure refresh-cookie и реальные S3
credentials. Платежи, marketplace и чат не входят в T09.
