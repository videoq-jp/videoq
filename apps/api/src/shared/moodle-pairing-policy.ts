import {z} from 'zod';
import {materialsServiceSchema} from '../features/lms/contracts';
import {LmsSyncError} from '../features/lms/resource';
export const moodleUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "An HTTPS Moodle URL is required").transform(value => value.replace(/\/+$/, ""));
const codeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const pairingRequestSchema = z.object({ moodleUrl: moodleUrlSchema, codeChallenge: codeChallengeSchema.optional() }).strict();
export async function pairingCodeChallenge(verifier: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function requireProof(challenge: unknown, verifier?: string): Promise<void> {
  if (challenge === undefined ? verifier !== undefined : typeof challenge !== "string" || !verifier || await pairingCodeChallenge(verifier) !== challenge) {
    throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
  }
}
export const pairingExchangeSchema = z.object({
  secret: z.string().regex(/^[a-f0-9]{64}$/), issuer: moodleUrlSchema,
  clientId: z.string().trim().min(1).max(255), deploymentId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  syncToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mode: z.enum(["legacy", "materials"]).default("legacy"),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(),
  materialsService: materialsServiceSchema.optional(),
}).strict().refine(value => value.mode === "materials" ? value.syncToken === undefined && Boolean(value.materialsService) && Object.values(value.materialsService!).every(endpoint => endpoint.startsWith(value.issuer + "/") && new URL(endpoint).origin === new URL(value.issuer).origin) : Boolean(value.syncToken) && value.materialsService === undefined, "Invalid connection authentication mode");
export const pairingPayloadSchema = z.object({ ownerUserId: z.string().min(1), moodleUrl: moodleUrlSchema, mode: z.enum(["legacy", "materials"]).default("legacy"), codeChallenge: codeChallengeSchema.optional() });
export const PAIRING_SECONDS = 600;

