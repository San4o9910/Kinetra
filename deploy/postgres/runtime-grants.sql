-- Run explicitly as kinetra_migrate only after the full migration ledger has
-- been checked. Not an initdb script: the application tables do not exist yet.
-- This transaction is repeatable; invoking it is still a reviewed DB mutation.
\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kinetra_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kinetra_api;
REVOKE ALL ON TABLE schema_migrations FROM kinetra_api;

GRANT SELECT ON users, subscriptions, workout_completions, videos, program_weeks,
  program_days, weekly_metrics, push_subscriptions, push_notification_deliveries
  TO kinetra_notifications;
GRANT INSERT ON push_notification_deliveries TO kinetra_notifications;
GRANT UPDATE ON push_subscriptions, push_notification_deliveries TO kinetra_notifications;

GRANT SELECT, UPDATE ON subscriptions, subscription_payment_attempts TO kinetra_renewals;
GRANT INSERT ON subscription_payment_attempts TO kinetra_renewals;

GRANT SELECT, DELETE ON chat_photos TO kinetra_chat_cleanup;
-- SELECT FOR UPDATE SKIP LOCKED requires UPDATE privilege on one column.
GRANT UPDATE (id) ON chat_photos TO kinetra_chat_cleanup;
-- The photo DELETE trigger inserts into this queue under the caller's identity.
GRANT SELECT, INSERT, UPDATE ON chat_media_deletion_jobs TO kinetra_chat_cleanup;

GRANT SELECT ON videos, video_media_deletion_jobs, video_upload_rate_events,
  video_worker_heartbeats TO kinetra_video_cleanup;
GRANT UPDATE ON video_media_deletion_jobs, video_worker_heartbeats TO kinetra_video_cleanup;
GRANT INSERT ON video_worker_heartbeats TO kinetra_video_cleanup;
GRANT UPDATE (id) ON video_upload_rate_events TO kinetra_video_cleanup;
GRANT DELETE ON video_upload_rate_events TO kinetra_video_cleanup;

GRANT SELECT ON trainer_video_uploads, trainer_video_upload_parts, videos,
  trainer_profiles, video_media_deletion_jobs, video_worker_heartbeats TO kinetra_video_verify;
GRANT INSERT ON video_media_deletion_jobs, video_worker_heartbeats TO kinetra_video_verify;
GRANT UPDATE ON trainer_video_uploads, videos, video_media_deletion_jobs,
  video_worker_heartbeats TO kinetra_video_verify;
COMMIT;
