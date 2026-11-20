import {sql} from 'drizzle-orm';
import {users} from '../../db/schema';
import { lmsOwnerAvailable } from '../../application/lms-owner';
import { lmsOwnerDrizzleLogic, lmsOwnerStringLogic } from '../lms-owner-policy';
/** The same active-account policy is used for synchronization and LTI access. */
export function activeLmsOwner() {
  return lmsOwnerAvailable({ active: sql`${users.isActive} = true`, notDeactivated: sql`${users.deactivatedAt} IS NULL`,
    notBanned: sql`${users.banned} IS NOT TRUE`, banExpires: users.banExpires, now: sql`now()`,
  }, lmsOwnerDrizzleLogic);
}

/** The upload/lease paths retain their fresh clock after acquiring locks. */
export function postgresLmsOwnerSql(clock: 'now()' | 'clock_timestamp()', alias: 'owner' | 'u' = 'owner'): string {
  return lmsOwnerAvailable({ active: `${alias}.is_active=true`, notDeactivated: `${alias}.deactivated_at IS NULL`,
    notBanned: `${alias}.banned IS NOT TRUE`, banExpires: `${alias}.ban_expires`, now: clock,
  }, lmsOwnerStringLogic);
}
