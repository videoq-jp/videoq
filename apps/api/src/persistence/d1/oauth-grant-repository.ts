import type { OAuthGrantRepository } from "../contracts/oauth-grant-repository";

export function createD1OAuthGrantRepository(database: D1Database): OAuthGrantRepository {
  return {
    async revoke(userId, consentId) {
      // No read-before-batch: the owned grant is resolved inside the same atomic
      // operation as the deletions. Keep consent until the final statement.
      const target = "SELECT client_id FROM oauth_consent WHERE id=? AND user_id=?";
      const result = await database.batch<{ id: string }>([
        database.prepare(`DELETE FROM oauth_access_token WHERE user_id=? AND client_id IN (${target})`).bind(userId, consentId, userId),
        database.prepare(`DELETE FROM oauth_refresh_token WHERE user_id=? AND client_id IN (${target})`).bind(userId, consentId, userId),
        // Materialize the target before deleting any consent rows: deleting the
        // selected row must not hide other grants for this same user/client.
        database.prepare(`WITH target AS MATERIALIZED (${target})
          DELETE FROM oauth_consent WHERE user_id=? AND client_id IN (SELECT client_id FROM target) RETURNING id`).bind(consentId, userId, userId),
      ]).catch(() => {
        // SQL/driver exceptions can contain identifiers or credential values.
        throw new Error("OAuth grant revocation persistence failed.");
      });
      return result[2].results.some(row => row.id === consentId);
    },
  };
}
