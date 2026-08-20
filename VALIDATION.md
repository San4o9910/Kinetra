# Kinetra T02 — Validation report

**Дата проверки:** 2026-08-19  
**Пакет:** Kinetra standalone PWA monorepo, версия `0.2.0`  
**Задача:** T02 — регистрация и авторизация по email/паролю с опциональным телефоном

## Итог

Структура T02 собрана. Реализованы auth API, SQL-миграция, конфигурация, общие типы,
положительные и отрицательные E2E-тесты, документация и защита токенов/сессий.

В доступной среде пройдены офлайн-проверки структуры, синтаксиса, TypeScript и сервисной
логики. Полная проверка с реальными npm-пакетами и PostgreSQL должна быть выполнена после
`npm install` на машине с доступом к npm registry и Docker/PostgreSQL.

## Пройденные проверки

### 1. Структурная проверка проекта

Команда:

```bash
npm run verify:structure
```

Результат:

```text
125 structural checks passed.
```

Проверены, в частности:

- точные workspace-имена `@kinetra/frontend`, `@kinetra/backend`, `@kinetra/shared`;
- наличие всех семи auth endpoints;
- конфигурационное включение `/verify-email`;
- bcrypt hash/compare и ограничение bcrypt в 72 UTF-8 байта;
- короткоживущий access JWT, алгоритм HS256, подпись и проверка;
- случайные opaque refresh/reset/verification tokens и SHA-256 hash-only storage;
- refresh rotation, replacement chain, logout/revocation и reuse detection;
- одноразовый reset token, TTL, rate limit и отзыв всех refresh-сессий после смены пароля;
- одинаковый reset-request ответ для существующего и неизвестного аккаунта;
- нормализация email и телефона;
- запрет использования `userId`/`user_id` из request body;
- PostgreSQL-транзакции, row locks и параметризованные запросы;
- отсутствие реального `.env`, legacy-брендинга и запрещённой auth-интеграции.

### 2. JSON и JavaScript

- Все 11 JSON-файлов успешно разобраны через `JSON.parse`.
- `node --check` пройден для:
  - `scripts/verify-project.mjs`;
  - `apps/backend/scripts/migrate.mjs`;
  - `apps/frontend/public/service-worker.js`.

### 3. TypeScript

Использован доступный в среде TypeScript `5.8.3` и временные локальные declaration stubs,
которые не входят в итоговый архив.

Успешно проверены:

```text
packages/shared/tsconfig.json          PASS
apps/backend/tsconfig.json             PASS
apps/backend/tsconfig.test.json        PASS
apps/frontend/tsconfig.json            PASS
```

Компилятор работал со строгими настройками, включая `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noUnusedLocals` и `noUnusedParameters`.

### 4. Auth service smoke test

Результат:

```text
KINETRA_T02_SERVICE_SMOKE=PASS
```

Покрыты сценарии:

- email registration/login и нормализация регистра;
- реальный bcrypt-формат хэша через системную bcrypt-совместимую проверку;
- неверный пароль;
- phone alternative и конфигурационно разрешённый phone-only сценарий;
- выпуск, проверка, подмена подписи и истечение access JWT;
- refresh rotation, reuse detection и отзыв replacement-сессии;
- reset request для существующего/неизвестного аккаунта;
- хранение reset token только по SHA-256 хэшу;
- одноразовое использование и отклонение просроченного reset token;
- отзыв refresh-сессий и смена действующего пароля;
- опциональная email verification и запрет повторного применения token.

Smoke test проверяет доменную логику без HTTP/Express и PostgreSQL. Для него использовались
временные совместимые runtime stubs; они удалены из выдаваемого пакета и не заменяют запуск
официального E2E-набора с реальными зависимостями.

## Что не было выполнено в этой среде

### npm-зависимости и полная команда `npm run check`

Доступ к npm registry отсутствовал:

```text
EAI_AGAIN getaddrinfo registry.npmjs.org
```

Поэтому здесь не запускались с реальными установленными пакетами:

- `npm install`;
- `npm run lint`;
- `npm run test`;
- `npm run build`;
- полная команда `npm run check`.

### PostgreSQL

В среде отсутствовали Docker, `psql` и PostgreSQL server. Поэтому миграция
`apps/backend/migrations/001_auth.sql` не применялась к живой базе данных.

## Финальная локальная приёмка

После распаковки выполните:

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run check
npm run dev
```

Для PowerShell:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run check
npm run dev
```

Ожидаемый результат:

- migration runner применяет `001_auth.sql`;
- `typecheck`, `lint`, E2E tests и production builds проходят;
- `GET /health` возвращает `200`;
- auth API доступен по `/api/v1/auth`.
