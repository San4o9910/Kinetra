# T02 — Auth API contract

## Общие правила

- Base URL: `/api/v1/auth`.
- Формат: JSON.
- Access token возвращается в JSON как `accessToken`; frontend хранит его в памяти, не в `localStorage`.
- Refresh token устанавливается сервером в `HttpOnly` cookie.
- Auth-ответы получают `Cache-Control: no-store`.
- Клиент не передаёт `userId` или `user_id`; такие поля отклоняются.
- Ошибка имеет форму:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid identifier or password.",
    "requestId": "..."
  }
}
```

## POST /register

Email — основной идентификатор. Телефон можно добавить как альтернативу.

```json
{
  "email": "user@example.com",
  "phone": "+79991234567",
  "password": "StrongPass123"
}
```

`phone` необязателен. `email` можно не передавать только при
`AUTH_PHONE_ONLY_REGISTRATION_ENABLED=true`.

Успех без обязательной верификации — `201`:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "phone": "+79991234567",
    "emailVerified": true,
    "createdAt": "2026-08-19T08:00:00.000Z"
  },
  "accessToken": "jwt",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

Если email verification включена, `201` не выдаёт сессию:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "phone": null,
    "emailVerified": false,
    "createdAt": "2026-08-19T08:00:00.000Z"
  },
  "emailVerificationRequired": true
}
```

Основные ошибки: `INVALID_EMAIL`, `INVALID_PHONE`, `EMAIL_REQUIRED`, `WEAK_PASSWORD`,
`IDENTIFIER_ALREADY_REGISTERED`.

## POST /login

Можно передать ровно один из трёх вариантов:

```json
{
  "identifier": "user@example.com",
  "password": "StrongPass123"
}
```

или:

```json
{
  "email": "user@example.com",
  "password": "StrongPass123"
}
```

или:

```json
{
  "phone": "+79991234567",
  "password": "StrongPass123"
}
```

Успех — `200` и тот же session response, что после обычной регистрации.

Неверный email, неизвестный аккаунт и неверный пароль дают одинаковую ошибку
`401 INVALID_CREDENTIALS`. При обязательной, но не завершённой верификации —
`403 EMAIL_NOT_VERIFIED` после проверки правильного пароля.

## POST /refresh

Body не нужен. Браузер отправляет refresh cookie:

```ts
await fetch('/api/v1/auth/refresh', {
  method: 'POST',
  credentials: 'include',
});
```

Успех — `200`, новый access token и новая refresh cookie. Предыдущий refresh token немедленно
отзывается. Отсутствующий cookie даёт `REFRESH_TOKEN_REQUIRED`; недействительная, отозванная или
протухшая сессия — `INVALID_REFRESH_TOKEN`. Reuse token, у которого есть rotation replacement,
считается компрометацией и отзывает все активные sessions пользователя. Intentional logout token
без replacement просто отклоняется, чтобы оставшийся HttpOnly cookie не уничтожил unrelated login
family при следующем bootstrap.

## POST /logout

Body не нужен. Browser-вызов передаёт captured access bearer: backend атомарно отзывает текущую
cookie только когда её сессия принадлежит подписанному subject и является `sid` access token либо
его потомком по цепочке refresh rotation. Другая login family того же пользователя и другой аккаунт
не затрагиваются. Refresh и logout используют единый lock order `user → refresh session`. Если
remote refresh успел создать один или несколько replacement до ожидающего logout, logout отзывает
предъявленную cookie и всех её replacement descendants в доказанной signed `sid` chain. Если logout
получил user lock первым, ожидающий refresh не создаёт replacement. Возраст proof отдельно не
ограничивается: sliding refresh может пережить исходный cookie lifetime, а принадлежность к его
rotation family проверяется в PostgreSQL. Подпись, HS256, `typ`, `iss`, `aud`, `type`, UUID
`sub`/`sid`/`jti`, safe `iat`/`exp`, точный access TTL и запрет future-issued proof остаются
обязательными. Обычная API/Socket.IO-проверка истёкшие access tokens по-прежнему отклоняет.

Logout всегда отвечает `204` без `Set-Cookie`. Legacy-вызов без `Authorization` является
server-side no-op: иначе поздний запрос старой вкладки мог бы отозвать refresh cookie нового
аккаунта. Современный frontend всегда отправляет family-bound bearer и локально завершает logout
даже при недоступном backend.

Logout идемпотентен: отсутствие cookie не раскрывает информацию и тоже возвращает `204`. Уже
выпущенный access JWT не хранится на сервере и истекает сам по короткому TTL; refresh этой сессии
после logout невозможен.

## POST /password-reset/request

Передаётся ровно один идентификатор:

```json
{
  "email": "user@example.com"
}
```

или телефон/универсальное поле `identifier`.

Ответ всегда `202`:

```json
{
  "message": "If the account exists, password-reset instructions have been sent."
}
```

Этот ответ одинаков для существующего, неизвестного и синтаксически неподходящего
идентификатора. После превышения IP rate limit возвращается `429 RATE_LIMITED`.

## POST /password-reset/confirm

```json
{
  "token": "one-time-token",
  "newPassword": "NewStrongPass456"
}
```

Успех — `200`:

```json
{
  "message": "Password has been reset."
}
```

После успеха:

- token нельзя применить второй раз;
- все другие reset tokens этого пользователя инвалидируются;
- все refresh-сессии пользователя отзываются;
- старый пароль больше не подходит.

Неверный, использованный или протухший token даёт одну ошибку
`INVALID_OR_EXPIRED_RESET_TOKEN`.

## POST /verify-email

Маршрут существует только при `AUTH_EMAIL_VERIFICATION_REQUIRED=true`.

```json
{
  "token": "one-time-token"
}
```

Успех — `200`, email отмечается подтверждённым, выдаётся access token и refresh cookie.
Повторное использование или истечение TTL даёт `INVALID_OR_EXPIRED_VERIFICATION_TOKEN`.

## Cookie policy

По умолчанию:

- `HttpOnly=true`;
- `SameSite=Lax`;
- `Path=/api/v1/auth`;
- `Secure=false` только для локального HTTP.

В production требуется `AUTH_REFRESH_COOKIE_SECURE=true`. Для `SameSite=None` secure-cookie
обязателен, иначе backend не запустится.
