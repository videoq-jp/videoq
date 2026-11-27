import { sql } from "drizzle-orm";
import { users } from "../../db/schema/sqlite";
import { lmsOwnerAvailable } from "../../domain/lms/lms-owner";
import { lmsOwnerDrizzleLogic } from "../lms-owner-policy";

export function activeD1LmsOwner() {
  return lmsOwnerAvailable(
    {
      active: sql`${users.isActive}=1`,
      notDeactivated: sql`${users.deactivatedAt} IS NULL`,
      notBanned: sql`${users.banned} IS NOT TRUE`,
      banExpires: sql`julianday(${users.banExpires})`,
      now: sql`julianday('now')`,
    },
    lmsOwnerDrizzleLogic,
  );
}
