\set ON_ERROR_STOP on
\getenv migrate_password KINETRA_MIGRATE_PASSWORD
\getenv api_password KINETRA_API_PASSWORD
\getenv notifications_password KINETRA_NOTIFICATIONS_PASSWORD
\getenv renewals_password KINETRA_RENEWALS_PASSWORD
\getenv chat_cleanup_password KINETRA_CHAT_CLEANUP_PASSWORD
\getenv video_cleanup_password KINETRA_VIDEO_CLEANUP_PASSWORD
\getenv video_verify_password KINETRA_VIDEO_VERIFY_PASSWORD
BEGIN;
CREATE ROLE kinetra_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'migrate_password';
CREATE ROLE kinetra_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD :'api_password';
CREATE ROLE kinetra_notifications LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'notifications_password';
CREATE ROLE kinetra_renewals LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'renewals_password';
CREATE ROLE kinetra_chat_cleanup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'chat_cleanup_password';
CREATE ROLE kinetra_video_cleanup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'video_cleanup_password';
CREATE ROLE kinetra_video_verify LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'video_verify_password';
ALTER DATABASE kinetra OWNER TO kinetra_migrate;
REVOKE ALL ON DATABASE kinetra FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE kinetra TO kinetra_migrate, kinetra_api, kinetra_notifications, kinetra_renewals, kinetra_chat_cleanup, kinetra_video_cleanup, kinetra_video_verify;
GRANT USAGE ON SCHEMA public TO kinetra_api, kinetra_notifications, kinetra_renewals, kinetra_chat_cleanup, kinetra_video_cleanup, kinetra_video_verify;
GRANT USAGE, CREATE ON SCHEMA public TO kinetra_migrate;
-- No default table/sequence DML grants: reviewed grants follow migrations.
COMMIT;
