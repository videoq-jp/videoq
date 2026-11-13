import type {Db} from "../../db/pool";
import {externalTasks} from "../../db/schema";
/**
 * 招待メール配送タスクの dedupe key。再送のたびに新しいタスクを作れるよう
 * 招待 ID だけでなく enqueue 時刻も含める。
 */
function invitationEmailDedupeKey(
  invitationId: number,
  enqueuedAt: Date,
): string {
  return `invitation_email:${invitationId}:${enqueuedAt.getTime()}`;
}

/** 呼び出し元のtransactionに配送タスクを載せるoutbox primitive。 */
export async function insertInvitationEmailTasks(
  tx: Pick<Db, "insert">,
  invitationIds: readonly number[],
  enqueuedAt: Date,
): Promise<void> {
  if (invitationIds.length === 0) return;
  await tx
    .insert(externalTasks)
    .values(
      invitationIds.map((invitationId) => ({
        kind: "invitation_email",
        payload: { invitation_id: invitationId },
        dedupeKey: invitationEmailDedupeKey(invitationId, enqueuedAt),
      })),
    )
    .onConflictDoNothing();
}

