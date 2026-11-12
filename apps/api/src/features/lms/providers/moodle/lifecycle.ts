import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../../db/pool';
import { ltiCredentials } from '../../../../db/schema';

/** Called inside the owner's disconnect transaction. Preserve exchange lock order. */
export async function revokeMoodlePairingPointer(db: Db, ownerUserId: string, issuer: string) {
  // Exchange locks code -> owner; deleting a code here (owner -> code) could deadlock.
  // Only the owner pointer is removed, so the exchange cannot reactivate a connection.
  await db.delete(ltiCredentials).where(and(eq(ltiCredentials.kind, 'moodle-pairing'),
    sql`${ltiCredentials.payload}->>'codeHash' IN (
      SELECT id FROM ${ltiCredentials} WHERE kind = 'moodle-pairing-code'
        AND payload->>'ownerUserId' = ${ownerUserId} AND payload->>'moodleUrl' = ${issuer}
    )`));
}
