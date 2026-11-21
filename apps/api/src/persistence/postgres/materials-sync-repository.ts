import {
  and,
  eq,
  inArray,
  isNull,
  isNotNull,
  exists,
  notExists,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { withDb, type Db } from "../../db/pool";
import { insertSelectValues } from "../../db/postgres/query-builders";
import {
  lmsInstallations as installations,
  ltiCredentials as credentials,
  users,
  teachingConnections,
  lmsResources,
  videoCourses,
  videos,
  externalTasks,
} from "../../db/schema";
import { activeLmsOwner } from "./lms-owner-policy";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import type { Bindings } from "../../types/bindings";
import type {
  MaterialsSyncRepository,
  MaterialsLease,
  MaterialsConnection,
} from "../contracts/materials-sync-repository";
import { MaterialsLeaseLostError } from "../contracts/materials-sync-repository";
const configuration = (i: {
  ownerUserId: SQLWrapper;
  clientId: SQLWrapper;
  deploymentId: SQLWrapper;
  materialsService: SQLWrapper;
}) =>
  sql`jsonb_build_object('owner',${i.ownerUserId},'client',${i.clientId},'deployment',${i.deploymentId},'service',${i.materialsService})`;
export function postgresMaterialsLease(
  lease: MaterialsLease,
  kind: "materials-lease" | "materials-poll" | "either" = "materials-lease",
) {
  const db = new QueryBuilder(),
    c = alias(credentials, "material_lease"),
    i = alias(installations, "lease_installation"),
    owner = alias(users, "lease_owner");
  return exists(
    db
      .select({ id: c.id })
      .from(c)
      .innerJoin(i, eq(i.id, sql`${c.payload}->>'installationId'`))
      .innerJoin(owner, eq(owner.id, i.ownerUserId))
      .where(
        and(
          eq(c.id, lease.id),
          eq(i.id, lease.installationId),
          eq(sql`${c.payload}->>'lease'`, lease.token),
          kind === "either"
            ? inArray(c.kind, ["materials-lease", "materials-poll"])
            : eq(c.kind, kind),
          sql`${c.expiresAt}>clock_timestamp()`,
          eq(i.active, true),
          isNotNull(i.materialsService),
          sql`${c.payload}->'configuration'=${configuration(i)}`,
        ),
      ),
  );
}
const projection = {
  id: installations.id,
  ownerUserId: installations.ownerUserId,
  clientId: installations.clientId,
  deploymentId: installations.deploymentId,
  materialsService: sql<
    MaterialsConnection["materialsService"]
  >`${installations.materialsService}`,
  materialsCursor: installations.materialsCursor,
};
function normalizeConnection(row: MaterialsConnection): MaterialsConnection {
  const cursor = Number(row.materialsCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid materials cursor");
  return { ...row, materialsCursor: cursor };
}
export function createPostgresMaterialsSyncRepository(
  env: Bindings,
): MaterialsSyncRepository {
  const active = and(
    eq(installations.active, true),
    isNotNull(installations.materialsService),
  );
  const payload = (token: string) =>
    sql`jsonb_build_object('lease',${token}::text,'installationId',${installations.id},'configuration',${configuration(installations)})`;
  const exportMatch = (lease: MaterialsLease, key: string) =>
    and(
      eq(credentials.id, key),
      eq(credentials.kind, "materials-export"),
      eq(sql`${credentials.payload}->>'installationId'`, lease.installationId),
    );
  async function write<T>(
    lease: MaterialsLease,
    kind: "materials-lease" | "materials-poll",
    operation: (db: Db) => Promise<T>,
  ): Promise<T | null> {
    return withDb(env, (database) =>
      database.transaction(async (db) => {
        // Owner -> connection -> lease matches synchronization and revocation. Keep
        // the authority rows locked while a subsequent export/video write waits.
        await db
          .select({ id: users.id })
          .from(users)
          .where(
            inArray(
              users.id,
              db
                .select({ id: teachingConnections.ownerUserId })
                .from(teachingConnections)
                .where(
                  and(
                    eq(teachingConnections.provider, "moodle"),
                    eq(
                      teachingConnections.installationId,
                      lease.installationId,
                    ),
                  ),
                ),
            ),
          )
          .orderBy(users.id)
          .for("share");
        await db
          .select({ id: installations.id })
          .from(installations)
          .where(eq(installations.id, lease.installationId))
          .for("update");
        const current = await db
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, lease.id),
              postgresMaterialsLease(lease, kind),
            ),
          )
          .for("share");
        if (!current.length) return null;
        return operation(db);
      }),
    );
  }
  return {
    claimContext(installationId, leaseId, token) {
      return withDb(env, (database) =>
        database.transaction(async (db) => {
          const lease = { id: leaseId, token, installationId };
          await db
            .insert(credentials)
            .select(
              db
                .select(
                  insertSelectValues(credentials, {
                    id: leaseId,
                    kind: "materials-lease",
                    payload: payload(token),
                    expiresAt: sql`clock_timestamp()+interval '10 minutes'`,
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
                sql`${credentials.expiresAt}<clock_timestamp()`,
              ),
            });
          const [row] = await db
            .select(projection)
            .from(installations)
            .innerJoin(users, eq(users.id, installations.ownerUserId))
            .where(
              and(
                eq(installations.id, installationId),
                postgresMaterialsLease(lease),
              ),
            );
          const available = row
            ? true
            : (
                await db
                  .select({ id: installations.id })
                  .from(installations)
                  .innerJoin(users, eq(users.id, installations.ownerUserId))
                  .where(and(eq(installations.id, installationId), active))
              ).length > 0;
          return row
            ? { status: "claimed", lease, connection: normalizeConnection(row) }
            : { status: available ? "busy" : "unavailable" };
        }),
      );
    },
    owns(lease) {
      return withDb(
        env,
        async (db) =>
          (
            await db
              .select({ id: credentials.id })
              .from(credentials)
              .where(
                and(
                  eq(credentials.id, lease.id),
                  postgresMaterialsLease(lease, "either"),
                ),
              )
          ).length > 0,
      );
    },
    async release(lease) {
      await withDb(env, (db) =>
        db
          .delete(credentials)
          .where(
            and(
              eq(credentials.id, lease.id),
              inArray(credentials.kind, ["materials-lease", "materials-poll"]),
              eq(sql`${credentials.payload}->>'lease'`, lease.token),
            ),
          ),
      );
    },
    async prepareExport(lease, key, contextId, attempt) {
      const result = await write(lease, "materials-lease", async (db) => {
        await db
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
                  expiresAt: sql`clock_timestamp()+interval '1 hour'`,
                }),
              )
              .from(installations)
              .where(
                and(
                  eq(installations.id, lease.installationId),
                  postgresMaterialsLease(lease),
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
              sql`${credentials.expiresAt}<=clock_timestamp()`,
            ),
          });
        const [row] = await db
          .select({ payload: credentials.payload })
          .from(credentials)
          .where(
            and(
              exportMatch(lease, key),
              sql`${credentials.expiresAt}>clock_timestamp()`,
              eq(sql`${credentials.payload}->>'contextId'`, contextId),
              postgresMaterialsLease(lease),
            ),
          );
        const value = row?.payload;
        if (!value || typeof value.attempt !== "string")
          throw new MaterialsLeaseLostError();
        return {
          attempt: value.attempt,
          ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
        };
      });
      if (!result) throw new MaterialsLeaseLostError();
      return result;
    },
    async saveExportJob(lease, key, attempt, jobId) {
      return (
        (await write(
          lease,
          "materials-lease",
          async (db) =>
            (
              await db
                .update(credentials)
                .set({
                  payload: sql`jsonb_set(${credentials.payload},'{jobId}',to_jsonb(${jobId}::text))`,
                })
                .where(
                  and(
                    exportMatch(lease, key),
                    sql`${credentials.expiresAt}>clock_timestamp()`,
                    eq(sql`${credentials.payload}->>'attempt'`, attempt),
                    postgresMaterialsLease(lease),
                  ),
                )
                .returning({ id: credentials.id })
            ).length > 0,
        )) ?? false
      );
    },
    async deleteExport(lease, key, attempt) {
      return (
        (await write(
          lease,
          "materials-lease",
          async (db) =>
            (
              await db
                .delete(credentials)
                .where(
                  and(
                    exportMatch(lease, key),
                    eq(sql`${credentials.payload}->>'attempt'`, attempt),
                    postgresMaterialsLease(lease),
                  ),
                )
                .returning({ id: credentials.id })
            ).length > 0,
        )) ?? false
      );
    },
    async confirmUpload(lease, upload) {
      return (
        (await write(lease, "materials-lease", async (db) => {
          // Resource before video, matching resource synchronization.
          const [resource] = await db
            .select({ owner: teachingConnections.ownerUserId })
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
                activeLmsOwner(sql`clock_timestamp()`),
              ),
            )
            .where(
              and(
                eq(lmsResources.installationId, lease.installationId),
                eq(lmsResources.externalId, upload.externalId),
                eq(lmsResources.generation, upload.generation),
                eq(lmsResources.videoId, upload.videoId),
                eq(lmsResources.enabled, true),
              ),
            )
            .$dynamic()
            .for("update", { of: lmsResources })
            .for("share", { of: teachingConnections });
          if (!resource) return false;
          const changed = await db
            .update(videos)
            .set({ status: "pending", errorMessage: "" })
            .where(
              and(
                eq(videos.id, upload.videoId),
                eq(videos.file, upload.fileKey),
                eq(videos.status, "uploading"),
                eq(videos.userId, resource.owner),
                postgresMaterialsLease(lease),
              ),
            )
            .returning({ id: videos.id });
          if (!changed.length) return false;
          const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
            video_id: upload.videoId,
          });
          const [task] = await db
            .insert(externalTasks)
            .values({
              kind: "sqs_job",
              payload: { message },
              dedupeKey: `job:${message.job_id}`,
            })
            .returning({ id: externalTasks.id });
          return {
            videoId: upload.videoId,
            taskId: Number(task.id),
            jobId: message.job_id,
          };
        })) ?? false
      );
    },
    claimNext(token) {
      return withDb(env, (database) =>
        database.transaction(async (db) => {
          const c = alias(credentials, "poll_lease"),
            pollId = sql<string>`'lti-materials-poll:'||${installations.id}`;
          const [row] = await db
            .select(projection)
            .from(installations)
            .innerJoin(users, eq(users.id, installations.ownerUserId))
            .where(
              and(
                active,
                sql`${installations.nextMaterialsSyncAt}<=clock_timestamp()`,
                notExists(
                  db
                    .select({ id: c.id })
                    .from(c)
                    .where(
                      and(
                        eq(c.id, pollId),
                        sql`${c.expiresAt}>=clock_timestamp()`,
                      ),
                    ),
                ),
              ),
            )
            .orderBy(installations.nextMaterialsSyncAt, installations.id)
            .limit(1)
            .for("update", { of: installations, skipLocked: true });
          if (!row) return null;
          const id = "lti-materials-poll:" + row.id;
          const inserted = await db
            .insert(credentials)
            .select(
              db
                .select(
                  insertSelectValues(credentials, {
                    id,
                    kind: "materials-poll",
                    payload: payload(token),
                    expiresAt: sql`clock_timestamp()+interval '1 minute'`,
                  }),
                )
                .from(installations)
                .where(eq(installations.id, row.id)),
            )
            .onConflictDoUpdate({
              target: credentials.id,
              set: {
                payload: sql`excluded.payload`,
                expiresAt: sql`excluded.expires_at`,
              },
              setWhere: and(
                eq(credentials.kind, "materials-poll"),
                sql`${credentials.expiresAt}<clock_timestamp()`,
              ),
            })
            .returning({ id: credentials.id });
          if (!inserted.length) return null;
          await db
            .update(installations)
            .set({
              nextMaterialsSyncAt: sql`${db.select({ expiry: credentials.expiresAt }).from(credentials).where(eq(credentials.id, id))}`,
            })
            .where(eq(installations.id, row.id));
          return {
            lease: { id, token, installationId: row.id },
            connection: normalizeConnection(row),
          };
        }),
      );
    },
    async finishPoll(lease, cursor, delaySeconds) {
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        ![10, 30].includes(delaySeconds)
      )
        throw new Error("Invalid materials poll completion");
      return (
        (await write(
          lease,
          "materials-poll",
          async (db) =>
            (
              await db
                .update(installations)
                .set({
                  materialsCursor: cursor,
                  nextMaterialsSyncAt: sql`clock_timestamp()+(${delaySeconds}*interval '1 second')`,
                })
                .where(
                  and(
                    eq(installations.id, lease.installationId),
                    postgresMaterialsLease(lease, "materials-poll"),
                  ),
                )
                .returning({ id: installations.id })
            ).length > 0,
        )) ?? false
      );
    },
  };
}
