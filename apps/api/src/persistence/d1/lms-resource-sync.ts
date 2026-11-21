import {
  and,
  or,
  eq,
  ne,
  inArray,
  exists,
  isNotNull,
  not,
  sql,
  getTableColumns,
  type SQLWrapper,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  runD1Batch,
  insertSelectFields,
  insertSelectValues,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  lmsInstallations as installations,
  users,
  lmsResources as resources,
  lmsCourses,
  teachingConnections as connections,
  videoCourses as courses,
  videos,
  videoCourseMembers as members,
  ltiCourseTags as tags,
  ltiCourseVideoTags as assignments,
  externalTasks as tasks,
  mcpIdempotencyRecords as idempotency,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  materialTeacherConnectionAccess,
  materialTeacherCourseMatches,
} from "../../application/lms-owner";
import { activeD1LmsOwner } from "./lms-owner-policy";
import {
  planResourceRemoval,
  resourceContentValues,
  resourceCourseTitle,
  resourceUploadError,
} from "../../application/resource-mutation";
import { resourceDrizzleErrorChoice } from "../resource-policy-sql";
import {
  planResourceReconciliation,
  resourceCourseBindingMatches,
  resourceCourseOwnerMatches,
  resourceRevisionConflict,
  resourceVideoBindingMatches,
} from "../../application/resource-reconciliation";
import {
  quotaAllowsAdditional,
  validateUploadReservationBytes,
} from "../../application/quota-policy";
import { quotaDrizzleComparison } from "../quota-policy-sql";
import { MaterialsLeaseLostError } from "../contracts/materials-sync-repository";
import { d1MaterialsLease } from "./materials-sync-repository";
import type {
  LmsResource,
  LmsResourceSyncRepository,
} from "../contracts/lms-resource-repository";
import { LmsSyncError } from "../../features/lms/resource";
import {
  buildPendingUploadFileKey,
  fileExtension,
  parseReservedBytesFromFileKey,
} from "../../lib/upload";
import { buildJobMessage, JOB_TRANSCRIBE_VIDEO } from "../../lib/job-message";
import { normalizeLmsResource } from "../../shared/lms-resource-values";
import {
  enqueueCurrentSceneDeletes,
  enqueueStagedSceneDeletes,
} from "./scene-index-writer";
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const month = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month')`;
const resourceJson = sql<string>`json_object('id',${resources.id},'installationId',${resources.installationId},'externalId',${resources.externalId},'kind',${resources.kind},'contextId',${resources.contextId},'resourceLinkId',${resources.resourceLinkId},'generation',${resources.generation},'manifestHash',${resources.manifestHash},'enabled',${resources.enabled},'contentHash',${resources.contentHash},'contentType',${resources.contentType},'fileSize',${resources.fileSize},'youtubeVideoId',${resources.youtubeVideoId},'courseId',${resources.courseId},'videoId',${resources.videoId},'syncError',${resources.syncError},'updatedAt',${resources.updatedAt})`;
type Video = {
  id: number;
  userId: string;
  status: string;
  file: string;
  sourceType: string;
  youtubeVideoId: string;
  transcriptionLanguage: string | null;
  period: string | null;
  multipart: string | null;
  managed: number;
  heartbeat: string | null;
};
type Mapping = {
  id: string;
  courseId: number;
  userId: string | null;
  managed: number | null;
  disabled: number | null;
};
type Course = { id: number; userId: string; managed: number; disabled: number };
function resource(raw: string): LmsResource {
  const r = JSON.parse(raw) as LmsResource;
  return normalizeLmsResource({ ...r, enabled: Boolean(r.enabled) });
}
type Probe = { query: D1Query & SQLWrapper; raw: string | null };
export function createD1LmsResourceSyncRepository(
  database: D1Database,
): LmsResourceSyncRepository {
  const db = createD1Connection(database);
  async function probes(
    queries: Array<D1Query & SQLWrapper>,
  ): Promise<Probe[]> {
    const result = await runD1Batch<{ value: string }>(database, queries);
    return queries.map((query, i) => ({
      query,
      raw: result[i].results[0]?.value ?? null,
    }));
  }
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const inserted = (token: string, kind: string) =>
    db.insert(receipts).select(
      db
        .select(
          insertSelectValues(receipts, {
            token,
            kind,
            resourceId: sql`last_insert_rowid()`,
          }),
        )
        .from(sql`(VALUES(1)) input`)
        .where(sql`changes()=1`),
    );
  return {
    async sync(grant, externalId, manifest, manifestHash) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const [linkProbe] = await probes([
          db
            .select({
              value:
                sql<string>`json_object('id',${connections.id},'ownerUserId',${connections.ownerUserId},'courseId',${connections.courseId},'resourceLinkId',${connections.resourceLinkId})`.as(
                  "value",
                ),
            })
            .from(connections)
            .where(
              and(
                eq(connections.provider, "moodle"),
                eq(connections.installationId, grant.id),
                eq(connections.contextId, manifest.contextId),
                eq(connections.active, true),
              ),
            ),
        ]);
        const candidateLink = linkProbe.raw
          ? (JSON.parse(linkProbe.raw) as {
              id: string;
              ownerUserId: string;
              courseId: number;
              resourceLinkId: string | null;
            })
          : null;
        const access = materialTeacherConnectionAccess(
          candidateLink,
          grant.ownerUserId,
        );
        if (access.kind === "denied") throw new LmsSyncError(403, access.code);
        const link = access.connection,
          ownerUserId = link.ownerUserId;
        const active = exists(
          db
            .select({ id: installations.id })
            .from(installations)
            .innerJoin(users, eq(users.id, ownerUserId))
            .where(
              and(
                eq(installations.id, grant.id),
                eq(installations.active, true),
                activeD1LmsOwner(),
              ),
            ),
        );
        const authority = and(
          active,
          grant.materialsLease
            ? d1MaterialsLease(
                { ...grant.materialsLease, installationId: grant.id },
                "materials-lease",
              )
            : undefined,
        )!;
        if (
          !(
            await db
              .select({ allowed: authority })
              .from(sql`(VALUES(1)) input`)
              .get()
          )?.allowed
        ) {
          if (
            grant.materialsLease &&
            (
              await db
                .select({ allowed: active })
                .from(sql`(VALUES(1)) input`)
                .get()
            )?.allowed
          )
            throw new MaterialsLeaseLostError();
          throw new LmsSyncError(403, "INSTALLATION_UNAVAILABLE");
        }
        const [previousProbe, mappingProbe, entryProbe] = await probes([
          db
            .select({ value: resourceJson.as("value") })
            .from(resources)
            .where(
              and(
                eq(resources.installationId, grant.id),
                eq(resources.externalId, externalId),
              ),
            ),
          db
            .select({
              value:
                sql<string>`json_object('id',${lmsCourses.id},'courseId',${lmsCourses.courseId},'userId',${courses.userId},'managed',${courses.managedByLms},'disabled',${courses.nativeAccessDisabled})`.as(
                  "value",
                ),
            })
            .from(lmsCourses)
            .leftJoin(courses, eq(courses.id, lmsCourses.courseId))
            .where(
              and(
                eq(lmsCourses.installationId, grant.id),
                eq(lmsCourses.contextId, manifest.contextId),
              ),
            ),
          db
            .select({ value: sql<string>`${resources.id}`.as("value") })
            .from(resources)
            .where(
              and(
                eq(resources.installationId, grant.id),
                eq(resources.contextId, manifest.contextId),
                eq(resources.kind, "course"),
              ),
            ),
        ]);
        const previous = previousProbe.raw ? resource(previousProbe.raw) : null,
          mapping = mappingProbe.raw
            ? (JSON.parse(mappingProbe.raw) as Mapping)
            : null;
        if (!mapping || !materialTeacherCourseMatches(mapping, link.courseId))
          throw new LmsSyncError(403, "TEACHER_CONNECTION_REQUIRED");
        const otherResources = db
          .select({ count: sql<number>`count(*)` })
          .from(resources)
          .where(
            and(
              eq(resources.videoId, sql`${previous?.videoId ?? null}`),
              ne(resources.id, sql`${previous?.id ?? null}`),
            ),
          );
        const otherMembers = db
          .select({ count: sql<number>`count(*)` })
          .from(members)
          .where(
            and(
              eq(members.videoId, sql`${previous?.videoId ?? null}`),
              sql`${members.courseId} IS NOT ${previous?.courseId ?? null}`,
            ),
          );
        const [videoProbe, oldCourseProbe, sharedProbe] = await probes([
          db
            .select({
              value:
                sql<string>`json_object('id',${videos.id},'userId',${videos.userId},'status',${videos.status},'file',${videos.file},'sourceType',${videos.sourceType},'youtubeVideoId',${videos.youtubeVideoId},'transcriptionLanguage',${videos.transcriptionLanguage},'period',${videos.uploadUsagePeriodStart},'multipart',${videos.multipartUpload},'managed',${videos.managedByLms},'heartbeat',${videos.uploadHeartbeatAt})`.as(
                  "value",
                ),
            })
            .from(videos)
            .where(eq(videos.id, sql`${previous?.videoId ?? null}`)),
          db
            .select({
              value:
                sql<string>`json_object('id',${courses.id},'userId',${courses.userId},'managed',${courses.managedByLms},'disabled',${courses.nativeAccessDisabled})`.as(
                  "value",
                ),
            })
            .from(courses)
            .where(eq(courses.id, sql`${previous?.courseId ?? null}`)),
          db
            .select({
              value:
                sql<string>`CAST(${otherResources}+${otherMembers} AS TEXT)`.as(
                  "value",
                ),
            })
            .from(sql`(VALUES(1)) input`),
        ]);
        const video = videoProbe.raw
          ? (JSON.parse(videoProbe.raw) as Video)
          : null;
        const oldCourse = oldCourseProbe.raw
          ? (JSON.parse(oldCourseProbe.raw) as Course)
          : null;
        const revisionConflict = resourceRevisionConflict(
          previous,
          manifest,
          manifestHash,
        );
        if (revisionConflict) throw new LmsSyncError(409, revisionConflict);
        if (
          !resourceCourseOwnerMatches(ownerUserId, mapping) ||
          (manifest.kind === "course" &&
            !resourceCourseBindingMatches(
              ownerUserId,
              {
                id: mapping.courseId,
                userId: mapping.userId,
                managedByLms: Boolean(mapping.managed),
                nativeAccessDisabled: Boolean(mapping.disabled),
              },
              previous?.courseId,
            ))
        )
          throw new LmsSyncError(409, "COURSE_BINDING_CHANGED");
        if (
          !resourceVideoBindingMatches(ownerUserId, manifest, previous, video)
        )
          throw new LmsSyncError(409, "RESOURCE_BINDING_CHANGED");
        const reconciliation = planResourceReconciliation(
          ownerUserId,
          previous,
          video,
          manifest,
          mapping.courseId,
        );
        const { idempotent, keepVideo: keep } = reconciliation;
        if (reconciliation.languageLocked)
          throw new LmsSyncError(409, "TRANSCRIPTION_LANGUAGE_LOCKED");
        const removing = reconciliation.replaceSource && video !== null;
        const removalBytes =
          removing && video ? parseReservedBytesFromFileKey(video.file) : null;
        const removal =
          removing && video
            ? planResourceRemoval({
                shared: Number(sharedProbe.raw) > 0,
                status: video.status,
                bytes: removalBytes,
                uploadPeriodStart: video.period,
              })
            : null;
        if (removal?.kind === "blocked")
          throw new LmsSyncError(409, removal.code);
        const fences = [
          linkProbe,
          previousProbe,
          mappingProbe,
          videoProbe,
          oldCourseProbe,
          entryProbe,
          ...(removing ? [sharedProbe] : []),
        ];
        const token = crypto.randomUUID(),
          videoToken = token + ":video",
          clockToken = token + ":month";
        // The entire plan is admitted only while every observed row remains unchanged.
        const statements: (D1Query | D1PreparedStatement)[] = [
          db.insert(receipts).select(
            db
              .select(
                insertSelectValues(receipts, {
                  token,
                  kind: "lms_sync",
                  resourceId: 0,
                }),
              )
              .from(sql`(VALUES(1)) input`)
              .where(
                and(
                  authority,
                  ...fences.map((p) => sql`${p.query} IS ${p.raw}`),
                ),
              ),
          ),
        ];
        if (manifest.kind !== "course") {
          if (video)
            statements.push(
              db
                .update(videos)
                .set({ managedByLms: true })
                .where(
                  and(
                    eq(videos.id, video.id),
                    eq(videos.userId, ownerUserId),
                    gate(token),
                  ),
                ),
            );
          if (oldCourse)
            statements.push(
              db
                .update(courses)
                .set({ managedByLms: true, nativeAccessDisabled: true })
                .where(
                  and(
                    eq(courses.id, oldCourse.id),
                    eq(courses.userId, ownerUserId),
                    gate(token),
                  ),
                ),
            );
        }
        if (!idempotent) {
          if (manifest.kind !== "course") {
            if (reconciliation.detachMembership && previous) {
              if (reconciliation.clearPreviousVocabulary)
                statements.push(
                  db.delete(assignments).where(
                    and(
                      eq(assignments.videoId, sql`${previous.videoId}`),
                      inArray(
                        assignments.tagId,
                        db
                          .select({ id: tags.id })
                          .from(tags)
                          .where(eq(tags.courseId, sql`${previous.courseId}`)),
                      ),
                      gate(token),
                    ),
                  ),
                );
              statements.push(
                db
                  .delete(members)
                  .where(
                    and(
                      eq(members.courseId, sql`${previous.courseId}`),
                      eq(members.videoId, sql`${previous.videoId}`),
                      gate(token),
                    ),
                  ),
              );
            }
            if (video && removal?.kind === "remove") {
              const bytes = removalBytes,
                multipart = video.multipart
                  ? (JSON.parse(video.multipart) as { uploadId: string })
                  : null;
              statements.push(
                db
                  .insert(tasks)
                  .select(
                    db
                      .select(
                        insertSelectValues(tasks, {
                          kind: "storage_cleanup",
                          payload: {
                            file_key: video.file,
                            user_id: ownerUserId,
                            bytes,
                            ...(multipart
                              ? { multipart_upload_id: multipart.uploadId }
                              : {}),
                          },
                          dedupeKey: `storage:video:${video.id}`,
                        }),
                      )
                      .from(receipts)
                      .where(eq(receipts.token, token)),
                  )
                  .onConflictDoNothing({ target: tasks.dedupeKey }),
                db
                  .insert(tasks)
                  .select(
                    db
                      .select(
                        insertSelectValues(tasks, {
                          kind: "storage_cleanup",
                          payload: {
                            file_key: video.file,
                            user_id: ownerUserId,
                            bytes: null,
                          },
                          dedupeKey: `storage:video:${video.id}:late-upload`,
                          availableAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours')`,
                        }),
                      )
                      .from(receipts)
                      .where(
                        and(
                          eq(receipts.token, token),
                          sql`${Number(removal.lateUploadCleanup)}=1`,
                          exists(
                            db
                              .select({ id: installations.id })
                              .from(installations)
                              .where(
                                and(
                                  eq(installations.id, grant.id),
                                  isNotNull(installations.materialsService),
                                ),
                              ),
                          ),
                        ),
                      ),
                  )
                  .onConflictDoNothing({ target: tasks.dedupeKey }),
                enqueueCurrentSceneDeletes(database, video.id, token),
                enqueueStagedSceneDeletes(database, video.id, token),
              );
              if (removal.refund)
                statements.push(
                  db
                    .update(users)
                    .set({
                      usedUploadBytes: sql`max(0,${users.usedUploadBytes}-${removal.refund.bytes})`,
                    })
                    .where(
                      and(
                        eq(users.id, ownerUserId),
                        sql`julianday(${users.uploadUsagePeriodStart})=julianday(${removal.refund.periodStart})`,
                        gate(token),
                      ),
                    ),
                );
              statements.push(
                db
                  .delete(idempotency)
                  .where(
                    and(
                      eq(idempotency.userId, ownerUserId),
                      eq(idempotency.resourceId, video.id),
                      inArray(idempotency.action, [
                        "request_video_upload",
                        "create_youtube_video",
                      ]),
                      gate(token),
                    ),
                  ),
                db
                  .delete(videos)
                  .where(
                    and(
                      eq(videos.id, video.id),
                      eq(videos.userId, ownerUserId),
                      gate(token),
                    ),
                  ),
              );
            }
            if (manifest.enabled && !keep) {
              if (manifest.kind === "youtube") {
                statements.push(
                  db.insert(videos).select(
                    db
                      .select(
                        insertSelectValues(videos, {
                          userId: ownerUserId,
                          managedByLms: true,
                          title: manifest.title,
                          description: "",
                          transcript: "",
                          errorMessage: "",
                          file: "",
                          status: "pending",
                          sourceType: "youtube",
                          sourceUrl:
                            "https://www.youtube.com/watch?v=" +
                            manifest.youtubeVideoId!,
                          youtubeVideoId: manifest.youtubeVideoId!,
                          uploadedAt: now,
                        }),
                      )
                      .from(receipts)
                      .where(eq(receipts.token, token)),
                  ),
                  inserted(videoToken, "lms_youtube"),
                );
                const message = buildJobMessage(JOB_TRANSCRIBE_VIDEO, {
                  video_id: 0,
                });
                statements.push(
                  db.insert(tasks).select(
                    db
                      .select(
                        insertSelectValues(tasks, {
                          kind: "sqs_job",
                          payload: sql`json_set(${JSON.stringify({ message })},'$.message.payload.video_id',${receipts.resourceId})`,
                          dedupeKey: "job:" + message.job_id,
                        }),
                      )
                      .from(receipts)
                      .where(eq(receipts.token, videoToken)),
                  ),
                );
              } else {
                const file = manifest.file!;
                validateUploadReservationBytes(file.size);
                statements.push(
                  db.insert(receipts).select(
                    db
                      .select(
                        insertSelectValues(receipts, {
                          token: clockToken,
                          kind: month,
                          resourceId: 0,
                        }),
                      )
                      .from(receipts)
                      .where(eq(receipts.token, token)),
                  ),
                );
                const period = db
                  .select({ value: receipts.kind })
                  .from(receipts)
                  .where(eq(receipts.token, clockToken));
                const usage = sql`CASE WHEN strftime('%Y-%m',${users.uploadUsagePeriodStart})=strftime('%Y-%m',${period}) THEN ${users.usedUploadBytes} ELSE 0 END`;
                const storageAllowed = quotaAllowsAdditional(
                  users.usedStorageBytes,
                  sql`floor(${users.storageLimitGb}*1073741824)`,
                  sql`${file.size}`,
                  quotaDrizzleComparison,
                );
                const uploadAllowed = quotaAllowsAdditional(
                  usage,
                  sql`floor(${users.monthlyUploadLimitGb}*1073741824)`,
                  sql`${file.size}`,
                  quotaDrizzleComparison,
                );
                statements.push(
                  db.insert(videos).select(
                    db
                      .select(
                        insertSelectFields(videos, {
                          userId: users.id,
                          managedByLms: sql`1`,
                          title: sql`${manifest.title}`,
                          description: sql`''`,
                          transcript: sql`''`,
                          errorMessage: sql`''`,
                          file: sql`${buildPendingUploadFileKey(ownerUserId, file.size, fileExtension(file.filename))}`,
                          status: sql`'uploading'`,
                          sourceType: sql`'uploaded'`,
                          sourceUrl: sql`''`,
                          youtubeVideoId: sql`''`,
                          uploadedAt: now,
                          transcriptionLanguage: sql`${manifest.transcriptionLanguage ?? null}`,
                          uploadUsagePeriodStart: sql`${period}`,
                        }),
                      )
                      .from(users)
                      .where(
                        and(
                          eq(users.id, ownerUserId),
                          gate(token),
                          sql`${users.isOverQuota} IS NOT TRUE`,
                          storageAllowed,
                          uploadAllowed,
                          sql`${users.usedStorageBytes}<=9007199254740991-${file.size}`,
                          sql`${usage}<=9007199254740991-${file.size}`,
                        ),
                      ),
                  ),
                  inserted(videoToken, "lms_upload"),
                  db
                    .update(users)
                    .set({
                      usedStorageBytes: sql`${users.usedStorageBytes}+${file.size}`,
                      usedUploadBytes: sql`${usage}+${file.size}`,
                      uploadUsagePeriodStart: sql`${period}`,
                    })
                    .where(and(eq(users.id, ownerUserId), gate(videoToken))),
                );
              }
            } else if (manifest.enabled && keep)
              statements.push(
                db
                  .update(videos)
                  .set({ title: manifest.title, managedByLms: true })
                  .where(
                    and(
                      eq(videos.id, sql`${reconciliation.videoId}`),
                      eq(videos.userId, ownerUserId),
                      gate(token),
                    ),
                  ),
              );
          }
          const chosenVideo = keep
            ? sql`${reconciliation.videoId}`
            : sql`${db.select({ id: receipts.resourceId }).from(receipts).where(eq(receipts.token, videoToken))}`;
          if (
            (manifest.kind === "course" && manifest.courseTitle) ||
            (manifest.kind !== "course" && manifest.enabled)
          )
            statements.push(
              db
                .update(courses)
                .set({
                  managedByLms: true,
                  nativeAccessDisabled: true,
                  name: sql`coalesce(${resourceCourseTitle(manifest, Boolean(entryProbe.raw))},${courses.name})`,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(courses.id, mapping.courseId),
                    eq(courses.userId, ownerUserId),
                    gate(token),
                    manifest.kind === "course"
                      ? undefined
                      : isNotNull(chosenVideo),
                  ),
                ),
            );
          if (manifest.kind !== "course" && manifest.enabled)
            statements.push(
              db.insert(members).select(
                db
                  .select(
                    insertSelectValues(members, {
                      courseId: mapping.courseId,
                      videoId: chosenVideo,
                      order: 0,
                      addedAt: now,
                    }),
                  )
                  .from(receipts)
                  .where(
                    and(eq(receipts.token, token), isNotNull(chosenVideo)),
                  ),
              ),
            );
          const blocked =
            manifest.kind !== "course" &&
            manifest.kind !== "youtube" &&
            manifest.enabled &&
            !keep;
          let error = sql`NULL`;
          if (blocked) {
            const storageBlocked = or(
              sql`${users.isOverQuota} IS TRUE`,
              not(
                quotaAllowsAdditional(
                  users.usedStorageBytes,
                  sql`floor(${users.storageLimitGb}*1073741824)`,
                  sql`${manifest.file!.size}`,
                  quotaDrizzleComparison,
                ),
              ),
            )!;
            const quotaError = resourceUploadError(
              storageBlocked,
              isNotNull(users.monthlyUploadLimitGb),
              resourceDrizzleErrorChoice,
            );
            const reason = db
              .select({ error: quotaError })
              .from(users)
              .where(eq(users.id, ownerUserId));
            error = sql`CASE WHEN ${chosenVideo} IS NULL THEN ${reason} ELSE NULL END`;
          }
          const content = resourceContentValues(previous, manifest);
          const values = {
            installationId: grant.id,
            externalId,
            kind: manifest.kind ?? "video",
            contextId: manifest.contextId,
            resourceLinkId: manifest.resourceLinkId,
            generation: manifest.generation,
            manifestHash,
            enabled: manifest.enabled,
            contentHash: content.contentHash,
            contentType: content.contentType,
            fileSize: content.fileSize,
            youtubeVideoId: content.youtubeVideoId,
            courseId: mapping.courseId,
            videoId: manifest.kind === "course" ? null : chosenVideo,
            syncError: error,
            updatedAt: now,
          };
          const columns = getTableColumns(resources);
          const updates = Object.fromEntries(
            (Object.keys(values) as Array<keyof typeof values>).map((key) => [
              key,
              sql`excluded.${sql.identifier(columns[key].name)}`,
            ]),
          );
          statements.push(
            db
              .insert(resources)
              .select(
                db
                  .select(
                    insertSelectValues(resources, {
                      id: previous?.id ?? crypto.randomUUID(),
                      ...values,
                    }),
                  )
                  .from(receipts)
                  .where(eq(receipts.token, token)),
              )
              .onConflictDoUpdate({ target: resources.id, set: updates }),
          );
        }
        statements.push(
          db
            .select({ value: resourceJson.as("value") })
            .from(resources)
            .where(
              and(
                eq(resources.installationId, grant.id),
                eq(resources.externalId, externalId),
                gate(token),
              ),
            ),
          db
            .delete(receipts)
            .where(inArray(receipts.token, [token, videoToken, clockToken])),
        );
        const result = await runD1Batch<{ value: string }>(
            database,
            statements,
          ),
          saved = result[result.length - 2].results[0];
        if (saved) return resource(saved.value);
      }
      throw new LmsSyncError(409, "RESOURCE_CHANGED_RETRY");
    },
  };
}
