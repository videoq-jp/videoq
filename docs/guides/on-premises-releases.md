---
sidebar_label: Verified on-prem releases
description: Verify signed VideoQ images and charts, rehearse updates, and promote reviewed digests.
---

# Verified on-prem releases and updates

For sites with internet access, use an external OCI registry and immutable image
digests. The `On-prem Release` workflow prepares application and transcription-gateway GHCR
images for Linux amd64 and arm64, application and inference chart archives, and `release.json`. It runs only for the current source
repository main commit after successful push CI. It can also be dispatched for
that commit, for example to rebuild after distribution package fixes.

Distribution uses the public packages
`ghcr.io/videoq-jp/videoq-api`, `videoq-worker`,
`videoq-web` and `videoq-transcription-gateway`.
Docker and Kubernetes can pull them without a GHCR login
or `imagePullSecrets`. Site-owned private registries can still use
`imagePullSecrets` when required. The images include the repository's existing
LICENSE; making distribution public does not change those terms.

Package administrators initially set these packages to **Public** and grant
`videoq-jp/videoq` the **Write** role under **Package settings → Manage
Actions access**. The workflow checks public visibility before and after every
push and before assembling indexes. Missing, private or internal packages stop
publication. Staging verifies the signed release and pulls each reviewed digest
with an empty Docker credential configuration, proving anonymous image access.
Publishing still requires repository-scoped write credentials. GitHub does not
allow a public package to become private again.

## What the release verifies

