# T11 — платежи ЮKassa и доступ по подписке

T11 добавляет оплату Kinetra Premium за `799 ₽ / месяц`, сохранение способа оплаты для
последующих списаний, webhook-обработку, ежедневное продление и серверный paywall. Redirect на
страницу успеха сам по себе никогда не считается подтверждением оплаты: доступ открывает только
проверенное состояние подписки на backend.

## Пользовательский сценарий

1. Пользователь с неактивной подпиской видит заблокированную программу и автоматически открытый
   premium paywall; платный program API и player до активации не монтируются.
2. `/payment` показывает цену, состав подписки и предупреждение об автопродлении.
3. Frontend отправляет точный `return_url` на backend, получает URL подтверждения ЮKassa и
   выполняет полноэкранный redirect.
4. После возврата `/payment/success` запрашивает подписку сразу, затем не чаще одного запроса
   каждые 2 секунды, максимум 30 секунд.
5. Кнопка «Начать тренировки» доступна только после ответа `status: active`.
6. Отмена автопродления сохраняет оплаченный период и дату окончания, но устанавливает
   `auto_renew: false`.

Отдельный `/payment/cancel` позволяет повторить оплату или вернуться в приложение. Ни success URL,
ни cancel URL не меняют подписку без подтверждения провайдера.

## HTTP API

Все ответы endpoints подписки отдаются с `Cache-Control: no-store`. `create` и
`cancel-subscription` требуют access JWT; webhook публичный на транспортном уровне, но
fail-closed проверяет источник до обработки тела.

### `POST /api/v1/payments/create`

Запрос:

```json
{
  "return_url": "https://app.example.com/payment/success"
}
```

URL обязан точно входить в server-side allowlist `YUKASSA_RETURN_URL`. Backend создаёт
одностадийный платёж ЮKassa с `amount.value = "799.00"`, `currency = "RUB"`, `capture = true`,
`save_payment_method = true`, `confirmation.type = "redirect"`, идентификатором пользователя в
`metadata` и уникальным `Idempotence-Key`.

Успешный ответ (`201`):

```json
{
  "payment_id": "2f...",
  "confirmation_url": "https://yoomoney.ru/checkout/...",
  "status": "pending"
}
```

Frontend не принимает цену, валюту, user ID или provider metadata от клиента. Повторный клик
блокируется на время запроса.

### `POST /api/v1/payments/webhook`

Поддерживаемые notification events:

- `payment.succeeded` — активирует или продлевает подписку; сохранённый
  `payment_method.id` записывается только если `payment_method.saved === true`;
- `payment.canceled` — помечает незавершённую первую оплату отменённой, но не отнимает уже
  оплаченный активный период при неудачном продлении;
- `refund.succeeded` — обрабатывает подтверждённый возврат. Частичный возврат нельзя автоматически
  приравнивать к полному отзыву подписки без отдельного бизнес-правила.

У notification нет документированного уникального `event_id`. Детерминированный ключ события
строится из `event` и ID объекта: для refund это ID возврата, а связанный платёж находится в
`object.payment_id`. Повторная доставка должна завершаться тем же `200` без повторного изменения
периода подписки.

ЮKassa ожидает точный HTTP `200`; другие статусы приводят к повторным попыткам доставки в течение
24 часов. Невалидный или неподдерживаемый payload отклоняется до мутации; такие retries должны
попадать в мониторинг, чтобы изменение provider contract не осталось незамеченным.

### `POST /api/v1/payments/cancel-subscription`

Идемпотентно выключает будущие списания. Текущие `status: active`, `starts_at` и `expires_at`
сохраняются; ответ возвращает canonical `SubscriptionResponse` с `auto_renew: false`.

### Entitlement

Программные endpoints проверяют подписку на сервере. Для `none`, `pending`, `expired`,
`cancelled` и `refunded` возвращается:

```json
{
  "error": {
    "code": "SUBSCRIPTION_REQUIRED",
    "message": "An active subscription is required."
  }
}
```

HTTP status — `403`. Базовые уроки остаются доступны по правилам onboarding. UI-диалог — только
пояснение для пользователя и не является защитой данных.

## Автопродление и cron

Ежедневный worker запускается отдельной командой:

```bash
npm run payments:renew -w @kinetra/backend
```

