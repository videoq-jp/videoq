import { eq, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { users } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import type { UserSecretsRepository } from "../contracts/user-secrets";

async function getSearchApiKeyStatus(
  env: Bindings,
  userId: string,
): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ hasKey: sql<boolean>`COALESCE(${users.searchapiApiKeyEncrypted} <> '', false)` })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.hasKey ?? null;
  });
}

async function setSearchApiKey(
  env: Bindings,
  userId: string,
  encryptedValue: string | null,
): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db
      .update(users)
      .set({ searchapiApiKeyEncrypted: encryptedValue, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length > 0;
  });
}

export function createPostgresUserSecretsRepository(env: Bindings): UserSecretsRepository {
  return {
    getSearchApiKeyStatus: userId => getSearchApiKeyStatus(env, userId),
    setSearchApiKey: (userId, encryptedValue) => setSearchApiKey(env, userId, encryptedValue),
  };
}
