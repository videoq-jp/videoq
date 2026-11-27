import { authorizeLtiLaunch } from "./launch-service";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { verifyLearningIdToken } from '../../lib/learning-oidc';
import { launchLocale } from "./locale";
import { z } from "zod";
import type { LtiRegistration } from "./config";

export const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
export const loginRecord = z.object({
  registrationId: z.string(), nonce: z.string(), browserHash: z.string(), target: z.string(),
  deploymentHint: z.string().optional(),
  locale: z.enum(["ja", "en"]).optional(),
});
export const sessionRecord = z.object({
  transport: z.enum(["native", "classroom"]).optional(),
  moodleAuthor: z.object({ user_id: z.string(), username: z.string().max(255), email: z.string().max(320) }).optional(),
  registrationId: z.string(), registrationHash: z.string(), deploymentId: z.string(), contextId: z.string(), resourceLinkId: z.string(),
  locale: z.enum(["ja", "en"]).default("en"),
  scopeVideoIds: z.array(z.number().int().positive()).optional(),
  serviceSubject: z.string().min(1).max(255).optional(),
  accessProof: z.object({ token: z.string().max(2200), subject: z.string() }).optional(),
  courseId: z.number().int().positive(), videoId: z.number().int().positive().safe().optional(), resourceGeneration: z.number().int().positive().safe().optional(), subjectHash: z.string(), roles: z.array(z.string()),
});

// Bound cache size and reuse keys across launches; keys never come from JWT headers.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function platformKeys(url: string) {
  let keys = keySets.get(url);
  if (!keys) {
    if (keySets.size >= 100) keySets.delete(keySets.keys().next().value!);
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 });
    keySets.set(url, keys);
  }
  return keys;
}

export async function verifyLaunch(
  token: string, reg: LtiRegistration, login: z.infer<typeof loginRecord>,
  keys: JWTVerifyGetKey = platformKeys(reg.jwksUrl),
) {
  const payload = await verifyLearningIdToken(token, {
    jwks: keys, issuer: reg.issuer, audience: reg.clientId, algorithms: ["RS256"],
  }, login.nonce, 300, 5);
  // Signature, issuer, audience and token age are verified before projection.
  const identity = z.string().min(1);
  const subject = identity.parse(payload.sub);
  const deploymentId = identity.parse(payload[CLAIM + "deployment_id"]);
  const context = z.object({ id: identity }).parse(payload[CLAIM + "context"]);
  const resource = z.object({ id: identity }).parse(payload[CLAIM + "resource_link"]);
  const roles = z.array(z.string()).min(1).parse(payload[CLAIM + "roles"]);
  const accessToken = reg.courseAccess
    ? z.object({ videoq_access: z.string().regex(/^[a-f0-9]+\.[a-f0-9]{64}$/).max(2200) }).parse(payload[CLAIM + "custom"]).videoq_access
    : undefined;
  return authorizeLtiLaunch({
    subject, deploymentId, contextId: context.id, resourceLinkId: resource.id, roles,
    nonce: payload.nonce, authorizedParty: payload.azp, audience: payload.aud,
    messageType: payload[CLAIM + "message_type"], version: payload[CLAIM + "version"],
    target: payload[CLAIM + "target_link_uri"], locale: launchLocale(payload, login.locale), accessToken,
  }, {
    clientId: reg.clientId, resources: reg.resources,
    requiresAccessProof: Boolean(reg.courseAccess), serviceAuthority: Boolean(reg.materialsService),
  }, login);
}
