import { getCookies } from "better-auth/cookies";
import { getSignedCookie } from "hono/cookie";
import { createUploadSessionRepository } from "../persistence/factory";
import { isBanned } from "../lib/auth-security";
import type { AuthMethod } from "./auth";
import { sessionMethod } from "./auth";

/** Read-only authorization for repeated upload control requests.
 * Verify Better Auth's signed session cookie, then check the authoritative
 * session and user on every call. Never cache authorization or DB clients.
 * Login, refresh and logout continue through Better Auth's native endpoints.
 */
export const uploadSessionMethod: AuthMethod = async c => {
  // Keep the existing local-only test authentication gate in one place.
  if (c.env.ENVIRONMENT !== "production") return sessionMethod(c);
  const name = getCookies({ advanced: { useSecureCookies: true } }).sessionToken.name;
  if (!c.req.header("cookie")) return { kind: "absent" };
  const secret = c.env.BETTER_AUTH_SECRET?.trim() || c.env.AUTH_JWT_SECRET?.trim();
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  // Hono and Better Auth both verify HMAC-SHA256 signed cookies with Web Crypto.
  const token = await getSignedCookie(c, secret, name);
  if (!token) return { kind: "invalid", message: "Invalid session" };
  const repository = await createUploadSessionRepository(c.env);
  const user = await repository.findUnexpiredUser(token);
  if (!user || isBanned(user)) return { kind: "invalid", message: "Invalid session" };
  return { kind: "ok", userId: user.id, via: "session" };
};

const uploadProcedures = new Set([
  "videos.uploadPartUrl", "videos.completeMultipartUpload", "videos.abortUpload",
]);
export function isUploadControlRequest(path: string): boolean {
  const prefix = "/api/trpc/";
  return path.startsWith(prefix) && path.slice(prefix.length).split(",").every(p => uploadProcedures.has(p));
}
