# Personal training experience

Trainers build and publish their own programs. Kinetra does not generate workouts or prescribe changes to a student's load.

## Trainer workflow

- Add a named student and copy their invitation link. Expiring or expired invitations appear in the attention feed. The existing invitation renewal control issues a new link.
- Create a program or copy one of your templates. Template assignment creates an independent draft; review it before publishing. Copy one workout or a selected seven-day range inside the editor.
- Add exercises with sets, repetitions or duration, optional weight, rest and an optional private lesson. A full workout lesson may coexist with individual exercise videos.
- Valid changes autosave after a short pause. Local drafts are account scoped. Concurrent changes cause an explicit revision conflict; started and completed workouts keep their original instructions and results.
- Upload MP4, MOV (including HEVC) or WebM from the device, up to 256 MiB and two hours. Uploads use 4 MiB chunks. After a network interruption, select the same original file to continue. Pending uploads expire after 24 hours. Preparation continues on the server after the upload completes.
- Videos are converted to H.264/AAC and receive a cover. Search and folders help organize the private library. Each trainer has 1 GiB of lesson capacity; total capacity is bounded at 5 GiB. Pending work reserves capacity before processing.
- Review each student's actual sets, completion history, feedback and explicitly shared measurements. Approve or reject requested dates in the attention feed.

## Student workflow

- Today shows the next action; Schedule provides a monthly calendar and rescheduling requests; Progress collects workout and exercise history.
- Workout mode records actual repetitions, time and weight per set, starts a rest timer and prepares a question referencing the exercise for the trainer chat.
- Marks made in an open workout during a connection failure remain on that device. Keep the workout open or reopen it to send the pending marks. This does not promise that uncached pages or videos can be opened offline. Logging out clears local drafts.
- Measurements and raster photos are optional and private by default. Sharing is explicit, scoped to the current trainer relation and revocable. Signed photo/video links are short lived and recheck permission on every request. Closing access cannot retract a copy someone already saved.
- Daily workout reminders require both an enabled preference and browser notification permission. The selected local time is used only on scheduled days with unfinished workouts. On iPhone, open the installed home-screen app to enable supported push notifications.
- Report a problem with the trainer from Progress. The owner reviewer can investigate, reply and resolve it; revisions and append-only events preserve the decision history.

## Operations and verification

Migration 017 adds structured exercises, set revisions, templates, reschedules, measurements, complaints and resumable media fields. Migrations 001–016 are unchanged. Run the existing migration workflow and `deploy/postgres/runtime-grants.sql`; preserve the existing private `/training-media` bind mount. Personal reminders require valid existing VAPID configuration and `TRAINING_REMINDERS_ENABLED=true`.

The media worker serializes processing using a database advisory lock and resumes queued jobs after restart. Source files, normalized photos and prepared lessons stay outside the public document root. Cleanup only removes abandoned files after a grace period.

CI requires both `KINETRA_TRAINING_EXPERIENCE_POSTGRES=PASS` and `KINETRA_TRAINING_EXPERIENCE_BROWSER=PASS`, alongside the complete existing regression suites. Tests use isolated fixture accounts, real HEVC decoding, private media, consent revocation, revision conflicts, independent template copies, reminder deduplication, browser autosave and connection recovery. Production acceptance is anonymous and does not create real user accounts or send test notifications.
