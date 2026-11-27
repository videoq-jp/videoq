import { google } from 'better-auth/social-providers';
import { createAuthorizationURL, type OAuth2Tokens } from 'better-auth/oauth2';
import { z } from 'zod';
import type { Bindings } from '../../types/bindings';
import { encryptServerSecret, decryptServerSecret } from '../../lib/secret-encryption';
import { digest, putCredential, readCredential, randomSecret, replaceCredentialPayload } from '../lti/store';
import type { ClassroomConfig } from './config';
import { verifyLearningIdToken } from '../../lib/learning-oidc';
import { classroomOAuthTransport } from './oauth-transport';

function provider(env: Bindings) {
  if (!env.CLASSROOM_CLIENT_ID || !env.CLASSROOM_CLIENT_SECRET) throw new Error('Classroom OAuth credentials are required');
  return google({ clientId: env.CLASSROOM_CLIENT_ID, clientSecret: env.CLASSROOM_CLIENT_SECRET });
}
export const accountSchema = z.object({ subject: z.string(), name: z.string().max(512).optional(), email: z.email().max(512).optional(), clientId: z.string(),
  accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number(),
});
export type ClassroomAccount = z.infer<typeof accountSchema>;
const tokensSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().optional(),
  accessTokenExpiresAt: z.date(), idToken: z.string().optional(),
});
function validatedTokens(tokens: OAuth2Tokens | null) {
  const parsed = tokensSchema.parse(tokens);
  const lifetime = parsed.accessTokenExpiresAt.getTime() - Date.now();
  if (lifetime <= 0 || lifetime > 86400_000) throw new Error('Invalid Google token expiry');
  return parsed;
}
export function callbackUri(config: ClassroomConfig) { return config.toolOrigin + '/api/classroom/oauth/callback'; }
export async function classroomAuthorizationURL(env: Bindings, config: ClassroomConfig, input: {
  state: string; verifier: string; nonce: string; teacher: boolean; loginHint?: string;
}) {
  // Use the shared builder directly: Google's provider builder does not forward
  // idTokenNonce in the installed version. nonce must remain bound to our popup.
  return createAuthorizationURL({
    id: 'google', options: provider(env).options,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    redirectURI: callbackUri(config), state: input.state, codeVerifier: input.verifier, nonce: input.nonce,
    scopes: ['openid', 'email', 'profile', `https://www.googleapis.com/auth/classroom.addons.${input.teacher ? 'teacher' : 'student'}`],
    accessType: 'offline', prompt: input.loginHint ? 'consent' : 'select_account consent', loginHint: input.loginHint,
    additionalParams: { include_granted_scopes: 'true' },
  });
}
export async function exchangeCode(env: Bindings, config: ClassroomConfig, code: string, verifier: string, nonce: string, hint?: string) {
  const googleProvider = provider(env);
  let tokens: z.infer<typeof tokensSchema>;
  try {
    tokens = validatedTokens(await classroomOAuthTransport.exchange(googleProvider.options, code, verifier, callbackUri(config)));
  } catch { throw new Error('Google authorization failed; sign in again'); }
  if (!tokens.idToken) throw new Error('Missing Google identity');
  const payload = await verifyLearningIdToken(tokens.idToken, {
    ...googleProvider.idToken, jwks: await classroomOAuthTransport.keys(tokens.idToken),
  }, nonce, 600, 0);
  if (payload.nonce !== nonce || !payload.sub || (hint && hint !== payload.sub)
    || (payload.azp !== undefined && payload.azp !== env.CLASSROOM_CLIENT_ID)) throw new Error('Google account mismatch');
  return accountSchema.parse({ subject: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : undefined, clientId: env.CLASSROOM_CLIENT_ID,
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.accessTokenExpiresAt.getTime() });
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
    let fresh: z.infer<typeof tokensSchema>;
    try { fresh = validatedTokens(await classroomOAuthTransport.refresh(provider(env).options, account.refreshToken)); }
    catch { throw new Error('Google authorization failed; sign in again'); }
    // Updating only a live record preserves the original retention and cannot revive a disconnected account.
    account = { ...account, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? account.refreshToken, expiresAt: fresh.accessTokenExpiresAt.getTime() };
    if (!await replaceCredentialPayload(env, id, 'classroom-account', {
      envelope: await encryptServerSecret(env, JSON.stringify(account), `classroom-account:${id}`),
    })) throw new Error('Classroom account was disconnected');
  }
  return account;
}
