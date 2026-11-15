import {
  recordInvitationDeliveryOutcomes,
  rotateInvitationTokenForDelivery,
} from "../repositories/course-invitation-repository";
import type { Bindings } from "../types/bindings";
import { createInvitationToken, hashInvitationToken } from "./course-invitations";
import { sendMail } from "./mail";
import { stripTrailingSlashes } from "./url";
import type { ExternalTaskLease } from "../repositories/external-task-repository";

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

export type InvitationDeliveryResult =
  | { delivered: true }
  /** 招待が pending でなくなった（取り消し・承認済み・失効）。再試行しない。 */
  | { skipped: true; reason: string };

/**
 * 招待メールを 1 通配送する。external task から呼ばれる唯一の送信経路。
 *
 * トークンは「送信の直前」にここで発行する。enqueue 時点では推測不能な
 * ダミーの hash しか入っておらず、平文トークンがキューにもDBにも残らない。
 * 再試行のたびにトークンは作り直され、古いリンクは即座に無効になる。
 */
export async function deliverInvitationEmail(
  env: Bindings,
  invitationId: number,
  lease: ExternalTaskLease,
  now = new Date(),
): Promise<InvitationDeliveryResult> {
  const token = createInvitationToken();
  const rotated = await rotateInvitationTokenForDelivery(
    env,
    invitationId,
    await hashInvitationToken(token),
    now,
    lease,
  );
  if ("notFound" in rotated) {
    return { skipped: true, reason: "notFound" };
  }
  if ("invalidState" in rotated) {
    return { skipped: true, reason: rotated.invalidState };
  }

  try {
    await sendMail(
      env,
      rotated.email,
      `[VideoQ] 「${rotated.courseName}」への招待`,
      invitationMessage(
        rotated.courseName,
        rotated.inviterName,
        invitationUrl(env, token),
      ),
    );
  } catch {
    // A transport can echo the message, including the plaintext invitation
    // token. Keep only a fixed failure code in the DB and propagated error.
    const message = "INVITATION_EMAIL_DELIVERY_FAILED";
    // 失敗も記録してからthrowする。task 側のバックオフで再試行される。
    await recordInvitationDeliveryOutcomes(
      env,
      [{ invitationId, status: "failed", attemptedAt: now, error: message }],
      { lease },
    );
    throw new Error(message);
  }

  // 成功時は配信結果とタスク完了を1トランザクションにまとめる。
  await recordInvitationDeliveryOutcomes(
    env,
    [{ invitationId, status: "sent", attemptedAt: now }],
    { lease, completeTask: true },
  );
  return { delivered: true };
}
