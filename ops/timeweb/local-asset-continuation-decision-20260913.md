# Решение: точная проверка файлов страницы и продолжение после подтверждённого отката

## Что уже сделано

Предыдущее разрешение владельца на исправление optional Health и продолжение для
никогда не запускавшегося backend выполнено. Разрешение записано в
c124b95ba62ff4a72491622dc92601dab4f89b6d; реализация — 9fb986087d6a5e018512fddab4ff701b8b6516a0.

[Запуск 34779526000](https://github.com/San4o9910/Kinetra/actions/runs/34779526000)
(job103783858959, attempt1, control1940f0b72edfdc8dbc286789086cec00163a2d3b)
прошёл offline tests, реальные source/image/database gates и аутентификацию
сохранённого API/предыдущего сбоя/свежей проверки. Backend успешно стартовал.
Его runtime/readiness checks прошли, после чего frontend был создан и запущен.
Проверка nginx и локальный HTTP ответ страницы прошли; затем в LOCAL_ACCEPTANCE
возник UNREVIEWED_ASSET_ORIGIN. Более поздние asset/API/final проверки не завершены.
Общий run — FAILURE, успешного local handoff нет. HTTPS не запускался.

Автоматический откат исходного проверенного кода подтвердил STOPPED для обоих
контейнеров. PostgreSQL остался running. Все временные ключи и гостевой каталог
очищены: key772577, remote /run/kinetra-local-activation-501744680610025ad48e220a0ecb0f13.
Старые записи сбоя сохранены без изменения. Контейнеры и данные не удалялись.

Точный workflow SHA256:
a5d8308c30ba7cffd40849ec0738c6f84ee31ffaac3616eaf268fa0bfd8de5b4.
Артефакт kinetra-local-attempt-34779526000-1, ID10324610731, 3400bytes,
SHA256 3a482c172c4f54ec82667e4c541f51c94db8e0b21e9cabd4a597099492b590bc.
Он содержит свидетельство неудачной попытки, а не разрешение на HTTPS.

## Подтверждённая причина

[Проверка готового контейнера 34780143497](https://github.com/San4o9910/Kinetra/actions/runs/34780143497)
(job103785543396, control5f836991c0d0c73c593b81b63b7740503c624c25) SUCCESS,
2026-09-13 20:15:12 UTC. Только чтение трёх публичных файлов из остановленного
frontend через docker cp в память, без извлечения архива на диск, docker exec,
запуска контейнеров или изменений приложения. Полная очистка key772593 подтверждена.
Точные результаты: [local-asset-inspection-20260913.json](local-asset-inspection-20260913.json).

Страница квалифицированного образа содержит:

- Google Fonts stylesheet https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap
- локальный script /theme-init.js
- /assets/index-BWzIO3Fz.js
- /assets/index-BUHqTTi2.css

Замороженный парсер допускал только JS/CSS пути /assets/. Он отвергает и первую
ссылку, и скрипт темы. Это воспроизведено offline на реальных извлечённых ссылках.
Исходный nginx CSP уже ограничивает style-src и font-src своим origin; загрузка
этих внешних CSS/шрифтов запрещена. Предложение ниже не расширяет CSP.
Preconnect ссылки, имеющиеся в исходнике, остаются прежними; отсутствие любых
внешних соединений браузера не заявляется.

Точные файлы в уже квалифицированном образе:

| Файл | SHA256 |
|---|---|
| index.html | 6195327372c93442ceffdfc872b34f39296bf8e5cbc602a397b78df489f60f19 |
| theme-init.js | d9988fba5a56d7bd81528b74156f5ce65a8d07f649b9eef77104e81ae768788b |
| nginx.conf | c42be326f3455609704914785d7452808512cc2afb049607006f164532e74d26 |

Последние два файла побайтово совпадают с exact application
73b665065e00a5b375e90f701373b3e0856a0386. HTML хеш получен на хосте;
offline HTML fixture — явно обозначенная реконструкция ссылок, а не исходный HTML.

Первый read-only диагностический run34779895771 завершился ошибкой в
экранировании regex вывода. Исправлены только эти regex; их синтаксис и обработка
реального CSP проверены локально. Он также выполнил полную очистку key772587.
Это не повтор запуска приложения. Успешный результат выше получен отдельным
исправленным read-only run.

## Готовое точечное исправление

[local-asset-policy-fix-20260913.patch](local-asset-policy-fix-20260913.patch)
SHA256 e8612a9bb5d1648a85ef71eb04f47dbc6df18f1540b2a5d887ed99300ec62081.
**Патч подготовлен, но к рабочим helpers не применён.**

1. Требовать точный SHA256 квалифицированного HTML и полный точный прежний CSP.
   Изменение HTML, расширение разрешений CSS/шрифтов, дубликат директивы или
   добавленный style-src-elem останавливает проверку.
2. Проверять /theme-init.js через тот же локальный origin, статус/тип ответа и
   точный SHA256, совпадающий с квалифицированным образом и исходником.
3. Распознавать только одну точную прежнюю Google Fonts stylesheet как
   заблокированную CSP ссылку. Не загружать её, не принимать её за успешный asset
   и не разрешать внешние шрифты. Другие внешние URL, неверный тип ссылки,
   traversal/query варианты и неизвестные локальные файлы по-прежнему отклоняются.
4. Сохранить все прежние HTTP/API/readiness/headers/asset-count проверки;
   дополнительно требовать отдельно минимум один bundled JS и CSS, помимо темы.
   HTTPS повторяет те же привязки и полное совпадение local/public handoff.
5. При реализации обновить настоящие dependency pins и использовать эту же
   проверку в новом отдельном continuation helper; не применять патч к образам
   или приложению и не переиспользовать failed run как успешный.

| Helper | Прежний SHA256 | Предлагаемый SHA256 до обновления dependency pins |
|---|---|---|
| start-application-host.py | e7954b99525f9a66f174d4c4729f0c6287b11f3c8cb2432106e4283d87d6e9e4 | 8de4fdccd73c8c1d5666fa46806d47125f0aec49e73c6f4a1bf00db36584427d |
| activate-https-host.py | 3245b2d3cb1f5bf30265dce6f62d2cfa1545bd4dd1fbf1b51288c6d8fb726d2e | fa57da54c304254889a92c7960fa31a4a133d531012549e88f6146095ac60de5 |

16 offline tests PASS:
[test-local-asset-policy-proposal.py](test-local-asset-policy-proposal.py).
Проверены точное применение патча, неизменность прочих AST, сохранение всех
прежних acceptance assertions, воспроизведение исходного сбоя, реальные hash
bindings, внешние/неизвестные URL, CSP overrides, изменённый HTML/скрипт,
bundled JS/CSS, API cookies/no-store, HTML fallback и HTTPS/local correspondence.
Тесты не обращаются к сети, Docker или production.

## Состояние, к которому привязано предлагаемое продолжение

Nonce 9128e22668c33a1552f912415c800939.
Backend 460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a,
exited/nonrunning, последний StartedAt2026-09-13T20:04:12.951170708Z.
Frontend c47ad815087ec8f3b310ac59f565babfb03af5b43102f56ac24678ac1c36d206,
exited/nonrunning, последний StartedAt2026-09-13T20:04:20.381560242Z.
Наблюдавшийся health=unhealthy у уже остановленного backend не выдаётся за
допуск к запуску: после продолжения заново обязательны healthy/readiness checks.

- Original application-start-result и failed archive:
  ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a.
- Continuation-attempt:
  655db5eacc192aea6146040c9c814ec77d5b58876eb8d6a34e12e99c4bbcb572.
- Continuation-result:
  72ee16fdc09a163e0d311401c56f43c1e766b4e6e57442ddd7f68e98ada9be5b.
- Result phase LOCAL_ACCEPTANCE, error UNREVIEWED_ASSET_ORIGIN,
  start_attempted=[backend,frontend], uncertain_start_services=[],
  owned_containers равны указанным ID, rollback обоих STOPPED.
- PostgreSQL running. Fresh current database health/identity/isolation, config,
  mounts/ports/networks/privileges, credentials hashes и отсутствие HTTPS/новых
  попыток должны быть проверены под тем же host lock перед новым стартом.

## Точные границы нового решения

Предложение разрешает применить только описанную asset-проверку и реализовать
один отдельный state-specific continuation для этих двух остановленных
контейнеров. Оригинальный never-started helper теперь неприменим и не повторяется.

Перед исполнением:

1. Заново аутентифицировать реальные source/image/database и успешный API handoff,
   точные failed run/workflow/artifact и успешную read-only сверку. Использовать
   существующий разрешённый inspection workflow при необходимости чтения
   артефактов, без обхода отказов доступа.
2. Под прежним lock подтвердить точные ID/images/project/service/nonce, состояние
   exited/nonrunning и StartedAt, исходные attempt/result/archive hashes,
   config/credential hashes и все остальные исходные pre-start assertions.
   Любое расхождение останавливает работу.
3. Побайтово сохранить все оригинальные и failed continuation records. Создать
   новый эксклюзивный durable attempt до любого start, со ссылками на все прежние
   записи. Не стирать существующие попытки, не перезаписывать failed records и
   не объявлять их accepted. Второй запуск этого continuation автоматически запрещён.
4. Запустить существующий backend один раз, дождаться исходных healthy/readiness
   проверок; затем запустить существующий frontend один раз. Не создавать новые
   app контейнеры, не регенерировать секреты, не выполнять initialize/migrate.
   При ошибке использовать прежний ownership-bound stop/rollback без удаления.
5. Выполнить все runtime/local/asset/API/DB/Caddy-inactive проверки. Записать
   отдельный результат; только полный PASS позволяет установить новый canonical
   success checkpoint при сохранённых побайтовых архивах всех старых failure records.
6. Только фактический успешный outer run с полным handoff и cleanup разрешает
   HTTPS. После HTTPS проверить внешнюю анонимную страницу браузером. Никаких
   регистраций, входов, восстановления, платежей или писем.
7. До исполнения реализовать и проверить отдельный continuation, guards,
   dependency pins, failure/rollback boundaries; сохранить обычными GitHub commits.

Почему нужно отдельное решение: пункт1 предыдущего согласованного
[local-start-health-decision-20260913.md](local-start-health-decision-20260913.md)
сохранял все замороженные final acceptance assertions. Его пункт4 запрещал
автоматическое повторение частично выполненного continuation. Новый патч меняет
конкретную asset-проверку, а оба контейнера теперь уже запускались. Предыдущее
разрешение на Health и never-started backend не покрывает это новое состояние.

Все прочие ограничения сохраняются: server9069403/IP80.68.156.131 и SSH pin
SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0; exact application/base/merge,
успешная qualification34742116241, прежние exact image refs, PUBLIC package IDs,
source SBOM ebb69ea87b5ec9aa929c590bf6ceab0bc6239c38bfb3040e198e6a7bfa925dd7,
только CVE-2014-9826/CVE-2017-5506 до2026-09-26 и исходные raw reports.
Без mergePR21, удаления данных/контейнеров/пакетов, новых ресурсов/пакетов,
изменений видимости/оплаты, реальных сообщений или платежей.
Хостинг ≤2000₽/месяц, free beta15; готовность к пользователям требует отдельных
реальных backup/restore/операционных проверок.

## Формулировка согласия

Разрешаю описанный точечный патч проверки файлов страницы и одно отдельное
продолжение для указанных двух остановленных контейнеров. Сохранить все записи
сбоев, данные, секреты и остальные проверки. После полного успешного local
handoff и cleanup продолжить HTTPS и анонимную проверку сайта в прежних границах.
