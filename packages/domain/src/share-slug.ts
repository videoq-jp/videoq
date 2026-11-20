/**
 * VideoQ の共有スラッグを正規化・検証する。
 * strip + lower → 空/長さ(3-64)/`--`/パターン/予約語 を検査。
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  "about",
  "admin",
  "api",
  "help",
  "login",
  "settings",
  "share",
  "signup",
]);

export const INVALID_SLUG_MESSAGE =
  "Share link must be 3-64 chars of lowercase letters, numbers, or hyphens";
export const RESERVED_SLUG_MESSAGE = "This share link is reserved";
export const SLUG_ALREADY_EXISTS_MESSAGE = "This share link is already in use";

export function normalizeShareSlug(
  raw: string,
): { slug: string } | { error: string } {
  const n = raw.trim().toLowerCase();
  if (n.length < 3 || n.length > 64 || !SLUG_PATTERN.test(n)) {
    return { error: INVALID_SLUG_MESSAGE };
  }
  if (RESERVED_SLUGS.has(n)) return { error: RESERVED_SLUG_MESSAGE };
  return { slug: n };
}
