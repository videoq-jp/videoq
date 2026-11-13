import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Bindings } from '../../types/bindings';
import { encryptServerSecret, decryptServerSecret } from '../../lib/secret-encryption';
import { digest, putCredential, readCredential, randomSecret, replaceCredentialPayload } from '../lti/store';
import type { ClassroomConfig } from './config';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000 });
export const accountSchema = z.object({ subject: z.string(), name: z.string().max(512).optional(), email: z.email().max(512).optional(), clientId: z.string(),
  accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number(),
});
export type ClassroomAccount = z.infer<typeof accountSchema>;
const tokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(),
  expires_in: z.number().positive().max(86400), id_token: z.string().optional(),
});
export async function tokenRequest(env: Bindings, params: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ ...params, client_id: env.CLASSROOM_CLIENT_ID!, client_secret: env.CLASSROOM_CLIENT_SECRET! }),
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Google authorization failed; sign in again');
  return tokensSchema.parse(await response.json());
}
export function callbackUri(config: ClassroomConfig) { return config.toolOrigin + '/api/classroom/oauth/callback'; }
export async function exchangeCode(env: Bindings, config: ClassroomConfig, code: string, verifier: string, nonce: string, hint?: string) {
  const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code,
    redirect_uri: callbackUri(config), code_verifier: verifier });
  if (!tokens.id_token) throw new Error('Missing Google identity');
  const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.CLASSROOM_CLIENT_ID, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], maxTokenAge: '10m' });
  if (payload.nonce !== nonce || !payload.sub || (hint && hint !== payload.sub)
    || (payload.azp !== undefined && payload.azp !== env.CLASSROOM_CLIENT_ID)) throw new Error('Google account mismatch');
  return accountSchema.parse({ subject: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : undefined, clientId: env.CLASSROOM_CLIENT_ID,
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
}
export async function saveAccount(env: Bindings, account: ClassroomAccount): Promise<string> {
  const token = randomSecret(), id = await digest(token);
  await putCredential(env, id, 'classroom-account', {
    envelope: await encryptServerSecret(env, JSON.stringify(account), `classroom-account:${id}`),
  }, account.refreshToken ? 30 * 86400 : Math.max(1, Math.floor((account.expiresAt - Date.now()) / 1000)));
  return token;
}
export async function readAccount(env: Bindings, token: string) {
  const id = await digest(token);
  const stored = z.object({ envelope: z.string() }).parse(await readCredential(env, id, 'classroom-account'));
  let account = accountSchema.parse(JSON.parse(await decryptServerSecret(env, stored.envelope, `classroom-account:${id}`)));
  if (account.clientId !== env.CLASSROOM_CLIENT_ID) throw new Error('Classroom account was revoked');
  if (account.expiresAt < Date.now() + 60_000) {
    if (!account.refreshToken) throw new Error('Sign in to Google again');
    const fresh = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    // Updating only a live record preserves the original retention and cannot revive a disconnected account.
    account = { ...account, accessToken: fresh.access_token, refreshToken: fresh.refresh_token ?? account.refreshToken, expiresAt: Date.now() + fresh.expires_in * 1000 };
    if (!await replaceCredentialPayload(env, id, 'classroom-account', {
      envelope: await encryptServerSecret(env, JSON.stringify(account), `classroom-account:${id}`),
    })) throw new Error('Classroom account was disconnected');
  }
  return account;
}
export async function pkceChallenge(verifier: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
