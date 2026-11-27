import { and, or, not, sql, type SQL } from "drizzle-orm";
import type { PairingLogic } from "../domain/lms/pairing-exchange";
export const pairingDrizzleLogic: PairingLogic<string, SQL> = {
  modeIsNot: (mode, expected) => sql`${mode}<>${expected}`,
  and: (...terms) => and(...terms)!,
  or: (left, right) => or(left, right)!,
  not,
};
