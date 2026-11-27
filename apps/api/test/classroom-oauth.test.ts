import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Bindings } from '../src/types/bindings';
import { exchangeCode, classroomAuthorizationURL } from '../src/features/classroom/oauth';
let jwks: object;
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');privateKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'google', alg: 'RS256', use: 'sig' }] };
});
afterEach(() => vi.restoreAllMocks());
const env = { CLASSROOM_CLIENT_ID: 'classroom', CLASSROOM_CLIENT_SECRET: 'secret' } as Bindings;
const config = { toolOrigin: 'https://api.example', courses: [] };
function requestUrl(input: string | URL | Request) {
  return input instanceof Request ? input.url : input.toString();
}
async function googleToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer('https://accounts.google.com').setAudience('classroom').setSubject('subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
it('verifies the Google signature, audience, nonce and login hint before accepting identity', async () => {
  const idToken = await googleToken();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (requestUrl(url) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(jwks);
    expect(requestUrl(url)).toBe('https://oauth2.googleapis.com/token');
    const body = init!.body;
    if (typeof body !== 'string' && !(body instanceof URLSearchParams)) throw new Error('Expected form body');
    const params = new URLSearchParams(body);
    expect(params.get('code_verifier')).toBe('verifier');expect(params.get('redirect_uri')).toBe('https://api.example/api/classroom/oauth/callback');
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: idToken });
  });
  expect(await exchangeCode(env, config, 'code', 'verifier', 'nonce', 'subject')).toMatchObject({ subject: 'subject', accessToken: 'access', refreshToken: 'refresh' });
  await expect(exchangeCode(env, config, 'code', 'verifier', 'wrong')).rejects.toThrow();
  await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce', 'different')).rejects.toThrow();
  await expect(exchangeCode({ ...env, CLASSROOM_CLIENT_ID: 'another' }, config, 'code', 'verifier', 'nonce')).rejects.toThrow();
  expect(fetch.mock.calls.filter(([url]) => requestUrl(url).endsWith('/certs'))).toHaveLength(1);
});
it('rejects an untrusted issuer, missing ID token, bad azp, and token endpoint failure', async () => {
  const badIssuer = await new SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer('https://evil.example').setAudience('classroom').setSubject('subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const token of [badIssuer, await googleToken({ azp: 'different' }), undefined]) {
    fetch.mockImplementation(async url => Response.json(requestUrl(url).endsWith('/certs') ? jwks : { access_token: 'access', expires_in: 3600, id_token: token }));
    await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce')).rejects.toThrow();
  }
  fetch.mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce')).rejects.toThrow('Google authorization failed');
});
it('uses the RFC 7636 SHA-256 challenge', async () => {
  const url = await classroomAuthorizationURL(env, config, { state: 'state', nonce: 'nonce', teacher: true, verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' });
  expect(url.searchParams.get('nonce')).toBe('nonce');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  expect(url.searchParams.get('scope')).toContain('classroom.addons.teacher');
});

it('retains only signed profile claims and verified email for owner attribution', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const verified of [true, false]) {
    const idToken = await googleToken({ name: '生徒 A', email: 'student@school.example', email_verified: verified });
    fetch.mockImplementation(async url => Response.json(requestUrl(url).endsWith('/certs') ? jwks : { access_token: 'access', expires_in: 3600, id_token: idToken }));
    const account = await exchangeCode(env, config, 'code', 'verifier', 'nonce');
    expect(account.name).toBe('生徒 A');
    expect(account.email).toBe(verified ? 'student@school.example' : undefined);
  }
});
