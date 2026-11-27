import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from '@videoq/trpc/router';
import { TRPC_MAX_BATCH_SIZE } from '@videoq/trpc/schema';
import { createPrototypeComposition } from '../integrations/prototype/composition';

/** Standalone local composition: production never imports this entrypoint. */
export function createPrototypeApp(options: Parameters<typeof createPrototypeComposition>[0]) {
  const composition = createPrototypeComposition(options);
  const app = new Hono();
  let rawRevision: string | undefined;
  const positions = new Map<string, number>();
  app.get('/health', c => c.json({ status: 'ok', mode: options.mode, prototype: true }));
  app.use('/api/trpc/*', trpcServer({ endpoint: '/api/trpc', router: appRouter, maxBatchSize: TRPC_MAX_BATCH_SIZE,
    createContext: () => composition.context(),
  }));
  app.all('*', async c => {
    const { document, snapshot } = await composition.source.load();
    if (rawRevision !== snapshot.revision) { positions.clear(); rawRevision = snapshot.revision; }
    const key = `${c.req.method} ${c.req.path}`;
    const responses = document.http[key];
    if (!responses?.length) return c.json({ error: 'SCENARIO_MISSING', route: key }, 404);
    const position = positions.get(key) ?? 0;
    if (position >= responses.length && !document.repeatLast) return c.json({ error: 'SCENARIO_EXHAUSTED' }, 409);
    positions.set(key, Math.min(position + 1, responses.length));
    const response = responses[Math.min(position, responses.length - 1)];
    const headers = new Headers(response.headers);
    headers.set('X-VideoQ-Prototype', options.mode);
    if (response.body === undefined || [204, 205, 304].includes(response.status) || c.req.method === 'HEAD') {
      return new Response(null, { status: response.status, headers });
    }
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const body = headers.get('Content-Type')?.includes('application/json') ? JSON.stringify(response.body) : typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(body, { status: response.status, headers });
  });
  app.onError((_error, c) => c.json({ error: 'PROTOTYPE_ERROR', message: 'Check the prototype scenario and application output.' }, 500));
  return app;
}
