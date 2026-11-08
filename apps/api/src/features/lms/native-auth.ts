import { hasCourseAuthority } from './authority';
import { lmsIdentity } from './contracts';
import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Bindings } from "../../types/bindings";
import { ApiError } from "../../shared/errors";
import { getCourseWithMembers } from "../../repositories/chat-repository";
import { resolvedLtiConfig } from "../lti/registrations";
import { platformKeys } from "../lti/protocol";
import { courseAccessContext } from "../lti/course-access";
import { digest } from "../lti/store";
import { registrationFingerprint, type LearningAuthorization } from "../lti/session-authorization";
import { ensureNativeSession } from "./native-session";

const text = lmsIdentity;
export const nativeAssertionClaims = z.object({
  iss: z.string().min(1).max(2048), sub: text, aud: z.string().min(1).max(2300),
  deploymentId: text, subject: text, contextId: text, resourceLinkId: text,
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
  const config = await resolvedLtiConfig(env);
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
  const binding = reg.resources.find(b => b.deploymentId === claims.deploymentId &&
    b.contextId === claims.contextId && b.resourceLinkId === claims.resourceLinkId);
  if (!binding || (!reg.materialsService && !claims.accessProof)) throw denied();
  const subjectHash = await digest(JSON.stringify([reg.issuer, reg.clientId, claims.deploymentId, claims.subject]));
  const grant: LearningAuthorization["grant"] = {
    transport: "native", registrationId: reg.id, registrationHash: await registrationFingerprint(reg),
    deploymentId: claims.deploymentId, contextId: claims.contextId, resourceLinkId: claims.resourceLinkId,
    courseId: binding.courseId, subjectHash, roles: [], locale: claims.locale,
    ...(binding.videoId !== undefined ? { videoId: binding.videoId } : {}),
    ...(binding.generation !== undefined ? { resourceGeneration: binding.generation } : {}),
    ...(reg.materialsService ? { serviceSubject: claims.subject } :
      { accessProof: { token: claims.accessProof!, subject: claims.subject } }),
  };
  let current;
  try { current = await courseAccessContext(reg, grant, env); } catch { throw denied(); }
  if (!current) throw denied();
  const course = await getCourseWithMembers(env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId,
    ltiVideoGrant: [...current.videos, ...(current.managementVideos ?? [])].map(v => v.videoId) });
  if (!course) throw denied();
  grant.scopeVideoIds = current.videos.map(v => v.videoId).sort((a, b) => a - b);
  const sessionHash = await digest(JSON.stringify(["moodle-native-session-v1", reg.id, subjectHash,
    claims.contextId, claims.resourceLinkId, claims.sessionId]));
  await ensureNativeSession(env, {
    ownerUserId: course.userId, grant, sessionHash,
    markerHash: await digest(JSON.stringify(["moodle-native-session-started-v1", sessionHash])),
    nonceHash: await digest(JSON.stringify(["moodle-native-request-v1", reg.id, claims.jti])),
    nonceExpiresAt: new Date((claims.exp + 60) * 1000), expiresAt: new Date(claims.sessionExpiresAt * 1000),
  });
  return { grant, reg, sessionHash, current, course };
}
