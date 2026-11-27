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

export async function allocateUniqueUsername(
  usernameExists: (candidate: string) => Promise<boolean>, preferred: string, newId: () => string,
): Promise<string> {
  let seed = preferred.includes("@")
    ? usernameFromEmail(preferred)
    : preferred
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 150);
  if (seed.length < 3) seed = usernameFromEmail(preferred.includes("@") ? preferred : `${seed || "user"}@x`);

  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `_${i}`;
    const candidate = `${seed.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
    if (!await usernameExists(candidate)) return candidate;
  }
  return `user_${newId().replace(/-/g, "").slice(0, 12)}`;
}

