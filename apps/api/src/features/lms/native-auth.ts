import { nativeLearningService } from "../../integrations/native-learning";
import { asApiError } from "../../shared/errors";
import type { LearningAuthorization } from "../lti/session-authorization";
import { hasCourseAuthority } from './authority';
import { lmsIdentity } from './contracts';
import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Bindings } from "../../types/bindings";
import { ApiError } from "../../shared/errors";
import { resolvedLtiConfig } from "../lti/registrations";
import { platformKeys } from "../lti/protocol";

const text = lmsIdentity;
export const nativeAssertionClaims = z.object({
  iss: z.string().min(1).max(2048), sub: text, aud: z.string().min(1).max(2300),
  deploymentId: text, subject: text, contextId: text, resourceLinkId: text,
  author: z.object({ name: z.string().trim().min(1).max(255), email: z.string().max(320) }).strict().optional(),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/),
  sessionStartedAt: z.number().int().positive().safe(),
  sessionExpiresAt: z.number().int().positive().safe(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  accessProof: z.string().regex(/^[a-f0-9]+\.[a-f0-9]{64}$/).max(2200).optional(),
  locale: z.enum(["en", "ja"]), version: z.literal(1),
  iat: z.number().int().positive().safe(), exp: z.number().int().positive().safe(), jti: z.uuid(),
}).strict().refine(c => c.exp > c.iat && c.exp - c.iat <= 60 &&
  c.sessionStartedAt <= c.iat && c.exp <= c.sessionExpiresAt &&
  c.sessionExpiresAt - c.sessionStartedAt <= 3600);

const denied = () => new ApiError(403, "FORBIDDEN", "The LMS learning request is unavailable.");

/** Verify a purpose-, endpoint- and body-bound assertion from an approved LMS.
 * No roles, capabilities, VideoQ owner or VideoQ course ID come from the caller.
 * The caller must bound the body before computing its SHA256.
 */
export async function verifyNativeAssertion(env: Bindings, assertion: string, operation: string,
  bodySha256: string, keys?: JWTVerifyGetKey) {
  if (assertion.length > 16384) throw denied();
  let hint: z.infer<typeof nativeAssertionClaims>;
  try { hint = nativeAssertionClaims.parse(decodeJwt(assertion)); } catch { throw denied(); }
  const config = await resolvedLtiConfig(env, { issuer: hint.iss, clientId: hint.sub });
  if (!config) throw denied();
  const candidates = config.registrations.filter(r => r.issuer === hint.iss && r.clientId === hint.sub &&
    (r.deploymentId === hint.deploymentId || r.resources.some(b => b.deploymentId === hint.deploymentId)));
  if (candidates.length !== 1) throw denied();
  const reg = candidates[0];
  if (!hasCourseAuthority(reg)) throw denied();
  const audience = config.toolOrigin + "/api/lms/native" + operation;
  let claims: z.infer<typeof nativeAssertionClaims>;
  try {
    const verified = await jwtVerify(assertion, keys ?? platformKeys(reg.jwksUrl), {
      issuer: reg.issuer, audience, algorithms: ["RS256"], typ: "videoq-native+jwt",
      requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"], maxTokenAge: "1m", clockTolerance: 5,
    });
    claims = nativeAssertionClaims.parse(verified.payload);
    if (claims.sub !== reg.clientId || claims.aud !== audience || claims.bodySha256 !== bodySha256) throw denied();
  } catch { throw denied(); }
  return { reg, claims };
}

export async function authorizeNativeRequest(env: Bindings, assertion: string, operation: string,
  bodySha256: string): Promise<LearningAuthorization> {
  const { reg, claims } = await verifyNativeAssertion(env, assertion, operation, bodySha256);
  try { return await nativeLearningService(env)(reg, claims); }
  catch (error) { throw asApiError(error) ?? error; }
}
