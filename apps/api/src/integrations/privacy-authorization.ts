import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { authorizePrivacyRequest } from '../features/lms/privacy-authorization-service';
import { createPrivacyAuthorizationRepository } from '../persistence/factory';
import { privacyRequest } from '../shared/privacy';
import { asApiError } from '../shared/errors';
import { ltiConfig } from '../features/lti/config';
import { platformKeys } from '../features/lti/protocol';
import { digest } from '../features/lti/store';
import type { Bindings } from '../types/bindings';

const claims=z.object({iss:z.string().min(1).max(2048),sub:z.string().min(1).max(255),aud:z.string().min(1).max(2200),
  deploymentId:z.string().min(1).max(255),iat:z.number().int(),exp:z.number().int(),jti:z.uuid(),
  version:z.literal(1),request:privacyRequest,
}).strict().refine(value=>value.exp>value.iat&&value.exp-value.iat<=120);
export async function verifyPrivacyAssertion(env: Bindings, assertion: string, keys?: JWTVerifyGetKey) {
  const config = ltiConfig(env);
  try {
    return await authorizePrivacyRequest({
      enabled: Boolean(config?.databaseRegistrations && config.privacyEnabled === true),
      toolOrigin: config?.toolOrigin ?? '',
      hint: token => claims.parse(decodeJwt(token)),
      verify: async (token, installation) => {
        const result = await jwtVerify(token, keys ?? platformKeys(installation.jwksUrl), {
          issuer: installation.issuer, audience: config!.toolOrigin + '/api/lms/privacy', algorithms: ['RS256'], typ: 'videoq-privacy+jwt',
          requiredClaims: ['iat', 'exp', 'jti', 'sub'], clockTolerance: 5, maxTokenAge: '2m',
        });
        return claims.parse(result.payload);
      },
      repository: () => createPrivacyAuthorizationRepository(env), digest,
    }, assertion);
  } catch (error) { throw asApiError(error) ?? error; }
}
