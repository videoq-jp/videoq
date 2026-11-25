# Minimal whisper runtime consumer pins

The chart and basic inference allowlist consume only the two immutable manifests in
`.github/whisper-runtime-pins.json`, from the isolated public package
`ghcr.io/videoq-jp/videoq-whispercpp-candidate`.

Source verification run 45538276974 built and checked the exact original upstream
ELF files on native amd64 and arm64 runners. Protected publication run 45540057431
copied those already verified OCI artifacts without rebuilding. Both independent
anonymous native pull jobs (138956447654 and 138956447631) passed read-only,
non-root, network-isolated help, model-loaded health and synthetic WAV inference,
and full unsuppressed scans. Publication receipt and artifact checksums are recorded
in `whispercpp-publication-independent-2026-11-25.json`.

Normal on-prem validation now repeats native runtime verification and registry
scanning for these pins on both architectures. The minimal runtime accepts no VEX,
APT assessment or header exception: HIGH, CRITICAL and UNKNOWN findings fail the
strict scan. Helm checks still require all three deployment profiles, loopback
binding, non-root execution, read-only model mounts and the existing isolation.
The historical original-image assessment fixtures remain as regression evidence;
they do not authorize the minimal runtime. The llama.cpp assessment is unchanged.

Local validation: 34 security, publisher and CI-selection tests; 18 actual Helm
chart tests; five basic package policy tests. Actual normal integration CI remains
required after these consumer changes; the earlier publication run is not a claim
that the changed normal CI route has run.
