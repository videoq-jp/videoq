import { materialsServiceSchema } from "../lti/materials-client";
import { ltiConfig, ltiMaterialsEnabled } from "../lti/config";
import { ensureToolKeys } from "../lti/tool-keys";
import { presignR2Put } from "../../integrations/media";
import { armMaintenance } from "../../lib/task-scheduler";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { withDb } from "../../db/pool";
import { lmsInstallations, ltiCredentials, users } from "../../db/schema";
import { activeLmsOwner } from "../../repositories/lms-installation-repository";
import type { Bindings } from "../../types/bindings";
import { digest, randomSecret } from "../lti/store";
import { LmsSyncError } from "./resource";

export const moodleUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "An HTTPS Moodle URL is required").transform(value => value.replace(/\/+$/, ""));
export const pairingRequestSchema = z.object({ moodleUrl: moodleUrlSchema }).strict();
export const pairingExchangeSchema = z.object({
  secret: z.string().regex(/^[a-f0-9]{64}$/), issuer: moodleUrlSchema,
  clientId: z.string().trim().min(1).max(255), deploymentId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  syncToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mode: z.enum(["legacy", "materials"]).default("legacy"),
  materialsService: materialsServiceSchema.optional(),
}).strict().refine(value => value.mode === "materials" ? value.syncToken === undefined && Boolean(value.materialsService) && Object.values(value.materialsService!).every(endpoint => endpoint.startsWith(value.issuer + "/") && new URL(endpoint).origin === new URL(value.issuer).origin) : Boolean(value.syncToken) && value.materialsService === undefined, "Invalid connection authentication mode");
const pairingPayloadSchema = z.object({ ownerUserId: z.string().min(1), moodleUrl: moodleUrlSchema, mode: z.enum(["legacy", "materials"]).default("legacy") });
export const PAIRING_SECONDS = 600;

/** No raw code is retained. Its account and exact Moodle base URL are fixed here. */
export async function issueMoodlePairing(env: Bindings, ownerUserId: string, moodleUrl: string, toolOrigin: string) {
  const mode = ltiMaterialsEnabled(env) ? "materials" : "legacy";
  const secret = randomSecret();
  const expiresAt = new Date(Date.now() + PAIRING_SECONDS * 1000);
  await withDb(env, db => db.transaction(async tx => {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, ownerUserId), activeLmsOwner())).for("update");
    if (!owner) throw new LmsSyncError(403, "INACTIVE_ACCOUNT");
    if (mode === "materials") await ensureToolKeys(env, tx);
    // Only the most recently issued unused code for this account remains valid.
    await tx.delete(ltiCredentials).where(and(eq(ltiCredentials.kind, "moodle-pairing"),
      eq(ltiCredentials.id, await digest("moodle-pairing-owner:" + ownerUserId))));
    await tx.insert(ltiCredentials).values({ id: await digest("moodle-pairing:" + secret), kind: "moodle-pairing-code",
      payload: { ownerUserId, moodleUrl, mode }, expiresAt });
    await tx.insert(ltiCredentials).values({ id: await digest("moodle-pairing-owner:" + ownerUserId), kind: "moodle-pairing",
      payload: { codeHash: await digest("moodle-pairing:" + secret) }, expiresAt });
  }));
  // Copyable text, not a URL: credentials never enter request paths or referrers.
  const code = (mode === "materials" ? "VIDEOQ2." : "VIDEOQ1.") + btoa(JSON.stringify({ origin: toolOrigin, secret }));
  return { code, moodleUrl, expiresAt: expiresAt.toISOString() };
}

