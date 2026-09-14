# Решение: устойчивое сравнение подключений PostgreSQL и продолжение сохранённых контейнеров

## Результат уже согласованной работы

Разрешение владельца на точную asset-проверку и одно продолжение записано в
1be0c7f18c7a9ee2d3835ce22cf7deefbd98e969. Код принят в
e60dadf762128e08f423ad9326092b7dfa8dbcff. Это разрешение выполнено; повторно
согласовывать публичные образы, asset-проверку или добавление SMTP secrets не нужно.

[Фактический запуск 34816449431](https://github.com/San4o9910/Kinetra/actions/runs/34816449431)
(job103888017101, attempt1, control369891effdfce1077c2d4740782fef6b354159e1)
завершился FAILURE 14 сентября 2026 в 07:09 UTC. Все offline tests, source/image/database,
сохранённый успешный API handoff, аутентификация предыдущих сбоев и свежей проверки
прошли. Оба существующих контейнера запущены, backend healthy/readiness и frontend
runtime/nginx проверки прошли. Согласованные HTML, CSP, JS/CSS, theme-init и API
проверки также прошли. Локальные ответы и их хеши сохранены в настоящем результате.
Ответ /api/v1/me=401 ожидаем для анонимного запроса; /ready=404 ожидаем для закрытого
публичного readiness маршрута. Это не проверки пользовательского входа или регистрации.

Позднее исходное сравнение PostgreSQL завершилось DATABASE_ISOLATION_CHANGED.
Более поздние listener/Caddy/final hash gates не достигнуты. Успешного local handoff
нет, HTTPS не запускался. Нельзя принимать этот failed run за квалификацию запуска.

Исходный rollback подтвердил STOPPED для обоих собственных контейнеров; PostgreSQL
остался running. Полная очистка временных объектов подтверждена: key772851,
remote /run/kinetra-local-activation-ae6581dd8e92bd1bcc73e82a186f31b9.
Workflow SHA256 b25f542342bf463b3bd3f5c3846c0e7272f11329ee67ca7c1b90220b93d27ff7.
Артефакт kinetra-local-attempt-34816449431-1, ID10337085613, 3400bytes,
SHA256 489933664f4af6042303af710f2e9c7083431e884c13ac86832347739bdbf578.

Предварительная попытка 34816357110 не дошла до хоста: тест root-only helper
отклонил runner-owned checkout. Исправлено только владение изолированной тестовой
копией через TemporaryDirectory под /root; все проверки оставлены. Исправленный
run34816449431 действительно прошёл этот тестовый этап. Это не дополнительный
повтор startup и не изменение runtime permissions хоста.

## Диагноз на реальном хосте

[Сверка 34816598509](https://github.com/San4o9910/Kinetra/actions/runs/34816598509)
(job103888449025, control5b77cdb2f36b591885e81719772554681fc7cf9f) SUCCESS,
полная очистка key772855. Подтверждены новые failure records, STOPPED обоих
контейнеров и сохранность предыдущих записей.

[Диагностика 34816826708](https://github.com/San4o9910/Kinetra/actions/runs/34816826708)
(job103889141914, control09744cb81f5bf2dc409eedc0c1fdb3aa8a3465f4) SUCCESS,
полная очистка key772861. Выполнены 12 чтений разрешённых docker inspect полей
одного точного PostgreSQL контейнера без startup, docker exec, изменения базы
или чтения значений secrets. Сохранены 9 различных вариантов порядка Mounts.
Из всех 14 сравниваемых полей менялось только расположение элементов массива
mounts. Каждый элемент, его путь, тип, права и все остальные поля совпадали.
После сортировки полных mount-объектов все 12 наблюдений эквивалентны.

Точное свидетельство: [database-order-inspection-20260914.json](database-order-inspection-20260914.json).
Ограничение доказательства: исходные before/after снимки упавшей попытки не были
записаны. Отдельная диагностика воспроизвела причину ложного срабатывания; она не
восстанавливает отсутствующую историческую пару и не доказывает, что других
кратковременных изменений в момент сбоя не было. Поэтому перед следующим стартом
все исходные проверки изоляции обязательны заново.

## Подготовленный точный патч

[database-order-policy-fix-20260914.patch](database-order-policy-fix-20260914.patch),
SHA256 475d56f37d9dcf46b4826cf93a6da5f86d9f5054695183a8ced1d00d831a516c.
Патч подготовлен и проверен в изолированной копии, к рабочим helpers не применён.
Точные before/after SHA256: [database-order-policy-proposal-20260914.json](database-order-policy-proposal-20260914.json).

1. Перед сравнением только снимков PostgreSQL упорядочить mounts по полной
   канонической JSON записи каждого элемента. Сохранить все элементы, поля,
   значения и все прочие поля исходного снимка. Не сравнивать только volume или
   выбранные пути, не удалять дубликаты и не подменять снимок кратким хешем.
2. Отвергать повреждённую структуру mounts, пустой список, некорректные и
   повторяющиеся Destination. Реальное изменение Source, Destination, RW, Type,
   Driver, Name, Mode, Propagation, нового поля или состава mounts остаётся ошибкой.
3. В start-application-host.py и текущем stopped helper применить нормализацию
   только к PostgreSQL before/after снимкам. Оригинальное сравнение всех 14 полей,
   require assertions, raw inspect, ownership, rollback и записи не менять.
4. В activate-https-host.py возвращать тот же полный снимок PostgreSQL с
   упорядоченными mounts. Исходное полное равенство before/after и все проверки
   сети/volume/состояния/приложения остаются. Та же причина устранена до HTTPS,
   а не разрешена как новое исключение при ошибке.
5. При реализации обновить настоящие dependency pins и использовать этот же
   проверенный normalizer в отдельном continuation для нового точного состояния.
   Этот патч сам по себе не разрешает повтор использованного assets helper.

[16 offline tests](test-database-order-policy-proposal.py) PASS: точное применение
и hash bindings; неизменность всего прочего AST, pins и require assertions;
воспроизведение ошибки на реальных вариантах Mounts; отрицательные проверки
каждого mount-поля, добавления/удаления/дубликатов, всех остальных isolation fields;
сохранение полного HTTPS сравнения и отсутствие изменения входного снимка.
Тесты не обращаются к Docker, сети, secrets или production.

## Новое точное состояние для продолжения

Host9069403 /80.68.156.131, прежний SSH pin
SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0.
PostgreSQL ID a6d4870c61fae621ba44e772a11d5ef2a551e32944e6cc0487bd484c124ebad1.
Nonce9128e22668c33a1552f912415c800939.

| Контейнер | ID | Последний StartedAt |
|---|---|---|
| Backend, exited/nonrunning | 460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a | 2026-09-14T07:09:16.50418728Z |
| Frontend, exited/nonrunning | c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206 | 2026-09-14T07:09:23.759748703Z |

Новые записи, которые требуется сохранить побайтово вместе со всеми прежними:

- application-assets-attempt-9128e22668c33a1552f912415c800939.json:
  ee37bc351f5792155d6a47ed8f011926694b27055cc1e8febe06ba40f2564486.
- application-assets-result-9128e22668c33a1552f912415c800939.json:
  4fdc8a2de3957c8f0a0d369127d195484205dfb33b8fef1398a01cc3bd54ce2d.
- Прежний original result и failed archive:
  ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a.
- Прежний continuation-attempt:
  655db5eacc192aea6146040c9c814ec77d5b58876eb8d6a34e12e99c4bbcb572.
- Прежний continuation-result:
  72ee16fdc09a163e0d311401c56f43c1e766b4e6e57442ddd7f68e98ada9be5b.

Новый result имеет CHECKPOINT_ONLY / LOCAL_ACCEPTANCE / DATABASE_ISOLATION_CHANGED,
start_attempted_services=[backend,frontend], uncertain_start_services=[],
точные owned_containers и rollback обоих STOPPED. Наблюдавшийся unhealthy у
остановленного backend не является допуском: после старта обязательны healthy
и исходные readiness checks.

## Границы предлагаемого решения

Применить только описанное исправление сравнения. Реализовать один отдельный
state-specific continuation для двух указанных сохранённых контейнеров, с новыми
эксклюзивными application-database-order-attempt/result records до любого start.
Сохранить все original/failed/continuation/assets records и их архивы побайтово.
Не удалять либо переименовывать попытки ради обхода одноразовых guards.

Перед исполнением заново аутентифицировать реальные успешные source/image/database
и API handoffs, точный failed run34816449431/workflow/artifact/cleanup и свежую
успешную read-only сверку. Под прежним host lock проверить IDs/images/nonce/StartedAt,
exited/nonrunning, configured sandbox, credentials hashes, все prior hashes и
отсутствие нового startup/HTTPS attempt. Исходные database private network/volume,
readonly migration ledger, permissions и Caddy inactive gates обязательны.

Запустить существующий backend один раз, дождаться healthy/readiness; затем
существующий frontend один раз. Никаких create/recreate, initialize/migrate,
смены секретов или удаления данных. При ошибке прежний stop/rollback только
своих контейнеров, отдельная durable failure запись и read-only диагностика;
повтор использованного continuation не разрешён. Только полный реальный PASS
позволяет установить success checkpoint, сохранив все старые failure archives.
Только успешный outer run и полная cleanup разрешают последовательный HTTPS
этап и внешнюю анонимную браузерную проверку без production writes.

Причина нового узкого решения: пункты 3–4 согласованного
[local-asset-continuation-decision-20260913.md](local-asset-continuation-decision-20260913.md)
разрешали одну попытку и прямо запрещали второй запуск этого continuation.
Она уже выполнена и завершилась новым частичным сбоем. Кроме того, предлагается
исправление другого замороженного сравнения, которого не было в asset-патче.
Общие полномочия CONTINUOUS FIX & DEPLOYMENT не отменяют этот явный одноразовый
guard. Данное предложение не требует повторного одобрения уже выполненной работы.

Все остальные ограничения остаются: exact app73b665065e00a5b375e90f701373b3e0856a0386,
baseea0412a20baa87b7a00c4ce466d204d12fb052cc, merge2f5d388dea92ed4994131d0b5e77734189de026c;
source CI34535162371/34535166746 и успешная image qualification34742116241,
все exact qualified image refs и существующие PUBLIC package IDs15042113/15042114;
source SBOM ebb69ea87b5ec9aa929c590bf6ceab0bc6239c38bfb3040e198e6a7bfa925dd7;
только CVE-2014-9826/CVE-2017-5506 до2026-09-26, прежние raw reports и прочие gates.
Без PR21 merge, удаления данных/контейнеров/пакетов, новых ресурсов/пакетов,
смены видимости/оплаты, production forms, писем и платежей. Хостинг ≤2000₽/месяц,
free beta15. Реальные backup/restore/операционные проверки ещё нужны для готовности
к пользователям. Автоматическое продолжение остаётся отключённым до решения.

## Формулировка согласия

Разрешаю точечное исправление сравнения подключений PostgreSQL и одно отдельное
продолжение для указанных двух остановленных контейнеров с сохранением всех
записей, данных и остальных проверок. После полного local PASS и cleanup
продолжить HTTPS и внешнюю анонимную проверку в прежних границах.
