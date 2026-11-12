import { withClient } from "../../db/pool";
import { ApiError } from "../../shared/errors";
import type { Bindings } from "../../types/bindings";
import { sessionRecord } from "../lti/protocol";
import type { LearningAuthorization } from "../lti/session-authorization";

type NativeSessionInput = {
  ownerUserId: string; grant: LearningAuthorization["grant"]; sessionHash: string; markerHash: string;
  nonceHash: string; nonceExpiresAt: Date; expiresAt: Date;
};
const denied = () => new ApiError(403, "FORBIDDEN", "The LMS learning session is unavailable.");

/** The owner lock matches subject erasure. Existing session payloads, including
 * their atomic scope union, are never overwritten. A one-time marker survives
 * deletion of the session so an in-flight request cannot resurrect it. Markers
 * contain no subject metadata and expire shortly after the original session.
 */
export async function ensureNativeSession(env: Bindings, input: NativeSessionInput): Promise<void> {
  await withClient(env, async client => {
    await client.query("BEGIN");
    try {
      if (!(await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [input.ownerUserId])).rowCount) throw denied();
      const nonce = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
        VALUES($1,'moodle-native-request','{}',$2) ON CONFLICT DO NOTHING RETURNING id`,
      [input.nonceHash, input.nonceExpiresAt]);
      if (nonce.rowCount !== 1) throw denied();
      const marker = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
        VALUES($1,'moodle-native-started','{}',$2) ON CONFLICT DO NOTHING RETURNING id`,
      [input.markerHash, new Date(input.expiresAt.getTime() + 120_000)]);
      if (marker.rowCount === 1) {
        const created = await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
          VALUES($1,'session',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
        [input.sessionHash, JSON.stringify(input.grant), input.expiresAt]);
        if (created.rowCount !== 1) throw denied();
      }
      const existing = await client.query<{ payload: unknown; expiresAt: Date }>(
        `SELECT payload,expires_at AS "expiresAt" FROM lti_credentials
          WHERE id=$1 AND kind='session' AND expires_at>now() FOR SHARE`, [input.sessionHash]);
      const stored = sessionRecord.safeParse(existing.rows[0]?.payload);
      if (!stored.success || stored.data.transport !== "native" ||
          existing.rows[0].expiresAt.getTime() !== input.expiresAt.getTime()) throw denied();
      for (const field of ["registrationId", "registrationHash", "subjectHash", "deploymentId", "contextId",
        "resourceLinkId", "courseId", "videoId", "resourceGeneration", "serviceSubject"] as const) {
        if (stored.data[field] !== input.grant[field]) throw denied();
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
