# Background job wire contract

`background-jobs.json` is a shared set of wire inputs, acceptance decisions,
canonical identity strings and SHA-256 digests for the four common background job
types. Both the API Vitest test and Python worker pytest test consume it through
their actual execution entry points. Changes select both CI jobs.

The envelope requires exactly `type`, `job_id` and `payload`. Payload fields are
specific to each job type. Identifiers are preserved without trimming; user and
root identifiers must contain a non-whitespace character according to ECMAScript
`String.trim`. Length limits use UTF-16 units, matching JavaScript. Unpaired
surrogates are rejected before persistence because they have no portable UTF-8
identity. JSON integral numbers such as `42`, `42.0` and `4.2e1` normalize to the
same safe integer; strings, booleans, fractions and unsafe integers are rejected.

Identity remains the UTF-8 SHA-256 of compact JSON with sorted keys and unescaped
Unicode, containing only `payload` and `type`. Existing valid integer/string
payloads retain their digests. A completed replay must reach the same claim
barrier and perform no task side effects.

The worker still supports its media-specific tasks and explicit retired-task
acknowledgements. Those are outside the four shared job types and remain covered
by worker tests. Tightening unknown envelope fields, missing payload and long
identifiers is intentional; do not silently acknowledge rejected historical
messages. They retain the existing retry/DLQ behavior.

Run from the repository root:

```sh
npm run test:unit --workspace @videoq/api -- test/background-job-contract.test.ts
apps/worker/.venv/bin/python -m pytest apps/worker/tests/test_background_job_contract.py -q
```
