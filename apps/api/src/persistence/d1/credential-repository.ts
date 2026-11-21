import { alias } from "drizzle-orm/sqlite-core";
import { insertSelectFields } from "../../db/d1/query-builders";
import { and, eq, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { ltiCredentials, videoCourses, users } from "../../db/schema/sqlite";
import { ApiError } from "../../shared/errors";
import { ltiSessionProof } from "../../shared/lti-session-proof";
import type { CredentialRepository } from "../contracts/credential-repository";
export function createD1CredentialRepository(
  database: D1Database,
): CredentialRepository {
  const db = createD1Connection(database);
  const live = (id: string, kind: string) =>
    and(
      eq(ltiCredentials.id, id),
      eq(ltiCredentials.kind, kind),
      sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`,
    );
  return {
    async put(id, kind, payload, expiresAt) {
      await db
        .insert(ltiCredentials)
        .values({ id, kind, payload, expiresAt: new Date(expiresAt) });
    },
    async read(id, kind) {
      return (
        (
          await db
            .select({ payload: ltiCredentials.payload })
            .from(ltiCredentials)
            .where(live(id, kind))
            .limit(1)
        )[0]?.payload ?? null
      );
    },
    async replacePayload(id, kind, payload) {
      return (
        (
          await db
            .update(ltiCredentials)
            .set({ payload })
            .where(live(id, kind))
            .returning({ id: ltiCredentials.id })
        ).length === 1
      );
    },
    async recordScopeVideos(id, videoIds) {
      // json_each exposes booleans as 0/1; preserve their JSON type so malformed
      // stored scopes cannot become authorized numeric video IDs.
      const previous = sql`CASE WHEN json_type(${ltiCredentials.payload},'$.scopeVideoIds') IS NULL THEN '[]'
        WHEN json_type(${ltiCredentials.payload},'$.scopeVideoIds')='array' THEN ${ltiCredentials.payload}->'$.scopeVideoIds'
        ELSE json_array(json(${ltiCredentials.payload}->'$.scopeVideoIds')) END`;
      const fields = {
        value: sql`value`.as("value"),
        type: sql<string>`type`.as("type"),
      };
      const scopes = db
        .select(fields)
        .from(sql`json_each(${previous})`)
        .union(
          db.select(fields).from(sql`json_each(${JSON.stringify(videoIds)})`),
        )
        .as("scopes");
      const merged = db
        .select({
          value: sql`json_group_array(CASE WHEN ${scopes.type} IN('array','object') THEN json(${scopes.value})
        WHEN ${scopes.type}='true' THEN json('true') WHEN ${scopes.type}='false' THEN json('false') ELSE ${scopes.value} END)`,
        })
        .from(scopes);
      const [row] = await db
        .update(ltiCredentials)
        .set({
          payload: sql`json_set(${ltiCredentials.payload},'$.scopeVideoIds',json((${merged})))`,
        })
        .where(live(id, "session"))
        .returning({ payload: ltiCredentials.payload });
      const ids = row?.payload.scopeVideoIds;
      return Array.isArray(ids) && ids.every(Number.isSafeInteger)
        ? (ids as number[])
        : null;
    },
    async consume(id, kind) {
      return (
        (
          await db
            .delete(ltiCredentials)
            .where(live(id, kind))
            .returning({ id: ltiCredentials.id })
        ).length === 1
      );
    },
    async prune() {
      await db
        .delete(ltiCredentials)
        .where(sql`julianday(${ltiCredentials.expiresAt})<=julianday('now')`);
    },
    async putFeedback(id, proof, courseId, logId, expiresAt) {
      ltiSessionProof(proof, proof.sessionHash);
      const session = alias(ltiCredentials, "session");
      const [row] = await db
        .insert(ltiCredentials)
        .select(
          db
            .select(
              insertSelectFields(ltiCredentials, {
                id: sql`${id}`,
                kind: sql`'lti-feedback'`,
                payload: sql`${JSON.stringify({ sessionHash: proof.sessionHash, courseId, logId })}`,
                expiresAt: sql`${new Date(expiresAt).toISOString()}`,
              }),
            )
            .from(videoCourses)
            .innerJoin(users, eq(users.id, videoCourses.userId))
            .innerJoin(session, eq(session.id, proof.sessionHash))
            .where(
              and(
                eq(videoCourses.id, courseId),
                eq(session.kind, "session"),
                sql`julianday(${session.expiresAt})>julianday('now')`,
                sql`json_extract(${session.payload},'$.registrationId')=${proof.registrationId}`,
                sql`json_extract(${session.payload},'$.subjectHash')=${proof.subjectHash}`,
              ),
            ),
        )
        .returning({ id: ltiCredentials.id });
      if (!row)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "The Moodle session is unavailable.",
        );
    },
  };
}
