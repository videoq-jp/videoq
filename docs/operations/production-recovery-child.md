# Production recovery child

`apps/api/scripts/d1-production-recovery.ts` is the fixed, AWS-only child of a
future held recovery operation. Packaging this file does **not** enable a
recovery stage, change IAM, stop writers, switch the production database, or
establish that production rollback is ready.

The child accepts only three private file paths: a bounded snapshot envelope,
the original PostgreSQL LOGIN plan, and a new receipt. Its environment must bind
the envelope's run, reviewed source and action to a production rotation build.
It compares the whole input's SHA-256 and the bundled schema mapping before
touching external storage. These environment checks are defense in depth;
authority comes from the parent, not from a caller setting environment variables.

The parent must independently prove the global owner, stopped deployment/API/
consumer admission, the actual D1 write fence and target, the original PostgreSQL
fence, and the versioned private snapshot's provenance. No parent stage is wired
by this change. The `d1Fence` envelope field is parent-owned evidence, not a
child-generated or child-verified authorization.

For versioned visual artifacts, the child verifies source content and creates
only absent legacy compatibility keys in the existing production media bucket.
It never overwrites existing objects: an existing conflicting destination fails
recovery. The application must remain offline for the whole operation. This
does not provide a second independent object backup or a universal recovery
strategy for conflicting legacy keys.

After visual verification, the child emits one `recovery_prepared` JSON line
containing only digests. The parent must persist and read back that exact
snapshot digest in the same owned recovery intent **before** sending
`{"authorize":true,"snapshotSha256":"<prepared digest>"}` followed by a newline
on stdin. Missing, oversized, malformed, different or stalled grants fail before
PostgreSQL mutation. The grant deadline is 30 seconds. The parent must not grant
on a digest mismatch or an ambiguous persistence result.

Only then does the existing production primitive open the fixed direct-Neon TLS
connection, verify the original LOGIN fence, and restore within its owned
transaction. A private completion receipt is written and synced after success.
Any error or missing completion receipt means writers remain stopped while the
parent reconciles the operation; process exit alone is not a recovery receipt.
The output explicitly retains `productionSafe:false`. Backend configuration,
consumer handoff, readiness checks and maintenance-lock release are separate
required operations.

The child receives only basic process variables, fixed build ownership, the
AWS-local administration connection and scoped R2 credentials. The future
parent must strip AWS role credentials, Cloudflare management tokens, GitHub
credentials, application/LLM secrets, `NODE_OPTIONS` and unrelated `PG_*`
variables. This child must never be invoked from a local operator machine with
production DB administration credentials.

Tests exercise grant ordering and denial, private-file handling, snapshot
ownership, create-if-absent storage requests and object size bounds with mocked
remote services. The existing isolated PostgreSQL/operator-ZIP fixture verifies
that the child imports with the locked operations dependencies alone; it does
not execute the production-only child against production.
