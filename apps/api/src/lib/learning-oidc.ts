import { verifyProviderIdToken } from 'better-auth/oauth2';
import { decodeJwt } from 'jose';
import type { OAuthProvider } from 'better-auth/oauth2';

type IdTokenConfig = Extract<NonNullable<OAuthProvider['idToken']>, { jwks: unknown }>;

/** Better Auth verifies identity; callers still authorize the learning resource. */
export async function verifyLearningIdToken(token: string, config: IdTokenConfig, nonce: string,
  maxAgeSeconds: number, clockTolerance: number) {
  if (!nonce) throw new Error('An expected ID-token nonce is required');
  const verified = await verifyProviderIdToken({
    id: 'videoq-learning', options: {},
    idToken: {
      ...config,
      maxTokenAge: `${maxAgeSeconds}s`,
      // Better Auth allows 30 seconds of clock skew. Preserve the stricter
      // learning launch windows instead of widening them during migration.
      verifyClaims: claims => {
        const now = Math.floor(Date.now() / 1000);
        return typeof claims.exp === 'number' && claims.exp > now - clockTolerance
          && typeof claims.iat === 'number' && claims.iat <= now + clockTolerance
          && now - claims.iat <= maxAgeSeconds + clockTolerance
          && (claims.nbf === undefined || typeof claims.nbf === 'number' && claims.nbf <= now + clockTolerance)
          && (!config.verifyClaims || config.verifyClaims(claims));
      },
    },
  }, token, nonce);
  if (!verified) throw new Error('Learning ID token could not be verified');
  // Decode only after Better Auth has verified the signature and OIDC claims.
  return decodeJwt(token);
}
