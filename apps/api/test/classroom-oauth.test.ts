import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Bindings } from '../src/types/bindings';
import { exchangeCode, pkceChallenge } from '../src/features/classroom/oauth';
const localKeys = vi.hoisted(() => ({ value: null as ReturnType<typeof createLocalJWKSet> | null }));
vi.mock('jose', async original => ({ ...await original<typeof import('jose')>(), createRemoteJWKSet: () => (...args: Parameters<ReturnType<typeof createLocalJWKSet>>) => localKeys.value!(...args) }));
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');privateKey = pair.privateKey;
  localKeys.value = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'google' }] });
});
afterEach(() => vi.restoreAllMocks());
const env = { CLASSROOM_CLIENT_ID: 'classroom', CLASSROOM_CLIENT_SECRET: 'secret' } as Bindings;
const config = { toolOrigin: 'https://api.example', courses: [] };
async function googleToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer('https://accounts.google.com').setAudience('classroom').setSubject('subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
it('verifies the Google signature, audience, nonce and login hint before accepting identity', async () => {
  const idToken = await googleToken();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const params = init!.body as URLSearchParams;
    expect(params.get('code_verifier')).toBe('verifier');expect(params.get('redirect_uri')).toBe('https://api.example/api/classroom/oauth/callback');
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: idToken });
  });
  expect(await exchangeCode(env, config, 'code', 'verifier', 'nonce', 'subject')).toMatchObject({ subject: 'subject', accessToken: 'access', refreshToken: 'refresh' });
  await expect(exchangeCode(env, config, 'code', 'verifier', 'wrong')).rejects.toThrow();
  await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce', 'different')).rejects.toThrow();
  await expect(exchangeCode({ ...env, CLASSROOM_CLIENT_ID: 'another' }, config, 'code', 'verifier', 'nonce')).rejects.toThrow();
});
it('rejects an untrusted issuer, missing ID token, bad azp, and token endpoint failure', async () => {
  const badIssuer = await new SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer('https://evil.example').setAudience('classroom').setSubject('subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const token of [badIssuer, await googleToken({ azp: 'different' }), undefined]) {
    fetch.mockResolvedValue(Response.json({ access_token: 'access', expires_in: 3600, id_token: token }));
    await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce')).rejects.toThrow();
  }
  fetch.mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await expect(exchangeCode(env, config, 'code', 'verifier', 'nonce')).rejects.toThrow('Google authorization failed');
});
it('uses the RFC 7636 SHA-256 challenge', async () => {
  expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

it('retains only signed profile claims and verified email for owner attribution', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const verified of [true, false]) {
    fetch.mockResolvedValue(Response.json({ access_token: 'access', expires_in: 3600,
      id_token: await googleToken({ name: '生徒 A', email: 'student@school.example', email_verified: verified }) }));
    const account = await exchangeCode(env, config, 'code', 'verifier', 'nonce');
    expect(account.name).toBe('生徒 A');
    expect(account.email).toBe(verified ? 'student@school.example' : undefined);
  }
});
