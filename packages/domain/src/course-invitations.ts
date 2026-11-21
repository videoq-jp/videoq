/** Normalize identity and enforce invitation limits; syntax validation is supplied by adapters. */
export function normalizeInvitationEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || email.split("@").length !== 2) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain || local.length > 64 || domain.length > 253) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.startsWith("-") ||
    domain.endsWith("-") ||
    domain.includes("..")
  ) {
    return null;
  }
  if (!domain.includes(".") || domain.split(".").some(label =>
    label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return email;
}
