import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields } from "../../db/d1/query-builders";
import {
  lmsInstallations,
  ltiCredentials,
  users,
} from "../../db/schema/sqlite";
import type { PrivacyAuthorizationRepository } from "../contracts/privacy-authorization-repository";
export function createD1PrivacyAuthorizationRepository(
  database: D1Database,
): PrivacyAuthorizationRepository {
  const db = createD1Connection(database);
  return {
    async findInstallation(identity) {
      return (
        (await db
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
          .get()) ?? null
      );
    },
    async consumeNonce(r, nonce, action, expiresAt) {
      const rows = await db
        .insert(ltiCredentials)
        .select(
          db
            .select(
              insertSelectFields(ltiCredentials, {
                id: sql`${nonce}`,
                kind: sql`'lti-privacy-nonce'`,
                payload: sql`${JSON.stringify({ installationId: r.id, action })}`,
                expiresAt: sql`${expiresAt.toISOString()}`,
              }),
            )
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
                sql`julianday(${expiresAt.toISOString()})>julianday('now')`,
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ id: ltiCredentials.id });
      return rows.length === 1;
    },
  };
}
