import {sql} from 'drizzle-orm';
import {users} from '../../db/schema';
/** The same active-account policy is used for synchronization and LTI access. */
export function activeLmsOwner() {
  return sql`${users.isActive} = true AND ${users.deactivatedAt} IS NULL
    AND (${users.banned} IS NOT TRUE OR ${users.banExpires} <= now())`;
}

