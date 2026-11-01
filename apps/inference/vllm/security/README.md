# NVIDIA vLLM image assessment

The image keeps the C/UAPI headers needed by Triton's runtime JIT. These headers
are not a Linux kernel. CI mounts and runs `verify_kernel_headers.py` against the unmodified upstream image: every regular
file owned by `linux-libc-dev` must be a header or its documentation, none may be
ELF or a kernel module, and the image may contain no kernel binaries/modules.
Do not remove package metadata or retain untracked headers to change scan results.

`kernel-headers.openvex.json` lists the 386 kernel implementation CVEs reported on
this package by CI run 39954013361 on 2026-10-23. The assessment is restricted to
Ubuntu 24.04 amd64 `linux-libc-dev` version `6.8.0-147.147`, with explicit vulnerability IDs and the
`vulnerable_code_not_present` justification. It does not apply to host kernels,
other packages, unknown CVEs, or another distribution/architecture. A new package version does not match this assessment and requires a fresh
review. A changed package inventory also fails the inventory check instead of
silently accepting executable code under the assessment.

VideoQ does not patch, rebuild or republish the upstream vLLM image. CI tests
the gateway's PCM WAV decoding path in that exact image. ROCm speech additionally
mounts an offline payload of locked upstream codec packages from the gateway;
the gateway image scan covers those packages. A vulnerability outside
this explicit assessment still fails validation and requires an upstream update.

CI applies `trivy.yaml` only to this NVIDIA vLLM image. HIGH/CRITICAL findings,
including unfixed ones, still fail unless covered by the explicit assessment.
The JSON report uses `show-suppressed`, so both outstanding and assessed findings
remain available in the `vllm-security-nvidia` artifact alongside this directory.
Never describe an assessed passing result as zero raw findings.

From the repository root, using the exact upstream image reference:

```sh
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
  --config apps/inference/vllm/security/trivy.yaml \
  --format json --output vllm-security.json YOUR_PINNED_UPSTREAM_IMAGE
```

To obtain the unassessed report, omit `--config` and use a different output path.
Before promoting an image, retain both the report and the exact image digest.
Assess and patch the actual Kubernetes host kernel independently during site
acceptance; its state cannot be established by scanning the container's headers.

References:
- [Trivy maintainer explanation of kernel header findings](https://github.com/aquasecurity/trivy/discussions/6562)
- [Trivy OpenVEX and package URL matching](https://trivy.dev/docs/latest/supply-chain/vex/file/)
- [Example Ubuntu kernel implementation advisory](https://ubuntu.com/security/CVE-2026-63825)
- [Triton runtime compilation](https://github.com/triton-lang/triton/blob/v3.8.0/third_party/nvidia/backend/driver.py)

On 2026-10-26, the unmodified `vllm/vllm-openai:v0.32.0` image at
`sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34`
passed `check_runtime.py` as UID/GID 10001 with networking disabled and no
additional package installation. The header inventory check reported
`linux-libc-dev` version `6.8.0-147.147` and 990 header/documentation files.
This verifies WAV decoding and the header inventory; it is not a GPU inference
or vulnerability-scan result.

The `vllm-image` CI matrix also checks the official ROCm image. That job uses
no NVIDIA VEX configuration and retains `vllm-security-amd` separately.
The header inventory script/assessment in this directory is NVIDIA-only.
