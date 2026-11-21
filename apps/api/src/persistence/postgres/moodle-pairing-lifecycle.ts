import { alias } from "drizzle-orm/pg-core";
import { and, eq, sql, inArray } from "drizzle-orm";
import type { Db } from "../../db/pool";
import { ltiCredentials } from "../../db/schema";

/** Called inside the owner's disconnect transaction. Preserve exchange lock order. */
export async function revokeMoodlePairingPointer(
  db: Db,
  ownerUserId: string,
  issuer: string,
) {
  // Exchange locks code -> owner; deleting a code here (owner -> code) could deadlock.
  // Only the owner pointer is removed, so the exchange cannot reactivate a connection.
  const codes = alias(ltiCredentials, "pairing_codes");
  await db.delete(ltiCredentials).where(
    and(
      eq(ltiCredentials.kind, "moodle-pairing"),
      inArray(
        sql<string>`${ltiCredentials.payload}->>'codeHash'`,
        db
          .select({ id: codes.id })
          .from(codes)
          .where(
            and(
              eq(codes.kind, "moodle-pairing-code"),
              sql`${codes.payload}->>'ownerUserId'=${ownerUserId}`,
              sql`${codes.payload}->>'moodleUrl'=${issuer}`,
            ),
          ),
      ),
    ),
  );
}
