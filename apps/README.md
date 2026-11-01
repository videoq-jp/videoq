# apps/

Runnable packages for VideoQ.

| Directory | Role | Runtime |
|---|---|---|
| [`api/`](api/) | tRPC API and protocol transports | Hono / Cloudflare Workers (Node.js on-prem) |
| [`demo-video/`](demo-video/) | Demo films for the landing pages and ads | Remotion |
| [`docs/`](docs/) | Site for browsing and searching the documentation in `../docs/` | Docusaurus |
| `inference/` | Private speech gateway and engine images for on-prem Whisper | Containers |
| [`web/`](web/) | Browser application | React / Vite |
| [`worker/`](worker/) | Asynchronous processing, including transcription, indexing, and visual caches | Python / SQS Lambda (long polling on-prem) |

Node.js packages are managed through npm workspaces at the repository root; `worker/` and `inference/` are Python.

```bash
npm ci
npm run dev:api
npm run dev:web
npm run dev:docs
```

Start the full local stack:

```bash
docker compose up --build -d
```

To enable frontend HMR:

```bash
docker compose --profile dev up -d web-dev
```
