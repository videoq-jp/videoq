import { and, eq, isNull, isNotNull, notExists, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import {
  externalTasks,
  lmsInstallations,
  videos,
  videoCourseInvitations as invitations,
} from "../../db/schema";
import { ltiMaterialsEnabled } from "../../features/lti/config";
import type { Bindings } from "../../types/bindings";
import type {
  MaintenanceWindows,
  MaintenanceWakeup,
  MaintenanceRepository,
} from "../contracts/maintenance-repository";

/** Keep overdue and future deadlines separately so backoff cannot hide work. */
export async function getNextMaintenanceWakeup(
  env: Bindings,
  windows: MaintenanceWindows,
): Promise<MaintenanceWakeup> {
  return withDb(env, async (db) => {
    const lease = sql`make_interval(secs => ${windows.leaseMs / 1000}::double precision)`;
    const taskDue = sql<string>`CASE WHEN ${externalTasks.lockedAt} IS NOT NULL AND ${externalTasks.lockedAt}>now()-${lease}
      THEN ${externalTasks.lockedAt}+${lease} ELSE GREATEST(${externalTasks.availableAt},now()) END`;
    const tasks = db
      .select({ due: taskDue.as("due_at") })
      .from(externalTasks)
      .where(
        and(isNull(externalTasks.completedAt), isNull(externalTasks.deadAt)),
      );
    const initial = ltiMaterialsEnabled(env)
      ? tasks.unionAll(
          db
            .select({
              due: sql<string>`${lmsInstallations.nextMaterialsSyncAt}`.as(
                "due_at",
              ),
            })
            .from(lmsInstallations)
            .where(
              and(
                eq(lmsInstallations.active, true),
                isNotNull(lmsInstallations.materialsService),
              ),
            ),
        )
      : tasks;
    const deadlines = db.$with("deadlines").as(
      initial
        .unionAll(
          db
            .select({
              due: sql<string>`COALESCE(${videos.uploadHeartbeatAt},${videos.uploadedAt})+make_interval(secs => ${windows.abandonedUploadMs / 1000}::double precision)`.as(
                "due_at",
              ),
            })
            .from(videos)
            .where(eq(videos.status, "uploading")),
        )
        .unionAll(
          db
            .select({
              due: sql<string>`${invitations.updatedAt}+make_interval(secs => ${windows.staleInvitationMs / 1000}::double precision)`.as(
                "due_at",
              ),
            })
            .from(invitations)
            .where(
              and(
                eq(invitations.status, "pending"),
                eq(invitations.deliveryStatus, "queued"),
                notExists(
                  db
                    .select({ id: externalTasks.id })
                    .from(externalTasks)
                    .where(
                      and(
                        eq(externalTasks.kind, "invitation_email"),
                        isNull(externalTasks.completedAt),
                        isNull(externalTasks.deadAt),
                        sql`(${externalTasks.payload}->>'invitation_id')::bigint=${invitations.id}`,
                      ),
                    ),
                ),
              ),
            ),
        ),
    );
    const [row] = await db
      .with(deadlines)
      .select({
        nextAt: sql<string | null>`min(${deadlines.due})`,
        nextFutureAt: sql<
          string | null
        >`min(${deadlines.due}) FILTER(WHERE ${deadlines.due}>now())`,
      })
      .from(deadlines);
    return {
      nextAt: row?.nextAt == null ? null : new Date(row.nextAt),
      nextFutureAt:
        row?.nextFutureAt == null ? null : new Date(row.nextFutureAt),
    };
  });
}
export function createPostgresMaintenanceRepository(
  env: Bindings,
): MaintenanceRepository {
  return { getNextWakeup: (windows) => getNextMaintenanceWakeup(env, windows) };
}
