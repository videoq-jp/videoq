import { isValidInvitationEmail } from "@videoq/trpc/course-invitations";
import { planInvitationEmails as plan } from "../application/course-invitations";

export function planInvitationEmails(emails: readonly string[]) {
  return plan(emails, isValidInvitationEmail);
}

export * from "../application/course-invitations";
import { sha256Hex } from "../shared/crypto";

export function createInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function hashInvitationToken(token: string): Promise<string> {
  return sha256Hex(token);
}

// Runtime clock defaults belong to the compatibility adapter. Domain callers
// supply their operation time explicitly.
import {
  isInvitationExpired as expired,
  effectiveInvitationStatus as effectiveStatus,
  type InvitationStatus,
} from "../application/course-invitations";

export function isInvitationExpired(expiresAt: Date, now = new Date()): boolean {
  return expired(expiresAt, now);
}

export function effectiveInvitationStatus(status: InvitationStatus, expiresAt: Date, now = new Date()): InvitationStatus {
  return effectiveStatus(status, expiresAt, now);
}
