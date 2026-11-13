import { eq } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { users } from "../../db/schema/sqlite";
import type { UserSecretsRepository } from "../contracts/user-secrets";

export function createD1UserSecretsRepository(database: D1Database): UserSecretsRepository {
  const db = createD1Connection(database);
  return {
    async getSearchApiKeyStatus(userId) {
      const [user] = await db.select({ value: users.searchapiApiKeyEncrypted })
        .from(users).where(eq(users.id, userId)).limit(1);
      return user ? Boolean(user.value) : null;
    },
    async setSearchApiKey(userId, encryptedValue) {
      const rows = await db.update(users)
        .set({ searchapiApiKeyEncrypted: encryptedValue, updatedAt: new Date() })
        .where(eq(users.id, userId)).returning({ id: users.id });
      return rows.length > 0;
    },
  };
}
