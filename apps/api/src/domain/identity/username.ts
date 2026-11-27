/** Normalize an email local-part (or name) into a BA username candidate. */
export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length < 3) base = `user_${base}`.replace(/_+/g, "_");
  if (base.length < 3) base = "user";
  return base.slice(0, 150);
}

/** Normalize facts once; the application owns querying candidates in order. */
export function usernameSeed(preferred: string): string {
  let seed = preferred.includes("@")
    ? usernameFromEmail(preferred)
    : preferred
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 150);
  if (seed.length < 3) seed = usernameFromEmail(preferred.includes("@") ? preferred : `${seed || "user"}@x`);

  return seed;
}
export function usernameCandidate(seed: string, index: number): string {
  const suffix = index === 0 ? '' : `_${index}`;
  return `${seed.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
}
export function fallbackUsername(id: string): string {
  return `user_${id.replace(/-/g, '').slice(0, 12)}`;
}
