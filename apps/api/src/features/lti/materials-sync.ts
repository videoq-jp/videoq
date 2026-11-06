import { ltiMaterialsEnabled } from "./config";
import { armMaintenance } from "../../lib/task-scheduler";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { lmsInstallations, ltiCredentials, users } from "../../db/schema";
import { activeLmsOwner } from "../../repositories/lms-installation-repository";
import { getLmsResource, syncLmsResource } from "../../repositories/lms-resource-repository";
import { presignR2Put } from "../../integrations/media";
import { confirmVideoUpload } from "../videos/service";
import type { Bindings } from "../../types/bindings";
import { MaterialsClient } from "./materials-client";
import { digest } from "./store";

/** Bounded JSON orchestration. Media is uploaded by the platform's background task. */
export async function synchronizeMaterials(env: Bindings, installationId: string, contextId: string) {
  const installation = await withDb(env, async db => (await db.select({ row: lmsInstallations }).from(lmsInstallations)
    .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
    .where(and(eq(lmsInstallations.id, installationId), eq(lmsInstallations.active, true), activeLmsOwner())))[0]?.row);
  if (!installation?.materialsService || !ltiMaterialsEnabled(env)) throw new Error("LTI materials connection unavailable");
  const leaseId = await digest("lti-materials-lease:" + installationId + ":" + contextId);
  const lease = crypto.randomUUID();
  const claimed = await withDb(env, db => db.insert(ltiCredentials).values({ id: leaseId, kind: "materials-lease",
    payload: { lease }, expiresAt: new Date(Date.now() + 600000) }).onConflictDoUpdate({ target: ltiCredentials.id,
      set: { payload: { lease }, expiresAt: new Date(Date.now() + 600000) },
      setWhere: sql`${ltiCredentials.expiresAt} < now()` }).returning({ id: ltiCredentials.id }));
  if (!claimed.length) return { busy: true, pending: true };
  try {
    const client = new MaterialsClient(env, { ...installation, materialsService: installation.materialsService });
    const snapshot = await client.manifest(contextId);
    let exports = 0, pending = false;
    for (const source of snapshot.resources) {
      // Every explicit tombstone is reconciled, even when the export batch is full.
      const reconciled = await syncLmsResource(env, installation, source.externalId, source.manifest);
      const data = await getLmsResource(env, installation, source.externalId);
      if (!source.manifest.enabled || data?.video?.status !== "uploading") {
        await client.acknowledge(contextId, source.externalId, source.manifest.generation,
          !source.manifest.enabled ? "disabled" : data?.resource.syncError ? "blocked" : data?.resource.kind === 'course' ? 'completed' : data?.video?.status ?? "awaiting_upload", data?.resource.syncError ?? null);
        continue;
      }
      pending = true;
      if (exports >= 5) continue;
      exports++;
      const generation = source.manifest.generation;
      const stateKey = await digest("lti-export:" + installationId + ":" + source.externalId + ":" + generation);
      const state = await withDb(env, async db => (await db.select().from(ltiCredentials)
        .where(and(eq(ltiCredentials.id, stateKey), sql`${ltiCredentials.expiresAt} > now()`)))[0]);
      let status: Awaited<ReturnType<MaterialsClient["exportStatus"]>>;
      if (typeof state?.payload.jobId === "string") status = await client.exportStatus(contextId, state.payload.jobId, generation);
      else {
        const attempt = typeof state?.payload.attempt === "string" ? state.payload.attempt : crypto.randomUUID();
        // Save the attempt before the HTTP request. A dropped response must not
        // create another platform job on the next reconciliation.
        if (!state) await withDb(env, db => db.insert(ltiCredentials).values({ id: stateKey, kind: "materials-export",
          payload: { installationId, contextId, attempt }, expiresAt: new Date(Date.now() + 3600000) })
          .onConflictDoUpdate({ target: ltiCredentials.id, set: { payload: { installationId, contextId, attempt }, expiresAt: new Date(Date.now() + 3600000) } }));
        const url = await presignR2Put(env, data.video.file, source.manifest.file!.contentType, source.manifest.file!.size);
        status = await client.startExport(contextId, source.externalId, generation, url, attempt);
        const jobId = status.jobId;
        await withDb(env, db => db.update(ltiCredentials).set({ payload: { installationId, contextId, attempt, jobId } }).where(eq(ltiCredentials.id, stateKey)));
      }
      if (status.status === "failed" || status.status === "stale") {
        await withDb(env, db => db.delete(ltiCredentials).where(eq(ltiCredentials.id, stateKey)));
        continue;
      }
      if (status.status !== "uploaded") continue;
      if (status.bytes !== source.manifest.file!.size) throw new Error("Invalid LTI export byte count");
      const current = await getLmsResource(env, installation, source.externalId);
      if (!current?.resource.enabled || current.resource.generation !== reconciled.generation || current.video?.id !== data.video.id) continue;
      // Confirmation verifies the actual object size and uses the existing quota/worker flow.
      const confirmed = await confirmVideoUpload(env, data.video.id, installation.ownerUserId);
      if (!("video" in confirmed)) throw new Error("LTI export confirmation failed");
    }
    await armMaintenance(env, Date.now());
    return { busy: false, pending };
  } finally {
    await withDb(env, db => db.delete(ltiCredentials).where(and(eq(ltiCredentials.id, leaseId), sql`${ltiCredentials.payload}->>'lease' = ${lease}`)));
  }
}

/** Poll enrolled platforms without requiring a learner to open a video first. */
export async function sweepMaterials(env: Bindings) {
  if (!ltiMaterialsEnabled(env)) return { synchronized: 0 };
  const connection = await withDb(env, db => db.transaction(async tx => {
    const [item] = await tx.select({ row: lmsInstallations }).from(lmsInstallations)
      .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
      .where(and(eq(lmsInstallations.active, true), isNotNull(lmsInstallations.materialsService),
        lte(lmsInstallations.nextMaterialsSyncAt, new Date().toISOString()), activeLmsOwner()))
      .orderBy(lmsInstallations.nextMaterialsSyncAt).limit(1).for("update", { of: lmsInstallations, skipLocked: true });
    if (!item) return null;
    await tx.update(lmsInstallations).set({ nextMaterialsSyncAt: new Date(Date.now() + 60000).toISOString() }).where(eq(lmsInstallations.id, item.row.id));
    return item.row;
  }));
  if (!connection?.materialsService) return { synchronized: 0 };
  const client = new MaterialsClient(env, { ...connection, materialsService: connection.materialsService });
  const contexts = [...new Set(await client.courses())].sort();
  if (!contexts.length) return { synchronized: 0 };
  const cursor = connection.materialsCursor % contexts.length;
  await synchronizeMaterials(env, connection.id, contexts[cursor]);
  await withDb(env, db => db.update(lmsInstallations).set({ materialsCursor: (cursor + 1) % contexts.length,
    nextMaterialsSyncAt: new Date(Date.now() + (contexts.length > 1 ? 10000 : 30000)).toISOString() }).where(eq(lmsInstallations.id, connection.id)));
  return { synchronized: 1 };
}
