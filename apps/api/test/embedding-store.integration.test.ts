import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { HNSWIndex, PGEngine, PGVectorStore } from "@yukiharada1228/langchain-postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertEmbeddingSchema } from "../src/lib/embedding-schema";
import { resolveEmbeddingConfig } from "../src/lib/embedding-contract";
import { openSceneSearch } from "../src/repositories/vector-repository";
import type { Bindings } from "../src/types/bindings";
import { embedding } from "./helpers/embedding";

const exec = promisify(execFile);
const databaseUrl = process.env.EMBEDDING_TEST_DATABASE_URL;
const workerPath = fileURLToPath(new URL("../../worker", import.meta.url));
const pythonHelper = fileURLToPath(new URL("./helpers/embedding-store.py", import.meta.url));
const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));

afterEach(() => vi.unstubAllGlobals());

(databaseUrl ? describe : describe.skip).each([
  { profile: "openai", model: "text-embedding-3-small", dimensions: 1536, table: "scene_embeddings" },
  { profile: "embeddinggemma2", model: "embeddinggemma-2-f9972ac", dimensions: 768, table: "scene_embeddings_768" },
])("$profile cross-language storage", ({ profile, model, dimensions, table }) => {
  it("migrates an empty DB, writes through Python, searches through the API and builds both HNSW indexes", async () => {
    const vector = () => embedding(1).slice(0, dimensions);
    const settings = { EMBEDDING_PROFILE: profile, EMBEDDING_MODEL: model, EMBEDDING_BASE_URL: "http://embedding.test/v1" };
    const name = `videoq_embedding_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    admin.on("error", () => {});
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      pool = new Pool({ connectionString: url.toString(), max: 1 });
      pool.on("error", () => {});
      await migrate(drizzle(pool), { migrationsFolder: migrations });
      await assertEmbeddingSchema(pool, resolveEmbeddingConfig(settings));
      const { stdout } = await exec(process.env.VIDEOQ_TEST_PYTHON || "python3", [pythonHelper], {
        cwd: workerPath,
        env: { ...process.env, DATABASE_URL: url.toString(), ...settings, PYTHONPATH: workerPath },
      });
      expect(stdout).toContain("python_save_search_hnsw_ok");
      const env = { HYPERDRIVE: { connectionString: url.toString() }, OPENAI_API_KEY: "test-key", ...settings } as Bindings;
      const fetch = vi.fn(async () => Response.json({ data: [{ index: 0, embedding: vector() }] }));
      vi.stubGlobal("fetch", fetch);
      const search = await openSceneSearch(env, { userId: "allowed-owner", videoIds: [60] });
      try {
        const hits = await search.search("evaporation");
        expect(hits.map((hit) => hit.videoId)).toEqual([60]);
        expect(hits[0].content).toContain("Water evaporates");
        expect(hits[0]).toMatchObject({
          videoTitle: "Video 60", startTime: "00:00:00,000", endTime: "00:00:05,000",
        });
        await expect(search.search("evaporation", [62])).rejects.toThrow("subset");
      } finally { await search.close(); }

      const engine = PGEngine.fromPool(pool);
      const store = await PGVectorStore.initialize(engine, { embedQuery: async () => vector(), embedDocuments: async (texts) => texts.map(() => vector()) }, table, { metadataColumns: ["user_id", "video_id"] });
      await store.applyVectorIndex(new HNSWIndex({ name: "js_embedding_hnsw" }));
      expect(await store.isValidIndex("js_embedding_hnsw")).toBe(true);
      const hits = await store.similaritySearch("water", 10, { user_id: "allowed-owner", video_id: 60 });
      expect(hits).toHaveLength(1);
      await store.dropVectorIndex("js_embedding_hnsw");

      // The table is deliberately empty: checking rows would miss this mismatch.
      await pool.query(`TRUNCATE ${table}`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(1024)`);
      fetch.mockClear();
      await expect(openSceneSearch(env, { userId: "allowed-owner", videoIds: [60] })).rejects.toMatchObject({ reason: "EMBEDDING_SCHEMA_MISMATCH" });
      for (const ddl of [
        `ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector`,
        `ALTER TABLE ${table} ALTER COLUMN embedding TYPE text USING embedding::text`,
        `ALTER TABLE ${table} DROP COLUMN embedding`,
      ]) {
        await pool.query(ddl);
        await expect(openSceneSearch(env, { userId: "allowed-owner", videoIds: [60] }))
          .rejects.toMatchObject({ reason: "EMBEDDING_SCHEMA_MISMATCH" });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await pool?.end();
      // Let connections finish closing instead of terminating sockets still draining after pool.end().
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  }, 60_000);
});
