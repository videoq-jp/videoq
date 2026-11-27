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
} from '../../domain/media/content-read';
import { contentDrizzleLogic } from "../content-read-policy-sql";
import { sql, and, eq, inArray, desc, isNotNull } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import {
  ltiMaterialOperations,
  videos,
  lmsResources,
  videoCourses,
  videoCourseMembers,
  externalTasks,
  jobExecutions,
} from "../../db/schema";
import { lockLmsGrant } from "./lms-resource-repository";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import { reserveLtiOperation } from "./operation-reservations";
import { insertJobTask } from "./external-task-repository";
import { buildJobMessage, type JobMessage } from "../../lib/job-message";
import { apiNotFound, asApiError } from "../../shared/errors";
import type { ReadableManagedVideo } from "../../application/material-management";
import { digest } from "../../features/lti/store";
import {
  materialConflict as conflict,
  revisionOf,
  originalMessage,
  materialView,
  checkMaterialManagement,
} from "../../shared/material-management";
import type { Bindings } from "../../types/bindings";
import type {
  ManagedMaterialScope,
  ManagedVideo,
  MaterialJob,
  MaterialManagementRepository,
} from "../contracts/material-management-repository";
async function readVideo(
  db: Db,
  scope: ManagedMaterialScope,
): Promise<ReadableManagedVideo> {
  const [video] = await db
    .select({
      title: videos.title,
      file: videos.file,
      status: videos.status,
      description: sql<
        string | null
      >`${inlineMaterialDescription(sql`${videos.description}`, sql`octet_length(${videos.description})`, contentDrizzleLogic)}`,
      transcript: sql<
        string | null
      >`${inlineTranscript(sql`${videos.transcript}`, sql`octet_length(${videos.transcript})`, contentDrizzleLogic).value}`,
    })
    .from(videos)
    .where(
      and(
        eq(videos.id, scope.videoId),
        eq(videos.userId, scope.ownerUserId),
        eq(videos.managedByLms, true),
      ),
    )
    .for("update");
  if (!video) throw apiNotFound("Material not found.");
  assertMaterialReadable(video);
  return video;
}
async function latestJob(db: Db, videoId: number, transcribeOnly = false) {
  const [row] = await db
    .select({
      id: externalTasks.id,
      message: sql<MaterialJob["message"]>`${externalTasks.payload}->'message'`,
      dead: sql<boolean>`${isNotNull(externalTasks.deadAt)}`,
      status: jobExecutions.status,
    })
    .from(externalTasks)
    .leftJoin(
      jobExecutions,
      sql`${jobExecutions.jobId}=${externalTasks.payload}->'message'->>'job_id'`,
    )
    .where(
      and(
        eq(externalTasks.kind, "sqs_job"),
        sql`${externalTasks.payload}->'message'->'payload'->>'video_id'=${String(videoId)}`,
        inArray(
          sql<string>`${externalTasks.payload}->'message'->>'type'`,
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
    .orderBy(desc(externalTasks.createdAt), desc(externalTasks.id))
    .limit(1);
  return row;
}
async function publicMaterial(
  db: Db,
  scope: ManagedMaterialScope,
  video: ManagedVideo,
) {
  const job = await latestJob(db, scope.videoId);
  const retryJob =
    video.status === "error"
      ? await latestJob(db, scope.videoId, true)
      : undefined;
  return materialView(scope, video, job, retryJob);
}

export function createPostgresMaterialManagementRepository(
  env: Bindings,
): MaterialManagementRepository {
  return {
    async execute(scope, input) {
      checkMaterialManagement(scope, input);
      return withDb(env, async (db, client) => {
        await client.query("BEGIN");
        try {
          await lockLmsGrant(
            db,
            { id: scope.installationId, ownerUserId: scope.ownerUserId },
            scope.contextId,
            scope.courseId,
          );
          await lockLtiDataSessionWithDb(
            db,
            scope.ownerUserId,
            scope.sessionProof,
          );
          const [resource] = await db
            .select({
              id: lmsResources.id,
              generation: lmsResources.generation,
            })
            .from(lmsResources)
            .where(
              and(
                eq(lmsResources.installationId, scope.installationId),
                eq(lmsResources.contextId, scope.contextId),
                eq(lmsResources.resourceLinkId, scope.resourceLinkId),
                eq(lmsResources.courseId, scope.courseId),
                eq(lmsResources.videoId, scope.videoId),
                eq(lmsResources.enabled, true),
              ),
            )
            .for("update");
          if (!resource) throw apiNotFound("Material not found.");
          assertMaterialGeneration(
            Number(resource.generation),
            scope.generation,
          );
          const course = await db
            .select({ id: videoCourses.id })
            .from(videoCourses)
            .where(
              and(
                eq(videoCourses.id, scope.courseId),
                eq(videoCourses.userId, scope.ownerUserId),
                eq(videoCourses.managedByLms, true),
              ),
            )
            .for("share");
          if (!course.length) throw apiNotFound("Material not found.");
          const members = await db
            .select({ courseId: videoCourseMembers.courseId })
            .from(videoCourseMembers)
            .where(eq(videoCourseMembers.videoId, scope.videoId))
            .for("share");
          const bindings = await db
            .select({ id: lmsResources.id })
            .from(lmsResources)
            .where(eq(lmsResources.videoId, scope.videoId))
            .for("share");
          assertMaterialReferences(
            members.length,
            Number(members[0]?.courseId),
            bindings.length,
            scope.courseId,
          );
          if (input.action !== "get") {
            // Match the Python indexer's global/shared and per-video locks. Never
            // wait for provider I/O while holding course/account row locks.
            if (
              !(
                await client.query<{ ok: boolean }>(
                  "SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS ok",
                  [0x564944454f51],
                )
              ).rows[0].ok ||
              !(
                await client.query<{ ok: boolean }>(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok",
                  ["videoq:vector:video:" + scope.videoId],
                )
              ).rows[0].ok
            )
              throw conflict(
                "This material is being indexed. Try again after processing finishes.",
              );
          }
          const video = await readVideo(db, scope);
          if (input.action === "get") {
            const material = await publicMaterial(db, scope, video);
            await client.query("COMMIT");
            return { material, externalTaskId: null, reused: false };
          }
          const requestHash = await digest(JSON.stringify(input));
          const freshOperation = await reserveLtiOperation(
            client,
            "material",
            input.operationId,
          );
          const [prior] = await db
            .select({
              actor_key: ltiMaterialOperations.actorKey,
              resource_id: ltiMaterialOperations.resourceId,
              request_hash: ltiMaterialOperations.requestHash,
              external_task_id: ltiMaterialOperations.externalTaskId,
            })
            .from(ltiMaterialOperations)
            .where(eq(ltiMaterialOperations.id, input.operationId));
          if (prior) {
            assertMaterialReplayIdentity(
              prior.actor_key === scope.actorKey,
              prior.resource_id === resource.id,
              prior.request_hash === requestHash,
            );
            const material = await publicMaterial(db, scope, video);
            await client.query("COMMIT");
            return {
              material,
              externalTaskId:
                prior.external_task_id === null
                  ? null
                  : Number(prior.external_task_id),
              reused: true,
            };
          }
          assertMaterialOperationAvailable(freshOperation);
          const beforeRevision = await revisionOf(scope, video);
          assertMaterialRevision(beforeRevision, input.revision);
          const kind = materialMutationKind(input, video.status);
          const retryJob =
            kind === "retry"
              ? await latestJob(db, scope.videoId, true)
              : undefined;
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
          let message: JobMessage | undefined;
          if (input.action === "update")
            await updateDerivedFields(
              db,
              scope.videoId,
              input.fields,
              plan.transcriptChanged,
            );
          else
            await db
              .update(videos)
              .set({ status: plan.next.status, errorMessage: "" })
              .where(eq(videos.id, scope.videoId));
          if (plan.job)
            message =
              plan.job.kind === "index"
                ? buildJobMessage("index_video_transcript", plan.job.payload)
                : plan.job.message;
          const task = message
            ? await insertJobTask(db, {
                message,
                dedupeKey: "lti-material:" + input.operationId,
              })
            : null;
          const next = await readVideo(db, scope);
          await db
            .insert(ltiMaterialOperations)
            .values({
              id: input.operationId,
              resourceId: resource.id,
              videoId: scope.videoId,
              courseId: scope.courseId,
              sourceGeneration: scope.generation,
              actorKey: scope.actorKey,
              action: input.action,
              requestHash,
              beforeRevision,
              afterRevision: await revisionOf(scope, next),
              externalTaskId: task?.id ?? null,
            });
          const material = await publicMaterial(db, scope, next);
          await client.query("COMMIT");
          return { material, externalTaskId: task?.id ?? null, reused: false };
        } catch (error) {
          await client.query("ROLLBACK");
          throw asApiError(error) ?? error;
        }
      });
    },
  };
}

async function updateDerivedFields(
  db: Db,
  videoId: number,
  fields: { description?: string; transcript?: string },
  transcriptChanged: boolean,
) {
  // Title, source identity and source media are canonical Moodle fields.
  await db
    .update(videos)
    .set({
      description: fields.description ?? sql`${videos.description}`,
      transcript: fields.transcript ?? sql`${videos.transcript}`,
      status: transcriptChanged ? "indexing" : sql`${videos.status}`,
      errorMessage: transcriptChanged ? "" : sql`${videos.errorMessage}`,
    })
    .where(eq(videos.id, videoId));
}
