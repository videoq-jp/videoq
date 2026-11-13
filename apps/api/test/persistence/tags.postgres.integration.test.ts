import { describe } from "vitest";
import { createPostgresTagRepository } from "../../src/persistence/postgres/tag-repository";
import type { Bindings } from "../../src/types/bindings";
import { tagRepositoryContract } from "./contracts/tag-repository.contract";
import { isolatedPostgres } from "./isolated-postgres";

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL tags", () => {
  tagRepositoryContract("postgres", async () => {
    const { pool, dispose } = await isolatedPostgres(databaseUrl!);
    try {
      await pool.query(`CREATE TABLE tags(id bigserial PRIMARY KEY,name text NOT NULL,color text NOT NULL,created_at timestamptz NOT NULL,user_id text NOT NULL);
        CREATE TABLE videos(id bigserial PRIMARY KEY,file text NOT NULL,title text NOT NULL,description text NOT NULL DEFAULT '',uploaded_at timestamptz NOT NULL DEFAULT now(),
          status text NOT NULL DEFAULT 'completed',source_type text NOT NULL DEFAULT 'uploaded',source_url text NOT NULL DEFAULT '',youtube_video_id text NOT NULL DEFAULT '');
        CREATE TABLE video_tags(id bigserial PRIMARY KEY,tag_id bigint REFERENCES tags(id) ON DELETE CASCADE,video_id bigint REFERENCES videos(id),added_at timestamptz NOT NULL DEFAULT now());`);
      return {
        repository: createPostgresTagRepository({ DATABASE_POOL: pool, USE_S3_STORAGE: "false" } as Bindings),
        linkVideo: async tagId => {
          const id = Number((await pool.query("INSERT INTO videos(file,title) VALUES ('related.mp4','Related') RETURNING id")).rows[0].id);
          await pool.query("INSERT INTO video_tags(tag_id,video_id) VALUES ($1,$2)", [tagId, id]);
          return id;
        },
        linkCount: async tagId => Number((await pool.query("SELECT count(*) AS count FROM video_tags WHERE tag_id=$1", [tagId])).rows[0].count),
        dispose,
      };
    } catch (error) { await dispose(); throw error; }
  });
});
