import { insertSelectValues, runD1Batch } from "../../db/d1/query-builders";
import {
} from '../../application/teaching';
import {
  teachingConnectionConflicts,
  teachingInstallationRequired,
  teachingResourceLinkAllowed,
  selectTeachingCourse} from '../../domain/lms/teaching';
import { activeD1LmsOwner } from "./lms-owner-policy";
import { and, eq, exists, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  teachingConnections,
  lmsInstallations,
  ltiCredentials,
  mutationReceipts as receipts,
  users,
  videoCourses,
} from "../../db/schema/sqlite";
import { ticketSchema } from "../../shared/teaching";
import { ApiError } from "../../shared/errors";
import type { TeachingRepository } from "../contracts/teaching-repository";
const denied = () =>
  new ApiError(403, "FORBIDDEN", "The teaching connection is unavailable.");
const active = activeD1LmsOwner();
type Existing = {
  id: string;
  ownerUserId: string;
  teacherSubject: string;
  courseId: number;
  resourceLinkId: string | null;
  active: number;
};
export function createD1TeachingRepository(
  database: D1Database,
): TeachingRepository {
  const db = createD1Connection(database);
  const existingQuery = (
    provider: string,
    installationId: string,
    contextId: string,
  ) =>
    db
      .select({
        value: sql<string>`json_object(
  'id',${teachingConnections.id},'ownerUserId',${teachingConnections.ownerUserId},'teacherSubject',${teachingConnections.teacherSubject},
  'courseId',${teachingConnections.courseId},'resourceLinkId',${teachingConnections.resourceLinkId},'active',${teachingConnections.active})`,
      })
      .from(teachingConnections)
      .where(
        and(
          eq(teachingConnections.provider, provider),
          eq(teachingConnections.installationId, installationId),
          eq(teachingConnections.contextId, contextId),
        ),
      );
  const ticket = (id: string) =>
    and(
      eq(ltiCredentials.id, id),
      eq(ltiCredentials.kind, "teaching-connect"),
      sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`,
    );
  return {
    async consumeBootstrapNonce(id, expiresAt) {
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now()
      )
        return false;
      return (
        (
          await db
            .insert(ltiCredentials)
            .values({ id, kind: "teaching-link-nonce", payload: {}, expiresAt })
            .onConflictDoNothing()
            .returning({ id: ltiCredentials.id })
        ).length === 1
      );
    },
    async findConnection(provider, installationId, contextId) {
      const row = (
        await db
          .select({ link: teachingConnections, courseTitle: videoCourses.name })
          .from(teachingConnections)
          .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
          .innerJoin(
            videoCourses,
            and(
              eq(videoCourses.id, teachingConnections.courseId),
              eq(videoCourses.userId, teachingConnections.ownerUserId),
            ),
          )
          .where(
            and(
              eq(teachingConnections.provider, provider),
              eq(teachingConnections.installationId, installationId),
              eq(teachingConnections.contextId, contextId),
              eq(teachingConnections.active, true),
              active,
            ),
          )
      )[0];
      return row
        ? {
            ...row.link,
            createdAt: row.link.createdAt.toISOString(),
            courseTitle: row.courseTitle,
          }
        : null;
    },
    async findInstallation(id) {
      return (
        (
          await db
            .select({
              id: lmsInstallations.id,
              clientId: lmsInstallations.clientId,
              deploymentId: lmsInstallations.deploymentId,
              materialsService: lmsInstallations.materialsService,
            })
            .from(lmsInstallations)
            .where(
              and(
                eq(lmsInstallations.id, id),
                eq(lmsInstallations.active, true),
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    },
    async connect(ticketId, ownerUserId, verified, selectedCourseId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const permitted = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, ownerUserId), active))
          .limit(1);
        if (!permitted.length) throw denied();
        const raw = (
          await db
            .select({ payload: sql<string>`${ltiCredentials.payload}` })
            .from(ltiCredentials)
            .where(ticket(ticketId))
            .get()
        )?.payload;
        const parsed = ticketSchema.safeParse(raw ? JSON.parse(raw) : null);
        if (!parsed.success) throw denied();
        const input = parsed.data;
        if (JSON.stringify(input) !== JSON.stringify(verified)) throw denied();
        const previous = existingQuery(
          input.provider,
          input.installationId,
          input.contextId,
        );
        const snapshot = (await previous.get())?.value ?? null;
        const existing = snapshot ? (JSON.parse(snapshot) as Existing) : null;
        if (
          teachingConnectionConflicts(
            existing,
            ownerUserId,
            input.teacherSubject,
            selectedCourseId,
          )
        )
          throw new ApiError(
            409,
            "CONFLICT",
            "This class is already connected. Ask its owner to manage this connection.",
          );
        if (!teachingResourceLinkAllowed(input)) throw denied();
        const courseId = selectTeachingCourse(existing, selectedCourseId);
        if (courseId === null) throw denied();
        const token = crypto.randomUUID(),
          gate = exists(
            db
              .select({ token: receipts.token })
              .from(receipts)
              .where(eq(receipts.token, token)),
          );
        // The pre-read selects an expected state only. Every permission and the full
        // ticket/connection snapshot are checked again inside this atomic batch.
        const results = await runD1Batch(database, [
          db.insert(receipts).select(
            db
              .select(
                insertSelectValues(receipts, {
                  token,
                  kind: "teaching_connect",
                  resourceId: courseId,
                }),
              )
              .from(users)
              .where(
                and(
                  eq(users.id, ownerUserId),
                  active,
                  exists(
                    db
                      .select({ id: ltiCredentials.id })
                      .from(ltiCredentials)
                      .where(
                        and(
                          ticket(ticketId),
                          sql`${ltiCredentials.payload}=${raw}`,
                        ),
                      ),
                  ),
                  sql`(${previous}) IS ${snapshot}`,
                  teachingInstallationRequired(input.provider)
                    ? exists(
                        db
                          .select({ id: lmsInstallations.id })
                          .from(lmsInstallations)
                          .where(
                            and(
                              eq(lmsInstallations.id, input.installationId),
                              eq(lmsInstallations.active, true),
                            ),
                          ),
                      )
                    : undefined,
                  exists(
                    db
                      .select({ id: videoCourses.id })
                      .from(videoCourses)
                      .where(
                        and(
                          eq(videoCourses.id, courseId),
                          eq(videoCourses.userId, ownerUserId),
                          eq(videoCourses.nativeAccessDisabled, false),
                        ),
                      ),
                  ),
                ),
              ),
          ),
          db
            .insert(teachingConnections)
            .select(
              db
                .select(
                  insertSelectValues(teachingConnections, {
                    id: existing?.id ?? crypto.randomUUID(),
                    provider: input.provider,
                    installationId: input.installationId,
                    contextId: input.contextId,
                    teacherSubject: input.teacherSubject,
                    ownerUserId,
                    courseId,
                    resourceLinkId: input.resourceLinkId ?? null,
                    active: true,
                  }),
                )
                .from(receipts)
                .where(eq(receipts.token, token)),
            )
            .onConflictDoUpdate({
              target: [
                teachingConnections.provider,
                teachingConnections.installationId,
                teachingConnections.contextId,
              ],
              set: {
                active: true,
                resourceLinkId: sql`excluded.resource_link_id`,
              },
            }),
          db
            .delete(ltiCredentials)
            .where(and(eq(ltiCredentials.id, ticketId), gate)),
          db
            .select({ token: receipts.token })
            .from(receipts)
            .where(eq(receipts.token, token)),
          db.delete(receipts).where(eq(receipts.token, token)),
        ]);
        if (results[3].results.length)
          return { returnUrl: input.returnUrl, courseId };
        // Stable permission failures should not become a misleading retry conflict.
        const owner = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, ownerUserId), active))
          .limit(1);
        const course = await db
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .where(
            and(
              eq(videoCourses.id, courseId),
              eq(videoCourses.userId, ownerUserId),
              eq(videoCourses.nativeAccessDisabled, false),
            ),
          )
          .limit(1);
        if (
          !owner.length ||
          !course.length ||
          (teachingInstallationRequired(input.provider) &&
            !(await db
              .select({ id: lmsInstallations.id })
              .from(lmsInstallations)
              .where(
                and(
                  eq(lmsInstallations.id, input.installationId),
                  eq(lmsInstallations.active, true),
                ),
              )
              .get()))
        )
          throw denied();
      }
      throw new ApiError(
        409,
        "CONFLICT",
        "The teaching connection changed. Retry the connection.",
      );
    },
    async courses(ownerUserId) {
      return db
        .select({ id: videoCourses.id, name: videoCourses.name })
        .from(videoCourses)
        .where(
          and(
            eq(videoCourses.userId, ownerUserId),
            eq(videoCourses.nativeAccessDisabled, false),
          ),
        );
    },
    async connections(ownerUserId) {
      return db
        .select({
          id: teachingConnections.id,
          provider: teachingConnections.provider,
          contextId: teachingConnections.contextId,
          courseId: teachingConnections.courseId,
          name: videoCourses.name,
          active: teachingConnections.active,
        })
        .from(teachingConnections)
        .innerJoin(
          videoCourses,
          eq(videoCourses.id, teachingConnections.courseId),
        )
        .where(eq(teachingConnections.ownerUserId, ownerUserId));
    },
    async disconnect(id, ownerUserId) {
      return (
        (
          await db
            .update(teachingConnections)
            .set({ active: false })
            .where(
              and(
                eq(teachingConnections.id, id),
                eq(teachingConnections.ownerUserId, ownerUserId),
              ),
            )
            .returning({ id: teachingConnections.id })
        ).length === 1
      );
    },
  };
}
