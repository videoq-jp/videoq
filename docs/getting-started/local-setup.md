---
title: Run the development environment
description: Start VideoQ with Docker Compose and log in with a local account.
---

# Run the development environment

The goal is to run VideoQ on your computer and log in. Start with Docker Compose managing the API, database, and video processing.

For documentation-only changes, go to [Update the documentation](../guides/documentation.md). You do not need to start the app.

## Prerequisites

| Requirement | Purpose |
|---|---|
| Git and repository access | Get the source code |
| Docker and Docker Compose | Run the database, API, video processing, and related services |
| Node.js and npm (the version in `.node-version`) | Install dependencies and configure a local account |
| An OpenRouter API key for development | Transcription, search data generation, and AI answers |

The video processing and AI answers in this guide incur external API usage charges. Use a development key and a short test video. A separate SearchAPI key is needed only for YouTube imports.

## 1. Get the code and configuration

```bash
git clone https://github.com/videoq-jp/videoq.git
cd videoq
cp -n .env.example .env
npm ci
```

Run subsequent commands from the repository root, `videoq/`, unless stated otherwise. Skip cloning if you already have a working copy.

## 2. Configure AI services for development

Edit the matching entries in `.env` to use these values. Set `OPENROUTER_API_KEY` to your own development key.

```dotenv
OPENROUTER_API_KEY=your-development-key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=openai/gpt-6-luna
EMBEDDING_MODEL=openai/text-embedding-3-small
WHISPER_BACKEND=openrouter
```

These are the values already in `.env.example`, so you normally only add the key. `WHISPER_BACKEND=openai` is the legacy direct route and would need a separate `OPENAI_API_KEY`.

Answer generation and image inspection share `LLM_MODEL`, set here to GPT-6 Luna through OpenRouter. With visual Q&A enabled, choose a model that supports image input, tool calling, and strict JSON output. See [model settings](../architecture/prompt-engineering.md#model-settings-and-limits).

The templates already use these embedding defaults. Dimensions are fixed at 1536; no dimension environment variable is needed. The API and worker must use the same provider and model. For private llama.cpp/vLLM endpoints and diagnostic commands, see [embedding configuration](../guides/embeddings.md).

Generate two development secrets:

```bash
openssl rand -base64 48
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Set `.env`'s `AUTH_JWT_SECRET` to the first output and `USER_SECRET_ENCRYPTION_KEY` to the second.

`AUTH_JWT_SECRET` is a compatibility setting used by the current Compose startup script. Browser authentication uses Better Auth cookie sessions. When running the API directly on the host, use `BETTER_AUTH_SECRET`. See [authentication](../concepts/auth.md) for the distinction.

## 3. Start the services

```bash
docker compose up --build -d
docker compose ps -a
```

The first start takes time to download and build images.

- Continue when services such as `postgres`, `api`, `worker`, `web`, and `gateway` are running.
- `migrate` and `garage-init` stop after initialization. Exit code `0` means they completed successfully.
- If a service fails, inspect it with `docker compose logs --tail=100 migrate api worker`.

```bash
curl -fsS http://localhost/health
curl -fsS http://localhost/ready
```

`/health` checks that the API responds; `/ready` also checks DB connectivity. A successful `/ready` response looks like this:

```json
{"data":{"status":"ready","db":"ok"}}
```

## 4. Create an account and log in

1. Create a user on the [local signup screen](http://localhost/signup).
2. In a local environment without email configured, activate the account and grant administrator access with the following command. Replace `your-username` with the username or email address you registered.

```bash
npm run user:admin --workspace @videoq/api -- your-username
```

3. Log in on the [login screen](http://localhost/login).

This promotion procedure is for your own local development database. The default connection is `127.0.0.1:55432` on the host. If you have already set `DATABASE_URL`, check its target before running the command.

## 5. Edit the frontend

The default `http://localhost` serves a built frontend. Add the Vite development server to see changes immediately:

```bash
docker compose --profile dev up --build -d web-dev
```

Open [http://localhost:3000](http://localhost:3000) during development. This is a separate entry point from the static frontend at `http://localhost`.

## Stop and restart

```bash
docker compose stop
docker compose up -d
```

`stop` preserves the local database and videos. After changing `.env`, recreate the affected services to reload their settings:

```bash
docker compose up -d --force-recreate api worker
```

Starting the API through Docker generates `apps/api/.dev.vars`. Manual edits to this file are overwritten at the next start, so edit `.env` for Compose setups. The startup script forwards only a defined subset of settings.

**Read next:** [Add a video and ask questions](first-walkthrough.md). If startup fails, see [Troubleshooting](../guides/troubleshooting.md).
