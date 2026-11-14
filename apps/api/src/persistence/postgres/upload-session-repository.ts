import { and, eq, gt, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { session, users } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import type { UploadSessionRepository } from "../contracts/upload-session-repository";

export function createPostgresUploadSessionRepository(env: Bindings): UploadSessionRepository {
  return {
    findUnexpiredUser: token => withDb(env, async db => {
      const [user] = await db.select({ id: users.id, banned: users.banned, banExpires: users.banExpires })
        .from(session).innerJoin(users, eq(users.id, session.userId))
        .where(and(eq(session.token, token), gt(session.expiresAt, sql`now()`))).limit(1);
      return user ? { ...user, banExpires: user.banExpires?.toISOString() ?? null } : null;
    }),
  };
}
