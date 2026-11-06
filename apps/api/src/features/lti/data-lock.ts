import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Db } from '../../db/pool';
import { ApiError } from '../../shared/errors';

/** Server-derived proof of the current stored LTI session, never browser input. */
export type LtiSessionProof = { sessionHash: string; registrationId: string; subjectHash: string };
export function ltiSessionProof(grant: { registrationId: string; subjectHash: string }, sessionHash: string): LtiSessionProof {
  if (!/^[a-f0-9]{64}$/.test(sessionHash) || !/^[a-f0-9]{64}$/.test(grant.subjectHash))
    throw new ApiError(403, 'FORBIDDEN', 'The Moodle session is unavailable.');
  return { sessionHash, registrationId: grant.registrationId, subjectHash: grant.subjectHash };
}

/** Owner first, then session: erasure takes the same owner lock exclusively. */
export function ltiSessionRows(ownerUserId: string, proof: LtiSessionProof): SQL {
  ltiSessionProof(proof, proof.sessionHash);
  return sql`WITH owner AS MATERIALIZED (
    SELECT id FROM users WHERE id=${ownerUserId} FOR SHARE
  ) SELECT c.id FROM owner JOIN lti_credentials c ON c.id=${proof.sessionHash}
    WHERE c.kind='session' AND c.expires_at>now()
      AND c.payload->>'registrationId'=${proof.registrationId}
      AND c.payload->>'subjectHash'=${proof.subjectHash} FOR SHARE OF c`;
}

/** Call within the write/read transaction before course or conversation locks. */
export async function lockLtiDataSessionWithDb(db: Db, ownerUserId: string, proof?: LtiSessionProof) {
  if (!proof) return;
  if (!(await db.execute(ltiSessionRows(ownerUserId, proof))).rows.length)
    throw new ApiError(403, 'FORBIDDEN', 'The Moodle session is unavailable.');
}
export const lockLtiDataSession = (client: pg.Client, ownerUserId: string, proof?: LtiSessionProof) =>
  lockLtiDataSessionWithDb(drizzle(client), ownerUserId, proof);
