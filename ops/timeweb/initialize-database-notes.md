# Initial database runner — offline implementation review

Target: existing Timeweb server 9069403, 80.68.156.131. The runner initializes only the approved new PostgreSQL database under /srv/kinetra-stage. It keeps API, frontend, workers and Caddy stopped. It does not create users, invoke providers, pull images, request certificates, buy resources or delete database data.

The implementation and mocked tests are prepared; no host initialization or live acceptance has been performed by this task. Root must activate a workflow only after the exact approved application revision has all mandatory green gates and qualified image digests.

## Activation inputs and local verification

Invoke ops/timeweb/initialize-database-host.py with --initialize-new-empty-database from a new GitHub Actions run, attempt 1, in the fixed project repository. Required public inputs are APP_CHECKOUT, APPROVED_APP_COMMIT, NODE_IMAGE, NGINX_IMAGE, BACKEND_IMAGE, FRONTEND_IMAGE and POSTGRES_IMAGE. The existing Timeweb secret is consumed only by the bounded API client and removed from child environments. Registry authentication is neither required nor sent to the host.

Root's activation workflow must independently verify the successful exact-head, merge-ref and image-qualification evidence, bind those runs to the supplied commit/digests, and exclude concurrent host maintenance. The Python script validates commit/source/image identity; it does not replace CI provenance checks.

Run offline tests with the application checkout explicitly supplied:

    APP_CHECKOUT=/absolute/approved/app-checkout python3 ops/timeweb/test-initialize-database-host.py
    python3 ops/timeweb/test-prepare-database-host.py

The first command uses the actual checkout's deploy/postgres/runtime-grants.sql in a Node parser fixture. That fixture mocks the database client and opens no connection.

## Preconditions and operation order

1. Verify the fixed server through the API and pin SSH fingerprint SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0 before key creation. Use one verified ephemeral key with bounded cleanup. Never delete an unverified returned key ID.
2. Read committed deployment sources and the exact 13 migration hashes directly from the approved Git commit. Require successful STAGED_ONLY evidence matching that commit, all image references and all staged source hashes.
3. Require canonical private stage paths, unchanged public metadata, an API environment containing only NODE_ENV=production, an empty UID999/mode0700 data directory, no containers or volumes, and only the previously observed empty backend network beyond Docker defaults. Refuse any earlier initialization-attempt or completion record.
4. Reinspect local approved image revisions. Run the existing strict validate-single-server.mjs in migrate mode through the reviewed staging helper, with narrow read-only mounts. Never mount the CA signing key. Images must already be local.
5. Render Compose quietly with a clean environment. Write and fsync an exclusive initialization-attempt record before the first Compose start. Start only postgres, with --no-deps --no-build --pull never. Wait once for health within a bounded deadline; do not automatically retry bootstrap.
6. Authenticate as kinetra_migrate over verify-full TLS. Require PostgreSQL major 17, database kinetra, the migration identity and zero public tables.
7. Run the existing migrate service command. Require exactly APPLY 001_auth.sql through APPLY 013_trainer_verification.sql. Independently compare the exact database ledger and image migration-file hashes to the approved commit, including rejection of extra ledger entries.
8. Override only the existing migrate service command with node scripts/seed.mjs --initial-empty-database. Require its PASS marker and unchanged catalogue counts: 12 weeks, 84 days, 7 base lessons, 84 workouts and 5 achievements. The seed guard performs its own transactional empty-content/users checks. No demo or subscription seed runs.
9. Apply the reviewed runtime-grants.sql as kinetra_migrate. The parser requires its sole exact psql directive, removes only that line, rejects other psql directives, and executes the retained BEGIN/COMMIT transaction. The real-source offline fixture validates this parsing.
10. Authenticate sequentially as API and each of the five worker roles in disposable backend containers attached only to the internal database network. Execute read-only SQL; no application entrypoint runs. Require TLS/major17/expected identity on every connection. API acceptance additionally verifies users=0, the catalogue counts, database ownership, seven constrained LOGIN roles and their connection limits, all four users DML privileges, no ledger privileges and no public-schema CREATE.
11. Recheck the exact migration ledger. Require only the PostgreSQL container, exact PostgreSQL image, restart policy no, one correctly labeled bind-backed volume targeting the staged data directory, only the internal database network attached to PostgreSQL, no published database port and no 5432/8080 host listener. The retained backend network must remain empty.
12. Persist the final result with commit/images/migration hashes. Success is DATABASE_INITIALIZED_ONLY; application_started remains false. Overall success also requires confirmed ephemeral-key cleanup.

The current acceptance verifies the applied grant source plus key effective API restrictions and all role authentication/flags. It does not claim an exhaustive per-column audit of every worker permission. No CI integration suite should be pointed at this production database.

## Failure and recovery contract

All subprocesses and database operations have bounded timeouts. Logs contain fixed error categories and public evidence, never credentials, raw provider responses or secret-bearing environment dumps. Disposable containers are removed only after verifying their invocation-owned ID/name/nonce/image; their own anonymous volumes are removed with them.

The PostgreSQL container, bind-backed data and initialization-attempt marker are preserved after any failure. The runner refuses a new initial invocation against that partial state. Root must inspect the failed phase and prepare a concrete correction or a separate resume operation against the same known ledger. It must never clear data, remove the attempt marker, regenerate credentials, call down -v or silently rerun initialization to make the original command pass.

Missing YooKassa and auth-delivery provider inputs continue to block API launch. This database-only result must not be reported as a deployed or production-ready application.
