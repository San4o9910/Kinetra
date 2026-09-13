# Approved preserved-backend continuation — 2026-09-13

Owner approval c124b95ba62ff4a72491622dc92601dab4f89b6d applies to the proposal
at3fe71151ff3d590c0cb03c367693a87ef0f2d4a6. No renewed decision is needed for its scope.

Fresh read-only run34778863835/job103782050733 at99511c096a6842dc8902794211157718d7e5d59f
completed SUCCESS with exact previously observed never-started backend, original failed
checkpoint, running PostgreSQL, repaired data-directory identity and full key cleanup.
The immutable raw sanitized response is in created-backend-inspection-20260913.json.

The approved Health expression is installed in start-application-host.py;
its SHA256 is e7954b99525f9a66f174d4c4729f0c6287b11f3c8cb2432106e4283d87d6e9e4.
Fresh-start refusal remains intact. The separate resume-created-application-host.py
requires exact backend ID460a447fc441071f595dea383b60487aa707e719511792aefa52a3a0b831962a,
nonce9128e22668c33a1552f912415c800939 and failed checkpoint
ad5f14d8c643045b59275b4d0433cd9e96f63c1e4fba22dd1af7f3da7812548a.
All source/config/API/database handoff checks are retained. Only the pre-start
container inventory admits the exact additional created backend; database/network/
listener and health checks otherwise match the frozen implementation.

The continuation acquires the same lock, verifies zero StartedAt and zero restarts,
writes an exclusive continuation-attempt, fsyncs byte-identical archives of both original
records, and starts this backend once. Frontend uses the original create-before-start
ownership sequence. No backend recreation, container removal, credential generation,
initialization, migration or provider step occurs. A repeated continuation is refused.
The original startup attempt remains unchanged at its canonical path. Only on complete
local acceptance is the canonical checkpoint atomically replaced with the new checkpoint,
while the failed archive and separate continuation result are retained. Failure and
uncertainty remain subject to real-state reconciliation; no blind retry.

resume-local-application-host.py preserves original transport, SSH pin, result validation
and cleanup with its exact new guest/CLI. resume-application-caller.py requires a current-
run authentication receipt before host access and uses original envelope validators.
authenticate-created-backend.py authenticates original successful API/database evidence,
the exact failed start run/workflow/artifact, its complete cleanup and the new successful
read-only inspection. It never treats the failed run as an accepted local handoff.

17 new continuation tests PASS: original acceptance AST/tail equality, fixed identities,
checkpoint/attempt mutations, previous continuation/HTTPS refusal, symlink refusal,
durable archives, failed-versus-successful checkpoint behavior, never-started checks,
extra-container rejection, create/start order, real inspection fixture mutations and
complete transferred helper/explicit CLI checks.8 Health regression tests,19 local
wrapper tests,15 application caller tests,8 preserved-API tests and17 HTTPS caller tests
also PASS. Frozen source/image/CPE policies and all original acceptance tests remain.
HTTPS changes here are dependency hashes only; its activation template stays dormant
until actual complete local success, exact evidence and cleanup.
