import { and, eq, gt, or, sql, exists, inArray } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  users,
  videos,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import { quotaAllowsAdditional } from "../../domain/billing/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import {
  validateProcessingReservation,
  type ProcessingQuotaRepository,
} from "../contracts/processing-quota";
export function createD1ProcessingQuotaRepository(
  database: D1Database,
): ProcessingQuotaRepository {
  const db = createD1Connection(database);
  const current = sql`strftime('%Y-%m',${users.usagePeriodStart})=strftime('%Y-%m','now')`;
  const used = sql`CASE WHEN ${current} THEN ${users.usedProcessingSeconds} ELSE 0 END`;
  return {
    async reserve(videoId, seconds) {
      validateProcessingReservation(videoId, seconds);
      const token = crypto.randomUUID();
      const reserved = exists(
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(
            and(
              eq(receipts.token, token),
              eq(receipts.kind, "processing_reserved"),
            ),
          ),
      );
      const result = await runD1Batch<{
        kind: string;
        processing_limit_minutes: number | null;
      }>(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`CASE WHEN ${videos.processingSeconds}>0 THEN 'processing_reused' ELSE 'processing_reserved' END`,
                resourceId: videos.id,
              }),
            )
            .from(videos)
            .innerJoin(users, eq(users.id, videos.userId))
            .where(
              and(
                eq(videos.id, videoId),
                or(
                  gt(videos.processingSeconds, 0),
                  and(
                    sql`${users.isOverQuota} IS NOT TRUE`,
                    sql`(${used})<=9007199254740991-${seconds}`,
                    quotaAllowsAdditional(
                      used,
                      sql`${users.processingLimitMinutes}*60`,
                      sql`${seconds}`,
                      quotaDrizzleComparison,
                    ),
                  ),
                ),
              ),
            ),
        ),
        db
          .update(users)
          .set({
            usedProcessingSeconds: sql`(${used})+${seconds}`,
            usedAiAnswers: sql`CASE WHEN ${current} THEN ${users.usedAiAnswers} ELSE 0 END`,
            usagePeriodStart: sql`CASE WHEN ${current} THEN ${users.usagePeriodStart} ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month') END`,
          })
          .where(
            and(
              inArray(
                users.id,
                db
                  .select({ userId: videos.userId })
                  .from(videos)
                  .where(eq(videos.id, videoId)),
              ),
              reserved,
            ),
          ),
        db
          .update(videos)
          .set({ processingSeconds: seconds })
          .where(and(eq(videos.id, videoId), reserved)),
        db
          .select({
            kind: receipts.kind,
            processingLimitMinutes: users.processingLimitMinutes,
          })
          .from(videos)
          .innerJoin(users, eq(users.id, videos.userId))
          .leftJoin(receipts, eq(receipts.token, token))
          .where(eq(videos.id, videoId)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      const row = result[3].results[0];
      if (!row) throw new Error("Processing video not found");
      return {
        allowed: Boolean(row.kind),
        limitSeconds:
          row.processing_limit_minutes === null
            ? null
            : row.processing_limit_minutes * 60,
      };
    },
  };
}
