import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  ltiMaterialOperations,
  ltiCourseTagOperations,
  ltiOperationReservations as reservations,
  courseQaModeration,
  ltiReportAccesses,
} from "../../db/schema/sqlite";
import {
  LTI_AUDIT_BATCH_SIZE as BATCH_SIZE,
  type AuditRetentionRepository,
} from "../contracts/audit-retention-repository";
import { operationReservationKey } from "../../shared/lti-operation-key";

/** Compare canonical UTC text to retain indexed, strict cutoff semantics. */
export function createD1AuditRetentionRepository(
  database: D1Database,
): AuditRetentionRepository {
  const db = createD1Connection(database),
    oneRow = sql`json_each('[0]')`;
  return {
    async pruneBatch(kind, cutoff) {
      if (!Number.isFinite(cutoff.getTime()))
        throw new Error("Invalid retention cutoff.");
      const at = cutoff.toISOString();
      if (kind === "material" || kind === "tag") {
        const table =
          kind === "material" ? ltiMaterialOperations : ltiCourseTagOperations;
        const candidates = await db
          .select({ id: table.id, createdAt: sql<string>`${table.createdAt}` })
          .from(table)
          .where(sql`${table.createdAt}<${at}`)
          .orderBy(table.createdAt, table.id)
          .limit(BATCH_SIZE);
        const snapshot = JSON.stringify(
          await Promise.all(
            candidates.map(async (row) => ({
              ...row,
              key: await operationReservationKey(kind, row.id),
            })),
          ),
        );
        const eligible = db
          .select({
            id: table.id,
            reservationKey:
              sql<string>`json_extract(candidate.value,'$.key')`.as(
                "reservation_key",
              ),
          })
          .from(sql`json_each(${snapshot}) candidate`)
          .innerJoin(
            table,
            and(
              sql`${table.id}=json_extract(candidate.value,'$.id')`,
              sql`${table.createdAt}=json_extract(candidate.value,'$.createdAt')`,
            ),
          )
          .where(sql`${table.createdAt}<${at}`)
          .as("eligible");
        const result = await runD1Batch(database, [
          db
            .insert(reservations)
            .select(
              db
                .select(
                  insertSelectFields(reservations, {
                    key: sql`${eligible.reservationKey}`,
                  }),
                )
                .from(eligible)
                .where(sql`1`),
            )
            .onConflictDoNothing(),
          db
            .delete(table)
            .where(
              inArray(
                table.id,
                db
                  .select({ id: eligible.id })
                  .from(eligible)
                  .innerJoin(
                    reservations,
                    eq(reservations.key, eligible.reservationKey),
                  ),
              ),
            ),
          db
            .select({
              more: exists(
                db
                  .select({ id: table.id })
                  .from(table)
                  .where(sql`${table.createdAt}<${at}`),
              ).as("more"),
            })
            .from(oneRow),
        ]);
        return {
          count: result[1].meta.changes,
          more: Boolean(result[2].results[0]?.more),
        };
      }
      if (kind === "moderation") {
        const eligible = and(
          isNotNull(courseQaModeration.ltiActorId),
          sql`${courseQaModeration.createdAt}<${at}`,
        );
        const candidates = db
          .select({ id: courseQaModeration.id })
          .from(courseQaModeration)
          .where(eligible)
          .orderBy(courseQaModeration.createdAt, courseQaModeration.id)
          .limit(BATCH_SIZE);
        const result = await runD1Batch(database, [
          db
            .update(courseQaModeration)
            .set({ ltiActorId: null })
            .where(inArray(courseQaModeration.id, candidates)),
          db
            .select({
              more: exists(
                db
                  .select({ id: courseQaModeration.id })
                  .from(courseQaModeration)
                  .where(eligible),
              ).as("more"),
            })
            .from(oneRow),
        ]);
        return {
          count: result[0].meta.changes,
          more: Boolean(result[1].results[0]?.more),
        };
      }
      const candidates = db
        .select({ id: ltiReportAccesses.id })
        .from(ltiReportAccesses)
        .where(sql`${ltiReportAccesses.createdAt}<${at}`)
        .orderBy(ltiReportAccesses.createdAt, ltiReportAccesses.id)
        .limit(BATCH_SIZE);
      const result = await runD1Batch(database, [
        db
          .delete(ltiReportAccesses)
          .where(inArray(ltiReportAccesses.id, candidates)),
        db
          .select({
            more: exists(
              db
                .select({ id: ltiReportAccesses.id })
                .from(ltiReportAccesses)
                .where(sql`${ltiReportAccesses.createdAt}<${at}`),
            ).as("more"),
          })
          .from(oneRow),
      ]);
      return {
        count: result[0].meta.changes,
        more: Boolean(result[1].results[0]?.more),
      };
    },
  };
}
