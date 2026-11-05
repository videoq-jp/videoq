---
sidebar_label: Single-server installation
description: Install and evaluate VideoQ on one Linux server, then back up, update and restore it.
---

# Install VideoQ on one server

Use this installer for a small deployment on one Linux server without an existing
Kubernetes cluster. It supplies the database, object storage and persistent job
queue alongside the production application. For an existing managed cluster or
site-managed infrastructure, use the [Kubernetes guide](on-premises.md) instead. Single-server storage
has one replica; backups on another host are required for host-loss recovery.

## Prerequisites

| Requirement | Purpose |
|---|---|
| Linux, Docker Engine, Docker Compose and Python 3.9+ | Run the installer and services |
| Repository checkout | Installer and configuration templates |
| Verified `verified-images.json` | Pin the reviewed application images |
| Public application and storage URLs | Browser login, upload and playback |
| OpenRouter key or existing local inference services | Chat, embeddings and transcription |

Use Python 3.9+, Docker Engine and Docker Compose on the Linux server. The installer generates a separate private
directory, uses production application images pinned by digest, generates unique
credentials, persists PostgreSQL/Garage/ElasticMQ data, and exposes only Caddy's
HTTP/HTTPS ports. ElasticMQ message persistence is enabled, including the DLQ.
The scheduler runs the existing recovery command every minute after completion
and retention on startup and once per UTC day. Failures cause a container restart.

