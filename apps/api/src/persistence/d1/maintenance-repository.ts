import {
  and,
  eq,
  ne,
  isNull,
  isNotNull,
  not,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  sceneIndexTasks,
  scenes,
  visualObjectAttempts,
  externalTasks,
  lmsInstallations,
  videos,
  videoCourseInvitations,
} from "../../db/schema/sqlite";
import { visualObjectDesiredPredicate } from "./visual-objects";
import { SCENE_INDEX_VERIFY_INTERVAL_MS } from "../contracts/scene-index";
import type { MaintenanceRepository } from "../contracts/maintenance-repository";

const millis = (timestamp: SQL) =>
  sql<number>`(julianday(${timestamp})-2440587.5)*86400000`;
const now = millis(sql`'now'`);
export function createD1MaintenanceRepository(
  database: D1Database,
  materialsEnabled: boolean,
  activeDimensions: 768 | 1536 = 1536,
): MaintenanceRepository {
  const db = createD1Connection(database);
  return {
    async getNextWakeup(windows) {
      const indexDue = sql<number>`CASE WHEN ${sceneIndexTasks.leaseToken} IS NOT NULL AND julianday(${sceneIndexTasks.leaseUntil})>julianday('now')
      THEN ${millis(sql`${sceneIndexTasks.leaseUntil}`)} ELSE max(${millis(sql`${sceneIndexTasks.availableAt}`)},${now}) END`;
      const objectDue = sql<number>`CASE WHEN ${visualObjectAttempts.leaseToken} IS NOT NULL AND julianday(${visualObjectAttempts.leaseUntil})>julianday('now')
      THEN ${millis(sql`${visualObjectAttempts.leaseUntil}`)} ELSE max(${millis(sql`${visualObjectAttempts.availableAt}`)},${now}) END`;
      // Keep the same three-term/five-term split for D1's compound SELECT limit.
      const indexDeadlines = db.$with("index_deadlines").as(
        db
          .select({ due: indexDue.as("due_at") })
          .from(sceneIndexTasks)
          .where(isNull(sceneIndexTasks.completedAt))
          .unionAll(
            db
              .select({
                due: sql<number>`${millis(sql`coalesce(${sceneIndexTasks.verifiedAt},${sceneIndexTasks.completedAt})`)}+${SCENE_INDEX_VERIFY_INTERVAL_MS}`.as(
                  "due_at",
                ),
              })
              .from(sceneIndexTasks)
              .innerJoin(
                scenes,
                and(
                  eq(scenes.vectorId, sceneIndexTasks.vectorId),
                  eq(scenes.dimensions, sceneIndexTasks.dimensions),
                  eq(scenes.revision, sceneIndexTasks.revision),
                ),
              )
              .where(
                and(
                  eq(sceneIndexTasks.operation, "upsert"),
                  eq(sceneIndexTasks.dimensions, activeDimensions),
                  isNotNull(sceneIndexTasks.completedAt),
                  ne(sceneIndexTasks.lastErrorCode, "SUPERSEDED"),
                ),
              ),
          )
          .unionAll(
            db
              .select({ due: objectDue.as("due_at") })
              .from(visualObjectAttempts)
              .where(
                and(
                  ne(visualObjectAttempts.status, "cleaned"),
                  not(visualObjectDesiredPredicate()),
                ),
              ),
          ),
      );
      const taskDue = sql<number>`CASE WHEN ${externalTasks.lockedAt} IS NOT NULL AND julianday(${externalTasks.lockedAt})>julianday('now')-${windows.leaseMs}/86400000.0
      THEN ${millis(sql`${externalTasks.lockedAt}`)}+${windows.leaseMs} ELSE max(${millis(sql`${externalTasks.availableAt}`)},${now}) END`;
      const tasks = db
        .select({ due: taskDue.as("due_at") })
        .from(externalTasks)
        .where(
          and(isNull(externalTasks.completedAt), isNull(externalTasks.deadAt)),
        );
      const deadlinesQuery = materialsEnabled
        ? tasks.unionAll(
            db
              .select({
                due: millis(sql`${lmsInstallations.nextMaterialsSyncAt}`).as(
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
        deadlinesQuery
          .unionAll(db.select({ due: indexDeadlines.due }).from(indexDeadlines))
          .unionAll(
            db
              .select({
                due: sql<number>`${millis(sql`coalesce(${videos.uploadHeartbeatAt},${videos.uploadedAt})`)}+${windows.abandonedUploadMs}`.as(
                  "due_at",
                ),
              })
              .from(videos)
              .where(eq(videos.status, "uploading")),
          )
          .unionAll(
            db
              .select({
                due: sql<number>`${millis(sql`${videoCourseInvitations.updatedAt}`)}+${windows.staleInvitationMs}`.as(
                  "due_at",
                ),
              })
              .from(videoCourseInvitations)
              .where(
                and(
                  eq(videoCourseInvitations.status, "pending"),
                  eq(videoCourseInvitations.deliveryStatus, "queued"),
                  notExists(
                    db
                      .select({ id: externalTasks.id })
                      .from(externalTasks)
                      .where(
                        and(
                          eq(externalTasks.kind, "invitation_email"),
                          isNull(externalTasks.completedAt),
                          isNull(externalTasks.deadAt),
                          sql`json_extract(${externalTasks.payload},'$.invitation_id')=${videoCourseInvitations.id}`,
                        ),
                      ),
                  ),
                ),
              ),
          ),
      );
      const row = await db
        .with(indexDeadlines, deadlines)
        .select({
          nextAt: sql<number | null>`min(${deadlines.due})`,
          nextFutureAt: sql<
            number | null
          >`min(${deadlines.due}) FILTER(WHERE ${deadlines.due}>${now})`,
        })
        .from(deadlines)
        .get();
      return {
        nextAt: row?.nextAt == null ? null : new Date(Math.round(row.nextAt)),
        nextFutureAt:
          row?.nextFutureAt == null
            ? null
            : new Date(Math.round(row.nextFutureAt)),
      };
    },
  };
}
