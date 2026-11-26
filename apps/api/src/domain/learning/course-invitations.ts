import { normalizeInvitationEmail } from "@videoq/domain/course-invitations";

const COURSE_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const COURSE_INVITATION_HARD_BATCH_LIMIT = 100;
const DEFAULT_COURSE_INVITATION_BATCH_LIMIT = 50;

export type InvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked";

export type InvitationDeliveryStatus = "queued" | "sent" | "failed";

type PlannedInvitationEmail = {
  email: string;
  status: "ready" | "invalid" | "duplicate";
};

export function planInvitationEmails(rawEmails: readonly string[], isValidEmail: (email: string) => boolean): PlannedInvitationEmail[] {
  const seen = new Set<string>();
  return rawEmails.map((input) => {
    const email = normalizeInvitationEmail(input);
    if (!email || !isValidEmail(email)) {
      return { email: input, status: "invalid" };
    }
    if (seen.has(email)) {
      return { email: input, status: "duplicate" };
    }
    seen.add(email);
    return { email, status: "ready" };
  });
}

export function invitationExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + COURSE_INVITATION_LIFETIME_MS);
}

export function isInvitationExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export function effectiveInvitationStatus(
  status: InvitationStatus,
  expiresAt: Date,
  now: Date,
): InvitationStatus {
  return status === "pending" && isInvitationExpired(expiresAt, now)
    ? "expired"
    : status;
}

export function maskInvitationEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local}${domain}`;
  return `${local[0]}${"*".repeat(local.length - 2)}${local.at(-1)}${domain}`;
}

export function resolveInvitationBatchLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_COURSE_INVITATION_BATCH_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_COURSE_INVITATION_BATCH_LIMIT;
  }
  return Math.min(value, COURSE_INVITATION_HARD_BATCH_LIMIT);
}
