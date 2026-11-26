# Historical vLLM proof unit fixtures

These non-executable `.txt` files are exact data snapshots from source
`eec22a49` and its original reviewed proof, for historical evaluator unit tests only:

- `check-vllm-runtime-eec22a49.py.txt`: SHA-256
  `511807d5a341b681c6ff6658c058cfcb049f7fa59dd1d68264b1cd153fc9264b`.
- `audio-wheels-eec22a49.json.txt`: SHA-256
  `4bd306454e793d6e2dcb67a94db771e703e9b5c2f7202ae98d8b53b4d27b4f7e`.

- `masked-ffmpeg-eec22a49-review.json.txt`: SHA-256
  `92c1a5eb3848dc77178b439e4be47e274b576170106af10f2ca556c373effc63`.

The evaluator test compiles a separate module with a test-only filesystem reader
that substitutes archived bytes **only** for the exact runtime-probe source and
masked-proof paths. Both archives have fixed SHA assertions; every other read
uses the actual filesystem. The archive is never executed
or imported, and no production module, require cache, global reader, workflow or
native probe is changed. Historical source and lock identities are set explicitly
in that unit fixture; all hostile mutation controls still run against it.

A separate test uses the actual production evaluator, active source and active
policy/lock. It requires the old native receipt to fail. Passing historical unit
tests neither approves the active 9.1 overlay nor authenticates a supplied JSON
receipt. Active acceptance depends on the explicitly reviewed current native
artifact and exact proof; the active evaluator still rejects this old receipt
after a fresh proof replacement. No historical file is a deployment input.
