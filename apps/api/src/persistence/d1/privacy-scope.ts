import {
  and,
  or,
  eq,
  exists,
  notExists,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { withMaterializedCtes } from "../../db/d1/query-builders";
import {
  videoCourses,
  lmsInstallations,
  users,
  ltiCredentials,
} from "../../db/schema/sqlite";
import { courseQaAuthorInput } from "../../application/subject-identity";
import { privacyHistoryNeedsUpgrade } from '../../domain/lms/privacy-policy';
import { privacyDrizzleLogic } from "../privacy-policy-sql";
import { assertPrivacyRecovery } from "../../shared/privacy";
import { ApiError } from "../../shared/errors";
import { digest } from "../../features/lti/store";
import type { PrivacySubject, PrivacyInstallation } from "../../shared/privacy";
function subjectScope(
  database: D1Database,
  installation: PrivacyInstallation,
  subject: PrivacySubject,
  contexts: string[] | null,
  authors: string,
  expectedCourses: string,
) {
  const db = createD1Connection(database);
  // Unique aliases prevent unqualified SQL expression references from resolving
  // to a similarly named column inside a correlated authorization subquery.
  const input = db
    .select({
      owner: sql<string>`${installation.ownerUserId}`.as("privacy_owner"),
      subject: sql<string>`${subject.subjectKey}`.as("privacy_subject"),
      registration: sql<string>`${subject.registrationId}`.as(
        "privacy_registration",
      ),
      subjectHash: sql<string>`${subject.subjectHash}`.as(
        "privacy_subject_hash",
      ),
      installation: sql<string>`${installation.id}`.as("privacy_installation"),
      contexts: sql<
        string | null
      >`${contexts ? JSON.stringify(contexts) : null}`.as("privacy_contexts"),
      authors: sql<string>`${authors}`.as("privacy_authors"),
      expectedCourses: sql<string>`${expectedCourses}`.as(
        "privacy_expected_courses",
      ),
      issuer: sql<string>`${installation.issuer}`.as("privacy_issuer"),
      client: sql<string>`${installation.clientId}`.as("privacy_client"),
      deployment: sql<string>`${installation.deploymentId}`.as(
        "privacy_deployment",
      ),
      jwks: sql<string | null>`${installation.jwksUrl ?? null}`.as(
        "privacy_jwks",
      ),
    })
    .from(sql`(VALUES(1)) input`);
  const params = db.$with("params").as(input);
  const ids = db
    .select({
      id: sql<string>`CAST(${videoCourses.id} AS TEXT)`.as("course_id_text"),
    })
    .from(videoCourses)
    .orderBy(videoCourses.id)
    .as("privacy_courses");
  const courses = db
    .select({ value: sql`json_group_array(${ids.id})` })
    .from(ids);
  const auth = exists(
    db
      .select({ id: lmsInstallations.id })
      .from(lmsInstallations)
      .innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
      .where(
        and(
          eq(lmsInstallations.id, params.installation),
          eq(users.id, params.owner),
          eq(lmsInstallations.issuer, params.issuer),
          eq(lmsInstallations.clientId, params.client),
          eq(lmsInstallations.deploymentId, params.deployment),
          or(
            sql`${params.jwks} IS NULL`,
            eq(lmsInstallations.jwksUrl, params.jwks),
          ),
        ),
      ),
  );
  const upgraded = notExists(
    db
      .select({ id: ltiCredentials.id })
      .from(ltiCredentials)
      .where(
        and(
          eq(ltiCredentials.kind, sql`'lti-history'`),
          privacyHistoryNeedsUpgrade(
            sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`,
            sql`json_extract(${ltiCredentials.payload},'$.registrationId') IS NULL`,
            sql`json_extract(${ltiCredentials.payload},'$.subjectHash') IS NULL`,
            privacyDrizzleLogic,
          ),
        ),
      ),
  );
  const stable = eq(sql`${courses}`, params.expectedCourses);
  const eligibleQuery = db
    .select()
    .from(params)
    .where(and(auth, upgraded, stable));
  const eligible = db.$with("eligible").as(eligibleQuery);
  return {
    db,
    p: eligible,
    wrap: (query: SQLWrapper) =>
      withMaterializedCtes(
        [
          { name: "params", source: input },
          { name: "eligible", source: eligibleQuery },
        ],
        query,
      ),
    check: () =>
      db
        .with(params)
        .select({
          allowed: auth.as("allowed"),
          upgraded: upgraded.as("upgraded"),
          stable: stable.as("stable"),
        })
        .from(params),
  };
}
export type D1PrivacySubjectScope = ReturnType<typeof subjectScope>;
export async function prepareD1PrivacyScope(
  database: D1Database,
  installation: PrivacyInstallation,
  subjects: PrivacySubject[],
  contexts: string[] | null,
) {
  const ids = (
    await createD1Connection(database)
      .select({ id: sql<string>`CAST(${videoCourses.id} AS TEXT)` })
      .from(videoCourses)
      .orderBy(videoCourses.id)
  ).map((r) => r.id);
  if (ids.some((id) => !Number.isSafeInteger(Number(id))))
    throw new ApiError(
      503,
      "PRIVACY_UPGRADE_PENDING",
      "Course identifiers require migration.",
    );
  const authors = new Map<string, string>();
  for (const subject of subjects) {
    const entries: Array<{ id: number; author: string }> = [];
    for (let offset = 0; offset < ids.length; offset += 100)
      entries.push(
        ...(await Promise.all(
          ids
            .slice(offset, offset + 100)
            .map(async (id) => ({
              id: Number(id),
              author: await digest(
                courseQaAuthorInput({ ...subject, courseId: Number(id) }),
              ),
            })),
        )),
      );
    authors.set(subject.subjectKey, JSON.stringify(entries));
  }
  const forSubject = (s: PrivacySubject) =>
    subjectScope(
      database,
      installation,
      s,
      contexts,
      authors.get(s.subjectKey) ?? "[]",
      JSON.stringify(ids),
    );
  return { forSubject, check: () => forSubject(subjects[0]).check() };
}
export function checkD1PrivacyScope(row: Record<string, unknown>): boolean {
  assertPrivacyRecovery(Boolean(row.allowed), Boolean(row.upgraded));
  return Boolean(row.stable);
}
