import { and, eq, inArray, sql } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { isUniqueViolation } from "../../db/errors";
import {
  ltiCourseTags as tags,
  ltiCourseVideoTags as assignments,
  ltiCourseTagOperations as operations,
  lmsResources,
  videoCourseMembers,
  videos,
  lmsCourses,
  videoCourses,
} from "../../db/schema";
import { MAX_COURSE_TAGS } from "../../application/course-tags";
import { reserveLtiOperation } from "./operation-reservations";
import { lockLmsGrant } from "./lms-resource-repository";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import {
  tagDenied as denied,
  tagConflict as conflict,
  assertTagOperationIdentity,
  assertTagOperationAvailable,
  checkTagMutation,
  refineTagScope,
  tagCatalog,
  checkCourseTags,
} from "../../shared/course-tags";
import { digest } from "../../features/lti/store";
import type { Bindings } from "../../types/bindings";
import type {
  CourseTagRepository,
  CourseTagScope,
} from "../contracts/course-tag-repository";
async function readTags(db: Db, scope: CourseTagScope) {
  const assigned = db
    .select({ id: sql<string>`${assignments.videoId}::text` })
    .from(assignments)
    .where(eq(assignments.tagId, tags.id))
    .orderBy(assignments.videoId);
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      revision: tags.revision,
      video_ids: sql<string[]>`ARRAY(${assigned.getSQL()})`,
    })
    .from(tags)
    .where(eq(tags.courseId, scope.courseId))
    .orderBy(tags.name, tags.id)
    .limit(MAX_COURSE_TAGS + 1);
}
async function catalog(db: Db, scope: CourseTagScope, reused = false) {
  return tagCatalog(await readTags(db, scope), scope, reused);
}
async function currentScope(
  db: Db,
  scope: CourseTagScope,
): Promise<CourseTagScope> {
  const candidates = [
    ...new Set([
      ...scope.readableVideoIds,
      ...scope.management.map((item) => item.videoId),
    ]),
  ];
  const rows = await db
    .select({
      video_id: videos.id,
      resource_link_id: lmsResources.resourceLinkId,
      generation: lmsResources.generation,
      status: videos.status,
    })
    .from(lmsResources)
    .innerJoin(
      videoCourseMembers,
      and(
        eq(videoCourseMembers.videoId, lmsResources.videoId),
        eq(videoCourseMembers.courseId, lmsResources.courseId),
      ),
    )
    .innerJoin(
      videos,
      and(eq(videos.id, lmsResources.videoId), eq(videos.managedByLms, true)),
    )
    .where(
      and(
        eq(lmsResources.installationId, scope.installationId),
        eq(lmsResources.contextId, scope.contextId),
        eq(lmsResources.courseId, scope.courseId),
        eq(videos.userId, scope.ownerUserId),
        eq(lmsResources.enabled, true),
        inArray(lmsResources.videoId, candidates),
      ),
    )
    .for("share", { of: [lmsResources, videoCourseMembers, videos] });
  return refineTagScope(scope, rows);
}
export function createPostgresCourseTagRepository(
  env: Bindings,
): CourseTagRepository {
  return {
    async execute(scope, input) {
      checkCourseTags(scope, input);
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
          const binding = await db
            .select({ id: lmsCourses.id })
            .from(lmsCourses)
            .innerJoin(videoCourses, eq(videoCourses.id, lmsCourses.courseId))
            .where(
              and(
                eq(lmsCourses.installationId, scope.installationId),
                eq(lmsCourses.contextId, scope.contextId),
                eq(lmsCourses.courseId, scope.courseId),
                eq(videoCourses.userId, scope.ownerUserId),
                eq(videoCourses.managedByLms, true),
              ),
            )
            .for("share", { of: [lmsCourses, videoCourses] });
          if (binding.length !== 1) throw denied();
          scope = await currentScope(db, scope);
          if (input.action === "list") {
            const result = await catalog(db, scope);
            await client.query("COMMIT");
            return result;
          }
          const hash = await digest(JSON.stringify(input));
          const freshOperation = await reserveLtiOperation(
            client,
            "tag",
            input.operationId,
          );
          const [prior] = await db
            .select({
              courseId: operations.courseId,
              actorKey: operations.actorKey,
              requestHash: operations.requestHash,
            })
            .from(operations)
            .where(eq(operations.id, input.operationId));
          if (prior) {
            assertTagOperationIdentity(
              Number(prior.courseId) === scope.courseId,
              prior.actorKey === scope.actorKey,
              prior.requestHash === hash,
            );
            const result = await catalog(db, scope, true);
            await client.query("COMMIT");
            return result;
          }
          assertTagOperationAvailable(freshOperation);
          await checkTagMutation(scope, input, await readTags(db, scope));
          if (input.action === "create")
            await db
              .insert(tags)
              .values({
                id: input.operationId,
                courseId: scope.courseId,
                name: input.name,
                color: input.color,
              });
          else if (input.action === "assign") {
            await db
              .delete(assignments)
              .where(
                and(
                  eq(assignments.videoId, input.videoId),
                  inArray(
                    assignments.tagId,
                    db
                      .select({ id: tags.id })
                      .from(tags)
                      .where(eq(tags.courseId, scope.courseId)),
                  ),
                ),
              );
            if (input.tagIds.length)
              await db
                .insert(assignments)
                .values(
                  input.tagIds.map((tagId) => ({
                    tagId,
                    videoId: input.videoId,
                  })),
                );
          } else if (input.action === "delete")
            await db
              .delete(tags)
              .where(
                and(eq(tags.id, input.id), eq(tags.courseId, scope.courseId)),
              );
          else
            await db
              .update(tags)
              .set({
                name: input.name,
                color: input.color,
                revision: crypto.randomUUID(),
              })
              .where(
                and(eq(tags.id, input.id), eq(tags.courseId, scope.courseId)),
              );
          await db
            .insert(operations)
            .values({
              id: input.operationId,
              courseId: scope.courseId,
              actorKey: scope.actorKey,
              action: input.action,
              requestHash: hash,
            });
          const result = await catalog(db, scope);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          if (isUniqueViolation(error)) throw conflict();
          throw error;
        }
      });
    },
  };
}
