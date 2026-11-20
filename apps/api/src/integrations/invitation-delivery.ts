import { deliverInvitationEmail as execute } from '../features/course-memberships/delivery-service';
import { recordInvitationDeliveryOutcomes, rotateInvitationTokenForDelivery } from '../repositories/course-invitation-repository';
import { createInvitationToken, hashInvitationToken } from '../lib/course-invitations';
import { sendMail } from '../lib/mail';
import { stripTrailingSlashes } from '../lib/url';
import type { Bindings } from '../types/bindings';
import type { ExternalTaskLease } from '../persistence/contracts/external-task-repository';

function frontendBaseUrl(env: Bindings): string {
  return stripTrailingSlashes(env.FRONTEND_URL?.trim() || "https://videoq.jp");
}

function invitationUrl(env: Bindings, token: string): string {
  return `${frontendBaseUrl(env)}/course-invitations/${encodeURIComponent(token)}`;
}

function invitationMessage(
  courseName: string,
  inviterName: string,
  url: string,
): string[] {
  return [
    `${inviterName}さんからVideoQの「${courseName}」講座へ招待されました。`,
    "以下のURLから招待内容を確認し、7日以内に承認してください。",
    "",
    "招待を確認:",
    url,
    "",
    "リンクを開いただけでは講座に参加しません。心当たりがない場合は、このメールを破棄してください。",
  ];
}

export function deliverInvitationEmail(env: Bindings, invitationId: number, lease: ExternalTaskLease, now = new Date()) {
  return execute({
    createToken: createInvitationToken, hashToken: hashInvitationToken,
    repository: {
      rotate: (...args) => rotateInvitationTokenForDelivery(env, ...args),
      record: (...args) => recordInvitationDeliveryOutcomes(env, ...args),
    },
    send: (recipient, token) => sendMail(env, recipient.email, `[VideoQ] 「${recipient.courseName}」への招待`,
      invitationMessage(recipient.courseName, recipient.inviterName, invitationUrl(env, token))),
  }, invitationId, lease, now);
}
