import { VISUAL_OBJECT_DESIRED } from "./visual-objects";
import { SCENE_INDEX_VERIFY_INTERVAL_MS } from "../contracts/scene-index";
import type { MaintenanceRepository } from "../contracts/maintenance-repository";

export function createD1MaintenanceRepository(database: D1Database, materialsEnabled: boolean, activeDimensions: 768 | 1536 = 1536): MaintenanceRepository {
  const materialsDeadline = materialsEnabled ? `UNION ALL
    SELECT (julianday(installation.next_materials_sync_at)-2440587.5)*86400000
    FROM lms_installations installation
    WHERE installation.active=1 AND installation.materials_service IS NOT NULL` : "";
  return {
    async getNextWakeup(windows) {
      // Keep each compound SELECT within D1's five-term limit. Index deadlines
      // form their own CTE instead of extending the main union indefinitely.
      const row = await database.prepare(`WITH index_deadlines(due_at) AS (
        SELECT CASE WHEN lease_token IS NOT NULL AND julianday(lease_until)>julianday('now')
          THEN (julianday(lease_until)-2440587.5)*86400000
          ELSE max((julianday(available_at)-2440587.5)*86400000,(julianday('now')-2440587.5)*86400000) END
          FROM scene_index_tasks WHERE completed_at IS NULL
        UNION ALL SELECT (julianday(coalesce(t.verified_at,t.completed_at))-2440587.5)*86400000+${SCENE_INDEX_VERIFY_INTERVAL_MS}
          FROM scene_index_tasks t JOIN scenes s ON s.vector_id=t.vector_id AND s.dimensions=t.dimensions AND s.revision=t.revision
          WHERE t.operation='upsert' AND t.dimensions=? AND t.completed_at IS NOT NULL AND t.last_error_code<>'SUPERSEDED'
        UNION ALL SELECT CASE WHEN lease_token IS NOT NULL AND julianday(lease_until)>julianday('now')
          THEN (julianday(lease_until)-2440587.5)*86400000
          ELSE max((julianday(available_at)-2440587.5)*86400000,(julianday('now')-2440587.5)*86400000) END
          FROM visual_object_attempts WHERE status<>'cleaned' AND NOT ${VISUAL_OBJECT_DESIRED}
      ), deadlines(due_at) AS (
        SELECT CASE WHEN locked_at IS NOT NULL AND julianday(locked_at)>julianday('now')-?/86400000.0
          THEN (julianday(locked_at)-2440587.5)*86400000+?
          ELSE max((julianday(available_at)-2440587.5)*86400000,(julianday('now')-2440587.5)*86400000) END
        FROM external_tasks WHERE completed_at IS NULL AND dead_at IS NULL
        ${materialsDeadline}
        UNION ALL SELECT due_at FROM index_deadlines
        UNION ALL SELECT (julianday(coalesce(upload_heartbeat_at,uploaded_at))-2440587.5)*86400000+?
          FROM videos WHERE status='uploading'
        UNION ALL SELECT (julianday(invitation.updated_at)-2440587.5)*86400000+?
          FROM video_course_invitations invitation WHERE status='pending' AND delivery_status='queued'
            AND NOT EXISTS(SELECT 1 FROM external_tasks live WHERE live.kind='invitation_email'
              AND live.completed_at IS NULL AND live.dead_at IS NULL
              AND json_extract(live.payload,'$.invitation_id')=invitation.id)
      ) SELECT min(due_at) AS next_at,min(due_at) FILTER(WHERE due_at>(julianday('now')-2440587.5)*86400000) AS next_future_at FROM deadlines`)
        .bind(activeDimensions, windows.leaseMs, windows.leaseMs, windows.abandonedUploadMs, windows.staleInvitationMs)
        .first<{ next_at: number | null; next_future_at: number | null }>();
      return {
        nextAt: row?.next_at == null ? null : new Date(Math.round(row.next_at)),
        nextFutureAt: row?.next_future_at == null ? null : new Date(Math.round(row.next_future_at)),
      };
    },
  };
}
