import { privacyDrizzleLogic } from "../privacy-policy-sql";
import { and, or, eq, inArray, sql } from "drizzle-orm";
import { alias, union } from "drizzle-orm/pg-core";
import {
  privacyCatalogPage,
  privacySubjectsWithData,
  privacyHistoryNeedsUpgrade,
} from '../../domain/lms/privacy-policy';
import { PRIVACY_CONTEXT_PAGE_SIZE } from '../../domain/lms/privacy';
import { withDb } from "../../db/pool";
import {
  lmsInstallations,
  users,
  teachingConnections,
  chatLogs,
  ltiChatLogSubjects as subjects,
  ltiCredentials,
  lmsCourses,
} from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import type { PrivacyRepository } from "../contracts/privacy-repository";
import {
  ORPHAN_CONTEXT,
  privacySubject,
  assertPrivacyRecovery,
} from "../../shared/privacy";
import {
  subjectPrivacyContexts,
  exportPrivacyPart,
  erasePrivacyData,
} from "./privacy-data";
export function createPostgresPrivacyRepository(
  env: Bindings,
): PrivacyRepository {
  return {
    async execute(installation, request) {
      return withDb(env, async (db, client) => {
        await client.query("BEGIN");
        try {
          const identity = and(
            eq(lmsInstallations.id, installation.id),
            eq(lmsInstallations.ownerUserId, installation.ownerUserId),
            eq(lmsInstallations.issuer, installation.issuer),
            eq(lmsInstallations.clientId, installation.clientId),
            eq(lmsInstallations.deploymentId, installation.deploymentId),
            installation.jwksUrl == null
              ? undefined
              : eq(lmsInstallations.jwksUrl, installation.jwksUrl),
          );
          assertPrivacyRecovery(
            (
              await db
                .select({ id: lmsInstallations.id })
                .from(lmsInstallations)
                .where(identity)
            ).length > 0,
          );
          // Recovery remains independent of enrolment, quota and connection activity.
          // Lock every affected owner in stable order before rechecking installation identity.
          const registered = alias(subjects, "registered");
          const affected = db
            .select({ id: chatLogs.userId })
            .from(chatLogs)
            .innerJoin(subjects, eq(subjects.chatLogId, chatLogs.id))
            .where(
              inArray(
                subjects.subjectKey,
                db
                  .select({ key: registered.subjectKey })
                  .from(registered)
                  .where(
                    eq(registered.registrationId, "db:" + installation.id),
                  ),
              ),
            );
          const owners = await db
            .select({ id: users.id })
            .from(users)
            .where(
              or(
                eq(users.id, installation.ownerUserId),
                inArray(
                  users.id,
                  db
                    .select({ id: teachingConnections.ownerUserId })
                    .from(teachingConnections)
                    .where(
                      and(
                        eq(teachingConnections.provider, "moodle"),
                        eq(teachingConnections.installationId, installation.id),
                      ),
                    ),
                ),
                inArray(users.id, affected),
              ),
            )
            .orderBy(users.id)
            .for(request.action === "erase" ? "update" : "share");
          const current = await db
            .select({ id: lmsInstallations.id })
            .from(lmsInstallations)
            .where(identity)
            .for("share");
          assertPrivacyRecovery(owners.length > 0 && current.length > 0);
          const legacy = await db
            .select({ id: ltiCredentials.id })
            .from(ltiCredentials)
            .where(
              and(
                eq(ltiCredentials.kind, "lti-history"),
                privacyHistoryNeedsUpgrade(
                  sql`${ltiCredentials.expiresAt}>now()`,
                  sql`${ltiCredentials.payload}->>'registrationId' IS NULL`,
                  sql`${ltiCredentials.payload}->>'subjectHash' IS NULL`,
                  privacyDrizzleLogic,
                ),
              ),
            )
            .limit(1);
          assertPrivacyRecovery(true, !legacy.length);
          let result: unknown;
          if (request.action === "catalog") {
            const contexts = union(
              db
                .select({ context: lmsCourses.contextId })
                .from(lmsCourses)
                .where(eq(lmsCourses.installationId, installation.id)),
              db
                .select({ context: teachingConnections.contextId })
                .from(teachingConnections)
                .where(
                  and(
                    eq(teachingConnections.provider, "moodle"),
                    eq(teachingConnections.installationId, installation.id),
                  ),
                ),
              db
                .select({
                  context:
                    sql<string>`${ltiCredentials.payload}->>'contextId'`.as(
                      "context",
                    ),
                })
                .from(ltiCredentials)
                .where(
                  and(
                    eq(ltiCredentials.kind, "lti-history"),
                    eq(
                      sql`${ltiCredentials.payload}->>'registrationId'`,
                      "db:" + installation.id,
                    ),
                    sql`${ltiCredentials.payload}->>'contextId' IS NOT NULL`,
                  ),
                ),
              db
                .select({
                  context: sql<string>`${ORPHAN_CONTEXT}`.as("context"),
                })
                .from(sql`(VALUES(1)) singleton(value)`),
            ).as("contexts");
            const rows = await db
              .select({ context: contexts.context })
              .from(contexts)
              .where(
                sql`${contexts.context} COLLATE "C">${request.after ?? ""}`,
              )
              .orderBy(sql`${contexts.context} COLLATE "C"`)
              .limit(PRIVACY_CONTEXT_PAGE_SIZE + 1);
            result = privacyCatalogPage(rows, (row) => row.context);
          } else if (request.action === "users") {
            const matches: boolean[] = [];
            for (const raw of request.subjects) {
              const found = await subjectPrivacyContexts(
                db,
                installation,
                await privacySubject(installation, raw),
                "",
                request.contexts,
              );
              matches.push(found.contexts.length > 0);
            }
            result = {
              subjects: privacySubjectsWithData(request.subjects, matches),
            };
          } else {
            const subject = await privacySubject(installation, request.subject);
            result =
              request.action === "contexts"
                ? await subjectPrivacyContexts(
                    db,
                    installation,
                    subject,
                    request.after,
                  )
                : request.action === "export"
                  ? await exportPrivacyPart(db, installation, subject, request)
                  : {
                      erased: await erasePrivacyData(
                        db,
                        installation,
                        subject,
                        request.contexts,
                      ),
                    };
          }
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    },
  };
}
