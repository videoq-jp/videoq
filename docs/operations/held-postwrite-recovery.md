# Held AWS post-write restoration

This adds the fixed `cutover-postwrite-recovery` rotation-project stage, disabled
by default. It is not a broker action, general SQL runner, backend switch or
maintenance-lock release. A trusted operator on reviewed main must first own the
existing cutover interval, preserve its original PostgreSQL LOGIN plan, stop
writers and persist an immutable private recovery-input reference. Ordinary
GitHub request permissions cannot directly start arbitrary CodeBuild stages.

Enable `enable_cutover_postwrite_recovery` only with the existing owned consumer
control and preserved private archive infrastructure. Only the rotation project
then gains reads of the fixed D1 inspection credential, the existing application
parameter containing scoped R2 credentials, and explicit object versions below
`cutover-recovery/` in the private archive. No upload/latest-object lookup,
additional DB authority, Worker configuration write or signing-key read is added.
Administration credentials stay inside AWS.

The run must retain `database_mutations_started=true`, `release_requested=false`,
`consumers-paused`, the installed PostgreSQL fence and all three closed admission
markers. The global owner must match the same execution. A recovery request uses
`recovery_action_id`, `recovery_state=requested`, `recovery_input_ref` and its
SHA-256. The strict reference binds version 1, run/source/action, the exact
`cutover-recovery/<run>/<action>.json` key and S3 version, bytes and SHA-256,
current manifest hash, original PostgreSQL plan hash, D1 identity and the
immutable operator source version reported by CodeBuild. The trusted
operator must create this intent conditionally; it must not replace an existing
request or clear its prepared digest.

The input is the child's private snapshot envelope. Its D1 fence state uses the
production target and the original exact trigger/schema plan. The trusted capture
must obtain all Vectorize values and ownership metadata for the frozen scene
revisions; this stage does not independently fetch Vectorize numeric contents.
Those values remain bound to the versioned trusted input and are validated
against scene ownership/revisions by the child. This is a required capture
responsibility, not a guarantee supplied by an arbitrary input checksum.

Before starting the DB child, the AWS parent:

- checks global/run ownership, closed admission records and original plan hashes;
- verifies disabled GitHub deployment workflows and drained workflow runs through
  the public repository's read-only API;
- checks actual paused API metadata and HTTP responses and disabled SQS mappings;
- downloads only the pinned private S3 version and verifies AES256, size and the
  returned and locally computed SHA-256;
- verifies actual D1 management identity, migration ledger, complete write-fence
  table/schema/trigger coverage, every frozen row and SQLite identity high-water
  values against the private snapshot.

The child receives only basic process values, fixed build/run/source/action,
scoped R2 credentials and the AWS-local administration connection. AWS role,
Cloudflare management, GitHub, LLM, `NODE_OPTIONS` and inherited `PG_*` credentials
are stripped; the fixed PG options are set explicitly.

On `recovery_prepared`, the parent rechecks fences/admission and atomically stores
that exact digest, build and prepared state with run revision and global-owner
conditions. It consistently reads the new state back before sending the matching
grant. A lost successful persistence response is accepted only by exact readback.
A changed digest or lost owner cannot grant a database write.

The bounded child protocol requires a matching completion event, successful exit
and a private strict receipt. Unknown or failed commit responses retain prepared
intent and exclusion. An explicit replay uses the same input/digest and repeats
the existing idempotent fenced restoration. No replay clears the business-write
marker. On success the parent rechecks D1 and writer admission and atomically
records the strict receipt. Unreviewed receipt fields are rejected before they
can enter DynamoDB.

Writers, the PostgreSQL LOGIN fence, the D1 fence and maintenance ownership all
remain in place. The output retains `productionSafe:false`. Backend/worker
handoff, restored data/search/authorization verification, readiness, traffic
resume and final lock release require the subsequent trusted operation. This
stage alone is not production-cutover readiness.

Validation uses real DynamoDB Local transactions and the complete actual SQLite
migration/fence schema. Remote AWS/Cloudflare/GitHub/R2 and the PG child are
explicit test transports. Tests cover loss of owner at grant, lost successful
persistence response, unknown commit and same-input replay, changed digest,
reopened admission, corrupt input, D1 row/trigger drift and strict receipt
rejection. Separate bounded-pipe tests execute real local child processes.
The immutable ZIP fixture resolves the parent/child with only locked operations
dependencies and retains the existing isolated PostgreSQL fence checks. None of
these tests claims to run this production-only parent against production.
