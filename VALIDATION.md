# Kinetra T06 — отчёт проверки

**Дата локальной проверки:** 2026-08-20

**Ветка:** `feature/t06-base-lessons` от актуального `develop`

**Объём:** T01–T06, standalone PWA monorepo

## Результат

T06 реализован обычными исходными файлами TypeScript/TSX/SQL/CSS/Markdown. В репозитории нет
bootstrap, encoded payload, временных apply-workflows и Telegram runtime-интеграций.

Локально пройдены структурная проверка, TypeScript, ESLint, backend/frontend tests и production
builds. PostgreSQL integration и полноценный Chrome acceptance оставлены fail-closed проверками
CI, потому что в рабочей sandbox-среде нет PostgreSQL server/Docker и Chrome binary.

## Локально пройдено

### Структура и защита исходников

```text
node scripts/verify-project.mjs
449 structural checks passed.
```

Verifier проверяет API/SQL/UI-контракты T01–T06, отсутствие реального `.env`, forbidden runtime
интеграций и подозрительных путей `bootstrap`, `payload`, `*.b64`, `*.base64`, `*.encoded` и
`.tNN-pr-trigger`.

CI дополнительно сравнивает список путей `MANIFEST.sha256` с полным `git ls-files` (кроме самого
manifest), после чего запускает `sha256sum -c`. Поэтому лишний tracked payload не может обойти
проверку простым отсутствием в manifest.

### TypeScript и ESLint

```text
packages/shared/tsconfig.json      PASS
apps/backend/tsconfig.json         PASS
apps/backend/tsconfig.test.json    PASS
apps/frontend/tsconfig.json        PASS
ESLint apps/packages/scripts       PASS
```

### Backend tests

```text
tests 19
pass 17
fail 0
skipped 2 (PostgreSQL: DATABASE_URL не настроен локально)
KINETRA_T06_BACKEND_E2E=PASS
```

T06 HTTP E2E проверяет JWT, семь упорядоченных placeholder-уроков, точный progress в повторном
GET, строгую валидацию, int32 boundary, монотонный completion, порог четырёх уроков,
идемпотентность и запрет обхода предыдущего onboarding state.

### Frontend unit/API tests

```text
tests 25
pass 25
fail 0
```

Проверены все API-запросы, keepalive progress PUT, семь точных названий, completed/in-progress/
not-started карточки, placeholder, динамическая CTA, optimistic update, защита от устаревшего GET
и сериализация periodic/final progress без гонки перед refetch.

### Production builds

```text
@kinetra/shared    PASS
@kinetra/backend   PASS
@kinetra/frontend  PASS
```

Frontend Vite build: 41 module, основной JS bundle около 240 kB (74 kB gzip).

## Обязательные CI-проверки

CI поднимает PostgreSQL, применяет миграции `001`–`004`, выполняет seed/verify-content и требует
реального запуска PostgreSQL integration. Затем установленный Chrome проходит единый browser
journey T04–T06 на ширинах 320/428 px.

T06 browser acceptance проверяет:

- семь уроков и три визуальных состояния карточки;
- placeholder без фиктивного прогресса и system Back при неуспешном background GET;
- реальный десятисекундный progress PUT на 45% и отдельный final PUT;
- четыре завершённых урока, динамическую CTA и переход `base_lessons -> active`;
- сохранение `active` после reload и очистку временного Chrome profile.

Fail-closed маркеры:

```text
KINETRA_T06_BACKEND_E2E=PASS
KINETRA_T06_POSTGRES_INTEGRATION=PASS
KINETRA_T06_PERIODIC_PROGRESS=PASS
KINETRA_T06_CARD_STATES=PASS
KINETRA_T06_SYSTEM_BACK=PASS
KINETRA_T06_BROWSER_E2E=PASS
KINETRA_T06_TEST_SUITE=PASS
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

Для production необходимо задать собственный JWT secret, secure refresh-cookie и HTTPS. Если
указан custom `S3_ENDPOINT`, production-конфигурация принимает только `https:`.
