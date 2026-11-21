import {
  and,
  eq,
  inArray,
  exists,
  notExists,
  isNull,
  isNotNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  insertSelectFields,
} from "../../db/d1/query-builders";
import {
  lmsInstallations as installations,
  ltiCredentials as credentials,
  users,
  videos,
  lmsResources,
  teachingConnections,
  videoCourses,
  externalTasks,
} from "../../db/schema/sqlite";
import { activeD1LmsOwner } from "./lms-owner-policy";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import type {
  MaterialsSyncRepository,
  MaterialsConnection,
  MaterialsLease,
} from "../contracts/materials-sync-repository";
import { MaterialsLeaseLostError } from "../contracts/materials-sync-repository";
const configuration = (i: {
  ownerUserId: SQLWrapper;
  clientId: SQLWrapper;
  deploymentId: SQLWrapper;
  materialsService: SQLWrapper;
}) =>
  sql`json_object('owner',${i.ownerUserId},'client',${i.clientId},'deployment',${i.deploymentId},'service',json(${i.materialsService}))`;
export function d1MaterialsLease(
  lease: MaterialsLease,
  kind?: "materials-lease" | "materials-poll",
) {
  const db = new QueryBuilder(),
    c = alias(credentials, "material_lease"),
    i = alias(installations, "lease_installation"),
    owner = alias(users, "lease_owner");
  return exists(
    db
      .select({ id: c.id })
      .from(c)
      .innerJoin(
        i,
        eq(i.id, sql`json_extract(${c.payload},'$.installationId')`),
      )
      .innerJoin(owner, eq(owner.id, i.ownerUserId))
      .where(
        and(
          eq(c.id, lease.id),
          eq(i.id, lease.installationId),
          eq(sql`json_extract(${c.payload},'$.lease')`, lease.token),
          kind
            ? eq(c.kind, kind)
            : inArray(c.kind, ["materials-lease", "materials-poll"]),
          sql`julianday(${c.expiresAt})>julianday('now')`,
          eq(i.active, true),
          isNotNull(i.materialsService),
          sql`json(json_extract(${c.payload},'$.configuration'))=${configuration(i)}`,
        ),
      ),
  );
}
const projection = {
  id: installations.id,
  ownerUserId: installations.ownerUserId,
  clientId: installations.clientId,
  deploymentId: installations.deploymentId,
  service: sql<string>`${installations.materialsService}`,
  materialsCursor: installations.materialsCursor,
};
const connection = (
  row: Omit<MaterialsConnection, "materialsService"> & { service: string },
): MaterialsConnection => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  clientId: row.clientId,
  deploymentId: row.deploymentId,
  materialsService: JSON.parse(
    row.service,
  ) as MaterialsConnection["materialsService"],
  materialsCursor: row.materialsCursor,
});
export function createD1MaterialsSyncRepository(
  database: D1Database,
): MaterialsSyncRepository {
  const db = createD1Connection(database),
    active = and(
      eq(installations.active, true),
      isNotNull(installations.materialsService),
    );
  const leasePayload = (token: string) =>
    sql`json_object('lease',${token},'installationId',${installations.id},'configuration',${configuration(installations)})`;
  const exportMatch = (lease: MaterialsLease, key: string) =>
    and(
      eq(credentials.id, key),
      eq(credentials.kind, "materials-export"),
      eq(
        sql`json_extract(${credentials.payload},'$.installationId')`,
        lease.installationId,
      ),
    );
  return {
    async claimContext(installationId, leaseId, token) {
      const lease = { id: leaseId, token, installationId };
      const result = await db.batch([
        db
          .insert(credentials)
          .select(
            db
              .select(
                insertSelectFields(credentials, {
                  id: sql`${leaseId}`,
                  kind: sql`'materials-lease'`,
                  payload: leasePayload(token),
                  expiresAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')`,
                }),
              )
              .from(installations)
              .innerJoin(users, eq(users.id, installations.ownerUserId))
              .where(and(eq(installations.id, installationId), active)),
          )
          .onConflictDoUpdate({
            target: credentials.id,
            set: {
              payload: sql`excluded.payload`,
              expiresAt: sql`excluded.expires_at`,
            },
            setWhere: and(
              eq(credentials.kind, "materials-lease"),
              sql`julianday(${credentials.expiresAt})<julianday('now')`,
            ),
          }),
        db
          .select(projection)
          .from(installations)
          .innerJoin(users, eq(users.id, installations.ownerUserId))
          .where(
            and(
              eq(installations.id, installationId),
              d1MaterialsLease(lease, "materials-lease"),
            ),
          ),
        db
          .select(projection)
          .from(installations)
          .innerJoin(users, eq(users.id, installations.ownerUserId))
          .where(and(eq(installations.id, installationId), active)),
      ]);
      const row = result[1][0];
      return row
        ? { status: "claimed", lease, connection: connection(row) }
        : { status: result[2].length ? "busy" : "unavailable" };
    },
    async owns(lease) {
      return Boolean(
        await db
          .select({ id: credentials.id })
          .from(credentials)
          .where(and(eq(credentials.id, lease.id), d1MaterialsLease(lease)))
          .get(),
      );
    },
    async release(lease) {
      await db
        .delete(credentials)
        .where(
          and(
            eq(credentials.id, lease.id),
            inArray(credentials.kind, ["materials-lease", "materials-poll"]),
            eq(
              sql`json_extract(${credentials.payload},'$.lease')`,
              lease.token,
            ),
          ),
        );
    },
    async prepareExport(lease, key, contextId, attempt) {
      const result = await db.batch([
        db
          .insert(credentials)
          .select(
            db
              .select(
                insertSelectValues(credentials, {
                  id: key,
                  kind: "materials-export",
                  payload: {
                    installationId: lease.installationId,
                    contextId,
                    attempt,
                  },
                  expiresAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')`,
                }),
              )
              .from(installations)
              .where(
                and(
                  eq(installations.id, lease.installationId),
                  d1MaterialsLease(lease, "materials-lease"),
                ),
              ),
          )
          .onConflictDoUpdate({
            target: credentials.id,
            set: {
              payload: sql`excluded.payload`,
              expiresAt: sql`excluded.expires_at`,
            },
            setWhere: and(
              eq(credentials.kind, "materials-export"),
              sql`julianday(${credentials.expiresAt})<=julianday('now')`,
            ),
          }),
        db
          .select({ payload: credentials.payload })
          .from(credentials)
          .where(
            and(
              exportMatch(lease, key),
              sql`julianday(${credentials.expiresAt})>julianday('now')`,
              eq(
                sql`json_extract(${credentials.payload},'$.contextId')`,
                contextId,
              ),
              d1MaterialsLease(lease, "materials-lease"),
            ),
          ),
      ]);
      const payload = result[1][0]?.payload;
      if (!payload || typeof payload.attempt !== "string")
        throw new MaterialsLeaseLostError();
      return {
        attempt: payload.attempt,
        ...(typeof payload.jobId === "string" ? { jobId: payload.jobId } : {}),
      };
    },
    async saveExportJob(lease, key, attempt, jobId) {
      return Boolean(
        await db
          .update(credentials)
          .set({
            payload: sql`json_set(${credentials.payload},'$.jobId',${jobId})`,
          })
          .where(
            and(
              exportMatch(lease, key),
              sql`julianday(${credentials.expiresAt})>julianday('now')`,
              eq(
                sql`json_extract(${credentials.payload},'$.attempt')`,
                attempt,
              ),
              d1MaterialsLease(lease, "materials-lease"),
            ),
          )
          .returning({ id: credentials.id })
          .get(),
      );
    },
    async deleteExport(lease, key, attempt) {
      return Boolean(
        await db
          .delete(credentials)
          .where(
            and(
              exportMatch(lease, key),
              eq(
                sql`json_extract(${credentials.payload},'$.attempt')`,
                attempt,
              ),
              d1MaterialsLease(lease, "materials-lease"),
            ),
          )
          .returning({ id: credentials.id })
          .get(),
      );
    },
    async confirmUpload(lease, upload) {
      const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
          video_id: upload.videoId,
        }),
        dedupeKey = `job:${message.job_id}`;
      const resource = exists(
        db
          .select({ id: lmsResources.id })
          .from(lmsResources)
          .innerJoin(
            teachingConnections,
            and(
              eq(teachingConnections.provider, "moodle"),
              eq(
                teachingConnections.installationId,
                lmsResources.installationId,
              ),
              eq(teachingConnections.contextId, lmsResources.contextId),
              eq(teachingConnections.courseId, lmsResources.courseId),
              eq(teachingConnections.active, true),
              isNull(teachingConnections.resourceLinkId),
            ),
          )
          .innerJoin(
            videoCourses,
            and(
              eq(videoCourses.id, teachingConnections.courseId),
              eq(videoCourses.userId, teachingConnections.ownerUserId),
            ),
          )
          .innerJoin(
            users,
            and(
              eq(users.id, teachingConnections.ownerUserId),
              activeD1LmsOwner(),
            ),
          )
          .where(
            and(
              eq(lmsResources.videoId, videos.id),
              eq(lmsResources.installationId, lease.installationId),
              eq(lmsResources.externalId, upload.externalId),
              eq(lmsResources.generation, upload.generation),
              eq(lmsResources.enabled, true),
              eq(videos.userId, teachingConnections.ownerUserId),
            ),
          ),
      );
      const result = await db.batch([
        db.insert(externalTasks).select(
          db
            .select(
              insertSelectValues(externalTasks, {
                kind: "sqs_job",
                payload: { message },
                dedupeKey,
              }),
            )
            .from(videos)
            .where(
              and(
                eq(videos.id, upload.videoId),
                eq(videos.file, upload.fileKey),
                eq(videos.status, "uploading"),
                resource,
                d1MaterialsLease(lease, "materials-lease"),
              ),
            ),
        ),
        db
          .update(videos)
          .set({ status: "pending", errorMessage: "" })
          .where(and(eq(videos.id, upload.videoId), sql`changes()=1`)),
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(eq(externalTasks.dedupeKey, dedupeKey)),
      ]);
      const task = result[2][0];
      return task
        ? {
            videoId: upload.videoId,
            taskId: Number(task.id),
            jobId: message.job_id,
          }
        : false;
    },
    async claimNext(token) {
      const c = alias(credentials, "poll_lease"),
        pollId = sql<string>`'lti-materials-poll:'||${installations.id}`;
      const result = await db.batch([
        db
          .insert(credentials)
          .select(
            db
              .select(
                insertSelectFields(credentials, {
                  id: pollId,
                  kind: sql`'materials-poll'`,
                  payload: leasePayload(token),
                  expiresAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')`,
                }),
              )
              .from(installations)
              .innerJoin(users, eq(users.id, installations.ownerUserId))
              .where(
                and(
                  active,
                  sql`julianday(${installations.nextMaterialsSyncAt})<=julianday('now')`,
                  notExists(
                    db
                      .select({ id: c.id })
                      .from(c)
                      .where(
                        and(
                          eq(c.id, pollId),
                          sql`julianday(${c.expiresAt})>=julianday('now')`,
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(
                sql`julianday(${installations.nextMaterialsSyncAt})`,
                installations.id,
              )
              .limit(1),
          )
          .onConflictDoUpdate({
            target: credentials.id,
            set: {
              payload: sql`excluded.payload`,
              expiresAt: sql`excluded.expires_at`,
            },
            setWhere: and(
              eq(credentials.kind, "materials-poll"),
              sql`julianday(${credentials.expiresAt})<julianday('now')`,
            ),
          }),
        db
          .update(installations)
          .set({
            nextMaterialsSyncAt: sql`${db.select({ expiry: c.expiresAt }).from(c).where(eq(c.id, pollId))}`,
          })
          .where(
            exists(
              db
                .select({ id: c.id })
                .from(c)
                .where(
                  and(
                    eq(c.id, pollId),
                    eq(c.kind, "materials-poll"),
                    eq(sql`json_extract(${c.payload},'$.lease')`, token),
                  ),
                ),
            ),
          ),
        db
          .select({
            ...projection,
            leaseId: sql<string>`${c.id}`.as("leaseId"),
          })
          .from(installations)
          .innerJoin(c, eq(c.id, pollId))
          .innerJoin(users, eq(users.id, installations.ownerUserId))
          .where(
            and(
              eq(c.kind, "materials-poll"),
              eq(sql`json_extract(${c.payload},'$.lease')`, token),
              active,
            ),
          ),
      ]);
      const row = result[2][0];
      return row
        ? {
            lease: { id: row.leaseId, token, installationId: row.id },
            connection: connection(row),
          }
        : null;
    },
    async finishPoll(lease, cursor, delaySeconds) {
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        ![10, 30].includes(delaySeconds)
      )
        throw new Error("Invalid materials poll completion");
      return Boolean(
        await db
          .update(installations)
          .set({
            materialsCursor: cursor,
            nextMaterialsSyncAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||${delaySeconds}||' seconds')`,
          })
          .where(
            and(
              eq(installations.id, lease.installationId),
              d1MaterialsLease(lease, "materials-poll"),
            ),
          )
          .returning({ id: installations.id })
          .get(),
      );
    },
  };
}
