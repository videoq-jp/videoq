import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import type { AppEnv } from '../types/bindings';

const LIFETIME = 30 * 24 * 60 * 60;
const pending = new WeakMap<Context<AppEnv>, Promise<string>>();

/** Browser ownership credential. Never return it in JSON or accept it from request input. */
export function visitorSession(c: Context<AppEnv>): Promise<string> {
  const existing = pending.get(c);
  if (existing) return existing;
  const session = resolveVisitorSession(c);
  pending.set(c, session);
  return session;
}

async function resolveVisitorSession(c: Context<AppEnv>): Promise<string> {
  const secret = c.env.BETTER_AUTH_SECRET?.trim() || c.env.AUTH_JWT_SECRET?.trim();
  if (!secret) throw new Error('An auth secret is required for visitor sessions');
  const secure = c.env.ENVIRONMENT === 'production' || new URL(c.req.url).protocol === 'https:';
  const name = secure ? '__Host-videoq-visitor' : 'videoq-visitor';
  const value = await getSignedCookie(c, secret, name);
  const match = typeof value === 'string' ? /^([0-9a-f-]{36})\.(\d+)$/.exec(value) : null;
  const now = Math.floor(Date.now() / 1000);
  const id = match && Number(match[2]) > now ? match[1] : crypto.randomUUID();
  await setSignedCookie(c, name, `${id}.${now + LIFETIME}`, secret, {
    httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: LIFETIME,
  });
  c.header('Cache-Control', 'private, no-store');
  return id;
}
