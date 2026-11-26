import { and, eq, exists, notExists, inArray, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import { ltiCredentials as credentials, users } from "../../db/schema/sqlite";
import { nativeSessionMarkerExpiry } from "../../domain/lms/native-session-marker";
import type { NativeSessionRepository } from "../contracts/native-session-repository";
import {
  nativeSessionDenied,
  matchesNativeSession,
  validateNativeSessionInput,
} from "../../shared/native-session";
export function createD1NativeSessionRepository(
  database: D1Database,
): NativeSessionRepository {
  const db = createD1Connection(database);
  return {
    async ensure(input) {
      validateNativeSessionInput(input);
      for (let retry = 0; retry < 5; retry++) {
        // Preserve the exact stored text for the snapshot fence, including JSON
        // whitespace and timestamp precision; decoding it would weaken equality.
        const rows = await db
          .select({
            id: credentials.id,
            kind: credentials.kind,
            payload: sql<string>`${credentials.payload}`,
            expiresAt: sql<string>`${credentials.expiresAt}`,
          })
          .from(credentials)
          .where(
            inArray(credentials.id, [
              input.sessionHash,
              input.markerHash,
              input.nonceHash,
            ]),
          );
        const session = rows.find((row) => row.id === input.sessionHash),
          marker = rows.find((row) => row.id === input.markerHash);
        if (rows.some((row) => row.id === input.nonceHash))
          throw nativeSessionDenied();
        let payload: unknown;
        try {
          payload = session ? JSON.parse(session.payload) : undefined;
        } catch {
          throw nativeSessionDenied();
        }
        if (marker) {
          if (
            marker.kind !== "moodle-native-started" ||
            !session ||
            session.kind !== "session" ||
            !matchesNativeSession(payload, new Date(session.expiresAt), input)
          )
            throw nativeSessionDenied();
        } else if (session) throw nativeSessionDenied();
        const snapshot = marker
          ? and(
              exists(
                db
                  .select({ id: credentials.id })
                  .from(credentials)
                  .where(
                    and(
                      eq(credentials.id, input.markerHash),
                      eq(credentials.kind, "moodle-native-started"),
                    ),
                  ),
              ),
              exists(
                db
                  .select({ id: credentials.id })
                  .from(credentials)
                  .where(
                    and(
                      eq(credentials.id, input.sessionHash),
                      eq(credentials.kind, "session"),
                      sql`${credentials.payload}=${session!.payload}`,
                      sql`${credentials.expiresAt}=${session!.expiresAt}`,
                      sql`julianday(${credentials.expiresAt})>julianday('now')`,
                    ),
                  ),
              ),
            )
          : notExists(
              db
                .select({ id: credentials.id })
                .from(credentials)
                .where(
                  inArray(credentials.id, [
                    input.markerHash,
                    input.sessionHash,
                  ]),
                ),
            );
        const result = await runD1Batch(database, [
          db
            .insert(credentials)
            .select(
              db
                .select(
                  insertSelectFields(credentials, {
                    id: sql`${input.nonceHash}`,
                    kind: sql`'moodle-native-request'`,
                    payload: sql`'{}'`,
                    expiresAt: sql`${input.nonceExpiresAt.toISOString()}`,
                  }),
                )
                .from(users)
                .where(
                  and(
                    eq(users.id, input.ownerUserId),
                    sql`julianday(${input.expiresAt.toISOString()})>julianday('now')`,
                    snapshot,
                  ),
                ),
            )
            .onConflictDoNothing(),
          db
            .insert(credentials)
            .select(
              db
                .select(
                  insertSelectFields(credentials, {
                    id: sql`${input.markerHash}`,
                    kind: sql`'moodle-native-started'`,
                    payload: sql`'{}'`,
                    expiresAt: sql`${nativeSessionMarkerExpiry(input.expiresAt).toISOString()}`,
                  }),
                )
                .from(users)
                .where(and(eq(users.id, input.ownerUserId), sql`changes()=1`)),
            )
            .onConflictDoNothing(),
          db
            .insert(credentials)
            .select(
              db
                .select(
                  insertSelectFields(credentials, {
                    id: sql`${input.sessionHash}`,
                    kind: sql`'session'`,
                    payload: sql`${JSON.stringify(input.grant)}`,
                    expiresAt: sql`${input.expiresAt.toISOString()}`,
                  }),
                )
                .from(users)
                .where(and(eq(users.id, input.ownerUserId), sql`changes()=1`)),
            )
            .onConflictDoNothing(),
        ]);
        if (result[0].meta.changes === 1) return;
      }
      throw nativeSessionDenied();
    },
  };
}
