# Public on-prem signature fixture

These are public provenance bundles and exact Helm/manifest bytes from the successful main On-prem Release run [42505541209, attempt 1](https://github.com/videoq-jp/videoq/actions/runs/42505541209/attempts/1), source `2f9e90290f1edb1d904903458a592c0b87b1499b`. They contain public certificates/provenance/transparency-log proofs, not signing keys or credentials.

`trusted-root.json` is a public Sigstore production trust-root snapshot obtained through Sigstore Python 4.5.1's TUF-verified production configuration. Unit tests use it to verify the real bundle cryptography without network access. **Production does not load this fixture:** the public verifier obtains its roots independently through `Verifier.production()`.

The archives are hash/signature test inputs only; tests do not extract or execute them. The release manifest covers both charts and all five immutable image references.
