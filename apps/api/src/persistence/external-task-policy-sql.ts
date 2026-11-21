import { sql, type SQL } from "drizzle-orm";
import type { StorageCleanupLogic } from "../application/external-task-policy";
import { QUOTA_GIB_BYTES } from "../application/quota-policy";

export const storageCleanupDrizzleLogic: StorageCleanupLogic<SQL, SQL> = {
  remaining: (used, refunded) => sql`GREATEST(0, ${used} - ${refunded})`,
  limitBytes: (limit) => sql`floor(${limit} * ${QUOTA_GIB_BYTES})`,
  unlimited: (limit) => sql`${limit} IS NULL`,
  atMost: (left, right) => sql`${left} <= ${right}`,
  and: (left, right) => sql`(${left} AND (${right}))`,
  or: (left, right) => sql`(${left} OR ${right})`,
  clearWhen: (condition, current) =>
    sql`CASE WHEN ${condition} THEN false ELSE ${current} END`,
};
