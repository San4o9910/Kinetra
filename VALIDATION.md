# Kinetra T07 — отчёт проверки

**Дата локальной проверки:** 2026-08-20

**Ветка:** `feature/t07-main-screen` от актуального `develop`

**Объём:** T01–T07, standalone PWA monorepo

## Результат

T07 реализован обычными исходными файлами TypeScript/TSX/SQL/CSS/Markdown. Главный экран
показывает текущую и доступную preview-неделю, семь тренировок, progress, Today, player или
placeholder и fixed tab bar. Backend вычисляет неделю по `workout_completions`, ограничивает
будущие недели и идемпотентно записывает completion от JWT-пользователя.

В репозитории нет bootstrap, encoded payload, временных apply-workflows и запрещённых runtime
интеграций. Локально пройдены structure, TypeScript, ESLint, backend/frontend tests, production
builds и статический visual QA реальных React-компонентов в Chromium 149. PostgreSQL integration
и полный Chrome journey оставлены обязательными fail-closed проверками CI: в sandbox нет
PostgreSQL server/Docker, а изолированный Chromium не получает HTTP-доступ к loopback mock server.

## Локально пройдено

### Структура и защита исходников

```text
node scripts/verify-project.mjs
654 structural checks passed.
```

Verifier проверяет API/SQL/UI-контракты T01–T07, canonical workout icons, explicit
`media_available`, browser markers и отсутствие подозрительных путей `bootstrap`, `payload`,
`*.b64`, `*.base64`, `*.encoded` и `.tNN-pr-trigger`.

CI сравнивает полный `git ls-files` (кроме manifest) со списком путей `MANIFEST.sha256`, затем
выполняет `sha256sum -c`. Лишний tracked payload не может обойти проверку отсутствием в manifest.

### TypeScript и ESLint

```text
npm run typecheck    PASS
npm run lint         PASS
```

Проверены shared, backend production/test и frontend TypeScript projects, а также ESLint для
`apps`, `packages` и `scripts`.

### Backend tests

```text
tests 26
pass 23
fail 0
skipped 3 (PostgreSQL: DATABASE_URL не настроен локально)
KINETRA_T06_BACKEND_E2E=PASS
KINETRA_T07_BACKEND_E2E=PASS
```

T07 HTTP E2E проверяет 401, неделю 1 по умолчанию, семь упорядоченных дней и emoji, preview
`current + 1`, запрет далёкого будущего, media availability, строгую Zod-валидацию,
user/video/week membership, идемпотентность и переход после 7/7 вплоть до недели 12.

Migration `005_program_media_availability.sql` сохраняет будущие S3 object keys, но по умолчанию
возвращает `null` URLs. URL подписывается только после `media_available = true`; locked-неделя
никогда не раскрывает media URL.

### Frontend unit/API tests

```text
tests 34
pass 34
fail 0
```

T07 тесты фиксируют семь направлений, emoji и длительности, `X/7`, границы стрелок, три состояния
карточек, Today в timezone пользователя, четыре вкладки, placeholder, threshold 90% и все три
authenticated program API requests. Доменный `PROGRAM_WEEK_LOCKED` не завершает JWT-сессию.

### Production builds

```text
@kinetra/shared    PASS
@kinetra/backend   PASS
@kinetra/frontend  PASS
```

Frontend Vite build: 47 modules, основной JS bundle около 258 kB (79 kB gzip), CSS около 31 kB.

### Visual QA

`ProgramWeekView` и `TabBar` отрендерены из production-компонентов в Chromium 149 при ширинах
320 и 428 px. Проверено: семь карточек, отсутствие горизонтального overflow
(`scrollWidth = viewport width`), fixed tab bar, targets стрелок 44×44 px, вкладок не меньше
79×56 px и карточек не меньше 296×82 px. Вычисленные цвета совпали с контрактом: фон
`rgb(8, 9, 9)`, accent `rgb(200, 241, 105)`.

## Обязательные CI-проверки

CI поднимает PostgreSQL 17, применяет migrations `001`–`005`, выполняет seed дважды,
`db:verify-content` и требует реального PostgreSQL integration marker. Затем установленный Chrome
проходит единый mobile journey T04–T07 на ширинах 320/428 px.

T07 browser acceptance проверяет:

- семь доступных карточек, progress, Today highlight и touch targets;
- Schedule → Progress → Home и `aria-current` каждой вкладки;
- preview недели 2, ровно семь locked-карточек и границы стрелок;
- Today player/placeholder и возврат системным Back с очисткой history state;
- закрытие player через Home/Schedule и чистый Back без скрытой same-URL записи;
- восстановление player через reload/Forward и блокировку вкладок во время saving;
- placeholder для отсутствующего workout media;
- отсутствие PUT на 89% и один `complete-workout` PUT на 95% через реальный `timeupdate`;
- возврат к списку, `completed`, `1/7`, reload persistence и переход в Settings.

Fail-closed markers:

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

## Команды воспроизведения

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run check
sha256sum -c MANIFEST.sha256
```

Перед включением workout media uploader должен сначала загрузить объект в S3 и только после
успешной загрузки выставить `media_available = true`. Для production также нужны собственные JWT
secrets, secure refresh-cookie и HTTPS; custom `S3_ENDPOINT` допускается только с `https:`.
