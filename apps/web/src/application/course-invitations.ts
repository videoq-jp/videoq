import { normalizeInvitationEmail } from '@videoq/domain/course-invitations';

export const DELIVERY_POLL_WINDOW_MS = 30_000;
const DELIVERY_POLL_INTERVAL_MS = 3_000;

export function splitInvitationEmails(value: string): string[] {
  return value.split(/[\n,;]+/).map(email => email.trim()).filter(Boolean);
}

export type RecipientPreview = {
  email: string;
  status: 'ready' | 'invalid' | 'duplicate' | 'already_member' | 'already_invited';
};

export function previewInvitationRecipients(
  inputs: readonly string[], memberEmails: ReadonlySet<string>, pendingEmails: ReadonlySet<string>, isValidEmail: (email: string) => boolean,
): RecipientPreview[] {
  const seen = new Set<string>();
  return inputs.map(input => {
    const normalized = normalizeInvitationEmail(input);
    if (!normalized || !isValidEmail(normalized)) return { email: input, status: 'invalid' };
    if (seen.has(normalized)) return { email: normalized, status: 'duplicate' };
    seen.add(normalized);
    if (memberEmails.has(normalized)) return { email: normalized, status: 'already_member' };
    if (pendingEmails.has(normalized)) return { email: normalized, status: 'already_invited' };
    return { email: normalized, status: 'ready' };
  });
}

export function invitationDeliveryPollInterval(input: {
  enabled: boolean; now: number; until: number;
  invitations?: readonly { status: string; delivery_status: string }[];
}): number | false {
  if (!input.enabled || input.now >= input.until) return false;
  return input.invitations?.some(invitation => invitation.status === 'pending' && invitation.delivery_status === 'queued')
    ? DELIVERY_POLL_INTERVAL_MS : false;
}
