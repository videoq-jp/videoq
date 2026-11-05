import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { describe, expect, it } from 'vitest';
import { visitorSession } from '../src/lib/visitor-session';
import { conversationThreadId } from '../src/repositories/conversation-repository';
import type { AppEnv, Bindings } from '../src/types/bindings';

const env = { BETTER_AUTH_SECRET: 'visitor-test-secret' } as Bindings;
function app() {
  const router = new Hono<AppEnv>();
  router.get('/', async c => {
    const [first, second] = await Promise.all([visitorSession(c), visitorSession(c)]);
    return c.json({ first, second });
  });
  return router;
}

describe('visitor ownership cookie', () => {
  it('issues one private secure cookie, restores it, and rejects tampering', async () => {
    const router = app();
    const first = await router.request('https://api.test/', {}, env);
    const identity = await first.json();
    expect(identity.first).toBe(identity.second);
    const header = first.headers.get('set-cookie')!;
    expect(header).toContain('__Host-videoq-visitor=');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const cookie = header.split(';')[0];
    const restored = await router.request('https://api.test/', { headers: { cookie } }, env);
    expect((await restored.json()).first).toBe(identity.first);
    const tampered = cookie.replace(identity.first, crypto.randomUUID());
    const rejected = await router.request('https://api.test/', { headers: { cookie: tampered } }, env);
    expect((await rejected.json()).first).not.toBe(identity.first);
    const other = await router.request('https://api.test/', {}, env);
    expect((await other.json()).first).not.toBe(identity.first);
  });

  it('replaces expired signed cookies and keeps HTTP development cookies separate', async () => {
    const router = app();
    const oldId = crypto.randomUUID();
    router.get('/expired', async c => {
      await setSignedCookie(c, '__Host-videoq-visitor', `${oldId}.1`, env.BETTER_AUTH_SECRET!, {
        secure: true, httpOnly: true, path: '/',
      });
      return c.text('');
    });
    const expired = await router.request('https://api.test/expired', {}, env);
    const cookie = expired.headers.get('set-cookie')!.split(';')[0];
    const renewed = await router.request('https://api.test/', { headers: { cookie } }, env);
    expect((await renewed.json()).first).not.toBe(oldId);
    const development = await router.request('http://localhost/', {}, env);
    const header = development.headers.get('set-cookie')!;
    expect(header).toMatch(/^videoq-visitor=/);
    expect(header).toContain('HttpOnly');
    expect(header).not.toContain('Secure');
    const proxied = await router.request('http://internal-api/', {}, { ...env, ENVIRONMENT: 'production' });
    expect(proxied.headers.get('set-cookie')).toContain('__Host-videoq-visitor=');
    expect(proxied.headers.get('set-cookie')).toContain('Secure');
  });

  it('requires a visitor session and isolates stolen IDs across browser sessions', async () => {
    const scope = { ownerUserId: 'owner', actorUserId: null, courseId: 1, shareSlug: 'public' };
    const id = crypto.randomUUID();
    await expect(conversationThreadId(scope, id)).rejects.toThrow('visitor session');
    const owner = await conversationThreadId({ ...scope, visitorSessionId: 'owner-browser' }, id);
    const attacker = await conversationThreadId({ ...scope, visitorSessionId: 'attacker-browser' }, id);
    expect(attacker).not.toBe(owner);
  });
});