/** Consuming the code and provisioning the connection commit atomically. */
export async function exchangeMoodlePairing(env: Bindings, rawInput: z.input<typeof pairingExchangeSchema>) {
  const input = pairingExchangeSchema.parse(rawInput);
  const codeHash = await digest("moodle-pairing:" + input.secret);
  const receiptId = await digest("lti-materials-pairing:" + input.secret);
  const settings = async (ownerUserId: string, installationId: string) => {
    const url = new URL(await presignR2Put(env, `videos/${ownerUserId}/policy`, "video/mp4", 1));
    return { installationId, toolOrigin: ltiConfig(env)!.toolOrigin,
      uploadTargets: [{ origin: url.origin, prefix: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) }] };
  };
  const result = await withDb(env, db => db.transaction(async tx => {
    if (input.mode === "materials") {
      if (!ltiMaterialsEnabled(env)) throw new LmsSyncError(403, "LTI_MATERIALS_DISABLED");
      const [receipt] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, receiptId),
        eq(ltiCredentials.kind, "materials-pairing"), gt(ltiCredentials.expiresAt, new Date())));
      if (receipt && receipt.payload.issuer === input.issuer && receipt.payload.clientId === input.clientId && receipt.payload.deploymentId === input.deploymentId) {
        const [connection] = await tx.select({ id: lmsInstallations.id, ownerUserId: lmsInstallations.ownerUserId }).from(lmsInstallations)
          .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
          .where(and(eq(lmsInstallations.id, String(receipt.payload.installationId)), eq(lmsInstallations.active, true), activeLmsOwner()));
        if (connection) return { installationId: connection.id, ownerUserId: connection.ownerUserId };
        throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
      }
    }
    const [row] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, codeHash),
      eq(ltiCredentials.kind, "moodle-pairing-code"), gt(ltiCredentials.expiresAt, new Date()))).for("update");
    const payload = pairingPayloadSchema.safeParse(row?.payload);
    if (!payload.success || payload.data.moodleUrl !== input.issuer || payload.data.mode !== input.mode) throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
    const ownerKey = await digest("moodle-pairing-owner:" + payload.data.ownerUserId);
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, payload.data.ownerUserId), activeLmsOwner())).for("update");
    if (!owner) throw new LmsSyncError(403, "INACTIVE_ACCOUNT");
    // Recheck after locking the owner: a concurrent code issuance can revoke this code.
    const [current] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, ownerKey),
      eq(ltiCredentials.kind, "moodle-pairing"), gt(ltiCredentials.expiresAt, new Date())));
    if (current?.payload.codeHash !== codeHash) throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
    const [existing] = await tx.select({ id: lmsInstallations.id, ownerUserId: lmsInstallations.ownerUserId }).from(lmsInstallations)
      .where(and(eq(lmsInstallations.issuer, input.issuer), eq(lmsInstallations.clientId, input.clientId)));
    if (existing && (input.mode !== "materials" || existing.ownerUserId !== owner.id)) throw new LmsSyncError(409, "CONNECTION_EXISTS");
    const installationId = existing?.id ?? crypto.randomUUID();
    const values = { id: installationId, ownerUserId: owner.id, name: input.issuer,
      issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId,
      authorizationUrl: input.issuer + "/mod/lti/auth.php", jwksUrl: input.issuer + "/mod/lti/certs.php",
      syncTokenHash: input.mode === "materials" ? null : await digest(input.syncToken!),
      ...(input.mode === "materials" ? { materialsService: input.materialsService! } : {}) };
    if (existing) await tx.update(lmsInstallations).set({ ...values, active: true }).where(eq(lmsInstallations.id, existing.id));
    else await tx.insert(lmsInstallations).values(values);
    if (input.mode === "materials") await tx.insert(ltiCredentials).values({ id: receiptId, kind: "materials-pairing", expiresAt: new Date(Date.now() + PAIRING_SECONDS * 1000),
      payload: { installationId, issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId } });
    await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, codeHash));
    await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, ownerKey));
    return { installationId, ownerUserId: owner.id };
  }));
  if (input.mode === "materials") {
    await armMaintenance(env, Date.now());
    return settings(result.ownerUserId, result.installationId);
  }
  return { installationId: result.installationId };
}
