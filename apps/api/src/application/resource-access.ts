/** Account and resource-access policy for already verified credentials. */
export const MCP_READ_SCOPE = "videoq.read";
export const MCP_WRITE_SCOPE = "videoq.write";

export type ResourceAccessResult =
  | { kind: "ok"; userId: string; via: "apikey" | "oauth"; accessLevel: string }
  | { kind: "rate_limited"; message: string; retryAfterSec: number }
  | { kind: "invalid"; message: string; wwwAuthenticate?: string }
  | { kind: "forbidden"; message: string; requiredScope: string };

export function accountIsBanned(user: object, nowMs: number): boolean {
  if (!("banned" in user) || user.banned !== true) return false;
  const expires = "banExpires" in user ? user.banExpires : null;
  return !((expires instanceof Date || typeof expires === "string") &&
    new Date(expires).getTime() < nowMs);
}

export function defaultApiKeyPermissions(configId: string): { videoq: string[] } {
  return { videoq: configId === 'read-write' ? ['read', 'write'] : ['read'] };
}

/** The adapter verifies the credential and required read permission first.
 * Evaluate the SDK's optional write permission only for a current active user. */
export function apiKeyResourceAccess<User extends { id: string }>(
  user: User | null | undefined, canWrite: () => boolean, nowMs: number,
): ResourceAccessResult {
  if (!user || accountIsBanned(user, nowMs)) return { kind: 'invalid', message: 'User is inactive' };
  return { kind: 'ok', userId: user.id, via: 'apikey', accessLevel: canWrite() ? 'all' : 'read_only' };
}

/** Undefined means no scopes; null means a malformed RFC 6749 scope claim. */
export function parseResourceScopes(scope: unknown): string[] | null {
  if (scope === undefined) return [];
  if (typeof scope !== "string" || !scope ||
    scope.split(" ").some((value) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value))) return null;
  return scope.split(" ");
}

export function oauthResourceAccess(
  userId: string, user: object | null | undefined, scopes: readonly string[], nowMs: number,
): ResourceAccessResult {
  if (!user || accountIsBanned(user, nowMs)) return { kind: "invalid", message: "User is inactive" };
  if (!scopes.includes(MCP_READ_SCOPE)) return {
    kind: "forbidden", message: "OAuth token lacks videoq.read scope", requiredScope: MCP_READ_SCOPE,
  };
  return {
    kind: "ok", userId, via: "oauth",
    accessLevel: scopes.includes(MCP_WRITE_SCOPE) ? "all" : "read_only",
  };
}
