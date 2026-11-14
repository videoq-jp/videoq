import { describe } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { users, session } from "../../src/db/schema";
import { isolatedPostgres } from "./isolated-postgres";
import { uploadSessionContract } from "./contracts/upload-session.contract";
import type { Bindings } from "../../src/types/bindings";

const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)("PostgreSQL upload session", () => {
  uploadSessionContract("PostgreSQL onprem", async () => {
    const f = await isolatedPostgres(url!);
    try {
      const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ users, session }));
      await f.pool.query(statements.map(s => s.replaceAll('"public".', "")).join("\n"), []);
      return {
        env: { DEPLOYMENT_EDITION: "onprem", DATABASE_POOL: f.pool } as Bindings,
        execute: async (sql, args = []) => {
          let index = 0;
          await f.pool.query(sql.replaceAll("?", () => `$${++index}`), args);
        },
        snapshot: async () => ({
          users: (await f.pool.query("SELECT * FROM users ORDER BY id")).rows,
          sessions: (await f.pool.query("SELECT * FROM session ORDER BY id")).rows,
        }),
        dispose: f.dispose,
      };
    } catch (error) { await f.dispose(); throw error; }
  });
});
