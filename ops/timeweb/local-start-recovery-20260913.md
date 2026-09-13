# Local startup continuation after verified import failure — 2026-09-13

Run34776089449 at f0d2e6daa8395426bcfa7a6e461464f6b3316dfc completed the
API recovery at18:56:20 UTC with API_ENVIRONMENT_PREPARED_ONLY, installed=true,
error=null, guest/account keys deleted and both owned temporary directories removed.
The later source/image/database recheck passed. The separate local startup wrapper
failed at18:57:13 UTC with complete key and guest-directory cleanup. The whole
run is FAILED, never a successful local handoff.

Retained attempt artifact10324010735, SHA256
42316ff964771c0aa766a2c2b9ddbdf5490d8268ba4c8355d61e4b0564275eb0
contains the successful API outer record. Exact workflow SHA256:
75a5263d8a47fc171cfd308014401d38c02f686174eb0763740520d90dd6052c.

Independent read-only run34776287669/job103774897052 at
82109af279cc9ebdbdabb3bc255b0620f678331b succeeded at19:00:12 UTC.
Only postgres is running; application-start-attempt/result do not exist.
API/recovery-complete records exist. Outer volume root is now mode0700 on
the same proven inode; PGDATA is unchanged. All owned SSH keys were cleaned.

The transferred local-wrapper helper set was missing inspect-host-monitoring.py.
Importing precisely that isolated set reproduced FileNotFoundError for the missing
module without executing a host command. Add its already frozen exact hash to local
and HTTPS outer transport sets. The HTTPS guest also retained an obsolete local
wrapper dependency hash; update that literal to the reviewed wrapper. AST comparison
confirms all HTTPS executable checks are identical, and frozen startup helper remains
654ae707445717a96b04c1a7b1f9e428e22ff06ccb04f40c68a2bf6b2ae11524.

The continuation authenticates only the successful API phase from the exact failed
overall run: real successful phase jobs, exact workflow/artifact bytes, original
outer success and cleanup, full source/config/handoff hashes, and the independent
successful no-start inspection. It does not call API preparation/recovery again.
The original current source/image/database gates and original frozen startup remain
required, including refusal if a concurrent or previous startup exists.

Validation:8 new cases include actual evidence acceptance, wrong run/attempt/job,
failed API stage, changed DB identity, incomplete cleanup, prior startup refusal,
and successful isolated local/HTTPS imports (plus missing-helper negative control).
19 local-wrapper,15 application-caller,17 HTTPS-caller tests pass. The old helper-count
test now requires the seventh dependency explicitly. No image/source/SBOM/CPE changes,
database reset/restart, provider secrets, mail, payments, visibility change or new
resources are part of this continuation.
