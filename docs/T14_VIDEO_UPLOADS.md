# T14 — загрузка workout-видео в private S3

T14 добавляет независимый от чата trainer-раздел `/trainer/videos`. Доступ получает только активный
`trainer_profiles` с `can_manage_videos=true`; capability каждый раз читается из PostgreSQL и также
возвращается в собственном `GET /api/v1/me`. Public registration никогда не назначает это право.

## Поток данных

1. Backend резервирует существующий workout slot и неизменяемый key вида
   `videos/workouts/week-01/day-1/<upload-uuid>.mp4`.
2. Browser считает SHA-256 отдельно для каждой части и отправляет её прямо в private S3 по короткому
   presigned URL. JWT, cookies и S3 credentials в S3 request не передаются.
3. Complete использует только server-side `ListParts`, durable manifest и `HeadObject`. Единственный
   claimant продлевает token-bound lease, повторно fence-ит его непосредственно перед S3 complete и
   отменяет S3 request по deadline/потере lease; takeover не разрешает stale claimant второй side effect.
4. One-shot worker потоково считает полный SHA-256, проверяет MP4 и запускает фиксированный `ffprobe`
   без shell. Разрешены один H.264 video stream и необязательный AAC audio stream.
5. Publish одной PostgreSQL-транзакцией обновляет тот же `videos.id` и увеличивает
   `media_revision`. Старое видео остаётся доступным до commit.
6. Старый или неудачный object удаляет отдельный retryable cleanup worker после grace period.
   Текущий `videos.storage_key`, включая hidden media, перед delete проверяется повторно.

## Инварианты повторного исправления

- Несовпадение upload metadata, ETag, VersionId, SSE/KMS, временная недоступность S3/DB/stream или
  ошибка процесса `ffprobe` не доказывают невалидность файла. Такие случаи получают bounded retry,
  затем quarantine без удаления object. Cleanup создаётся только для доказанной media-validation
  ошибки, явной отмены, expiration или supersede.
- Для SSE-S3 принимается только `AES256`; для SSE-KMS — только `aws:kms` с exact настроенным
  `SSEKMSKeyId`. Completion и verifier применяют одну и ту же проверку.
- Cleanup имеет общий deadline и передаёт один `AbortSignal` в multipart abort, version listing,
  HEAD, DELETE и post-delete reconciliation. Timeout оставляет durable retry и failed/degraded
  heartbeat; пустой последующий запуск не скрывает unresolved backlog.
- Unversioned preview перед подписью повторно сверяет current ETag с ETag опубликованной загрузки.
  Versioned preview всегда подписывает записанный `VersionId`.
- Expiration не забирает upload с живым completion lease, учитывает последний part URL и bounded
  период неоднозначного S3 complete. Поздно материализованный object записывается в expired upload,
  а завершённая cleanup job переоткрывается идемпотентно.
- PostgreSQL mutation paths блокируют trainer authority в порядке `users → trainer_profiles`; это
  совпадает с T12 account deletion. Rate-event retention ограничена 1000 строками за проход и
  очищает также dormant trainers.
- Verifier принимает только ISO MP4 major brands из явного allowlist, ровно один H.264 video stream
  и не более одного AAC audio stream. 3GP, QuickTime/MOV, subtitle, data и unknown streams
  отклоняются. Точная raw duration проверяется до округления.
- После reload trainer UI возобновляет polling состояний `completing`, `verification_pending` и
  `verifying` с 15-минутным deadline, AbortController и generation fencing. Polling и preview
  capability прекращаются при offline, logout и unmount.

## API

Все endpoints требуют access JWT, `can_manage_videos=true` и возвращают `Cache-Control: no-store`.

