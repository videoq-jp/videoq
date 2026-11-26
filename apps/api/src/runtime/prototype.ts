import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPrototypeApp } from './prototype-app';

const mode = process.env.VIDEOQ_PROTOTYPE_MODE ?? 'memory';
if (mode !== 'memory' && mode !== 'stub') throw new Error('VIDEOQ_PROTOTYPE_MODE must be memory or stub');
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535');
const scenario = process.env.VIDEOQ_SCENARIO ? resolve(process.env.VIDEOQ_SCENARIO)
  : fileURLToPath(new URL('../../prototype/default.json', import.meta.url).href);
const app = createPrototypeApp({ scenario, mode });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () =>
  console.log(`VideoQ prototype (${mode}): http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
