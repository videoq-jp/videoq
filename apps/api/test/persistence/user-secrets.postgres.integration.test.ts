import pg from "pg";
import { describe } from "vitest";
import { createPostgresUserSecretsRepository } from "../../src/persistence/postgres/user-secrets";
import type { Bindings } from "../../src/types/bindings";
import { userSecretsContract } from "./contracts/user-secrets.contract";

// Explicit opt-in: never fall back to the application's DATABASE_URL.
const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL persistence", () => {
  userSecretsContract("postgres", async () => {
    const schema = `persistence_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    const dispose = async () => {
      try {
        await pool.end();
      } finally {
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    };
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      // Minimal real table for this operation slice. Full migration parity is
      // separately covered by migration tests; this suite exercises adapter SQL.
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY,
        searchapi_api_key_encrypted text,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      return {
        repository: createPostgresUserSecretsRepository({ DATABASE_POOL: pool } as Bindings),
        createUser: async (id, encryptedValue) => {
          await pool.query("INSERT INTO users (id, searchapi_api_key_encrypted) VALUES ($1, $2)", [id, encryptedValue]);
        },
        readStoredCredential: async (id) => {
          const result = await pool.query<{ value: string | null }>(
            "SELECT searchapi_api_key_encrypted AS value FROM users WHERE id = $1", [id],
          );
          return result.rows[0]?.value ?? null;
        },
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  });
});
