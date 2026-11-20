import type { ExternalTaskLease } from '../../persistence/contracts/external-task-repository';
import type { InvitationDeliveryRepository } from '../../persistence/contracts/invitation-delivery-repository';

export interface InvitationDeliveryDependencies {
  createToken(): string;
  hashToken(token: string): Promise<string>;
  repository: Pick<InvitationDeliveryRepository, 'rotate' | 'record'>;
  send(recipient: { email: string; courseName: string; inviterName: string }, token: string): Promise<void>;
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
  deps: InvitationDeliveryDependencies,
  invitationId: number,
  lease: ExternalTaskLease,
  now: Date,
): Promise<InvitationDeliveryResult> {
  const token = deps.createToken();
  const rotated = await deps.repository.rotate(
    invitationId,
    await deps.hashToken(token),
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
    await deps.send(rotated, token);
  } catch {
    // A transport can echo the message, including the plaintext invitation
    // token. Keep only a fixed failure code in the DB and propagated error.
    const message = "INVITATION_EMAIL_DELIVERY_FAILED";
    // 失敗も記録してからthrowする。task 側のバックオフで再試行される。
    await deps.repository.record(
      [{ invitationId, status: "failed", attemptedAt: now, error: message }],
      { lease },
    );
    throw new Error(message);
  }

  // 成功時は配信結果とタスク完了を1トランザクションにまとめる。
  await deps.repository.record(
    [{ invitationId, status: "sent", attemptedAt: now }],
    { lease, completeTask: true },
  );
  return { delivered: true };
}
