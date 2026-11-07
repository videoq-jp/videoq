import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { launchLocale } from "./locale";
import { z } from "zod";
import type { LtiRegistration } from "./config";

export const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const rolePrefix = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
const allowedRoles = new Set(["Learner", "Instructor", "Administrator", "ContentDeveloper", "Mentor"].map(role => rolePrefix + role));
export const loginRecord = z.object({
  registrationId: z.string(), nonce: z.string(), browserHash: z.string(), target: z.string(),
  deploymentHint: z.string().optional(),
  locale: z.enum(["ja", "en"]).optional(),
});
export const sessionRecord = z.object({
  transport: z.literal("native").optional(),
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
  const { payload } = await jwtVerify(token, keys, {
    issuer: reg.issuer, audience: reg.clientId, algorithms: ["RS256"],
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
    maxTokenAge: "5m", clockTolerance: 5,
  });
  const subject = z.string().min(1).parse(payload.sub);
  if (payload.nonce !== login.nonce
    || (payload.azp !== undefined && payload.azp !== reg.clientId)
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== reg.clientId)
    || payload[CLAIM + "message_type"] !== "LtiResourceLinkRequest"
    || payload[CLAIM + "version"] !== "1.3.0"
    || payload[CLAIM + "target_link_uri"] !== login.target) throw new Error("Invalid LTI launch");
  const deploymentId = z.string().min(1).parse(payload[CLAIM + "deployment_id"]);
  const context = z.object({ id: z.string().min(1) }).parse(payload[CLAIM + "context"]);
  const resource = z.object({ id: z.string().min(1) }).parse(payload[CLAIM + "resource_link"]);
  const roles = z.array(z.string()).min(1).parse(payload[CLAIM + "roles"]);
  if (!roles.some(role => allowedRoles.has(role)) || (login.deploymentHint && login.deploymentHint !== deploymentId)) {
    throw new Error("LTI access is not allowed");
  }
  const binding = reg.resources.find(item => item.deploymentId === deploymentId
    && item.contextId === context.id && item.resourceLinkId === resource.id);
  if (!binding) throw new Error("LTI resource is not configured");
  const accessProof = reg.courseAccess ? { token: z.object({ videoq_access: z.string().regex(/^[a-f0-9]+\.[a-f0-9]{64}$/).max(2200) }).parse(payload[CLAIM + "custom"]).videoq_access, subject } : undefined;
  return { locale: launchLocale(payload, login.locale), subject, deploymentId, contextId: context.id, resourceLinkId: resource.id, roles, courseId: binding.courseId, ...(reg.materialsService ? { serviceSubject: subject } : {}), ...(accessProof ? { accessProof } : {}), ...(binding.videoId ? { videoId: binding.videoId } : {}), ...(binding.generation ? { resourceGeneration: binding.generation } : {}) };
}
