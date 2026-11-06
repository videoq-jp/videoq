import { and, eq, isNull, sql } from "drizzle-orm";
import { withDb } from "../db/pool";
import { lmsInstallations, ltiCredentials, users } from "../db/schema";
import { newSyncToken, provisionInstallationSchema, syncTokenHash, type ProvisionInstallation } from "../features/lms/installation";
import type { Bindings } from "../types/bindings";

/** The same active-account policy is used for synchronization and LTI access. */
export function activeLmsOwner() {
  return sql`${users.isActive} = true AND ${users.deactivatedAt} IS NULL
    AND (${users.banned} IS NOT TRUE OR ${users.banExpires} <= now())`;
}

/** Returns a credential once. No user or teacher account is created. */
export async function provisionLmsInstallation(env: Bindings, input: ProvisionInstallation) {
  const registration = provisionInstallationSchema.parse(input);
  const token = newSyncToken();
  const hash = (await syncTokenHash(token))!;
  return withDb(env, async db => db.transaction(async tx => {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, registration.ownerUserId), activeLmsOwner()))
      .for("update");
    if (!owner) throw new Error("Active VideoQ account not found");
    await tx.insert(lmsInstallations).values({ ...registration, syncTokenHash: hash });
    return { installationId: registration.id, token };
  }));
}

/** Always checks both revocation switches. Call on every synchronization request. */
export async function authenticateLmsInstallation(env: Bindings, token: string) {
  const hash = await syncTokenHash(token);
  if (!hash) return null;
  return withDb(env, async db => {
    const [installation] = await db.select({
      id: lmsInstallations.id,
      ownerUserId: lmsInstallations.ownerUserId,
      issuer: lmsInstallations.issuer,
      clientId: lmsInstallations.clientId,
      deploymentId: lmsInstallations.deploymentId,
    }).from(lmsInstallations)
      .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
      .where(and(eq(lmsInstallations.syncTokenHash, hash), isNull(lmsInstallations.materialsService), eq(lmsInstallations.active, true), activeLmsOwner()))
      .limit(1);
    return installation ?? null;
  });
}

/** Rotation invalidates the previous credential without changing LTI identifiers. */
export async function rotateLmsSyncToken(env: Bindings, ownerUserId: string, installationId: string) {
  const token = newSyncToken();
  const hash = (await syncTokenHash(token))!;
  return withDb(env, async db => {
    const [updated] = await db.update(lmsInstallations).set({ syncTokenHash: hash })
      .where(and(eq(lmsInstallations.id, installationId), eq(lmsInstallations.ownerUserId, ownerUserId), isNull(lmsInstallations.materialsService)))
      .returning({ id: lmsInstallations.id });
    return updated ? { installationId: updated.id, token } : null;
  });
}

/** Revoke future sync/LTI requests while retaining all courses, videos and credentials. */
export async function disconnectLmsInstallation(env: Bindings, ownerUserId: string, installationId: string) {
  return withDb(env, db => db.transaction(async tx => {
    // Match synchronization's lock order so an in-flight manifest finishes before revocation.
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, ownerUserId), activeLmsOwner())).for("update");
    if (!owner) return false;
    const [row] = await tx.update(lmsInstallations).set({ active: false })
      .where(and(eq(lmsInstallations.id, installationId), eq(lmsInstallations.ownerUserId, ownerUserId)))
      .returning({ id: lmsInstallations.id, issuer: lmsInstallations.issuer });
    // Revoke the owner pointer rather than locking a code row. Exchange locks
    // code -> owner, so deleting the code here (owner -> code) could deadlock.
    if (row) await tx.delete(ltiCredentials).where(and(eq(ltiCredentials.kind, "moodle-pairing"),
      sql`${ltiCredentials.payload}->>'codeHash' IN (
        SELECT id FROM ${ltiCredentials} WHERE kind = 'moodle-pairing-code'
          AND payload->>'ownerUserId' = ${ownerUserId} AND payload->>'moodleUrl' = ${row.issuer}
      )`));
    return Boolean(row);
  }));
}
