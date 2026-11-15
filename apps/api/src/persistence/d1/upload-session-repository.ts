import { and, eq, gt, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { session, users } from "../../db/schema/sqlite";
import type { UploadSessionRepository } from "../contracts/upload-session-repository";

export function createD1UploadSessionRepository(database: D1Database): UploadSessionRepository {
  const db = createD1Connection(database);
  return {
    async findUnexpiredUser(token) {
      const [user] = await db.select({ id: users.id, banned: users.banned, banExpires: users.banExpires })
        .from(session).innerJoin(users, eq(users.id, session.userId))
        .where(and(eq(session.token, token), gt(session.expiresAt, sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)))
        .limit(1);
      return user ? { ...user, banExpires: user.banExpires?.toISOString() ?? null } : null;
    },
  };
}
