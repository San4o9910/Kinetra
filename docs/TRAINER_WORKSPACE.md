# Personal trainer workspace

Approved trainers land on `/trainer/students`. Their own library is at
`/trainer/lessons`; access does not require the separate global-course editor flag.
Trainer verification and reviewer grants retain their existing rules.

## Working flow

1. Trainer adds a named student, optionally records a contact and copies a one-use
   invitation. No email is sent automatically. The invitation expires in seven days;
   reissuing it revokes the previous link. Its fragment is kept through sign-in.
2. Student explicitly accepts the invitation from their own authenticated account.
   Only then may the trainer see this student's future completion marks.
3. Trainer creates a draft, adds dated or undated workouts, instructions, duration
   and optional lessons from their own library, then publishes it to that student.
4. The student's home, schedule and progress use their trainer's published plan.
   The platform introductory course remains available only as the unassigned
   user's clearly labelled fallback; it is never copied into a trainer's plan.
5. Student watches a lesson, saves playback position and explicitly marks completion
   with difficulty, wellbeing and an optional note. Trainer sees these per student.
6. New published programs archive previous programs while retaining their history.
   Completed workouts cannot be changed or removed. Revisions prevent lost edits.

Each student has one active trainer. Existing explicit chat assignments are
imported by migration 016. Accepting another trainer's invitation cannot expose or
transfer an existing conversation with a different trainer: that case requires a
reviewed transfer. Archiving a student closes personal program/media access and
keeps history visible to the original trainer. It does not delete chat history.

## Private lessons on the existing server

`TRAINING_MEDIA_DIR` enables filesystem lesson storage. In production, merge
`deploy/compose.training-media.yml` after both production/single-server files and
set `KINETRA_TRAINING_MEDIA_DIR` to a pre-created, private, persistent directory
owned by UID/GID 1000. Do not store media in the container layer or web root.

MP4, H.264/yuv420p, optional AAC, at most one video/audio stream, 256 MiB per file,
2 hours, up to 4K. The server verifies metadata and decodes a bounded sample using
its qualified ffprobe/ffmpeg runtime. It does not claim a complete decode of every
frame. One upload is processed at a time; requests have a ten-minute deadline.
Actual stream byte count must match the reserved size. Files are atomically moved
into place after validation. No browser blob or local-storage entry is treated as
an uploaded lesson.

Space reservations cap each trainer at 1 GiB and all lessons at 5 GiB; uploads also
leave at least 512 MiB free. These are initial capacity limits, not paid plans.
Interrupted sessions expire after thirty minutes and orphaned private files are
removed during upload/library maintenance. Lesson removal refuses referenced
lessons. Database and private media directory must be backed up together; the
PostgreSQL-only backup is not a backup of uploaded videos.

Playback uses short-lived, lesson/user-bound HMAC links with five-minute expiry,
re-checks active trainer and assignment on every request, supports HTTP byte ranges,
and sends private/no-store responses. No path provided by a user reaches the
filesystem. The player refreshes links and keeps its position. Revoking a trainer
or archiving the student also denies playback, including an unexpired signed URL.
The global S3 upload system and its privileges remain separate.

## Release evidence

- Unit checks: schema boundaries, video seeking ranges, token expiry/tampering.
- PostgreSQL 17 test: invitation lifecycle, per-trainer isolation, actual H.264 file
  upload and verification, private draft/publish flow, completion idempotency,
  revision conflicts, history preservation and revocation.
- Browser test: trainer/student accounts, add/invite, upload UI, author/publish,
  accept, complete, receive feedback, 390/1280 px overflow checks. Browser upload
  fixture verifies transmitted bytes; actual media decoding is tested separately.
- Migration is additive (016); previously applied migration checksums must remain
  unchanged. Runtime table grants must be applied after migration.
