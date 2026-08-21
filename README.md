# Kinetra — standalone PWA monorepo

Kinetra — фитнес-приложение с React/Vite frontend и Express/PostgreSQL backend.

В репозитории завершены этапы T01–T08:

- **T01:** каркас монорепо, PWA, PostgreSQL в Docker Compose, health endpoint и transport Socket.IO;
- **T02:** регистрация и авторизация по email/паролю, опциональный телефон, refresh-сессии,
  logout, password reset и опциональная верификация email;
- **T03:** модель контента, 12 недель, 84 тренировки, 7 базовых уроков и достижения;
- **T04:** профиль, версионируемая анкета и серверный onboarding routing;
- **T05:** адаптивная онбординг-карусель и атомарный переход к базовым урокам;
- **T06:** список базовых уроков, плеер/placeholder, прогресс и серверная разблокировка
  программы после четырёх завершённых уроков.
- **T07:** главный экран 12-недельной программы, workout player, completion и нижняя навигация;
- **T08:** расписание текущей/следующей недели с полными описаниями и статусом выполнения.

## Структура

```text
kinetra/
├── apps/
│   ├── frontend/          @kinetra/frontend — React + TypeScript + Vite + PWA
│   └── backend/           @kinetra/backend — Express + TypeScript + PostgreSQL
├── packages/
│   └── shared/            @kinetra/shared — общие API-типы
├── docs/                 Контракты и сценарии T02–T08
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

## Onboarding и базовые уроки

Серверный `onboarding_status` задаёт единственный допустимый frontend-маршрут:

```text
survey_pending -> /survey
onboarding_pending -> /onboarding
base_lessons -> /base-lessons
active -> /
```

T06 добавляет защищённые endpoints:

| Метод | Путь                                      | Назначение                                     |
| ----- | ----------------------------------------- | ---------------------------------------------- |
| GET   | `/api/v1/base-lessons`                    | Семь уроков с прогрессом текущего пользователя |
| PUT   | `/api/v1/base-lessons/:lessonId/progress` | Upsert позиции и процента просмотра            |
| PUT   | `/api/v1/base-lessons/complete-program`   | Серверная проверка порога и переход в `active` |

При отсутствующем S3-ключе URL равен `null`, а UI показывает placeholder. Полный
контракт, ошибки и матрица проверок: [`docs/T06_BASE_LESSONS.md`](docs/T06_BASE_LESSONS.md).

## Программа и расписание

Для активного пользователя доступны защищённые endpoints:

| Метод | Путь                                | Назначение                                    |
| ----- | ----------------------------------- | --------------------------------------------- |
| GET   | `/api/v1/program/current-week`      | Текущая неделя главного экрана                |
| GET   | `/api/v1/program/weeks/:weekNumber` | Текущая, прошлая или следующая preview-неделя |
| PUT   | `/api/v1/program/complete-workout`  | Идемпотентное завершение текущей тренировки   |
| GET   | `/api/v1/program/schedule`          | Текущая и следующая недели для `/schedule`    |

Главный экран описан в [`docs/T07_MAIN_SCREEN.md`](docs/T07_MAIN_SCREEN.md), а компактный API и
UI расписания — в [`docs/T08_SCHEDULE.md`](docs/T08_SCHEDULE.md).

## Auth API T02

Базовый путь: `/api/v1/auth`.

| Метод | Путь                      | Назначение                                                           |
| ----- | ------------------------- | -------------------------------------------------------------------- |
| POST  | `/register`               | Регистрация по email/паролю; телефон можно добавить как альтернативу |
| POST  | `/login`                  | Вход по email или телефону и паролю                                  |
| POST  | `/refresh`                | Ротация refresh token и выпуск нового access JWT                     |
| POST  | `/logout`                 | Отзыв текущей refresh-сессии                                         |
| POST  | `/password-reset/request` | Запрос одноразового reset token                                      |
| POST  | `/password-reset/confirm` | Смена пароля по reset token                                          |
| POST  | `/verify-email`           | Появляется только при включённой email-верификации                   |

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

Миграции разделены по этапам:

- `001_auth.sql` — пользователи и auth tokens;
- `002_content.sql` — видео, программа, подписки, прогресс и достижения;
- `003_survey.sql` — версионируемые ответы анкеты;
- `004_base_lessons.sql` — placeholder-ключи и порог завершения базового урока.
- `005_program_media_availability.sql` — явная доступность workout media до выдачи S3 URL.
- `006_schedule_copy.sql` — канонические названия и описания семи дней расписания.

`schema_migrations` создаётся самим runner.

Runner использует advisory lock, SHA-256 миграций и не позволяет молча изменить уже применённый
SQL-файл.

## Проверки

```bash
npm run verify:structure
npm run typecheck
npm run lint
npm run test
npm run build
sha256sum -c MANIFEST.sha256
```

Все проверки одной командой:

```bash
npm run check
```

E2E-набор покрывает auth, профиль/анкету, онбординг-карусель, базовые уроки, главный экран и T08:
JWT-защиту расписания, точные семь дней, completion state, следующую/финальную неделю,
сегментированное переключение и переход с карточки на главную. CI также сравнивает
`MANIFEST.sha256` со всеми tracked-файлами и запрещает bootstrap/payload artifacts.

## Границы текущего этапа

В T08 не входят загрузка настоящих S3-видео, платежи YooKassa, каталог тренеров и доменная логика
чата. Telegram-интеграции нет: продукт остаётся самостоятельной PWA.
