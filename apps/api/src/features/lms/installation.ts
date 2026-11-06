import { z } from "zod";

const identifier = z.string().trim().min(1).max(255);
const httpsUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search;
}, "An HTTPS URL without credentials, query or fragment is required");

/** Only the operator provisions installations; Moodle cannot select a quota owner. */
export const provisionInstallationSchema = z.object({
  id: identifier,
  ownerUserId: identifier,
  name: z.string().trim().min(1).max(255),
  issuer: httpsUrl,
  clientId: identifier,
  deploymentId: identifier,
  authorizationUrl: httpsUrl,
  jwksUrl: httpsUrl,
}).strict().superRefine((value, ctx) => {
  const issuerOrigin = new URL(value.issuer).origin;
  for (const key of ["authorizationUrl", "jwksUrl"] as const) {
    if (new URL(value[key]).origin !== issuerOrigin) {
      ctx.addIssue({ code: "custom", path: [key], message: "Moodle endpoints must belong to the issuer origin" });
    }
  }
});

export type ProvisionInstallation = z.infer<typeof provisionInstallationSchema>;

export function newSyncToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("");
}

/** Invalid tokens are rejected before making a database connection. */
export async function syncTokenHash(token: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
