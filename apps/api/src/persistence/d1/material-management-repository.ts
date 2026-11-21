import {
  and,
  or,
  eq,
  inArray,
  exists,
  notExists,
  not,
  desc,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  videos,
  users,
  lmsResources as resources,
  lmsInstallations as installations,
  teachingConnections as connections,
  videoCourses,
  videoCourseMembers,
  videoIndexVersions as versions,
  externalTasks as tasks,
  jobExecutions as jobs,
  ltiCredentials as credentials,
  ltiMaterialOperations as operations,
  ltiOperationReservations as reservations,
  mutationReceipts as receipts,
  scenes,
  sceneStaging,
  sceneIndexRuns,
} from "../../db/schema/sqlite";
import {
  assertMaterialGeneration,
  assertMaterialReferences,
  assertMaterialReadable,
  assertMaterialReplayIdentity,
  assertMaterialOperationAvailable,
  assertMaterialRevision,
  materialMutationKind,
  planMaterialMutation,
} from "../../application/material-mutation";
import {
  inlineTranscript,
  inlineMaterialDescription,
} from "../../application/content-read";
import { contentDrizzleLogic } from "../content-read-policy-sql";
import { activeD1LmsOwner } from "./lms-owner-policy";
import type {
  MaterialManagementRepository,
  ManagedVideo,
  MaterialJob,
} from "../contracts/material-management-repository";
import {
  materialConflict as conflict,
  revisionOf,
  originalMessage,
  materialView,
  checkMaterialManagement,
} from "../../shared/material-management";
import { ApiError, apiNotFound, asApiError } from "../../shared/errors";
import { buildJobMessage, type JobMessage } from "../../lib/job-message";
import { digest } from "../../features/lti/store";
import { operationReservationKey } from "../../shared/lti-operation-key";
import {
  enqueueCurrentSceneDeletes,
  enqueueStagedSceneDeletes,
} from "./scene-index-writer";
const decode = <T>(raw: unknown): T | undefined => {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("Invalid material JSON");
  return JSON.parse(raw) as T;
};
export function createD1MaterialManagementRepository(
  database: D1Database,
): MaterialManagementRepository {
  const db = createD1Connection(database);
  return {
    async execute(scope, input) {
      try {
        checkMaterialManagement(scope, input);
        const proof = scope.sessionProof;
        const auth = exists(
          db
            .select({ id: installations.id })
            .from(installations)
            .innerJoin(
              connections,
              and(
                eq(connections.provider, "moodle"),
                eq(connections.installationId, installations.id),
                eq(connections.contextId, scope.contextId),
                eq(connections.courseId, scope.courseId),
                eq(connections.active, true),
              ),
            )
            .innerJoin(users, eq(users.id, connections.ownerUserId))
            .where(
              and(
                eq(installations.id, scope.installationId),
                eq(users.id, scope.ownerUserId),
                eq(installations.active, true),
                activeD1LmsOwner(),
                proof
                  ? exists(
                      db
                        .select({ id: credentials.id })
                        .from(credentials)
                        .where(
                          and(
                            eq(credentials.id, proof.sessionHash),
                            eq(credentials.kind, "session"),
                            sql`julianday(${credentials.expiresAt})>julianday('now')`,
                            eq(
                              sql`json_extract(${credentials.payload},'$.registrationId')`,
                              proof.registrationId,
                            ),
                            eq(
                              sql`json_extract(${credentials.payload},'$.subjectHash')`,
                              proof.subjectHash,
                            ),
                          ),
                        ),
                    )
                  : undefined,
              ),
            ),
        );
        const course = exists(
          db
            .select({ id: videoCourses.id })
            .from(videoCourses)
            .where(
              and(
                eq(videoCourses.id, scope.courseId),
                eq(videoCourses.userId, scope.ownerUserId),
                eq(videoCourses.managedByLms, true),
              ),
            ),
        );
        const resourceQuery = db
          .select({
            value: sql`json_object('id',${resources.id},'generation',${resources.generation})`,
          })
          .from(resources)
          .where(
            and(
              eq(resources.installationId, scope.installationId),
              eq(resources.contextId, scope.contextId),
              eq(resources.resourceLinkId, scope.resourceLinkId),
              eq(resources.courseId, scope.courseId),
              eq(resources.videoId, scope.videoId),
              eq(resources.enabled, true),
            ),
          );
        const sourceRevision = db
          .select({ revision: versions.revision })
          .from(versions)
          .where(eq(versions.videoId, videos.id));
        const videoQuery = db
          .select({
            value: sql`json_object('title',${videos.title},'file',${videos.file},'status',${videos.status},'description',${inlineMaterialDescription(sql`${videos.description}`, sql`length(CAST(${videos.description} AS BLOB))`, contentDrizzleLogic)},'transcript',${inlineTranscript(sql`${videos.transcript}`, sql`length(CAST(${videos.transcript} AS BLOB))`, contentDrizzleLogic).value},'sourceRevision',${sourceRevision})`,
          })
          .from(videos)
          .where(
            and(
              eq(videos.id, scope.videoId),
              eq(videos.userId, scope.ownerUserId),
              eq(videos.managedByLms, true),
            ),
          );
        const refCourses = db
          .select({ id: videoCourseMembers.courseId })
          .from(videoCourseMembers)
          .where(eq(videoCourseMembers.videoId, scope.videoId))
          .orderBy(videoCourseMembers.courseId)
          .as("ref_courses");
        const refResources = db
          .select({ id: resources.id })
          .from(resources)
          .where(eq(resources.videoId, scope.videoId))
          .orderBy(resources.id)
          .as("ref_resources");
        const coursesJson = db
            .select({ value: sql`json_group_array(${refCourses.id})` })
            .from(refCourses),
          resourcesJson = db
            .select({ value: sql`json_group_array(${refResources.id})` })
            .from(refResources);
        const refsSnapshot = sql`json_object('courses',json(${coursesJson}),'resources',json(${resourcesJson}))`;
        const latestJob = (transcribeOnly = false) =>
          db
            .select({
              value: sql`json_object('id',${tasks.id},'message',json(${tasks.payload} -> '$.message'),'dead',json(CASE WHEN ${tasks.deadAt} IS NOT NULL THEN 'true' ELSE 'false' END),'status',${jobs.status})`,
            })
            .from(tasks)
            .leftJoin(
              jobs,
              eq(jobs.jobId, sql`${tasks.payload} ->> '$.message.job_id'`),
            )
            .where(
              and(
                eq(tasks.kind, "sqs_job"),
                inArray(
                  sql`${tasks.payload} ->> '$.message.payload.video_id'`,
                  [scope.videoId, String(scope.videoId)],
                ),
                inArray(
                  sql`${tasks.payload} ->> '$.message.type'`,
                  transcribeOnly
                    ? ["transcribe_video"]
                    : [
                        "transcribe_video",
                        "index_video_transcript",
                        "reindex_video_transcript",
                      ],
                ),
              ),
            )
            .orderBy(desc(tasks.createdAt), desc(tasks.id))
            .limit(1);
        const busy = exists(
          db
            .select({ id: jobs.jobId })
            .from(jobs)
            .where(
              and(
                eq(jobs.status, "running"),
                sql`julianday(${jobs.leaseUntil})>julianday('now')`,
                or(
                  eq(jobs.jobType, "reindex_all_videos_embeddings"),
                  exists(
                    db
                      .select({ id: tasks.id })
                      .from(tasks)
                      .where(
                        and(
                          eq(tasks.kind, "sqs_job"),
                          eq(
                            sql`${tasks.payload} ->> '$.message.job_id'`,
                            jobs.jobId,
                          ),
                          inArray(
                            sql`${tasks.payload} ->> '$.message.payload.video_id'`,
                            [scope.videoId, String(scope.videoId)],
                          ),
                        ),
                      ),
                  ),
                ),
              ),
            ),
        );
        const gate = (token: string) =>
          exists(
            db
              .select({ token: receipts.token })
              .from(receipts)
              .where(eq(receipts.token, token)),
          );
        const id =
            input.action === "get" ? "" : input.operationId.toLowerCase(),
          key = await operationReservationKey("material", id),
          requestHash =
            input.action === "get" ? "" : await digest(JSON.stringify(input));
        for (let attempt = 0; attempt < 5; attempt++) {
          const snapshot = await runD1Batch<Record<string, unknown>>(database, [
            db
              .select({
                allowed: auth.as("allowed"),
                resource: sql`${resourceQuery}`.as("resource"),
                course: course.as("course"),
                refs: refsSnapshot.as("refs"),
                video: sql`${videoQuery}`.as("video"),
                job: sql`${latestJob()}`.as("job"),
                retryJob: sql`${latestJob(true)}`.as("retryJob"),
                busy: busy.as("busy"),
              })
              .from(sql`(VALUES(1)) input`),
            db
              .select({
                actor_key: operations.actorKey,
                resource_id: operations.resourceId,
                request_hash: operations.requestHash,
                external_task_id: operations.externalTaskId,
              })
              .from(operations)
              .where(eq(operations.id, id)),
            db
              .select({ key: reservations.key })
              .from(reservations)
              .where(eq(reservations.key, key)),
          ]);
          const state = snapshot[0].results[0];
          if (!state.allowed)
            throw new ApiError(
              403,
              "FORBIDDEN",
              "The material is unavailable.",
            );
          const resource = decode<{ id: string; generation: number }>(
            state.resource,
          );
          if (!resource || !state.course)
            throw apiNotFound("Material not found.");
          assertMaterialGeneration(
            Number(resource.generation),
            scope.generation,
          );
          const refs = decode<{ courses: number[]; resources: string[] }>(
            state.refs,
          )!;
          assertMaterialReferences(
            refs.courses.length,
            Number(refs.courses[0]),
            refs.resources.length,
            scope.courseId,
          );
          const video = decode<ManagedVideo>(state.video);
          if (!video) throw apiNotFound("Material not found.");
          assertMaterialReadable(video);
          const latest = decode<MaterialJob>(state.job),
            retryJob = decode<MaterialJob>(state.retryJob);
          if (input.action === "get")
            return {
              material: await materialView(
                scope,
                video,
                latest,
                video.status === "error" ? retryJob : undefined,
              ),
              externalTaskId: null,
              reused: false,
            };
          if (state.busy)
            throw conflict(
              "This material is being indexed. Try again after processing finishes.",
            );
          const prior = snapshot[1].results[0];
          if (prior)
            assertMaterialReplayIdentity(
              prior.actor_key === scope.actorKey,
              prior.resource_id === resource.id,
              prior.request_hash === requestHash,
            );
          else
            assertMaterialOperationAvailable(snapshot[2].results.length === 0);
          const beforeRevision = await revisionOf(scope, video);
          let next = { ...video },
            message: JobMessage | undefined,
            indexChanged = false;
          if (!prior) {
            assertMaterialRevision(beforeRevision, input.revision);
            const kind = materialMutationKind(input, video.status);
            // D1's physical binding limit is checked after the shared edit admission.
            if (
              input.action === "update" &&
              input.fields.transcript !== undefined &&
              new TextEncoder().encode(input.fields.transcript).length >
                1_800_000
            )
              throw new ApiError(
                413,
                "VALIDATION_ERROR",
                "Transcript is too large.",
              );
            const original =
              kind === "retry"
                ? originalMessage.safeParse(retryJob?.message)
                : undefined;
            const plan = planMaterialMutation(
              input,
              video,
              original?.success ? original.data : undefined,
              retryJob?.status,
            );
            next = plan.next;
            indexChanged = plan.indexChanged;
            if (plan.job)
              message =
                plan.job.kind === "index"
                  ? buildJobMessage("index_video_transcript", plan.job.payload)
                  : plan.job.message;
          }
          const token = crypto.randomUUID(),
            dedupeKey = "lti-material:" + input.operationId;
          const priorGuard = prior
            ? exists(
                db
                  .select({ id: operations.id })
                  .from(operations)
                  .where(
                    and(
                      eq(operations.id, id),
                      eq(operations.actorKey, scope.actorKey),
                      eq(operations.resourceId, resource.id),
                      eq(operations.requestHash, requestHash),
                      sql`${operations.externalTaskId} IS ${prior.external_task_id}`,
                    ),
                  ),
              )
            : and(
                notExists(
                  db
                    .select({ id: operations.id })
                    .from(operations)
                    .where(eq(operations.id, id)),
                ),
                notExists(
                  db
                    .select({ key: reservations.key })
                    .from(reservations)
                    .where(eq(reservations.key, key)),
                ),
              )!;
          const statements: (D1Query | D1PreparedStatement)[] = [
            db.insert(receipts).select(
              db
                .select(
                  insertSelectValues(receipts, {
                    token,
                    kind: "lti_material",
                    resourceId: scope.videoId,
                  }),
                )
                .from(sql`(VALUES(1)) input`)
                .where(
                  and(
                    auth,
                    course,
                    sql`${resourceQuery}=${state.resource}`,
                    sql`${refsSnapshot}=${state.refs}`,
                    sql`${videoQuery}=${state.video}`,
                    sql`${latestJob()} IS ${state.job}`,
                    sql`${latestJob(true)} IS ${state.retryJob}`,
                    not(busy),
                    priorGuard,
                  ),
                ),
            ),
            db
              .insert(reservations)
              .select(
                db
                  .select(insertSelectValues(reservations, { key }))
                  .from(receipts)
                  .where(eq(receipts.token, token)),
              )
              .onConflictDoNothing(),
          ];
          if (!prior) {
            statements.push(
              db
                .update(videos)
                .set({
                  description: next.description,
                  transcript: next.transcript,
                  status: next.status,
                  errorMessage: sql`CASE WHEN ${Number(Boolean(message))}=1 THEN '' ELSE ${videos.errorMessage} END`,
                })
                .where(and(eq(videos.id, scope.videoId), gate(token))),
            );
            if (indexChanged)
              statements.push(
                db
                  .insert(versions)
                  .select(
                    db
                      .select(
                        insertSelectValues(versions, {
                          videoId: scope.videoId,
                          revision: crypto.randomUUID(),
                        }),
                      )
                      .from(receipts)
                      .where(eq(receipts.token, token)),
                  )
                  .onConflictDoUpdate({
                    target: versions.videoId,
                    set: { revision: sql`excluded.revision` },
                  }),
                enqueueCurrentSceneDeletes(database, scope.videoId, token),
                enqueueStagedSceneDeletes(database, scope.videoId, token),
                db
                  .delete(scenes)
                  .where(and(eq(scenes.videoId, scope.videoId), gate(token))),
                db
                  .delete(sceneStaging)
                  .where(
                    and(
                      inArray(
                        sceneStaging.runId,
                        db
                          .select({ id: sceneIndexRuns.id })
                          .from(sceneIndexRuns)
                          .where(eq(sceneIndexRuns.videoId, scope.videoId)),
                      ),
                      gate(token),
                    ),
                  ),
              );
            if (message)
              statements.push(
                db.insert(tasks).select(
                  db
                    .select(
                      insertSelectValues(tasks, {
                        kind: "sqs_job",
                        payload: { message },
                        dedupeKey,
                      }),
                    )
                    .from(receipts)
                    .where(eq(receipts.token, token)),
                ),
              );
            const taskId = db
              .select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.dedupeKey, message ? dedupeKey : ""));
            statements.push(
              db.insert(operations).select(
                db
                  .select(
                    insertSelectValues(operations, {
                      id,
                      resourceId: resource.id,
                      videoId: scope.videoId,
                      courseId: scope.courseId,
                      sourceGeneration: scope.generation,
                      actorKey: scope.actorKey,
                      action: input.action,
                      requestHash,
                      beforeRevision,
                      afterRevision: await revisionOf(scope, next),
                      externalTaskId: sql`${taskId}`,
                    }),
                  )
                  .from(receipts)
                  .where(eq(receipts.token, token)),
              ),
            );
          }
          const output = statements.length,
            taskId = db
              .select({ id: operations.externalTaskId })
              .from(operations)
              .where(eq(operations.id, id));
          statements.push(
            db
              .select({
                video: sql`${videoQuery}`.as("video"),
                job: sql`${latestJob()}`.as("job"),
                retryJob: sql`${latestJob(true)}`.as("retryJob"),
                taskId: sql`${taskId}`.as("taskId"),
              })
              .from(receipts)
              .where(eq(receipts.token, token)),
            db.delete(receipts).where(eq(receipts.token, token)),
          );
          const result = await runD1Batch<Record<string, unknown>>(
              database,
              statements,
            ),
            row = result[output].results[0];
          if (row) {
            const current = decode<ManagedVideo>(row.video)!;
            return {
              material: await materialView(
                scope,
                current,
                decode<MaterialJob>(row.job),
                current.status === "error"
                  ? decode<MaterialJob>(row.retryJob)
                  : undefined,
              ),
              externalTaskId: row.taskId === null ? null : Number(row.taskId),
              reused: Boolean(prior),
            };
          }
        }
        throw conflict(
          "This material was changed by another operation. Refresh before saving.",
        );
      } catch (error) {
        throw asApiError(error) ?? error;
      }
    },
  };
}
