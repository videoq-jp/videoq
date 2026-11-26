import { and, eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { users, ltiCredentials as credentials } from "../../db/schema";
import { nativeSessionMarkerExpiry } from "../../domain/lms/native-session-marker";
import type { Bindings } from "../../types/bindings";
import type { NativeSessionRepository } from "../contracts/native-session-repository";
import {
  nativeSessionDenied as denied,
  matchesNativeSession,
  validateNativeSessionInput,
} from "../../shared/native-session";
export function createPostgresNativeSessionRepository(
  env: Bindings,
): NativeSessionRepository {
  return {
    async ensure(input) {
      validateNativeSessionInput(input);
      await withDb(env, (db) =>
        db.transaction(async (tx) => {
          const [owner] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.ownerUserId))
            .for("share");
          if (!owner) throw denied();
          const nonce = await tx
            .insert(credentials)
            .values({
              id: input.nonceHash,
              kind: "moodle-native-request",
              payload: {},
              expiresAt: input.nonceExpiresAt,
            })
            .onConflictDoNothing()
            .returning({ id: credentials.id });
          if (nonce.length !== 1) throw denied();
          const marker = await tx
            .insert(credentials)
            .values({
              id: input.markerHash,
              kind: "moodle-native-started",
              payload: {},
              expiresAt: nativeSessionMarkerExpiry(input.expiresAt),
            })
            .onConflictDoNothing()
            .returning({ id: credentials.id });
          if (marker.length === 1) {
            const created = await tx
              .insert(credentials)
              .values({
                id: input.sessionHash,
                kind: "session",
                payload: input.grant,
                expiresAt: input.expiresAt,
              })
              .onConflictDoNothing()
              .returning({ id: credentials.id });
            if (created.length !== 1) throw denied();
          }
          const [markerState] = await tx
            .select({ kind: credentials.kind })
            .from(credentials)
            .where(eq(credentials.id, input.markerHash))
            .for("share");
          if (markerState?.kind !== "moodle-native-started") throw denied();
          const [existing] = await tx
            .select({
              payload: credentials.payload,
              expiresAt: credentials.expiresAt,
            })
            .from(credentials)
            .where(
              and(
                eq(credentials.id, input.sessionHash),
                eq(credentials.kind, "session"),
                sql`${credentials.expiresAt}>clock_timestamp()`,
              ),
            )
            .for("share");
          if (
            !matchesNativeSession(
              existing?.payload,
              existing?.expiresAt ?? new Date(NaN),
              input,
            )
          )
            throw denied();
        }),
      );
    },
  };
}
