import { sql } from 'drizzle-orm';
import { users } from '../../db/schema/sqlite';
import { lmsOwnerAvailable } from '../../application/lms-owner';
import { lmsOwnerDrizzleLogic, lmsOwnerStringLogic } from '../lms-owner-policy';

export function activeD1LmsOwner() {
  return lmsOwnerAvailable({ active: sql`${users.isActive}=1`, notDeactivated: sql`${users.deactivatedAt} IS NULL`,
    notBanned: sql`${users.banned} IS NOT TRUE`, banExpires: sql`julianday(${users.banExpires})`, now: sql`julianday('now')`,
  }, lmsOwnerDrizzleLogic);
}

/** Closed aliases are supplied by adapters, never request input. */
export function d1LmsOwnerSql(alias: 'owner' | 'u' = 'owner'): string {
  return lmsOwnerAvailable({ active: `${alias}.is_active=1`, notDeactivated: `${alias}.deactivated_at IS NULL`,
    notBanned: `${alias}.banned IS NOT TRUE`, banExpires: `julianday(${alias}.ban_expires)`, now: "julianday('now')",
  }, lmsOwnerStringLogic);
}
