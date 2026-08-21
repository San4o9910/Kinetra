# Kinetra T10 — план и отчёт проверки

**Дата:** 2026-08-21

**Ветка:** `feature/t10-settings`

**Объём:** T01–T10, standalone PWA monorepo

## Текущий статус

T10 подготовлен обычными TypeScript/TSX/SQL/CSS/Markdown исходниками. Добавлены защищённые
settings API, полноценный экран настроек и три режима глобальной темы. Миграция называется
`008_notifications.sql`: номер `004` из исходного задания уже занят применённой T06-миграцией и
не может быть переиспользован в append-only журнале.

Итоговая проверка T10 ещё выполняется. Ниже `PASS` ставится только после фактического запуска;
непрогнанные команды явно оставлены `PENDING`.

## Матрица локальной проверки

| Проверка                          | Статус                  | Команда / условие                                       |
| --------------------------------- | ----------------------- | ------------------------------------------------------- |
| Структурные T01–T10 contracts     | PASS — 1196 checks      | `node scripts/verify-project.mjs`                       |
| TypeScript                        | PASS                    | shared, backend production/tests, frontend              |
| ESLint                            | PASS                    | `eslint apps packages scripts`                          |
| Backend + frontend unit/E2E       | PASS local              | backend 38 pass + 5 PG skip; frontend 52 pass           |
| Production build                  | PASS                    | shared, backend, frontend Vite (61 modules)             |
| PostgreSQL migrations/integration | PENDING CI              | нужен PostgreSQL и `KINETRA_REQUIRE_POSTGRES_TEST=true` |
| Chrome browser acceptance         | PENDING CI              | локальный Chrome/Chromium отсутствует                   |
| Tracked source manifest           | PASS — 177 source files | exact path set + `sha256sum -c MANIFEST.sha256`         |

Все изменённые форматируемые файлы проходят targeted Prettier check. Общий `prettier --check .`
также показывает 14 существовавших до T10 style warnings в неизменённых baseline-файлах; T10 их
не переписывает. Предыдущий T09 baseline был зелёным в CI, но он не заменяет новые T10 проверки и
не используется как доказательство результата T10.

## Что обязана доказать структура

`scripts/verify-project.mjs` проверяет существование обычных T10 source files, миграцию `008`,
JWT/no-store settings router, строгие Zod payload, PostgreSQL contracts, shared DTO и четыре
frontend API-метода. Для UI фиксируются шесть секций, 33 времени, debounce, dialogs, theme
provider, ранний `/theme-init.js`, semantic light/dark tokens, tests и fail-closed CI markers.

Отдельно запрещены `.t10-bootstrap`, `.github/workflows/apply-t10.yml`,
`docs/.t10-pr-trigger`, а общий рекурсивный gate продолжает запрещать bootstrap/payload,
`*.b64`, `*.base64`, `*.encoded`, apply/export workflows и encoded-source paths.

## Backend acceptance

HTTP E2E должен подтвердить:

- `401` и `Cache-Control: no-store` для неавторизованных settings requests;
- `none` subscription с nullable полями и вычисление active/pending/expired/cancelled;
- строгий notification payload, валидный `HH:MM`, успешный `204` и ошибки `400`;
- точное `{ "confirm": "DELETE" }`, отклонение отсутствующего/лишнего/неверного подтверждения;
- очистку refresh cookie после удаления.

PostgreSQL integration должен применить `001`–`008` и подтвердить legacy backfill/default/not-null
notification JSON, `auto_renew`, deterministic subscription selection, реальный upsert, CASCADE
всех пользовательских данных, недействительный refresh token и невозможность повторного login.
Integration marker не должен печататься при skip.

## Frontend и тема

Unit/API tests должны подтвердить:

- шесть settings sections, subscription states, support/about/level и survey entry;
- два switch, 33 значения `06:00`–`22:00`, debounce только финального полного PUT payload;
- logout и успешное удаление очищают in-memory access token;
- два этапа danger-flow и точный ввод `DELETE`;
- preference `system | light | dark`, безопасную localStorage-нормализацию и system resolution.

Browser journey должен проверить весь T10 flow при 320px и 428px, theme persistence после reload,
динамическую системную тему, применение light/dark за пределами `/settings`, debounced
notifications, отменённый и подтверждённый logout, затем отменённое и подтверждённое удаление.
Финальный marker печатается только после сохранения T04–T09 journey.

## Обязательные CI markers

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

CI обязан продолжать grep всех markers T04–T09 и дополнительно всех T10 markers; отсутствие любого
из них завершает job ошибкой.

## Команды полной проверки

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run db:seed
npm run db:verify-content
npm run check
diff -u \
  <(git ls-files | sed '/^MANIFEST\.sha256$/d' | sed 's#^#./#' | LC_ALL=C sort) \
  <(awk '{ print $2 }' MANIFEST.sha256 | LC_ALL=C sort)
sha256sum -c MANIFEST.sha256
```

## Границы

T10 не выполняет настоящий платёж и не отменяет auto-renew у провайдера. Кнопка отмены открывает
честную информационную модалку и направляет к тренеру; платежный endpoint/webhook остаётся
отдельным этапом. Для production также нужны реальные URLs политики, оплаты и поддержки,
собственные JWT secrets, HTTPS, secure refresh cookie и S3 credentials.
