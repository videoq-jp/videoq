import { sql, type SQL } from "drizzle-orm";
import type { MembershipLogic } from "../application/membership-policy";
export const membershipDrizzleLogic: MembershipLogic<SQL> = {
  and: (left, right) => sql`(${left} AND ${right})`,
  or: (left, right) => sql`(${left} OR ${right})`,
};
