import { alias } from "drizzle-orm/sqlite-core";
import { insertSelectValues, runD1Batch } from "../../db/d1/query-builders";
import {
  managementSystemAdministrator,
  managementConnectionActive,
} from "../../application/lms-management";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import { activeD1LmsOwner } from "./lms-owner-policy";
import { and, eq, isNull, sql, exists, inArray } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  teachingConnections,
  lmsInstallations,
  users,
  ltiCredentials,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import type { LmsInstallationRepository } from "../contracts/lms-installation-repository";
const active = activeD1LmsOwner();
export function createD1LmsInstallationRepository(
  database: D1Database,
): LmsInstallationRepository {
  const db = createD1Connection(database);
  return {
    managementAccess(userId, identity) {
      return (async (db) => {
        const [user] = await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!user) return null;
        const [connection] = await db
          .select({
            active:
              sql<boolean>`${managementConnectionActive(sql`${lmsInstallations.active}`, sql`${teachingConnections.active}`, mediaDrizzleLogic)}`.mapWith(
                Boolean,
              ),
          })
          .from(lmsInstallations)
          .innerJoin(
            teachingConnections,
            and(
              eq(teachingConnections.provider, "moodle"),
              eq(teachingConnections.installationId, lmsInstallations.id),
              eq(teachingConnections.ownerUserId, userId),
            ),
          )
          .where(
            and(
              eq(lmsInstallations.issuer, identity.issuer),
              eq(lmsInstallations.clientId, identity.clientId),
              eq(lmsInstallations.deploymentId, identity.deploymentId),
            ),
          )
          .limit(1);
        return {
          systemAdmin: managementSystemAdministrator(user.role),
          connectionActive: connection?.active ?? null,
        };
      })(db);
    },
    async insert(p) {
      const [row] = await db
        .insert(lmsInstallations)
        .select(
          db
            .select(
              insertSelectValues(lmsInstallations, {
                id: p.id,
                ownerUserId: p.ownerUserId,
                name: p.name,
                issuer: p.issuer,
                clientId: p.clientId,
                deploymentId: p.deploymentId,
                authorizationUrl: p.authorizationUrl,
                jwksUrl: p.jwksUrl,
                syncTokenHash: p.syncTokenHash,
                materialsService: p.materialsService ?? null,
              }),
            )
            .from(users)
            .where(and(eq(users.id, p.ownerUserId), active)),
        )
        .returning({ id: lmsInstallations.id });
      if (!row) throw new Error("Active VideoQ account not found");
    },
    async authenticate(hash) {
      return (
        (
          await db
            .select({
              id: lmsInstallations.id,
              issuer: lmsInstallations.issuer,
              clientId: lmsInstallations.clientId,
              deploymentId: lmsInstallations.deploymentId,
            })
            .from(lmsInstallations)
            .where(
              and(
                eq(lmsInstallations.syncTokenHash, hash),
                isNull(lmsInstallations.materialsService),
                eq(lmsInstallations.active, true),
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    },
    async rotate(ownerUserId, installationId, hash) {
      return (
        (
          await db
            .update(lmsInstallations)
            .set({ syncTokenHash: hash })
            .where(
              and(
                eq(lmsInstallations.id, installationId),
                eq(lmsInstallations.ownerUserId, ownerUserId),
                isNull(lmsInstallations.materialsService),
              ),
            )
            .returning({ id: lmsInstallations.id })
        )[0]?.id ?? null
      );
    },
    async disconnect(ownerUserId, installationId) {
      const token = crypto.randomUUID();
      const gate = exists(
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
      );
      const code = alias(ltiCredentials, "pairing_code");
      const codeIds = db
        .select({ id: code.id })
        .from(code)
        .innerJoin(lmsInstallations, eq(lmsInstallations.id, installationId))
        .where(
          and(
            eq(code.kind, "moodle-pairing-code"),
            sql`json_extract(${code.payload},'$.ownerUserId')=${ownerUserId}`,
            sql`json_extract(${code.payload},'$.moodleUrl')=${lmsInstallations.issuer}`,
          ),
        );
      const results = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "lms_disconnect",
                resourceId: 0,
              }),
            )
            .from(lmsInstallations)
            .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
            .where(
              and(
                eq(lmsInstallations.id, installationId),
                eq(users.id, ownerUserId),
                active,
              ),
            ),
        ),
        db
          .update(lmsInstallations)
          .set({ active: false })
          .where(and(eq(lmsInstallations.id, installationId), gate)),
        db
          .delete(ltiCredentials)
          .where(
            and(
              eq(ltiCredentials.kind, "moodle-pairing"),
              inArray(
                sql<string>`json_extract(${ltiCredentials.payload},'$.codeHash')`,
                codeIds,
              ),
              gate,
            ),
          ),
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return Boolean(results[3].results.length);
    },
    async listActive(ownerUserId) {
      return db
        .select({
          id: lmsInstallations.id,
          moodleUrl: lmsInstallations.issuer,
          active: lmsInstallations.active,
        })
        .from(lmsInstallations)
        .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
        .where(
          and(
            eq(lmsInstallations.ownerUserId, ownerUserId),
            eq(lmsInstallations.active, true),
            active,
          ),
        );
    },
  };
}
