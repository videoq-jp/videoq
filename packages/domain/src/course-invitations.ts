const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeInvitationEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
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
  return email;
}
