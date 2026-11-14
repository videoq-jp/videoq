import {and,eq,sql} from "drizzle-orm";
import type {Db} from "../../db/pool";
import {users} from "../../db/schema";
import type {StorageReservationResult,UploadReservationResult} from "../contracts/storage-quota";

// Independent of the AI/transcription period: resetting either quota must never
// erase upload usage. The database clock decides the month, including under load.
export const uploadUsageIsCurrent = sql`date_trunc('month', ${users.uploadUsagePeriodStart}, 'UTC')
  = date_trunc('month', CURRENT_TIMESTAMP, 'UTC')`;
export const currentUploadBytes = sql<number>`CASE WHEN ${uploadUsageIsCurrent}
  THEN ${users.usedUploadBytes} ELSE 0 END`;

/** Reserve both allowances in one conditional write, in the video's transaction. */
export async function reserveUploadInTransaction(
  db: Pick<Db, "update" | "select">,
  userId: string,
  additionalBytes: number,
): Promise<UploadReservationResult> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes <= 0) {
    throw new Error("Upload reservation bytes must be a positive safe integer.");
  }
  // The caller already holds the owner lock. Capture one fresh clock value
  // after that lock: transaction_timestamp() may still be in the previous month
  // after waiting, and must not overwrite usage already booked in the new one.
  const [clock] = await db.select({
    periodStart: sql<string>`date_trunc('month', clock_timestamp(), 'UTC')::text`,
  }).from(users).where(eq(users.id, userId));
  if (!clock) throw new Error("Quota owner not found.");
  const usage = sql`CASE WHEN ${users.uploadUsagePeriodStart} = ${clock.periodStart}::timestamptz
    THEN ${users.usedUploadBytes} ELSE 0 END`;
  const [reserved] = await db.update(users).set({
    usedStorageBytes: sql`${users.usedStorageBytes} + ${additionalBytes}`,
    usedUploadBytes: sql`${usage} + ${additionalBytes}`,
    uploadUsagePeriodStart: clock.periodStart,
  }).where(and(
    eq(users.id, userId),
    sql`${users.isOverQuota} IS NOT TRUE`,
    sql`(${users.storageLimitGb} IS NULL OR ${users.usedStorageBytes}
      <= floor(${users.storageLimitGb} * 1073741824) - ${additionalBytes})`,
    sql`(${users.monthlyUploadLimitGb} IS NULL OR ${usage}
      <= floor(${users.monthlyUploadLimitGb} * 1073741824) - ${additionalBytes})`,
  )).returning({ periodStart: users.uploadUsagePeriodStart });
  if (reserved?.periodStart) return { ok: true, periodStart: reserved.periodStart };

  const [state] = await db.select({
    overQuota: users.isOverQuota,
    storageLimit: users.storageLimitGb,
    storageUsed: users.usedStorageBytes,
    monthlyLimit: users.monthlyUploadLimitGb,
  }).from(users).where(eq(users.id, userId));
  if (!state) throw new Error("Quota owner not found.");
  if (state.overQuota) return { overQuota: true };
  if (state.storageLimit !== null &&
      state.storageUsed > Math.floor(state.storageLimit * 1073741824) - additionalBytes) {
    return { exceeded: true, limit: Math.floor(state.storageLimit * 1073741824) };
  }
  if (state.monthlyLimit !== null) {
    return { monthlyUploadExceeded: true, limit: Math.floor(state.monthlyLimit * 1073741824) };
  }
  throw new Error("Failed to reserve unlimited upload quota.");
}

/** Only call while deleting the locked, still-unconfirmed video in the same transaction. */
export async function refundUnconfirmedUpload(
  db: Pick<Db, "update">, userId: string, bytes: number, periodStart: string,
): Promise<void> {
  await db.update(users).set({
    usedUploadBytes: sql`GREATEST(0, ${users.usedUploadBytes} - ${bytes})`,
  }).where(and(eq(users.id, userId), eq(users.uploadUsagePeriodStart, periodStart)));
}

/** 動画行などと同じtransactionへ容量予約を含めるための共通primitive。 */
export async function reserveStorageInTransaction(
  db: Pick<Db, "update" | "select">,
  userId: string,
  additionalBytes: number,
): Promise<StorageReservationResult> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new Error("Storage reservation bytes must be a non-negative safe integer.");
  }
  const reserved = await db
    .update(users)
    .set({
      usedStorageBytes: sql`${users.usedStorageBytes} + ${additionalBytes}`,
    })
    .where(
      and(
        eq(users.id, userId),
        sql`${users.isOverQuota} IS NOT TRUE`,
        sql`(
          ${users.storageLimitGb} IS NULL
          OR ${users.usedStorageBytes}
             <= floor(${users.storageLimitGb} * 1073741824) - ${additionalBytes}
        )`,
      ),
    )
    .returning({ id: users.id });
  if (reserved.length > 0) return { ok: true } as const;

  const state = await db
    .select({
      isOverQuota: users.isOverQuota,
      limitBytes: sql<number | null>`CASE
        WHEN ${users.storageLimitGb} IS NULL THEN NULL
        ELSE floor(${users.storageLimitGb} * 1073741824)::bigint
      END`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = state[0];
  if (!row) throw new Error("Quota owner not found.");
  if (row.isOverQuota) return { overQuota: true } as const;
  if (row.limitBytes === null) {
    throw new Error("Failed to reserve unlimited storage quota.");
  }
  return { exceeded: true, limit: Number(row.limitBytes) } as const;
}
