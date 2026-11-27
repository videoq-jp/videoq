import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createClassroomOAuthTransport } from '../src/features/classroom/oauth-transport';

const options = { clientId: 'classroom', clientSecret: 'synthetic-secret' };
const redirectURI = 'https://api.example/api/classroom/oauth/callback';
let jwks: object, rotatedJwks: object, token: string, rotatedToken: string;
beforeAll(async () => {
  const pairs = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
  [jwks, rotatedJwks] = await Promise.all(pairs.map(async (pair, index) => ({
    keys: [{ ...await exportJWK(pair.publicKey), kid: `google-${index}`, alg: 'RS256', use: 'sig' }],
  })));
  [token, rotatedToken] = await Promise.all(pairs.map((pair, index) => new SignJWT({ sub: 'learner' })
    .setProtectedHeader({ alg: 'RS256', kid: `google-${index}` }).sign(pair.privateKey)));
});
beforeEach(() => { vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-27T00:00:00Z')); });
afterEach(() => vi.useRealTimers());

describe('bounded Google OAuth transport', () => {
  it.each(['exchange', 'refresh'] as const)('aborts a stalled %s request after ten seconds', async kind => {
    let signal: AbortSignal | undefined;
    const transport = createClassroomOAuthTransport(vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const operation = kind === 'exchange' ? transport.exchange(options, 'code', 'verifier', redirectURI) : transport.refresh(options, 'refresh');
    const rejected = expect(operation).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it('aborts a stalled JWKS request after five seconds and retries successfully', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })).mockImplementation(async () => Response.json(jwks));
    const transport = createClassroomOAuthTransport(fetcher);
    const rejected = expect(transport.keys(token)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    await expect(jwtVerify(token, await transport.keys(token))).resolves.toMatchObject({ payload: { sub: 'learner' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the timeout active until the token response body finishes', async () => {
    let signal: AbortSignal | undefined;
    const transport = createClassroomOAuthTransport(vi.fn(async (_url, init) => {
      signal = init!.signal!;
      return new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    }));
    const rejected = expect(transport.exchange(options, 'code', 'verifier', redirectURI)).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it('uses Better Auth client authentication for both grants and refuses redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(init!.redirect).toBe('error');
      const params = new URLSearchParams(init!.body as URLSearchParams);
      expect(params.get('client_id')).toBe(options.clientId);
      expect(params.get('client_secret')).toBe(options.clientSecret);
      if (params.get('grant_type') === 'authorization_code') {
        expect(params.get('code_verifier')).toBe('verifier');
        expect(params.get('redirect_uri')).toBe(redirectURI);
      } else {
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe('refresh');
      }
      return Response.json({ access_token: 'access', expires_in: 3600 });
    });
    const transport = createClassroomOAuthTransport(fetcher);
    expect(await transport.exchange(options, 'code', 'verifier', redirectURI)).toMatchObject({ accessToken: 'access' });
    expect(await transport.refresh(options, 'refresh')).toMatchObject({ accessToken: 'access' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Google JWKS cache', () => {
  it('reuses keys for sequential authentication and refreshes after five minutes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(jwks));
    const transport = createClassroomOAuthTransport(fetcher);
    for (let i = 0; i < 2; i++) await jwtVerify(token, await transport.keys(token));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_001);
    await jwtVerify(token, await transport.keys(token));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shares a single in-flight key fetch between concurrent authentications', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(resolve => { finish = resolve; }));
    const transport = createClassroomOAuthTransport(fetcher);
    const requests = [transport.keys(token), transport.keys(token), transport.keys(token)];
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(Response.json(jwks));
    for (const keys of await Promise.all(requests)) await jwtVerify(token, keys);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refetches for a rotated kid and rate-limits repeated unknown kids', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => Response.json(jwks))
      .mockImplementation(async () => Response.json(rotatedJwks));
    const transport = createClassroomOAuthTransport(fetcher);
    await jwtVerify(token, await transport.keys(token));
    await jwtVerify(rotatedToken, await transport.keys(rotatedToken));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(jwtVerify(token, await transport.keys(token))).rejects.toThrow();
    await expect(jwtVerify(token, await transport.keys(token))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not cache an invalid JWKS response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => Response.json({ keys: 'invalid' }))
      .mockImplementation(async () => Response.json(jwks));
    const transport = createClassroomOAuthTransport(fetcher);
    await expect(transport.keys(token)).rejects.toThrow();
    await jwtVerify(token, await transport.keys(token));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