Production scheduler должен вызывать её один раз в сутки. Worker выбирает только подписки с
`auto_renew = true`, сохранённым способом оплаты и приближающимся окончанием, а затем создаёт новый
платёж через `/v3/payments` с `payment_method_id`, `capture: true` и без redirect confirmation.
Claim/уникальный ключ попытки и `Idempotence-Key` защищают от двойного списания при параллельном
или повторном cron. HTTP 500 от ЮKassa означает неопределённый результат: повторяется тот же body
с тем же ключом либо состояние читается через API; новый ключ использовать нельзя.

Проверка актуальных `auto_renew`, срока и сохранённого способа оплаты сериализована с
отменой автопродления в PostgreSQL. Транзакция удерживает row lock во время ограниченного
по timeout вызова провайдера: либо cancel успевает первым и списание не стартует, либо он
дожидается уже начатого запроса. При подборе production pool нужно учитывать до
`YUKASSA_REQUEST_TIMEOUT_MS` удержания connection на активное списание.

Неудачное продление не сокращает уже оплаченный срок. Worker не должен печатать credentials,
полный объект способа оплаты или чувствительный provider response в логи.

## Webhook authenticity

В текущей публичной документации ЮKassa notification body содержит `type`, `event` и `object`, но
не документирован HMAC-заголовок. Поэтому нельзя придумывать или считать подписью произвольный
header.

До разбора события production ingress должен принимать только официальные сети:

```text
185.71.76.0/27
185.71.77.0/27
77.75.153.0/25
77.75.156.11
77.75.156.35
77.75.154.128/25
2a02:5180::/32
```

Если приложение стоит за reverse proxy, `TRUST_PROXY_HOPS` задаётся точным числом доверенных
переходов; доверять присланному клиентом `X-Forwarded-For` без такой границы нельзя. После
IP-проверки backend повторно читает payment/refund по ID через API ЮKassa и сравнивает terminal
status, ID, amount, currency и metadata с локальной записью; для refund дополнительно проверяется
исходный payment. IP-проверка и повторное чтение статуса решают разные задачи; redirect
пользователя не заменяет ни одну из них.

## Переменные окружения

```dotenv
YUKASSA_SHOP_ID=<shop id>
YUKASSA_SECRET_KEY=<server-only secret>
YUKASSA_RETURN_URL=https://app.example.com/payment/success
YUKASSA_REQUEST_TIMEOUT_MS=10000
```

Несколько разрешённых return URLs перечисляются через запятую. Production значения используют
HTTPS. Секрет никогда не попадает в `VITE_*`, browser bundle, git или клиентские ответы.

## Production checklist и ограничения

- Подключить HTTPS, настроить webhook URL в кабинете ЮKassa и проверить реальный source IP после
  всех proxy/CDN.
- Получить у ЮKassa разрешение на рекуррентные платежи и хранить доказуемое согласие пользователя
  на сохранение способа оплаты, сумму, периодичность и порядок отмены.
- Настроить ежедневный scheduler и alert на зависшие `pending`, повторные cron claims и ошибки
  provider API.
- Подключить production-доставку email/push к injectable `RenewalFailureNotifier`. В T11 дефолтная
  реализация создаёт только безопасное operator-событие без credentials/provider payload; это не
  заменяет уведомление пользователя.
- Подключить кассовые чеки в соответствии с моделью бизнеса, настройками ЮKassa и требованиями
  54-ФЗ. T11 не формирует receipt items и не является юридической/налоговой консультацией.
- Определить политику частичных возвратов до production. Автоматический полный отзыв доступа при
  любом refund небезопасен для частичного возврата.
- Ограничить размер webhook body, не логировать credentials и сохранять provider payload только в
  минимально необходимом объёме.

## Официальные источники ЮKassa

- [Создание платежа и статусы](https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process)
- [Формат запросов и Idempotence-Key](https://yookassa.ru/developers/using-api/interaction-format)
- [Обработка неопределённых ответов](https://yookassa.ru/developers/using-api/response-handling/recommendations)
- [Входящие уведомления, события и IP-адреса](https://yookassa.ru/developers/using-api/webhooks)
- [Сохранение способа оплаты](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/save-payment-method/save-during-payment)
- [Платёж сохранённым способом](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved)
- [Возвраты](https://yookassa.ru/developers/payment-acceptance/after-the-payment/refunds)
- [Чеки по 54-ФЗ](https://yookassa.ru/developers/payment-acceptance/receipts/54fz/basics)

Документация провайдера может меняться. Перед production rollout allowlist, event list и правила
рекуррентных платежей сверяются повторно с официальными страницами.