| Метод  | Путь                                                     | Назначение                              |
| ------ | -------------------------------------------------------- | --------------------------------------- |
| GET    | `/api/v1/trainer/videos/program`                         | Полный inventory 12 × 7                 |
| POST   | `/api/v1/trainer/videos/uploads`                         | Резервирование multipart operation      |
| POST   | `/api/v1/trainer/videos/uploads/:id/parts`               | Короткие подписи частей                 |
| GET    | `/api/v1/trainer/videos/uploads/:id/parts`               | Принятые S3 parts                       |
| POST   | `/api/v1/trainer/videos/uploads/:id/complete`            | Reconciliation и постановка на проверку |
| GET    | `/api/v1/trainer/videos/uploads/:id`                     | Durable status polling                  |
| DELETE | `/api/v1/trainer/videos/uploads/:id`                     | Идемпотентная отмена                    |
| GET    | `/api/v1/trainer/videos/workouts/:id/preview-url`        | Короткий trainer preview URL            |
| POST   | `/api/v1/trainer/videos/weeks/:week/days/:day/unpublish` | Soft unpublish                          |

DTO никогда не содержит bucket, object key, multipart upload ID или credentials. Presigned URL
считается временной bearer-capability и не сохраняется в Local Storage, IndexedDB, Cache API или logs.

## Operator commands

После production build:

```bash
npm run video:trainer:grant -w @kinetra/backend -- --user-id <UUID>
npm run video:trainer:revoke -w @kinetra/backend -- --user-id <UUID>
npm run video:uploads:process -w @kinetra/backend
npm run video:uploads:retry-quarantined -w @kinetra/backend -- --upload-id <UUID>
npm run video:media-cleanup -w @kinetra/backend
```

Grant/revoke работают только с существующим trainer profile. Revoke в одной DB transaction запрещает
новые операции, terminal-отменяет live uploads и создаёт cleanup jobs. Worker-команды изменяют DB/S3;
их нельзя запускать против неизвестного environment.

После исчерпания bounded retry verifier переводит только проблемную загрузку в
`verification_quarantined`: object сохраняется, новые загрузки других тренеров не блокируются.
Тренер может явно отменить quarantine и поставить object в cleanup, а оператор — повторно поставить
его на проверку указанной командой. Operator retry сериализован с резервированием workout slot и
отклоняется, если в этом slot уже появилась новая live upload.

## Bucket, CORS и IAM

- Block Public Access включён; ACL отключены; public website/read policy отсутствует.
- Разрешено только `videos/workouts/*` и необходимые multipart/get/head/delete actions.
- Unknown-version cleanup дополнительно требует prefix-scoped `ListBucketVersions`; worker фильтрует
  только exact immutable key и подтверждает удаление version/delete-marker перед ACK job.
- SSE-S3 `AES256` либо SSE-KMS с exact key. Для KMS нужны только `GenerateDataKey` и `Decrypt`.
- Lifecycle abort incomplete multipart uploads — не позже 24 часов; current media lifecycle не удаляет.
- CORS содержит только exact production frontend origins, методы PUT/GET/HEAD и checksum headers,
  без `*`.
- Production endpoint и frontend origin используют HTTPS.

## Rollout

`TRAINER_VIDEO_UPLOADS_ENABLED=false` — безопасный default. Сначала применяется migration 012,
настраиваются bucket/IAM/CORS/ffprobe и оба scheduled workers, проверяются свежие heartbeats, затем
permission выдаётся выбранному trainer. Включение production flag требует отдельного решения.

Verifier ограничен `VIDEO_VERIFY_DEADLINE_SECONDS`, продлевает token-bound lease во время работы и
повторяет инфраструктурные S3/файловые/DB сбои до `VIDEO_VERIFY_MAX_ATTEMPTS`. Ошибочный медиаконтент
остаётся отдельным terminal failure. Числовой exit code, signal или timeout `ffprobe` сами по себе не
доказывают ошибку media и не разрешают удаление object; неполный/повреждённый JSON protocol от
`ffprobe` также retryable. Перед успешным heartbeat verifier выполняет реальные ffprobe, temp-stream
и private-S3 list/head/get recovery probes, поэтому пустой запуск не скрывает продолжающийся runtime
outage. Cleanup heartbeat восстанавливается только
после успешного retry failed job (либо отдельного recovery probe), а пустой запуск не скрывает
unresolved failure. Cleanup worker запускается независимо от наличия `ffprobe`.

Rollback — выключить flag. Опубликованные video продолжают работать через существующий T07;
cleanup workers должны продолжать выполняться. Migration и таблицы назад не удаляются.