Application builds have read-only repository access. They scan each image for
HIGH/CRITICAL vulnerabilities, including unfixed findings, and export the image
and a CycloneDX inventory. Separate fresh runners publish the exact build
artifacts without running application containers or installing app dependencies
with publication credentials. GitHub OIDC signs provenance and per-architecture
SBOM attestations. A signed multi-architecture index binds the two architectures;
the signed schema-v5 release manifest binds all four VideoQ image index digests, their
supported architectures and both charts' bytes. The signed inference chart
pins upstream llama.cpp, whisper.cpp and vLLM image digests. These upstream
artifacts are used directly and are not rebuilt or signed as VideoQ images.
Each GPU profile uses the same vendor-specific upstream vLLM image for chat,
embeddings and speech: `vllm.image` for CUDA, `vllm.rocmImage` for ROCm.
The upstream pins are carried by the signed chart, not overridden by the
VideoQ image verifier. VideoQ's transcription gateway no longer builds or bundles whisper.cpp.
See the [inference image policy](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#upstream-image-policy-and-package-names).

These package names replace `videoq-onprem-*` for new releases. Existing signed
bundles remain unchanged for rollback. Use the chart and image values from the
same release, and migrate site overrides from `whisper.vllmImage` to
`vllm.image` (CUDA) or `vllm.rocmImage` (ROCm).

NVIDIA scanning retains the existing narrowly scoped
[kernel-header assessment](https://github.com/videoq-jp/videoq/blob/main/apps/inference/vllm/security/README.md).
Only explicitly assessed header findings are suppressed; other HIGH/CRITICAL
findings still block publication. The `vllm-security-nvidia` validation artifact retains JSON reports, including
suppressed findings and the assessment, for 14 days. AMD validation records
`vllm-security-amd` separately without applying the NVIDIA header assessment.

The production API and worker use digest-pinned Alpine images. In addition to the
interpreter, the canonical runtime updater refreshes these pins and the verified
npm/pip/uv build tools. A distribution change must pass the image tests: native
Python wheels, PostgreSQL, FFmpeg, auth and the Kubernetes lifecycle. OS package
versions are captured in the SBOM; a rebuild is a new artifact even at the same
source commit. Release runs and attempts use distinct registry tags and artifact
names. On a failed release, rerun **all jobs** so every artifact belongs to the
same attempt; partial retries fail closed when their inputs are from an older
attempt. Installation
always uses digests.

`On-prem Validation` runs on selected changes and daily against current main,
building and scanning images and exercising a disposable Kubernetes environment.
A daily failure requires triage; it does not approve or deploy a replacement.
Every release also verifies the signed artifacts and runs the Kubernetes rehearsal
on a fresh hosted runner. A successful release run therefore includes this staging
check and a separate real CPU model acceptance job. Production promotion remains operator-approved.

Existing dependency and runtime PR automation remains the review path for source
changes. No blanket `ignore-unfixed` or CVE ignore file is used.

## Download and verify a specific release

Use a recent authenticated GitHub CLI with `gh attestation verify`, Python 3.9+
and Helm 4.3.1. Run the verifier from your reviewed checkout, rather than from an
unverified downloaded bundle. Select a successful `On-prem Release` run and
independently review its full source SHA. Do not derive the trusted SHA from the
manifest being checked.

```sh
SOURCE_SHA=REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT
RUN_ID=REPLACE_WITH_SUCCESSFUL_RELEASE_RUN
RUN_ATTEMPT=$(gh run view "$RUN_ID" --repo videoq-jp/videoq --json attempt --jq .attempt)
mkdir -p /secure/videoq-release
gh run download "$RUN_ID" --repo videoq-jp/videoq \
  --name "onprem-release-$SOURCE_SHA-attempt-$RUN_ATTEMPT" --dir /secure/videoq-release
python3 .github/scripts/onprem-release.py verify "$SOURCE_SHA" \
  /secure/videoq-release/release.json /secure/videoq-release/verified-images.json \
  /secure/videoq-release/verified-inference.json
```

Image pulls do not require GHCR authentication or a `read:packages` credential.
The authenticated GitHub CLI above is used for workflow artifacts and attestation
verification. The verifier checks GitHub's signature and artifact
subject, the exact repository and release workflow, `refs/heads/main`, the source
commit and hosted-runner identity. It verifies the manifest, both chart checksums
and signatures, and all four VideoQ image index signatures before writing either values file.
A missing signature, altered chart, different source or unexpected repository
aborts verification and preserves existing values. Per-architecture SBOM
attestations can also be inspected using `gh attestation verify` with predicate
`https://cyclonedx.org/bom`. Preserve the chart, release manifest, verified values,
SBOMs and attestation bundles in your artifact archive; workflow downloads expire
after 90 days. Registry retention must preserve promoted digests and attestations.

Merge the generated image values **last** so site settings cannot accidentally
replace the reviewed digests:

```sh
helm template videoq /secure/videoq-release/videoq-0.1.0-sha.$SOURCE_SHA.tgz \
  -n videoq -f /secure/site.yaml -f /secure/videoq-release/verified-images.json
helm upgrade --install videoq /secure/videoq-release/videoq-0.1.0-sha.$SOURCE_SHA.tgz \
  -n videoq -f /secure/site.yaml -f /secure/videoq-release/verified-images.json \
  --wait --timeout 15m
helm test videoq -n videoq --timeout 2m
```

For fully local AI, install the verified inference archive with
`verified-inference.json` last, and the application with the matching local AI
overlay before `verified-images.json`. See the
[local inference guide](local-inference.md). Hosted OpenRouter remains the application
default; downloading the inference chart alone does not switch AI endpoints.

The chart enforces digests but does not itself enforce signatures. The verifier
is an operator-side gate; a cluster administrator can bypass it. If that must be
prevented, add a site-owned admission policy for the same signer identity.

## Staging and promotion

Start with a separate staging namespace and backing services. Record the source
commit, release run ID, chart checksum, image digests, site-values revision and
migration version in the site's change record. Verify the release, rehearse an
upgrade with a representative backup, and check upload, transcription, indexing,
cited Q&A, SSE and timestamp playback. Production promotion requires an operator
approval of this concrete set of artifacts and the migration/restore plan.

A GitOps repository can store `verified-images.json` in a reviewable PR after
verification. Let the staging controller reconcile approved values, then promote
the same digests to production after approval. Do not auto-promote a mutable tag
or regenerate a production Secret from release metadata. No site deployment or
GitOps credentials are configured in this repository while the target is unset.

## Reproduce the local lifecycle rehearsal

Build the three application images as `videoq-api:onprem-ci`,
`videoq-worker:onprem-ci` and `videoq-web:onprem-ci`. Then, with Docker, kind,
kubectl, Helm, Node and Python available:

```sh
npm ci --ignore-scripts --workspaces=false
kind create cluster --name videoq-onprem-lab --kubeconfig /tmp/videoq-lab-kubeconfig
HELM_BIN=helm python3 .github/scripts/onprem-lab.py \
  /tmp/videoq-lab-kubeconfig /tmp/videoq-lab-results
kind delete cluster --name videoq-onprem-lab --kubeconfig /tmp/videoq-lab-kubeconfig
```

The script restricts kubectl to that dedicated context. It creates disposable
PostgreSQL/pgvector, Garage, ElasticMQ and a deterministic inference HTTP fixture
outside the application chart. It exercises real uploads, FFmpeg audio extraction,
queue delivery, transcript storage, vector indexing, cited Q&A and SSE; then S3
object backup/delete/restore with checksum comparison, a database dump restored
to a separate database, application reconnection, a two-replica upgrade, Helm
tests and a one-replica rollback retaining the restored data. It writes
`result.json` only after all checks pass. Results and database dumps are local
artifacts; do not commit credential-bearing database dumps.

This rehearsal tests application and protocol integration. Real inference model
quality, GPU sizing, TLS/ingress, storage and queue persistence across host loss,
and the site's backup RPO/RTO require validation in the eventual target site.

## Real CPU model acceptance

The release's `Real CPU models with public egress blocked` job separately verifies
the signed bundle and pulls the app, CPU gateway and pinned llama.cpp images.
It provisions the exact chat, embedding and Whisper model revisions/checksums
from the verified inference chart before starting a dedicated kind cluster.
That cluster attaches only to a new dedicated Docker network. After bootstrap
and image loading, its node's IPv4/IPv6 OUTPUT and FORWARD rules reject public
destinations and new Docker-host connections; CoreDNS public forwarding is removed.
Kind needs a default gateway during bootstrap, so Docker `--internal` cannot be
used directly. No VideoQ processing begins until the firewall is installed.
A worker-Pod probe must reach private inference while
public IP connections and external DNS resolution fail.

The disposable PostgreSQL, S3 and queue fixtures are pulled by their reviewed
upstream digests, then imported into kind under explicit local aliases with
`imagePullPolicy: Never`. This avoids re-resolving a remote multiarch index after
public egress is blocked. Results retain their original references and native
Docker image IDs. These aliases are only for the disposable lab; operator installation
still uses the verified release digests. Failure artifacts retain Pod/node
status and warning events, excluding Pod specs and Secrets.
For containerd-backed Docker stores the importer uses native-platform export
(Docker API 1.48+); classic stores must already contain the daemon's native
architecture. It checks each alias through the node's CRI cache before blocking
public traffic, and records the actual imported platform and CRI image ID.

The job uploads the checksum-pinned public Japanese FLEURS clip through the app,
uses real whisper.cpp transcription and llama.cpp embeddings/chat, checks cited
answers and SSE, and uses Chromium to decode and play the uploaded video at an
actual citation timestamp. The transcript must have valid source-relative times
and normalized character error rate below 0.25 against the public reference.
It repeats Q&A after database restore, upgrade and
rollback. `onprem-cpu-acceptance-*` artifacts retain the public transcript,
answers, processing time, playback result, model checksums and image digests for
90 days. They exclude credentials, model files and database dumps.

This is one short public fixture, not site-specific quality or capacity approval.
The node firewall does not test the site's CNI enforcement. With a reviewed
checkout, the tools listed in the script, and Chromium installed, reproduce it:

```sh
npm ci --ignore-scripts --workspace @videoq/api --workspace @videoq/web
node node_modules/playwright/cli.js install --with-deps chromium
HELM_BIN=helm python3 .github/scripts/onprem-cpu-acceptance.py \
  "$SOURCE_SHA" /secure/videoq-release /tmp/videoq-real-cpu-results
```

The script refuses to replace an existing `videoq-onprem-lab` cluster. Initial
downloads need internet access. Allow at least 16 GiB RAM for this disposable
test with backing services; production sizing still needs representative videos.


## Release manifest migration

New upstream-engine releases use schemaVersion 5 and contain four signed VideoQ
packages: api, web, worker and transcription-gateway. The chart pins upstream
CUDA/ROCm engines by digest; they are not represented as VideoQ attestations.
The verifier preserves the exact mappings for schemaVersion 2 (original names),
3 (the old custom GPU namespace) and 4 (five packages including `videoq-vllm`).
All eight historical subjects are verified; schema 5 verifies seven subjects and
binds upstream engine digests through the signed inference chart. Mixed layouts
are rejected.
Historical installs and rollback require their original packages. The retired schema 2 packages and `videoq-onprem-whisper-vllm` have been explicitly removed; schema 2/3 manifests cannot be fully verified or installed from GHCR. Schema 4 remains the current five-package release until a schema 5 release passes all checks. New package visibility
and repository Actions access must be prepared before publication; all existing
visibility, vulnerability and signature gates remain mandatory.

This GPU change is not ready for release: upstream image vulnerability gates
remain unresolved and physical GPU/model acceptance has not been performed.

## Package names and historical releases

The namespace migration to `videoq-jp` is complete. The migration-only Package
Namespace Bootstrap and Retired Package Cleanup workflows have been retired.
Keep `videoq-vllm` and historical signed packages available for verification and
rollback. New builds use the normal signed release workflow; upstream adoption
still requires all security, anonymous-pull and CPU/Kubernetes acceptance gates.

## Evaluate upstream GPU image candidates

Before merge, manual **CI** on the PR branch supports the same candidate inputs with
`gpu_candidates_only=true`; its other selected CI suites still run. The main-only
manual **Operations** workflow (`check=onprem`, `validate_whisper_gpu=true`) accepts `nvidia_candidate` and
`amd_candidate` as official `repository@sha256:<digest>` references. Empty inputs
use the reviewed chart pins. Candidate runs never change deployment pins or
publish images. They check offline gateway WAV decoding, retain the actual vLLM
version, bind Trivy results to the requested digest, and keep the existing
HIGH/CRITICAL including unfixed gate. AMD does not inherit NVIDIA's assessment.
Nightly candidates are development builds; passing these checks does not establish
GPU inference or target hardware/model acceptance.

Manual runs may set `gpu_accelerator=nvidia` or `gpu_accelerator=amd` to evaluate
only a newly published vendor candidate. The default is `both`; PR, push and
scheduled validation always keep both vendors. This selection never changes pins
or weakens the protocol, digest-identity or vulnerability gates.

For isolated candidate evaluation, set `gpu_candidates_only=true` to skip the
application and CPU suites without changing normal CI defaults. NVIDIA evaluation
also accepts the vendor-maintained `nvcr.io/nvidia/vllm@sha256:<digest>` repository.
NGC candidates receive the full scan without VideoQ's official-image kernel-header
assessment. This is evaluation only: NGC and official vLLM releases may have
different vLLM, CUDA and driver requirements, so a passing scan alone does not
permit promotion into chart defaults. AMD candidates remain restricted to the
official `vllm/vllm-openai-rocm` repository.
