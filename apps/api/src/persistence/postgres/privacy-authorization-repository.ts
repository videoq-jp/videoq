import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { lmsInstallations, ltiCredentials, users } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import type { PrivacyAuthorizationRepository } from "../contracts/privacy-authorization-repository";
export function createPostgresPrivacyAuthorizationRepository(
  env: Bindings,
): PrivacyAuthorizationRepository {
  return {
    findInstallation: (identity) =>
      withDb(env, async (db) => {
        const [row] = await db
          .select({
            id: lmsInstallations.id,
            ownerUserId: lmsInstallations.ownerUserId,
            issuer: lmsInstallations.issuer,
            clientId: lmsInstallations.clientId,
            deploymentId: lmsInstallations.deploymentId,
            jwksUrl: lmsInstallations.jwksUrl,
          })
          .from(lmsInstallations)
          .where(
            and(
              eq(lmsInstallations.issuer, identity.issuer),
              eq(lmsInstallations.clientId, identity.clientId),
              eq(lmsInstallations.deploymentId, identity.deploymentId),
            ),
          )
          .limit(1);
        return row ?? null;
      }),
    consumeNonce: (r, nonce, action, expiresAt) =>
      withDb(env, async (db) => {
        const rows = await db
          .insert(ltiCredentials)
          .select(
            db
              .select({
                id: sql<string>`${nonce}`.as("id"),
                kind: sql<string>`'lti-privacy-nonce'`.as("kind"),
                payload:
                  sql`${JSON.stringify({ installationId: r.id, action })}::jsonb`.as(
                    "payload",
                  ),
                expiresAt: sql`${expiresAt.toISOString()}::timestamptz`.as(
                  "expires_at",
                ),
              })
              .from(lmsInstallations)
              .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
              .where(
                and(
                  eq(lmsInstallations.id, r.id),
                  eq(lmsInstallations.ownerUserId, r.ownerUserId),
                  eq(lmsInstallations.issuer, r.issuer),
                  eq(lmsInstallations.clientId, r.clientId),
                  eq(lmsInstallations.deploymentId, r.deploymentId),
                  eq(lmsInstallations.jwksUrl, r.jwksUrl),
                  sql`${expiresAt.toISOString()}::timestamptz>clock_timestamp()`,
                ),
              ),
          )
          .onConflictDoNothing()
          .returning({ id: ltiCredentials.id });
        return rows.length === 1;
      }),
  };
}
