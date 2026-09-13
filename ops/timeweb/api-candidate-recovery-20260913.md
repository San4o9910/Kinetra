# Preserved API candidate recovery — 2026-09-13

Actual read-only run 34775387238, job 103772445526, control
cddac769001a1f1dda45cb500bc51962b5bf2041 reproduced the original first
validator failure: data directory must be UID999 mode0700.
All diagnostic containers and temporary SSH objects were cleaned up;
candidate and active environment hashes were unchanged.

Metadata run 34775554137, job 103772903044, control
e9afda678f047b9c127f10a6b70149e4adb42195 confirmed at 18:45:05 UTC:
- /srv/kinetra-stage/postgres/data: device2049 inode524370 UID999 GID999 mode1777.
- Existing named volume kinetra-production_postgres17_data resolves to that exact inode.
- Nested pgdata: device2049 inode547799 UID999 GID0 mode0700.
- PostgreSQL17 and completed bootstrap marker are present.
- Pin SHA256:T3RfyVAstE+dyvneeMMYUjIm1Ej+NN3D5Vr9sIyRUG0; temporary guest/account keys API_DELETE_CONFIRMED, local REMOVED.

The correction restores only the existing outer directory to the already required
mode0700 via an identity-checked directory descriptor. No recursive chmod/chown,
database content changes, restart, initialization, key regeneration or provider
request is involved. A metadata restoration is necessary; weakening the validator
to accept1777 would change the agreed security gate and is not proposed.

A new explicit recovery entry point accepts only the inspected candidate
api-preparation-08115658b05bc897f6bdb8f7a7874938 and exact old/candidate hashes.
It repeats the original source/database/metadata checks, positively verifies the
preserved attempt, records recovery intent, repairs the directory mode, and uses
the original frozen validate_candidate, check_live_identity,
install_preserving_previous and collect_handoff_hashes functions. All frozen
helper files remain byte-identical. Existing candidate secrets and previous
environment are preserved. Any prior recovery/start record refuses repetition.

The recovery caller uses the original successful source/image/database
authentication, then the separate step-local SMTP/Timeweb inputs. The original
provenance recheck and frozen local startup follow only a real accepted recovered
API handoff with complete cleanup. The existing application workflow path is used.
Exact application, public package scope, CPE exceptions, raw evidence, source
SBOM, database handoff and hosting restrictions are unchanged.

Validation:10 new recovery tests passed (successful adoption and complete hashes,
secret/data preservation, changed source/candidate/provider refusal, directory
identity/symlink refusal, recorded recovery refusal, validator failure preservation,
live precheck refusal and explicit CLI). The17 existing transport tests passed
against the recovery wrapper;15 application-caller and19 local-wrapper tests passed.
No live mutation is implied by this preparation note; actual run outcome must be
recorded before HTTPS. Standing CONTINUOUS FIX & DEPLOYMENT covers this
state-specific correction; the approved replacement already supplied its evidence.
