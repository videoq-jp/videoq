import { sql, type SQLWrapper } from "drizzle-orm";
import { users } from "../../db/schema";
import { lmsOwnerAvailable } from "../../domain/lms/lms-owner";
import { lmsOwnerDrizzleLogic } from "../lms-owner-policy";
/** The same active-account policy is used for synchronization and LTI access. */
export function activeLmsOwner(clock: SQLWrapper = sql`now()`) {
  return lmsOwnerAvailable(
    {
      active: sql`${users.isActive} = true`,
      notDeactivated: sql`${users.deactivatedAt} IS NULL`,
      notBanned: sql`${users.banned} IS NOT TRUE`,
      banExpires: users.banExpires,
      now: clock,
    },
    lmsOwnerDrizzleLogic,
  );
}
