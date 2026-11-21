import { and, eq, inArray, exists, notExists, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  insertSelectFields,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  ltiCourseTags as tags,
  ltiCourseVideoTags as assignments,
  ltiCourseTagOperations as operations,
  ltiOperationReservations as reservations,
  mutationReceipts as receipts,
  lmsResources as resources,
  videoCourseMembers,
  videos,
  lmsInstallations,
  lmsCourses,
  teachingConnections,
  users,
  videoCourses,
  ltiCredentials,
} from "../../db/schema/sqlite";
import { MAX_COURSE_TAGS } from "../../application/course-tags";
import { activeD1LmsOwner } from "./lms-owner-policy";
import type {
  CourseTagRepository,
  CourseTag,
} from "../contracts/course-tag-repository";
import {
  tagDenied,
  tagConflict,
  assertTagCatalogSize,
  assertTagOperationIdentity,
  assertTagOperationAvailable,
  checkTagMutation,
  refineTagScope,
  tagCatalog,
  checkCourseTags,
  type TagResource,
} from "../../shared/course-tags";
import { digest } from "../../features/lti/store";
import { operationReservationKey } from "../../shared/lti-operation-key";
export function createD1CourseTagRepository(
  database: D1Database,
): CourseTagRepository {
  const db = createD1Connection(database);
  return {
    async execute(original, input) {
      checkCourseTags(original, input);
      const candidates = [
          ...new Set([
            ...original.readableVideoIds,
            ...original.management.map((r) => r.videoId),
          ]),
        ],
        proof = original.sessionProof;
      const auth = exists(
        db
          .select({ id: lmsInstallations.id })
          .from(lmsInstallations)
          .innerJoin(
            lmsCourses,
            eq(lmsCourses.installationId, lmsInstallations.id),
          )
          .innerJoin(
            teachingConnections,
            and(
              eq(teachingConnections.provider, "moodle"),
              eq(teachingConnections.installationId, lmsInstallations.id),
              eq(teachingConnections.contextId, lmsCourses.contextId),
              eq(teachingConnections.courseId, lmsCourses.courseId),
              eq(teachingConnections.active, true),
            ),
          )
          .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
          .innerJoin(videoCourses, eq(videoCourses.id, lmsCourses.courseId))
          .where(
            and(
              eq(lmsInstallations.id, original.installationId),
              eq(users.id, original.ownerUserId),
              eq(lmsInstallations.active, true),
              activeD1LmsOwner(),
              eq(lmsCourses.contextId, original.contextId),
              eq(lmsCourses.courseId, original.courseId),
              eq(videoCourses.userId, users.id),
              eq(videoCourses.managedByLms, true),
              proof
                ? exists(
                    db
                      .select({ id: ltiCredentials.id })
                      .from(ltiCredentials)
                      .where(
                        and(
                          eq(ltiCredentials.id, proof.sessionHash),
                          eq(ltiCredentials.kind, "session"),
                          sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`,
                          eq(
                            sql`json_extract(${ltiCredentials.payload},'$.registrationId')`,
                            proof.registrationId,
                          ),
                          eq(
                            sql`json_extract(${ltiCredentials.payload},'$.subjectHash')`,
                            proof.subjectHash,
                          ),
                        ),
                      ),
                  )
                : undefined,
            ),
          ),
      );
      const vocabulary = db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          revision: tags.revision,
        })
        .from(tags)
        .where(eq(tags.courseId, original.courseId))
        .orderBy(tags.name, tags.id)
        .limit(MAX_COURSE_TAGS + 1)
        .as("vocabulary");
      const assigned = db
        .select({ videoId: assignments.videoId })
        .from(assignments)
        .where(eq(assignments.tagId, vocabulary.id))
        .orderBy(assignments.videoId)
        .as("assigned");
      const videoIds = db
        .select({
          value: sql`json_group_array(CAST(${assigned.videoId} AS TEXT))`,
        })
        .from(assigned);
      const tagJson = db
        .select({
          value: sql`json_group_array(json_object('id',${vocabulary.id},'name',${vocabulary.name},'color',${vocabulary.color},'revision',${vocabulary.revision},'video_ids',json(${videoIds})))`,
        })
        .from(vocabulary);
      const resourceRows = db
        .select({
          id: resources.id,
          videoId: resources.videoId,
          resourceLinkId: resources.resourceLinkId,
          generation: resources.generation,
          status: videos.status,
        })
        .from(resources)
        .innerJoin(
          videoCourseMembers,
          and(
            eq(videoCourseMembers.videoId, resources.videoId),
            eq(videoCourseMembers.courseId, resources.courseId),
          ),
        )
        .innerJoin(
          videos,
          and(eq(videos.id, resources.videoId), eq(videos.managedByLms, true)),
        )
        .where(
          and(
            eq(resources.installationId, original.installationId),
            eq(resources.contextId, original.contextId),
            eq(resources.courseId, original.courseId),
            eq(videos.userId, original.ownerUserId),
            eq(resources.enabled, true),
            inArray(resources.videoId, candidates),
          ),
        )
        .orderBy(resources.id)
        .as("tag_resources");
      const resourceJson = db
        .select({
          value: sql`json_group_array(json_object('video_id',${resourceRows.videoId},'resource_link_id',${resourceRows.resourceLinkId},'generation',${resourceRows.generation},'status',${resourceRows.status}))`,
        })
        .from(resourceRows);
      const gate = (token: string) =>
        exists(
          db
            .select({ token: receipts.token })
            .from(receipts)
            .where(eq(receipts.token, token)),
        );
      const operationId =
        input.action === "list" ? "" : input.operationId.toLowerCase();
      const hash =
          input.action === "list" ? "" : await digest(JSON.stringify(input)),
        key = await operationReservationKey("tag", operationId);
      for (let retry = 0; retry < 5; retry++) {
        const snapshot = await runD1Batch<Record<string, unknown>>(database, [
          db
            .select({ allowed: auth.as("allowed") })
            .from(sql`(VALUES(1)) input`),
          db
            .select({ resources: sql`${resourceJson}`.as("resources") })
            .from(sql`(VALUES(1)) input`),
          db
            .select({ tags: sql`${tagJson}`.as("tags") })
            .from(sql`(VALUES(1)) input`),
          db
            .select({
              course_id: operations.courseId,
              actor_key: operations.actorKey,
              request_hash: operations.requestHash,
            })
            .from(operations)
            .where(eq(operations.id, operationId)),
          db
            .select({ key: reservations.key })
            .from(reservations)
            .where(eq(reservations.key, key)),
        ]);
        if (!snapshot[0].results[0]?.allowed) throw tagDenied();
        const rawResources = String(snapshot[1].results[0].resources),
          rawTags = String(snapshot[2].results[0].tags);
        const scope = refineTagScope(
            original,
            JSON.parse(rawResources) as TagResource[],
          ),
          all = JSON.parse(rawTags) as CourseTag[];
        if (input.action === "list") return tagCatalog(all, scope);
        assertTagCatalogSize(all.length);
        const prior = snapshot[3].results[0];
        if (prior)
          assertTagOperationIdentity(
            Number(prior.course_id) === scope.courseId,
            prior.actor_key === scope.actorKey,
            prior.request_hash === hash,
          );
        else {
          assertTagOperationAvailable(snapshot[4].results.length === 0);
          await checkTagMutation(scope, input, all);
        }
        const token = crypto.randomUUID();
        const operationGuard = prior
          ? exists(
              db
                .select({ id: operations.id })
                .from(operations)
                .where(
                  and(
                    eq(operations.id, operationId),
                    eq(operations.courseId, scope.courseId),
                    eq(operations.actorKey, scope.actorKey),
                    eq(operations.requestHash, hash),
                  ),
                ),
            )
          : and(
              notExists(
                db
                  .select({ id: operations.id })
                  .from(operations)
                  .where(eq(operations.id, operationId)),
              ),
              notExists(
                db
                  .select({ key: reservations.key })
                  .from(reservations)
                  .where(eq(reservations.key, key)),
              ),
            )!;
        const statements: D1Query[] = [
          db.insert(receipts).select(
            db
              .select(
                insertSelectValues(receipts, {
                  token,
                  kind: "lti_tag",
                  resourceId: 0,
                }),
              )
              .from(sql`(VALUES(1)) input`)
              .where(
                and(
                  auth,
                  sql`${resourceJson}=${rawResources}`,
                  sql`${tagJson}=${rawTags}`,
                  operationGuard,
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
          if (input.action === "create")
            statements.push(
              db.insert(tags).select(
                db
                  .select(
                    insertSelectValues(tags, {
                      id: operationId,
                      courseId: scope.courseId,
                      name: input.name,
                      color: input.color,
                      revision: crypto.randomUUID(),
                    }),
                  )
                  .from(receipts)
                  .where(eq(receipts.token, token)),
              ),
            );
          else if (input.action === "assign")
            statements.push(
              db
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
                    gate(token),
                  ),
                ),
              db.insert(assignments).select(
                db
                  .select(
                    insertSelectFields(assignments, {
                      tagId: sql`value`,
                      videoId: sql`${input.videoId}`,
                    }),
                  )
                  .from(sql`json_each(${JSON.stringify(input.tagIds)})`)
                  .where(gate(token)),
              ),
            );
          else if (input.action === "delete")
            statements.push(
              db
                .delete(tags)
                .where(
                  and(
                    eq(tags.id, input.id),
                    eq(tags.courseId, scope.courseId),
                    gate(token),
                  ),
                ),
            );
          else
            statements.push(
              db
                .update(tags)
                .set({
                  name: input.name,
                  color: input.color,
                  revision: crypto.randomUUID(),
                })
                .where(
                  and(
                    eq(tags.id, input.id),
                    eq(tags.courseId, scope.courseId),
                    gate(token),
                  ),
                ),
            );
          statements.push(
            db.insert(operations).select(
              db
                .select(
                  insertSelectValues(operations, {
                    id: operationId,
                    courseId: scope.courseId,
                    actorKey: scope.actorKey,
                    action: input.action,
                    requestHash: hash,
                  }),
                )
                .from(receipts)
                .where(eq(receipts.token, token)),
            ),
          );
        }
        const output = statements.length;
        statements.push(
          db
            .select({ tags: sql`${tagJson}`.as("tags") })
            .from(receipts)
            .where(eq(receipts.token, token)),
          db.delete(receipts).where(eq(receipts.token, token)),
        );
        let result: D1Result<Record<string, unknown>>[];
        try {
          result = await runD1Batch<Record<string, unknown>>(
            database,
            statements,
          );
        } catch (error) {
          if (String(error).includes("UNIQUE constraint failed"))
            throw tagConflict();
          throw error;
        }
        const row = result[output].results[0];
        if (row)
          return tagCatalog(
            JSON.parse(String(row.tags)) as CourseTag[],
            scope,
            Boolean(prior),
          );
      }
      throw tagConflict();
    },
  };
}
