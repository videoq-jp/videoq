# Large-course skill creation: D1 RPC envelope

## Reproduction

The reported course has 177 videos and 5,794,028 subtitle characters. The production skill-start request failed during D1 `batch`, before any model call or skill job was created. Schema inspection confirmed both skill tables exist.

A read-only remote D1 binding probe ran the real `skillChunks`/state codec against that course. It produced 282 chunks, 93,797 cues, 19,419,732 JSON characters and 304 storage parts. Sending those parts in a single batch of `SELECT length(?)` statements reproduced:

> D1_ERROR: Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: 43016280 bytes.

The same read-only probe with eight parts per call completed all 304 parts. No source contents, credentials, production writes or model calls were used in this probe's output.

## Change

D1 uploads and reads at most eight parts per call. A new job remains hidden until its upload is complete. Updates stage a new immutable revision while retaining the old visible pointer; a small transaction publishes only a complete revision under the unchanged owner, lease and pointer, then retires replaced/abandoned revisions. Failed uploads clean their unpublished parts. Lost commit acknowledgements preserve an already published revision. Readers retry if a concurrent publication retires their snapshot.

Existing inline states and committed `parts-v1` states remain readable. PostgreSQL also hides provisional pointers imported from D1. No migration, quota change or course-size cap is introduced.

## Validation

- Real remote D1 read-only reproduction and bounded-call comparison on the reported course.
- Real D1 fixtures with a simulated 32MiB request/response ceiling: snapshots over that ceiling round-trip through bounded calls; partial uploads remain hidden; old snapshots remain readable while uploading.
- A later-batch write failure, lease takeover during staging, abandoned-part retirement, and lost publication acknowledgement preserve the committed state.
- Native workerd creates, resumes and reads a 177-video / 93,906-cue synthetic snapshot using the production D1 repository.
- Existing source checks, generated-skill behavior, owner filtering, lease fencing and account cascades remain covered.

The synthetic generation tests do not claim that a real course has completed all AI generation steps. Production rollout uses normal reviewed CI/CD; final rollout IDs are recorded separately.
