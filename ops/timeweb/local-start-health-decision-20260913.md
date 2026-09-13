# Decision: frozen Health query and exact preserved local-start continuation

Status: OWNER_DECISION_REQUIRED. This is a new, narrower decision than the approved
replacement inspection. No activation change or retry is published by this proposal.

## Verified state — 2026-09-13

Application run [34777104737](https://github.com/San4o9910/Kinetra/actions/runs/34777104737),
job103777116383, control5da9479b63dd7884d6e5484fe33b8dd1f9fff3dc:
original source/image/database gates and authentication of the successful preserved
API phase PASS. Local startup FAILED at19:16:20 UTC with CHILD_COMMAND_FAILED.
Guest/account SSH keys were deleted; local key and owned guest directory removed.
Attempt artifact10323746979:
`8163808721d83b8a57f434961438ab3343a6efb85a5a88e3953db5d8d4845e55`.
This failed run is not a successful local handoff.

Read-only checkpoint run34777288124/job103777611640, control81d345c790d6aafb08f50112d3424cdcab13a05c,
then identity run34777544360/job103778299757, control23ed1f4cfdcb0d4e3ca4e880d90e23a2c7753758,
proved the actual state:
- PostgreSQL running; backend exists in created state; frontend absent.
- Backend ID `460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a`.
- Attempt nonce `9128e22668c33a1552f912415c800939`.
- Backend exact qualified image, project and activation label match.
- Docker StartedAt is `0001-01-01T00:00:00Z`; backend has never started.
- Durable application-start-result.json SHA256:
  `ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a`.
- Phase START_BACKEND, attempted_services=[backend], start_attempted_services=[],
  uncertain_start_services=[], owned_containers={},
  rollback.backend=UNCONFIRMED_REQUIRES_REVIEW.
  The latter is retained as the original failed observation, not rewritten as success.
- API environment and recovery-complete records remain present; PostgreSQL data-root
  device2049/inode524370 mode0700; nested PGDATA unchanged.
- All diagnostic temporary SSH key cleanup PASS. No services started or stopped.

The exact original docker inspect template fails with returncode1 and
`map has no entry for key "Health"` on that never-started backend.
Thus the first created-container inspect failed, and rollback's same inspect failed.
This explains both the startup failure and its original unknown-ownership result.

## Prepared query correction and verification

Dormant patch: [start-health-query-fix-20260913.patch](start-health-query-fix-20260913.patch).
One expression in start-application-host.py changes from
`{{if .State.Health}}` to `{{if (index .State "Health")}}`.
A missing optional field then produces JSON null; a present field retains its actual status.

Frozen original SHA256:
`654ae707445717a96b04c1a7b1f9e428e22ff06ccb04f40c68a2bf6b2ae11524`.
Proposed SHA256:
`e7954b99525f9a66f174d4c4729f0c6287b11f3c8cb2432106e4283d87d6e9e4`.
Patch SHA256:
`c83c167618b97c01a543e70c9af218969264106432d32437e0695fc977ab471d`.

Read-only real-engine verification
[34777637820](https://github.com/San4o9910/Kinetra/actions/runs/34777637820),
job103778553003, control7c2316e14cf7a4c6ad0a74f404c03bbde3610f22,
completed SUCCESS at19:26:12 UTC. Corrected query returns null Health for the
exact created backend and healthy for the running PostgreSQL. Frozen helper
remained unchanged; no production mutation. Complete key cleanup PASS.

Eight offline regression checks pass:
exact original/proposed identities, exact patch application, AST equality except
that one string expression, preservation of null/starting/healthy/unhealthy values,
invalid-ID refusal, unhealthy-backend refusal, missing-health deadline refusal,
and running-healthy-backend acceptance. These do not claim a full deployment PASS.
Tests: test-start-health-query-proposal.py.
Actual sanitized evidence: local-start-health-evidence-20260913.json.

## Why another decision is required

The continuing instruction explicitly preserves frozen guest checks.
This is now an executable change inside that frozen guest helper, unlike the
previous missing-dependency transport corrections. Also, the original startup
guard intentionally refuses an existing application-start-attempt/result, which now
exist. Silently clearing them, treating the failed checkpoint as accepted, or
rerunning the original startup would violate preserved-state requirements.

The owner-approved replacement inspection is complete. It does not itself grant
an exception to these frozen startup and prior-attempt conditions.

## Exact proposed scope

Permit the following bounded correction and continuation under CONTINUOUS FIX & DEPLOYMENT:

1. Apply only the prepared optional-Health query correction and propagate its real
   dependency hashes. Preserve every original health, image, port, mount, network,
   privilege, Caddy, source/SBOM/CPE and final acceptance assertion.
2. Add a separate explicit continuation for this exact never-started backend and
   exact failed checkpoint/nonce, with offline failure-boundary tests before publication.
   Authenticate the actual failed run, attempt artifact and successful read-only
   reconciliation evidence; retain the original successful API and database handoffs.
3. Under the existing host lock, recheck exact file hashes, container ID, image,
   nonce, created/nonrunning state, zero StartedAt, PostgreSQL identity/health/isolation
   and absence of any other application or HTTPS attempt. Extend the pre-start
   inventory check only to this one known never-started backend. Any discrepancy stops.
4. Preserve the original application-start-attempt and failed checkpoint byte-for-byte,
   including a durable hash-bound archive of the failed checkpoint before installing
   any later checkpoint at the canonical handoff path. Write a new exclusive
   continuation-attempt record before any Docker start. Never suppress or erase
   historical failure; a partial continuation cannot be retried automatically.
5. Start the existing proven backend once; do not recreate it or regenerate API
   credentials. Create/start frontend using the original reviewed ownership pattern.
   Execute all original runtime, readiness, local HTTP/static/CSP, anonymous-boundary,
   database-isolation and Caddy-inactive checks. No database initialization or migration.
6. Only a new fully successful outer run, complete temporary cleanup and exact matching
   successful checkpoint may authorize HTTPS. Then execute the existing HTTPS and
   anonymous browser checks sequentially. Failed runs remain failed evidence.

No container/data deletion is proposed. No new packages/resources, visibility or
billing changes, PR21 merge, payments, mail, registration/login submissions or
unrelated production writes. Same server9069403/IP80.68.156.131 and SSH pin
`SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0`.
Same exact app/images, source SBOM, CVE exceptions and expiry, original raw reports.
The already prepared SMTP inputs are retained; no new secret is requested.

The query patch is ready and verified. The separate state-specific continuation
is proposed here and must be implemented, reviewed against these bounds and tested
before execution after approval. Nothing in this proposal authorizes broad retries,
an unverified final handoff, deletion or weakening the actual acceptance checks.

## Owner decision

Разрешаю точечное исправление чтения Health и отдельное продолжение для указанного
уже созданного, ни разу не запущенного backend. Сохранить исходные записи сбоя,
все проверки безопасности и последовательные успешные handoff/cleanup; не удалять
контейнеры или данные и не повторять инициализацию. После проверок продолжить
запуск и HTTPS в этих границах.
