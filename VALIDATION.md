# Kinetra T11 — план и отчёт проверки

**Дата:** 2026-08-21

**Ветка:** `feature/t11-payments`

**Объём:** T01–T11, standalone PWA monorepo

## Текущий статус

T11 подготовлен обычными TypeScript/TSX/SQL/CSS/Markdown исходниками. Добавлены REST-интеграция
ЮKassa, webhook с независимой проверкой IP и canonical provider status, идемпотентные payment
events/renewal attempts, server entitlement, payment UI, polling, paywall и рабочая отмена будущих
списаний. Append-only миграция называется `009_payments.sql`.

Локальная проверка завершена. `PASS` ниже поставлен только после фактического запуска; проверки,
для которых локальная среда не готова, остаются `PENDING CI`.

## Матрица локальной проверки

| Проверка                          | Статус             | Команда / условие                                   |
| --------------------------------- | ------------------ | --------------------------------------------------- |
| Структурные T01–T11 contracts     | PASS — 1434 checks | `node scripts/verify-project.mjs`                   |
| TypeScript                        | PASS               | shared, backend production/tests, frontend          |
| ESLint                            | PASS               | `eslint apps packages scripts`                      |
| Backend + frontend unit/E2E       | PASS local         | backend 58 pass + 7 PG skip; frontend 61 pass       |
| Production build                  | PASS               | shared, backend, frontend Vite (70 modules)         |
| PostgreSQL migrations/integration | PENDING CI         | PostgreSQL + `KINETRA_REQUIRE_POSTGRES_TEST=true`   |
| Chrome browser acceptance         | PENDING CI         | script/contracts PASS; локальный Chrome отсутствует |
| Tracked source manifest           | PASS — 208 files   | полный sorted SHA-256 inventory без самого manifest |

### Сохранённый baseline T10

До начала T11 были зафиксированы: structure `PASS — 1196 checks`, TypeScript/ESLint/build `PASS`,
backend 38 tests + 5 PostgreSQL skips, frontend 52 tests, 177 source files в manifest. PostgreSQL
integration и Chrome acceptance оставались `PENDING CI`. T11 не заменяет эти результаты новыми
`PASS`: все прежние T04–T10 markers продолжают проверяться в том же CI job.

## Что обязана доказать структура

`scripts/verify-project.mjs` проверяет обычные T11 source files, миграцию `009`, shared DTO,
JWT/no-store create/cancel routes, public webhook с fail-closed source verifier, прямой REST client
ЮKassa, canonical status re-fetch, идемпотентные events/renewal attempts, server-side entitlement,
cron command, три payment routes, 2s/30s polling, premium paywall, settings integration, tests,
очистку workout sentinel state при истёкшем доступе, документацию и fail-closed CI markers.

Отдельно запрещены `.t11-bootstrap`, `.github/workflows/apply-t11.yml` и
`docs/.t11-pr-trigger`. Общий recursive gate продолжает запрещать bootstrap/payload paths,
`*.b64`, `*.base64`, `*.encoded`, apply/export workflows и encoded-source artifacts.

## Backend acceptance

HTTP/client E2E обязаны подтвердить:

- `401` для create/cancel без access JWT, строгий `{ return_url }` и server-side allowlist;
- server-owned `799.00 RUB`, `capture: true`, `save_payment_method: true`, redirect confirmation,
  metadata user ID, HTTP Basic credentials и `Idempotence-Key` не длиннее 64 символов;
- webhook без JWT, но с официальным IPv4/IPv6 allowlist до мутаций;
- повторное чтение payment/refund из ЮKassa, сравнение terminal status, IDs, amount/currency и
  metadata; redirect/body alone не активирует доступ;
- duplicate webhook возвращает `200` и не продлевает период повторно;
- `payment.canceled` renewal не отнимает уже оплаченный срок, а partial refund не маскируется под
  подтверждённый full-refund policy;
- отмена автопродления идемпотентна и сохраняет active status/expiry;
- `403 SUBSCRIPTION_REQUIRED` для платной программы без active entitlement; базовые уроки
  остаются доступны;
- повторный/параллельный daily worker не создаёт два списания для одного периода.
- cancel и renewal сериализованы на PostgreSQL row lock: либо отмена выигрывает до provider call,
  либо дожидается уже начатого запроса; terminal webhook не может быть перезаписан поздним attach;
- `payment_method.id` не сохраняется и автопродление не включается, если provider вернул
  `payment_method.saved: false`.

PostgreSQL integration обязан применить `001`–`009` и проверить реальные unique constraints,
provider IDs, saved payment method, processed-event deduplication, renewal claim и cancel update.
Integration marker не печатается при skip.

## Frontend и browser acceptance

Unit/API tests должны фиксировать exact routes и payload, блокировку duplicate submit,
полноэкранный redirect, немедленный non-overlapping polling каждые 2 секунды не дольше 30 секунд,
включая зависший fetch в общий hard deadline, timeout/retry/error states, subscription update до
перехода к тренировкам, cancel page, paywall и settings cancel/renew actions.

Same-origin browser journey сохраняет T04–T10 и дополнительно проверяет:

1. active subscription: подтверждение отмены делает один POST, меняет только `auto_renew`;
2. expired subscription: программа блокируется до запроса workout API, paywall открывается
   автоматически, workout cards/player не монтируются, оба workout history sentinel удаляются;
3. renew ведёт внутренней SPA-навигацией на `/payment`;
4. premium card, цена/benefits/copy и touch targets помещаются в 320px и 428px без overflow;
5. create отправляет точный `${window.location.origin}/payment/success`, duplicate click даёт один
   POST, confirmation redirect открывает success route;
6. success сначала видит `pending`, затем через polling получает `active`, обновляет canonical App
   state и открывает тренировку;
7. `/payment/cancel` поддерживает retry и «Позже».

## Обязательные CI markers

```text
KINETRA_T11_YOOKASSA_CLIENT=PASS
KINETRA_T11_BACKEND_E2E=PASS
KINETRA_T11_WEBHOOK_AUTH=PASS
KINETRA_T11_WEBHOOK_IDEMPOTENCY=PASS
KINETRA_T11_POSTGRES_INTEGRATION=PASS
KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS
KINETRA_T11_PAYMENT_FLOW=PASS
KINETRA_T11_PAYWALL=PASS
KINETRA_T11_SETTINGS_SUBSCRIPTION=PASS
KINETRA_T11_BROWSER_E2E=PASS
KINETRA_T11_TEST_SUITE=PASS
```

CI продолжает grep всех markers T04–T10 и дополнительно всех T11 markers; отсутствие любого из
них завершает job ошибкой.

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

Daily renewal отдельно проверяется безопасной test-конфигурацией:

```bash
npm run payments:renew -w @kinetra/backend
```

## Production границы

До production нужны реальные credentials, HTTPS, точная proxy topology, webhook registration,
daily scheduler и мониторинг. Рекуррентные платежи должны быть включены ЮKassa, а согласие
пользователя — зафиксировано. T11 не передаёт receipt items и не решает требования 54-ФЗ без
настройки кассы/налоговой проверки; partial refund policy также требует отдельного бизнес-решения.
Подробности и официальные ссылки: [`docs/T11_PAYMENTS.md`](docs/T11_PAYMENTS.md).
