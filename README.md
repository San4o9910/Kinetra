# Kinetra — standalone PWA monorepo

Kinetra — фитнес-приложение с React/Vite frontend и Express/PostgreSQL backend.

В репозитории завершены два этапа:

- **T01:** каркас монорепо, PWA, PostgreSQL в Docker Compose, health endpoint и transport Socket.IO;
- **T02:** регистрация и авторизация по email/паролю, опциональный телефон, refresh-сессии,
  logout, password reset и опциональная верификация email.

## Структура

```text
kinetra/
├── apps/
│   ├── frontend/          @kinetra/frontend — React + TypeScript + Vite + PWA
│   └── backend/           @kinetra/backend — Express + TypeScript + PostgreSQL
├── packages/
│   └── shared/            @kinetra/shared — общие API-типы
├── docs/
│   └── T02_AUTH_API.md    Контракт auth API и сценарии
├── scripts/               Структурная проверка проекта
├── docker-compose.yml     PostgreSQL 17
└── .env.example           Шаблон переменных без реальных секретов
```

## Быстрый запуск

Требования: Node.js 22.12+, npm 10+ и Docker Compose.

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Для PowerShell первая команда:

```powershell
Copy-Item .env.example .env
```

Адреса по умолчанию:

- frontend: `http://localhost:5173`;
- backend: `http://localhost:3000`;
- health: `http://localhost:3000/health`;
- PostgreSQL: `localhost:5432`.

Frontend и backend также запускаются отдельно:

```bash
npm run dev:frontend
npm run dev:backend
```

## Auth API T02

Базовый путь: `/api/v1/auth`.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/register` | Регистрация по email/паролю; телефон можно добавить как альтернативу |
| POST | `/login` | Вход по email или телефону и паролю |
| POST | `/refresh` | Ротация refresh token и выпуск нового access JWT |
| POST | `/logout` | Отзыв текущей refresh-сессии |
| POST | `/password-reset/request` | Запрос одноразового reset token |
| POST | `/password-reset/confirm` | Смена пароля по reset token |
| POST | `/verify-email` | Появляется только при включённой email-верификации |

Access token возвращается в JSON. Refresh token хранится в `HttpOnly` cookie и не возвращается
в теле ответа. Для запросов frontend должен использовать `credentials: 'include'`.

Пример регистрации:

```bash
curl -i http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"StrongPass123"}'
```

Пример входа:

```bash
curl -i http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"user@example.com","password":"StrongPass123"}'
```

Подробные форматы запросов и ответов находятся в [`docs/T02_AUTH_API.md`](docs/T02_AUTH_API.md).

## Email и телефон

Основной сценарий — email + пароль.

```dotenv
AUTH_PHONE_LOGIN_ENABLED=true
AUTH_PHONE_ONLY_REGISTRATION_ENABLED=false
```

При такой конфигурации телефон можно добавить к email и затем использовать для входа, но
регистрация только по телефону запрещена. Чтобы разрешить phone-only регистрацию:

```dotenv
AUTH_PHONE_LOGIN_ENABLED=true
AUTH_PHONE_ONLY_REGISTRATION_ENABLED=true
```

Телефон нормализуется в E.164, например `+7 (999) 123-45-67` становится `+79991234567`.
Номер без международного кода `+` не принимается, чтобы сервер не угадывал страну.

Email обрезается по краям, домен приводится к ASCII, весь идентификатор сохраняется в нижнем
регистре.

## Сессии и токены

- пароль хранится только как bcrypt-хэш;
- access token — короткоживущий JWT HS256, подписанный и проверяемый через `jose`;
- refresh token — случайная непрозрачная строка высокой энтропии;
- в PostgreSQL сохраняется только SHA-256 хэш refresh token;
- каждый refresh отзывает предыдущий token и выдаёт новый;
- повторное использование уже отозванного refresh token отзывает все активные refresh-сессии
  пользователя;
- logout отзывает текущую refresh-сессию;
- user ID не принимается из body как источник личности.

Access token рекомендуется держать только в памяти frontend. В `localStorage` его сохранять не
нужно: восстановление сессии выполняется через `HttpOnly` refresh cookie. После logout или смены
пароля уже выпущенный access token остаётся действительным только до окончания короткого TTL
(по умолчанию не более 15 минут); новые access tokens получить уже нельзя.

Перед production обязательно замените `JWT_ACCESS_SECRET`, включите secure-cookie и используйте
HTTPS:

```dotenv
NODE_ENV=production
JWT_ACCESS_SECRET=<длинный случайный секрет>
AUTH_REFRESH_COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
```

## Password reset

`POST /password-reset/request` всегда возвращает одинаковый ответ для существующего и
несуществующего аккаунта. Это не позволяет определить, зарегистрирован ли email.

Reset token:

- генерируется случайно;
- в БД хранится только его SHA-256 хэш;
- имеет TTL;
- становится недействительным после первого использования;
- новый reset request инвалидирует предыдущий неиспользованный token;
- после смены пароля отзывает все refresh-сессии пользователя;
- endpoint запроса ограничен по IP через fixed-window rate limiter.

В T02 нет привязки к конкретному почтовому или SMS-провайдеру. Есть интерфейс доставки токенов.
В local development режим `AUTH_TOKEN_DELIVERY_MODE=console` печатает одноразовый token в лог.
В production console-режим запрещён. Перед реальным запуском нужно подключить почтовый/SMS
адаптер.

Текущий rate limiter хранит счётчики в памяти одного процесса. Перед горизонтальным
масштабированием его нужно заменить общим хранилищем, например Redis. За reverse proxy задайте
точное число доверенных прокси через `TRUST_PROXY_HOPS`, иначе лимит будет видеть адрес прокси, а
не клиента.

## Email verification

По умолчанию отключена:

```dotenv
AUTH_EMAIL_VERIFICATION_REQUIRED=false
```

После включения регистрация по email не выдаёт сессию до подтверждения. Сервер создаёт
одноразовый хэшируемый token, а маршрут `/verify-email` активируется. Phone-only пользователь без
email не блокируется этой проверкой.

## Миграции

```bash
npm run db:migrate
```

Миграция создаёт:

- `users`;
- `refresh_tokens`;
- `password_reset_tokens`;
- `email_verification_tokens`;
- `schema_migrations` создаётся самим runner.

Runner использует advisory lock, SHA-256 миграций и не позволяет молча изменить уже применённый
SQL-файл.

## Проверки

```bash
npm run verify:structure
npm run typecheck
npm run lint
npm run test
npm run build
```

Все проверки одной командой:

```bash
npm run check
```

E2E-набор покрывает положительные и отрицательные сценарии: email login, неверный пароль,
phone-only configuration, refresh rotation/reuse/logout, одноразовый и просроченный reset token,
неразглашение существования email, отзыв сессий после смены пароля, email verification, rate limit
и запрет user ID из body.

## Граница T02

В T02 не входят UI-формы авторизации, настоящий email/SMS provider, OAuth/social login,
Telegram auth, восстановление через Telegram, S3-видео, YooKassa и доменная логика чата.
