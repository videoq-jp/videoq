import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Bindings } from "../types/bindings";

export type Db = NodePgDatabase;

export function databaseConnectionString(env: Bindings): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is not configured");
  return connectionString;
}

/**
 * Neon への接続（Hyperdrive 経由）。
 *
 * **接続 Client はリクエストごとに生成**し、
 * リクエストをまたいで使い回さない（global Pool 禁止）。
 * Drizzle は `withDb` 内でのみ `drizzle(client)` する。
 */
export async function withClient<T>(
  env: Bindings,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  if (env.DATABASE_POOL) {
    const client = await env.DATABASE_POOL.connect();
    let failed = false;
    try {
      return await fn(client);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A failed callback may have an aborted/open transaction. Never hand it
      // to another request; a fresh connection preserves the Workers behavior.
      client.release(failed);
    }
  }
  const client = new pg.Client({
    connectionString: databaseConnectionString(env),
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Drizzle DB を per-request Client に載せる。 */
export async function withDb<T>(
  env: Bindings,
  fn: (db: Db, client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(env, async (client) => {
    // Repositories use the SQL query builder and Better Auth supplies its own
    // adapter schema. Building the unused relational API walks every table on
    // every connection, consuming the Worker's small per-request CPU budget.
    const db = drizzle(client);
    return fn(db, client);
  });
}

/** /ready 用の軽量な疎通チェック。 */
export async function pingDb(env: Bindings): Promise<boolean> {
  return withClient(env, async (client) => {
    const { rows } = await client.query<{ ok: number }>("SELECT 1 AS ok");
    return rows[0]?.ok === 1;
  });
}
