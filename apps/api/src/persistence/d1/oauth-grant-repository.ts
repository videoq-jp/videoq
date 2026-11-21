import { and, eq, inArray, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { runD1Batch, withMaterialized } from "../../db/d1/query-builders";
import {
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
} from "../../db/schema/sqlite";
import type { OAuthGrantRepository } from "../contracts/oauth-grant-repository";
export function createD1OAuthGrantRepository(
  database: D1Database,
): OAuthGrantRepository {
  const db = createD1Connection(database);
  return {
    async revoke(userId, consentId) {
      const target = db
        .select({ clientId: oauthConsent.clientId })
        .from(oauthConsent)
        .where(
          and(eq(oauthConsent.id, consentId), eq(oauthConsent.userId, userId)),
        );
      const frozen = db
        .select({ clientId: sql<string>`client_id` })
        .from(sql`${sql.identifier("target")}`);
      const result = await runD1Batch<{ id: string }>(database, [
        db
          .delete(oauthAccessToken)
          .where(
            and(
              eq(oauthAccessToken.userId, userId),
              inArray(oauthAccessToken.clientId, target),
            ),
          ),
        db
          .delete(oauthRefreshToken)
          .where(
            and(
              eq(oauthRefreshToken.userId, userId),
              inArray(oauthRefreshToken.clientId, target),
            ),
          ),
        withMaterialized(
          "target",
          target,
          db
            .delete(oauthConsent)
            .where(
              and(
                eq(oauthConsent.userId, userId),
                inArray(oauthConsent.clientId, frozen),
              ),
            )
            .returning({ id: oauthConsent.id }),
        ),
      ]).catch(() => {
        throw new Error("OAuth grant revocation persistence failed.");
      });
      return result[2].results.some((row) => row.id === consentId);
    },
  };
}
