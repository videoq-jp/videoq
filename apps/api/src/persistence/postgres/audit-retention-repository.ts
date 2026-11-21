import { and, eq, lt, inArray, isNotNull, sql } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { materializedCtesSQL } from "../../db/materialized-cte";
import { insertSelectValues } from "../../db/postgres/query-builders";
import {
  ltiMaterialOperations,
  ltiCourseTagOperations,
  ltiOperationReservations as reservations,
  courseQaModeration,
  ltiReportAccesses,
} from "../../db/schema";
import { reservationKeySql } from "./operation-reservations";
import type { Bindings } from "../../types/bindings";
import type { LtiOperationKind } from "../../shared/lti-operation-key";
import {
  LTI_AUDIT_BATCH_SIZE as BATCH_SIZE,
  type AuditRetentionRepository,
} from "../contracts/audit-retention-repository";

async function receiptBatch(db: Db, kind: LtiOperationKind, cutoff: Date) {
  const table =
    kind === "material" ? ltiMaterialOperations : ltiCourseTagOperations;
  const key = reservationKeySql(kind, table.id);
  const keys = db
    .select({ reservationKey: key.as("reservation_key") })
    .from(table)
    .where(lt(table.createdAt, cutoff))
    .orderBy(table.createdAt, table.id)
    .limit(BATCH_SIZE)
    .as("reservation_candidates");
  await db
    .insert(reservations)
    .select(
      db
        .select(
          insertSelectValues(reservations, {
            key: sql`${keys.reservationKey}`,
          }),
        )
        .from(keys)
        .orderBy(keys.reservationKey),
    )
    .onConflictDoNothing();
  const candidateRows = db
    .select({ id: table.id, reservationKey: key.as("reservation_key") })
    .from(table)
    .where(lt(table.createdAt, cutoff))
    .orderBy(table.createdAt, table.id)
    .limit(BATCH_SIZE);
  const candidates = db.$with("candidates").as(candidateRows);
  const lockRows = db
    .select({ key: reservations.key })
    .from(reservations)
    .innerJoin(candidates, eq(candidates.reservationKey, reservations.key))
    .orderBy(reservations.key)
    .for("update", { of: reservations, skipLocked: true });
  const locked = db.$with("locked").as(lockRows);
  const removed = await db.execute(
    materializedCtesSQL(
      [
        { name: "candidates", source: candidateRows },
        { name: "locked", source: lockRows },
      ],
      db
        .delete(table)
        .where(
          and(
            inArray(
              table.id,
              db
                .select({ id: candidates.id })
                .from(candidates)
                .innerJoin(locked, eq(locked.key, candidates.reservationKey)),
            ),
            lt(table.createdAt, cutoff),
          ),
        )
        .returning({ id: table.id }),
    ),
  );
  const more = await db
    .select({ id: table.id })
    .from(table)
    .where(lt(table.createdAt, cutoff))
    .limit(1);
  return { count: removed.rows.length, more: more.length > 0 };
}
async function moderationBatch(db: Db, cutoff: Date) {
  const eligible = and(
    isNotNull(courseQaModeration.ltiActorId),
    lt(courseQaModeration.createdAt, cutoff),
  );
  const candidateRows = db
    .select({ id: courseQaModeration.id })
    .from(courseQaModeration)
    .where(eligible)
    .orderBy(courseQaModeration.createdAt, courseQaModeration.id)
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });
  const candidates = db.$with("candidates").as(candidateRows);
  const removed = await db.execute(
    materializedCtesSQL(
      [{ name: "candidates", source: candidateRows }],
      db
        .update(courseQaModeration)
        .set({ ltiActorId: null })
        .from(candidates)
        .where(eq(courseQaModeration.id, candidates.id))
        .returning({ id: courseQaModeration.id }),
    ),
  );
  const more = await db
    .select({ id: courseQaModeration.id })
    .from(courseQaModeration)
    .where(eligible)
    .limit(1);
  return { count: removed.rows.length, more: more.length > 0 };
}
async function reportBatch(db: Db, cutoff: Date) {
  const candidateRows = db
    .select({ id: ltiReportAccesses.id })
    .from(ltiReportAccesses)
    .where(lt(ltiReportAccesses.createdAt, cutoff))
    .orderBy(ltiReportAccesses.createdAt, ltiReportAccesses.id)
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });
  const candidates = db.$with("candidates").as(candidateRows);
  const removed = await db.execute(
    materializedCtesSQL(
      [{ name: "candidates", source: candidateRows }],
      db
        .delete(ltiReportAccesses)
        .where(
          inArray(
            ltiReportAccesses.id,
            db.select({ id: candidates.id }).from(candidates),
          ),
        )
        .returning({ id: ltiReportAccesses.id }),
    ),
  );
  const more = await db
    .select({ id: ltiReportAccesses.id })
    .from(ltiReportAccesses)
    .where(lt(ltiReportAccesses.createdAt, cutoff))
    .limit(1);
  return { count: removed.rows.length, more: more.length > 0 };
}
export function createPostgresAuditRetentionRepository(
  env: Bindings,
): AuditRetentionRepository {
  return {
    async pruneBatch(kind, cutoff) {
      if (!Number.isFinite(cutoff.getTime()))
        throw new Error("Invalid retention cutoff.");
      return withDb(env, (db) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'`,
          );
          return kind === "report"
            ? reportBatch(tx, cutoff)
            : kind === "moderation"
              ? moderationBatch(tx, cutoff)
              : receiptBatch(tx, kind, cutoff);
        }),
      );
    },
  };
}
