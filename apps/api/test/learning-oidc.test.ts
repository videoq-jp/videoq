import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { verifyLearningIdToken } from '../src/lib/learning-oidc';

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let other: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
const now = 1_800_000_000;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  other = await generateKeyPair('RS256');
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'learning', alg: 'RS256' }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each([{ name: 'LTI', age: 300, skew: 5 }, { name: 'Classroom', age: 600, skew: 0 }])('$name Better Auth identity verification', ({ age, skew }) => {
  async function token(overrides: JWTPayload = {}, omitted?: string, wrongSignature = false) {
    const claims: JWTPayload = { iss: 'https://issuer.example', aud: 'learning-client', sub: 'learner',
      nonce: 'expected-nonce', iat: now, exp: now + 60, ...overrides };
    if (omitted) delete claims[omitted];
    return new SignJWT(claims).setProtectedHeader({ kid: 'learning', alg: 'RS256' })
      .sign(wrongSignature ? other.privateKey : pair.privateKey);
  }
  async function verify(jwt: string, nonce = 'expected-nonce') {
    vi.useFakeTimers();vi.setSystemTime(now * 1000);
    return verifyLearningIdToken(jwt, { jwks: keys, issuer: 'https://issuer.example',
      audience: 'learning-client', algorithms: ['RS256'] }, nonce, age, skew);
  }
  it('accepts a signed identity only for the configured issuer, client and nonce', async () => {
    expect(await verify(await token())).toMatchObject({ sub: 'learner' });
  });
  it.each(['iss', 'aud', 'sub', 'exp', 'iat', 'nonce'])('rejects missing %s', async claim => {
    await expect(verify(await token({}, claim))).rejects.toThrow();
  });
  it('rejects forgery, wrong issuer/client/nonce and an unsigned token', async () => {
    for (const jwt of [await token({}, undefined, true), await token({ iss: 'https://attacker.example' }),
      await token({ aud: 'another-client' }), await token({ nonce: 'another-nonce' }),
      `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa('{}')}.`]) {
      await expect(verify(jwt)).rejects.toThrow();
    }
    await expect(verify(await token(), '')).rejects.toThrow();
  });
  it('preserves the stricter launch expiry, maximum age and future-time limits', async () => {
    for (const claims of [{ exp: now - skew - 1 }, { iat: now + skew + 1 },
      { iat: now - age - skew - 1 }, { nbf: now + skew + 1 }]) {
      await expect(verify(await token(claims))).rejects.toThrow();
    }
  });
  it('preserves provider-specific claim restrictions', async () => {
    vi.useFakeTimers();vi.setSystemTime(now * 1000);
    await expect(verifyLearningIdToken(await token(), { jwks: keys, issuer: 'https://issuer.example',
      audience: 'learning-client', algorithms: ['RS256'], verifyClaims: () => false },
    'expected-nonce', age, skew)).rejects.toThrow();
  });
});
