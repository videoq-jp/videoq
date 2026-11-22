import { indexTranscript } from "../src/integrations/search-index/index-transcript";
import { URL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { chatAnswerText } from "@videoq/trpc/chat";
import { embedQuery } from "../src/lib/embeddings";
import { runRag } from "../src/lib/rag";
import type { Bindings } from "../src/types/bindings";

// Explicit opt-in: real model calls incur charges. Never use an existing application DB.
const enabled = process.env.EMBEDDING_LIVE === "1";
const varsPath = new URL("../.dev.vars", import.meta.url);
const configured = enabled && existsSync(varsPath) ? parse(readFileSync(varsPath)) : {};
const settings = Object.fromEntries(
  ["OPENROUTER_FEDERATION_POLICY_ID", "OPENROUTER_FEDERATION_AUDIENCE", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"].map((key) =>
    [key, process.env[key] ?? configured[key]]),
);

describe.skipIf(!enabled)("real embedding providers", () => {
  it("indexes a short transcript and answers Q&A", async () => {
    const model = settings.EMBEDDING_MODEL || "text-embedding-3-small";
    const databaseUrl = process.env.EMBEDDING_TEST_DATABASE_URL;
    if (!databaseUrl || (!settings.OPENROUTER_FEDERATION_POLICY_ID && !settings.OPENROUTER_API_KEY && !settings.OPENAI_API_KEY)) throw new Error("Live tests require EMBEDDING_TEST_DATABASE_URL and OPENROUTER_API_KEY or OPENAI_API_KEY.");
    const name = `videoq_live_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    admin.on("error", () => {});
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    let pool: Pool | undefined;
    const providerSettings = { ...settings, EMBEDDING_MODEL: model };
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      pool = new Pool({ connectionString: url.toString(), max: 1 });
      pool.on("error", () => {});
      await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
      const transcript = "1\n00:00:00,000 --> 00:00:06,000\n蒸発とは、水などの液体が表面から気体に変化することです。\n\n2\n00:00:06,000 --> 00:00:12,000\n凝結とは、水蒸気などの気体が冷えて液体に変わることです。\n";
      await pool.query(`INSERT INTO users (id,email,username,max_video_upload_size_mb,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
        VALUES ('embedding-live','embedding-live@example.invalid','embedding-live',100,false,0,0,0)`);
      await pool.query(`INSERT INTO videos (id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id)
        VALUES (60,'','水の状態変化','',NOW(),$1,'completed','','embedding-live','uploaded','','')`, [transcript]);
      const env = { ...providerSettings, HYPERDRIVE: { connectionString: url.toString() }, DATABASE_POOL:pool } as Bindings;
      expect(await indexTranscript(env, 60)).toBeGreaterThan(0);
      expect(await embedQuery(env, "蒸発とは何ですか？")).toHaveLength(1536);
      const question = { messages: [{ role: "user", content: "動画に基づいて蒸発とは何か説明してください。" }], videoIds: [60], locale: "ja" };
      const answer = await runRag(env, { ...question, ownerUserId: "embedding-live" });
      expect(chatAnswerText(answer.answer).trim()).not.toBe("");
      expect(answer.answer.sources.some((source) => source.video_id === 60)).toBe(true);
      const dimensions = await pool.query("SELECT DISTINCT vector_dims(embedding) AS n FROM scene_embeddings");
      expect(dimensions.rows).toEqual([{ n: 1536 }]);
    } finally {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 240_000);
});
