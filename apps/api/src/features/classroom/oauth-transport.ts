import { authorizationCodeRequest, refreshAccessTokenRequest, getOAuth2Tokens, getJwks,
  type ProviderOptions } from 'better-auth/oauth2';
import { createLocalJWKSet } from 'jose';
import { z } from 'zod';

const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const keysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const jsonObject = z.record(z.string(), z.unknown());
const keySet = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) });

/** Only transport policy lives here; OAuth requests and JWKS caching use Better Auth. */
export function createClassroomOAuthTransport(fetcher: typeof fetch = (...args) => fetch(...args)) {
  const cacheKey = {};
  async function requestJson(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Google OAuth endpoint failed');
      }
      // Keep the deadline active while reading the response body as well.
      return jsonObject.parse(await response.json());
    } finally { clearTimeout(timer); }
  }
  async function fetchKeys() {
    const keys = keySet.parse(await requestJson(keysEndpoint, { headers: { Accept: 'application/json' } }, 5000));
    createLocalJWKSet(keys); // Invalid responses must not enter the shared cache.
    return keys;
  }
  return {
    async exchange(options: ProviderOptions, code: string, codeVerifier: string, redirectURI: string) {
      const request = await authorizationCodeRequest({ options, code, codeVerifier, redirectURI, tokenEndpoint });
      return getOAuth2Tokens(await requestJson(tokenEndpoint, { method: 'POST', ...request }, 10_000));
    },
    async refresh(options: ProviderOptions, refreshToken: string) {
      const request = await refreshAccessTokenRequest({ options, refreshToken, tokenEndpoint });
      return getOAuth2Tokens(await requestJson(tokenEndpoint, { method: 'POST', ...request }, 10_000));
    },
    async keys(token: string) {
      // Better Auth shares in-flight loads, expires keys after five minutes,
      // and refetches on an unknown kid with a cooldown against fetch storms.
      return createLocalJWKSet(await getJwks(token, { jwksFetch: fetchKeys, jwksCacheKey: cacheKey }));
    },
  };
}

export const classroomOAuthTransport = createClassroomOAuthTransport();
