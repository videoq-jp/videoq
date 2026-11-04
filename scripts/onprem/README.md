# VideoQ single-server installer

Start with the [single-server installation guide](../../docs/guides/on-premises-single-server.md)
([Japanese](../../apps/docs/i18n/ja/docusaurus-plugin-content-docs/current/guides/on-premises-single-server.md)).
It is the operator reference for prerequisites, verified images, installation,
TLS, local AI connections, backups, updates and recovery.

Run the CLI from the repository root:

```sh
python3 scripts/onprem/videoq.py --help
python3 scripts/onprem/videoq.py install --help
```

| Command | Purpose |
|---|---|
| `install` | Generate configuration, start, diagnose and provision an administrator |
| `init` | Generate configuration for review before startup |
| `doctor`, `status`, `logs` | Diagnose the host and services |
| `start`, `stop` | Run or stop the installation while retaining data |
| `admin` | Issue the administrator's single-use account setup link |
| `backup`, `restore`, `update` | Save, recover and update an installation |

The `--directory` option comes before the command. The root development
`docker-compose.yml` is a separate environment; use the generated installation's
CLI to manage its services.

## Contributor verification

Run the default installer checks without Docker:

```sh
python3 -m unittest discover -s scripts/onprem -v
node --check scripts/onprem/scheduler.mjs
```

With prebuilt production images, run the real lifecycle and acceptance checks:

Build the three application images using the
[production image build instructions](../../charts/videoq/README.md#build-and-load-images),
tagging them `videoq-api:onprem-ci`, `videoq-worker:onprem-ci`, and
`videoq-web:onprem-ci` for the default test configuration.

```sh
VIDEOQ_ONPREM_LIFECYCLE=1 VIDEOQ_DOCKER_SUDO=1 \
  python3 -m unittest discover -s scripts/onprem -p test_lifecycle.py -v
node node_modules/playwright/cli.js install --with-deps chromium
VIDEOQ_ONPREM_ACCEPTANCE=1 VIDEOQ_DOCKER_SUDO=1 \
  python3 -m unittest discover -s scripts/onprem -p test_acceptance.py -v
```

The Docker test uses prebuilt production `videoq-{api,worker,web}:onprem-ci`
images by their immutable local IDs and pinned infrastructure images. It uses
disposable unique projects and loopback ports 18090/18091, checks DB/S3/queue
data across restart and backup/restore, and removes only its own volumes.

The acceptance test provisions a loopback-only temporary registry, publishes and
pulls real image digests, completes initial account setup, uploads generated video,
extracts real audio with FFmpeg, and verifies transcription/indexing against a
deterministic private AI fixture. It checks cited Q&A, SSE and Chromium playback
before and after an image update and after restoring a pre-failure backup from
an intentionally failed migration. It also validates custom TLS certificates on
both gateway listeners. Only disposable projects, registry tags and volumes are
removed. This does not certify arbitrary SQL migration compatibility or model
quality. Real CPU model acceptance remains in the signed release pipeline.
The public `install` CLI is also exercised against a separate fresh database,
including infrastructure diagnostics and initial administrator provisioning.

The acceptance test needs Node, the repository's API development dependencies,
Chromium and OpenSSL. `VIDEOQ_ONPREM_API_IMAGE`, `VIDEOQ_ONPREM_WORKER_IMAGE`, and
`VIDEOQ_ONPREM_WEB_IMAGE` select alternative prebuilt production image tags;
`VIDEOQ_LAB_NODE` selects the Node executable. CI builds the current source images
before running both suites. Production releases still go through the existing
image scans and provenance verification.

Model/GPU provisioning and a complete offline distribution bundle remain separate
from this installer. Use the local inference guide to provision private services.