Follow [release download and signature verification](on-premises-releases.md#download-and-verify-a-specific-release) before installation. That guide lists the tools needed for verification. The installer
consumes the resulting `verified-images.json`; it does not replace signature
verification. Application and storage need distinct origins: use two DNS names
resolving to the server, or one name with separate ports (for example,
`https://videoq.example.edu` and `https://videoq.example.edu:9443`). HTTPS uses Caddy automatic certificates, which
requires working DNS and certificate issuance connectivity. For a private CA,
pass `--tls-cert /secure/site.crt --tls-key /secure/site.key` to `install` or `init`. The PEM
certificate must cover both hostnames, and browsers must trust its issuer.
The server running CLI diagnostics must also trust that issuer; install its CA
in the system trust store or set `SSL_CERT_FILE=/secure/ca-chain.pem` for the CLI.
The gateway publishes the ports specified in the two URLs (normally 80/443).
HTTPS also publishes port 80 for certificate challenges and redirects. Use
`--bind-address 127.0.0.1` for loopback-only access behind a host-side proxy;
the default publishes on all interfaces.

## Install

Get a repository checkout if needed:

```sh
git clone https://github.com/videoq-jp/videoq.git
cd videoq
```

Run all following commands from the repository root. Keep the verified release
and generated configuration outside the checkout. For the default hosted AI
configuration, the installer prompts for an OpenRouter key without echoing it.
Local AI connection options are described below.

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server install \
  --images /secure/videoq-release/verified-images.json \
  --url https://videoq.example.edu --storage-url https://s3.example.edu \
  --username site_admin --email admin@example.com
```

`install` generates configuration, starts services, runs infrastructure/public
endpoint checks, and prints the initial administrator's single-use setup link.
After a failure it preserves generated keys; do not rerun `init` over the same
directory. Diagnose and resume with the commands below. On-prem accounts are
issued by administrators; there is no public signup page.

## Diagnose and resume

For separate review of the generated configuration:

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server init \
  --images /secure/videoq-release/verified-images.json \
  --url https://videoq.example.edu --storage-url https://s3.example.edu
python3 scripts/onprem/videoq.py --directory /secure/videoq-server doctor
python3 scripts/onprem/videoq.py --directory /secure/videoq-server start
python3 scripts/onprem/videoq.py --directory /secure/videoq-server status
python3 scripts/onprem/videoq.py --directory /secure/videoq-server doctor --live
python3 scripts/onprem/videoq.py --directory /secure/videoq-server admin \
  --username site_admin --email admin@example.com
```

`doctor --live` checks authenticated S3/queue access, API readiness, public API
routing and the public storage upload preflight, including DNS/TLS.
`doctor --live --ai` additionally checks that chat and embedding APIs advertise
the selected models. It does not invoke inference or verify model quality.
Use `logs --service api` for startup failures, `logs --service migrate` for
migrations, and `logs --service worker` for video processing. Put `--directory`
before the subcommand in each invocation.
If access to Docker requires root, opt in using `VIDEOQ_DOCKER_SUDO=1`; the CLI
uses non-interactive `sudo -n docker` and does not request a password itself.

## Backup and restore

A backup temporarily stops the services. Schedule a maintenance window.

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server backup \
  --output /secure/backups/videoq-2026-11-04
python3 scripts/onprem/videoq.py --directory /secure/videoq-restored restore \
  --backup /secure/backups/videoq-2026-11-04
python3 scripts/onprem/videoq.py --directory /secure/videoq-server stop
python3 scripts/onprem/videoq.py --directory /secure/videoq-restored start
```

Backup requires downtime: it stops application writers, then infrastructure,
streams all five persistent volumes to an archive, saves configuration and keys,
and resumes the previously running services. The manifest is written only after
the archive completes. The restored copy uses separate volumes but the same public URLs, so stop the
original project before starting it.

Backups contain secrets and are not encrypted by this tool. Store them with
restricted access and copy them to a separate host. Restore only trusted local
backups. SHA-256 checks detect corruption; they do not authenticate the author.
Physical database backups require the matching PostgreSQL major version and
architecture. `start --offline` skips explicit image pulls; all application and
infrastructure images must already be loaded. The installer currently consumes
an operator-verified release; it does not produce an offline distribution bundle.

## Update

Verify the new release using the [release guide](on-premises-releases.md), then
choose a new backup destination and run:

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server update \
  --images /secure/new-release/verified-images.json \
  --backup /secure/backups/videoq-before-update
```

The installer pulls images before downtime, makes a cold backup, applies the
new images and runs migrations/readiness checks. On failure, application
services remain stopped. Inspect `logs --service migrate` and `logs --service api`.
Retry `start` after resolving the cause, or restore the pre-update backup into a
new directory. The installer does not automatically revert images over a changed
SQL schema. Verify a restored copy before returning it to users.

## Local AI connection presets

`--ai local-cpu` and `--ai local-gpu` configure the same model contracts
as the application Helm overlays. Use them with `install` or `init`. Provide `--chat-url`, `--embedding-url` and
`--transcription-url` with their `/v1` paths. These presets connect to existing
private inference services; they do not provision models or GPU drivers. See
[local inference](local-inference.md) for the model-serving requirements. The default
models match `charts/videoq/examples/local-ai-{llamacpp,vllm}.yaml`; explicit
`--chat-model` and `--embedding-model` override them. `VIDEOQ_LOCAL_AI_KEY` supplies
a shared provider key; absent a key, the preset uses `local-inference`.

Local presets remove hosted credentials and endpoints and disable visual Q&A.
For an existing dataset, changing the embedding model requires reindexing, even
when the dimensions match. This CLI does not install a host firewall or enforce
private-only egress.

The OpenRouter key is prompted without terminal echo. Automation can provide it
through `VIDEOQ_OPENROUTER_API_KEY`. Keep the generated directory and backups
private: `runtime.env` includes the encryption key needed to recover user secrets.
Initialization refuses an existing destination and never silently replaces keys.
Do not use `docker compose config` without `--quiet` in shared logs because its
resolved output includes credentials.

## Finish the single-server evaluation

Use a short representative video and the AI services you intend to deploy:

1. Log in using the administrator setup link, then upload the video.
2. Wait for transcription and indexing, ask a question, and play the cited moment.
3. Record processing time, simultaneous usage, storage growth and answer quality.
4. Make a backup, copy it off the server, and rehearse restore and an update.

The automated acceptance suite checks real video processing, cited answers,
playback and update recovery against a deterministic AI fixture. It does not
approve the quality or capacity of your selected models. Real CPU model checks
are separate in the [signed release pipeline](on-premises-releases.md#real-cpu-model-acceptance).

Use this evaluation to decide whether another server is needed for inference,
processing or storage. Keep off-host backups even while everything runs on one
server. This installer does not provision GPU drivers or an offline distribution
bundle; follow [local inference](local-inference.md) when preparing private models.
