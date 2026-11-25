import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import { installerPackage } from './installer-package';

const maxScriptBytes = 64_000;
export const skillInstallerRoutes = new Hono<AppEnv>();

// Public executable only. The installer still requires an owner-scoped API key to read skills.
skillInstallerRoutes.get('/:id', async c => {
  const id = c.req.param('id').replace(/\.tgz$/, '');
  if (!c.req.param('id').endsWith('.tgz') || !z.uuid().safeParse(id).success) return c.notFound();
  // Use the configured frontend, never a request-controlled host or redirect.
  const origin = new URL(c.env.FRONTEND_URL || c.env.BETTER_AUTH_URL).origin;
  const source = await fetch(new URL('/skills/install.mjs', origin), { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  // Nginx's stock MIME map serves .mjs downloads as application/octet-stream.
  const mediaType = source?.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!source?.ok || !source.body || !['text/javascript', 'application/javascript', 'application/octet-stream'].includes(mediaType ?? '')) {
    await source?.body?.cancel(); return c.text('Installer unavailable.', 503);
  }
  const reader = source.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) return c.text('Installer unavailable.', 503);
      size += value.length;
      if (size > maxScriptBytes) return c.text('Installer unavailable.', 503);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new Response(installerPackage(origin, id, new TextDecoder().decode(bytes)), { headers: {
    'Content-Type': 'application/gzip', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex',
    'Content-Disposition': 'attachment; filename="videoq-skills.tgz"',
  } });
});
