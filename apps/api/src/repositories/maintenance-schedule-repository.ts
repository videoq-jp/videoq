import { withClient } from "../db/pool";
import type { Bindings } from "../types/bindings";

/**
 * 回復処理が次に起きるべき時刻。ポーリングを止めた代わりに、
 * 「いつ起きれば取りこぼさないか」を DB から一度だけ引く。
 */
export type MaintenanceWindows = {
  /** claimExternalTasks のリース満了までの猶予。DB 側の INTERVAL と一致させる。 */
  leaseMs: number;
  /** uploading のまま放置された行を放棄とみなすまでの時間。 */
  abandonedUploadMs: number;
  /** queued のまま配送タスクが尽きた招待を failed に倒すまでの猶予。 */
  staleInvitationMs: number;
};

export type MaintenanceWakeup = {
  /** 期限切れを含む最も早い期限。対象が無ければ null。 */
  nextAt: Date | null;
  /** DB 問い合わせ時点で未来にある最も早い期限。該当が無ければ null。 */
  nextFutureAt: Date | null;
};

/**
 * 次に回復処理を走らせるべき時刻。対象が何も無ければ両方 null。
 *
 * 期限切れの対象で空振りが続いても、別の対象の期限をバックオフで遅らせない
 * よう、未来の期限も別に返す。同じ種類の中にも期限切れと未来の行が混在する
 * ため、種類ごとの最小値に絞る前に全行の期限を集計する。
 * 各副問い合わせの述語は、実際に回復を行う側の述語と一致させること。
 * ここだけ緩いと、回復できない行を延々と起こし続ける空振りループになる。
 */
export async function getNextMaintenanceWakeup(
  env: Bindings,
  windows: MaintenanceWindows,
): Promise<MaintenanceWakeup> {
  return withClient(env, async (client) => {
    const result = await client.query<{
      next_at: Date | null;
      next_future_at: Date | null;
    }>(
      `WITH deadlines AS (
          SELECT CASE
                   WHEN task.locked_at IS NOT NULL
                    AND task.locked_at > now() - make_interval(secs => $1::double precision)
                     THEN task.locked_at + make_interval(secs => $1::double precision)
                   ELSE GREATEST(task.available_at, now())
                 END AS due_at
            FROM external_tasks AS task
           WHERE task.completed_at IS NULL
             AND task.dead_at IS NULL
          UNION ALL
          SELECT installation.next_materials_sync_at
            FROM lms_installations AS installation
            JOIN users AS owner ON owner.id = installation.owner_user_id
           WHERE installation.active = true AND installation.materials_service IS NOT NULL
             AND owner.is_active = true AND owner.deactivated_at IS NULL
             AND (owner.banned IS NOT TRUE OR owner.ban_expires <= now())
          UNION ALL
          SELECT COALESCE(video.upload_heartbeat_at, video.uploaded_at) + make_interval(secs => $2::double precision)
            FROM videos AS video
           WHERE video.status = 'uploading'
          UNION ALL
          SELECT invitation.updated_at + make_interval(secs => $3::double precision)
            FROM video_course_invitations AS invitation
           WHERE invitation.status = 'pending'
             AND invitation.delivery_status = 'queued'
             AND NOT EXISTS (
                   SELECT 1
                     FROM external_tasks AS live
                    WHERE live.kind = 'invitation_email'
                      AND live.completed_at IS NULL
                      AND live.dead_at IS NULL
                      AND (live.payload->>'invitation_id')::bigint = invitation.id
                 )
       )
       SELECT MIN(due_at) AS next_at,
              MIN(due_at) FILTER (WHERE due_at > now()) AS next_future_at
         FROM deadlines`,
      [
        windows.leaseMs / 1000,
        windows.abandonedUploadMs / 1000,
        windows.staleInvitationMs / 1000,
      ],
    );
    const nextAt = result.rows[0]?.next_at ?? null;
    const nextFutureAt = result.rows[0]?.next_future_at ?? null;
    return {
      nextAt: nextAt === null ? null : new Date(nextAt),
      nextFutureAt: nextFutureAt === null ? null : new Date(nextFutureAt),
    };
  });
}
