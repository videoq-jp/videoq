import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../types/bindings';
import { installerPackage } from './installer-package';
import { installerSource } from './installer-source';

export const skillInstallerRoutes = new Hono<AppEnv>();

// Public executable only. The installer still requires an owner-scoped API key to read skills.
skillInstallerRoutes.get('/:id', async c => {
  const id = c.req.param('id').replace(/\.tgz$/, '');
  if (!c.req.param('id').endsWith('.tgz') || !z.uuid().safeParse(id).success) return c.notFound();
  // Use the configured frontend, never a request-controlled host or redirect.
  const origin = new URL(c.env.FRONTEND_URL || c.env.BETTER_AUTH_URL).origin;
  return new Response(installerPackage(origin, id, installerSource), { headers: {
    'Content-Type': 'application/gzip', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex',
    'Content-Disposition': 'attachment; filename="videoq-skills.tgz"',
  } });
});
