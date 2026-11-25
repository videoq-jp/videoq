# Historical vLLM proof unit fixtures

These non-executable `.txt` files are exact data snapshots from source
`eec22a49`, for historical evaluator unit tests only:

- `check-vllm-runtime-eec22a49.py.txt`: SHA-256
  `511807d5a341b681c6ff6658c058cfcb049f7fa59dd1d68264b1cd153fc9264b`.
- `audio-wheels-eec22a49.json.txt`: SHA-256
  `4bd306454e793d6e2dcb67a94db771e703e9b5c2f7202ae98d8b53b4d27b4f7e`.

The evaluator test compiles a separate module with a test-only filesystem reader
that substitutes the archived bytes **only** for the exact runtime-probe source
path. Every other read uses the actual filesystem. The archive is never executed
or imported, and no production module, require cache, global reader, workflow or
native probe is changed. Historical source and lock identities are set explicitly
in that unit fixture; all hostile mutation controls still run against it.

A separate test uses the actual production evaluator, active source and active
policy/lock. It requires the old native receipt to fail. Passing historical unit
tests neither approves the active 9.1 overlay nor authenticates a supplied JSON
receipt. Production remains blocked until a fresh native artifact and independent
review explicitly update the exact proof. No historical file is a deployment input.
