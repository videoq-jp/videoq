import type { CourseMembershipDependencies } from './ports';
import { invitationExpiresAt, effectiveInvitationStatus, maskInvitationEmail, planInvitationEmails } from '../../application/course-invitations';

type InviteResultStatus =
  | "queued"
  | "already_member"
  | "already_invited"
  | "invalid"
  | "duplicate";

export type InviteRecipientResult = {
  email: string;
  status: InviteResultStatus;
  invitation_id?: number;
  invitation_url?: string;
};

export async function inviteCourseMembers(
  deps: CourseMembershipDependencies,
  courseId: number,
  ownerUserId: string,
  rawEmails: readonly string[],
  issuedAt = deps.now(),
): Promise<
  | { notFound: true }
  | { tooMany: true; limit: number }
  | { results: InviteRecipientResult[] }
> {
  const limit = deps.batchLimit;
  const plan = planInvitationEmails(rawEmails);
  const ready = plan.filter(({ status }) => status === "ready");
  if (ready.length > limit) return { tooMany: true, limit };
  const expiresAt = invitationExpiresAt(issuedAt);
  const manualTokens = new Map<string, string>();
  const prepared = await Promise.all(
    ready.map(async ({ email }) => {
      const token = deps.createToken();
      if (!deps.emailDelivery) manualTokens.set(email, token);
      return { email, tokenHash: await deps.hashToken(token), expiresAt, createdAt: issuedAt };
    }),
  );

  // 招待行と配送タスクを同じtransactionで作る。メール送信はここでは行わない。
  // 最大50通をリクエスト内で送ると、途中でWorkerが終了したときに配信状態が
  // 失われるため、送信は external task 側に完全に委譲する。
  const stored = await deps.createRepository.create(
    courseId,
    ownerUserId,
    prepared,
  );
  if ("notFound" in stored) return { notFound: true };

  const resultByEmail = new Map<string, Omit<InviteRecipientResult, "email">>();
  for (const email of stored.alreadyMemberEmails) {
    resultByEmail.set(email, { status: "already_member" });
  }
  for (const email of stored.alreadyPendingEmails) {
    resultByEmail.set(email, { status: "already_invited" });
  }
  for (const invitation of stored.created) {
    resultByEmail.set(invitation.email, {
      status: "queued",
      invitation_id: invitation.id,
      ...(!deps.emailDelivery ? { invitation_url: `${deps.baseUrl}/course-invitations/${manualTokens.get(invitation.email)!}` } : {}),
    });
  }

  const results: InviteRecipientResult[] = plan.map(({ email, status }) =>
    status === "ready"
      ? { email, ...(resultByEmail.get(email) ?? { status: "queued" }) }
      : { email, status },
  );
  return { results };
}

export async function previewCourseInvitation(
  deps: CourseMembershipDependencies,
  token: string,
  now = deps.now(),
) {
  const tokenHash = await deps.hashToken(token);
  const invitation = await deps.readRepository.preview(tokenHash);
  if (!invitation) return null;
  return {
    course_id: invitation.course_id,
    course_name: invitation.course_name,
    inviter_name: invitation.inviter_name,
    email_hint: maskInvitationEmail(invitation.email),
    status: effectiveInvitationStatus(invitation.status, new Date(invitation.expires_at), now),
    expires_at: invitation.expires_at,
  };
}

export async function acceptInvitation(
  deps: CourseMembershipDependencies,
  token: string,
  userId: string,
  now = deps.now(),
) {
  return deps.writeRepository.decide("accept", await deps.hashToken(token), userId, now);
}

export async function declineInvitation(
  deps: CourseMembershipDependencies,
  token: string,
  userId: string,
  now = deps.now(),
) {
  return deps.writeRepository.decide("decline", await deps.hashToken(token), userId, now);
}

/**
 * 保留中の招待のトークンを失効させ、配送タスクを積み直す。
 * 一括招待と同じ経路に載せるので、送信自体はここでは行わない。
 */
export async function resendInvitation(
  deps: CourseMembershipDependencies,
  courseId: number,
  invitationId: number,
  ownerUserId: string,
  now = deps.now(),
) {
  const token = deps.createToken();
  const rotated = await deps.writeRepository.control(
    "resend",
    courseId,
    invitationId,
    ownerUserId,
    now,
    { tokenHash: await deps.hashToken(token), expiresAt: invitationExpiresAt(now) },
  );
  if ("notFound" in rotated || "invalidState" in rotated) return rotated;
  return { ok: true as const, delivery_status: "queued" as const,
    ...(!deps.emailDelivery ? { invitation_url: `${deps.baseUrl}/course-invitations/${token}` } : {}),
  };
}

export function revokeInvitation(
  deps: CourseMembershipDependencies,
  courseId: number,
  invitationId: number,
  ownerUserId: string,
  now = deps.now(),
) {
  return deps.writeRepository.control(
    "revoke",
    courseId,
    invitationId,
    ownerUserId,
    now,
  );
}
