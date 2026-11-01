import { visualSchema } from "./helpers/visual-schema";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getVideoDetail, updateVideo } from "../src/repositories/video-repository";
import { patchUserVideo } from "../src/features/videos/service";
import * as media from "../src/integrations/media";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const originalTranscript = "Original transcript";

(databaseUrl ? describe : describe.skip)("video updates on PostgreSQL", () => {
  const schema = `video_update_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      CREATE TABLE videos (
        id bigint PRIMARY KEY, user_id text NOT NULL, title text NOT NULL,
        description text NOT NULL, transcript text,
        file text NOT NULL DEFAULT 'videos/example.mp4',
        uploaded_at timestamptz NOT NULL DEFAULT '2026-09-01T00:00:00Z',
        status text NOT NULL DEFAULT 'completed', source_type text NOT NULL DEFAULT 'uploaded',
        source_url text NOT NULL DEFAULT '', youtube_video_id text NOT NULL DEFAULT '',
        error_message text NOT NULL DEFAULT ''
      );
      CREATE TABLE tags (id integer PRIMARY KEY, name text NOT NULL, color text NOT NULL);
      CREATE TABLE video_tags (video_id bigint REFERENCES videos ON DELETE CASCADE, tag_id integer REFERENCES tags);
      CREATE TABLE scene_embeddings (
        id integer PRIMARY KEY, video_id bigint NOT NULL, langchain_metadata json
      );
      CREATE TABLE external_tasks (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        kind text NOT NULL, payload jsonb NOT NULL, dedupe_key text NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz, completed_at timestamptz, dead_at timestamptz,
        effect_applied_at timestamptz, last_error text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await admin.query(visualSchema);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  beforeEach(async () => {
    await admin.query("TRUNCATE videos, tags, video_tags, scene_embeddings, external_tasks, video_visual_chunks, video_visual_runs");
    await admin.query(`
      INSERT INTO videos (id, user_id, title, description, transcript) VALUES (10, 'owner', 'Original', 'Description', $1),
                                (20, 'outsider', 'Private', 'Private description', 'Private transcript');
    `, [originalTranscript]);
    await admin.query(`
      INSERT INTO scene_embeddings VALUES
        (1, 10, '{"video_title":"Original","scene_index":3}'),
        (2, 10, NULL), (3, 20, '{"video_title":"Private"}');
      INSERT INTO tags VALUES (1, 'Z tag', 'blue'), (2, 'A tag', 'red');
      INSERT INTO video_tags VALUES (10, 1), (10, 2), (20, 1);
    `);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function video() {
    return (await admin.query("SELECT *, xmin::text AS version FROM videos WHERE id = 10")).rows[0];
  }
  async function vectors() {
    return (await admin.query("SELECT * FROM scene_embeddings ORDER BY id")).rows;
  }
  async function tasks() {
    return (await admin.query("SELECT * FROM external_tasks ORDER BY id")).rows;
  }

  it(
    "update returns the full updated video using one connection", async () => {
      const before = await getVideoDetail(env, 10, "owner");
      const connect = vi.spyOn(pg.Client.prototype, "connect");
      const query = vi.spyOn(pg.Client.prototype, "query");
      expect(await patchUserVideo(env, 10, "owner", { title: "Original", description: "Edited" }))
        .toEqual({ video: { ...before, description: "Edited" } });
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(4); // BEGIN, comparison, UPDATE RETURNING, COMMIT.
    },
  );

  it(
    "update keeps the committed response when deletion follows the update", async () => {
      const before = await getVideoDetail(env, 10, "owner");
      const promiseClient = pg.Client.prototype as { end(this: pg.Client): Promise<void> };
      const end = promiseClient.end;
      vi.spyOn(promiseClient, "end").mockImplementation(async function (this: pg.Client) {
        try { await admin.query("DELETE FROM videos WHERE id = 10"); }
        finally { await end.call(this); }
      });
      expect(await patchUserVideo(env, 10, "owner", { title: "Original", description: "Edited" }))
        .toEqual({ video: { ...before, description: "Edited" } });
    },
  );

  it("releases the database connection before resolving the updated media URL", async () => {
    const end = vi.spyOn(pg.Client.prototype, "end");
    const resolve = vi.spyOn(media, "resolveFileUrl").mockImplementation(async () => {
      expect(end).toHaveBeenCalledTimes(1);
      return "https://media.example.test/video";
    });
    expect(await patchUserVideo(env, 10, "owner", { description: "Edited" }))
      .toMatchObject({ video: { file: "https://media.example.test/video" } });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rolls back the update when its response cannot be read", async () => {
    const before = await video();
    const beforeVectors = await vectors();
    await admin.query("ALTER TABLE tags RENAME TO unavailable_tags");
    try {
      await expect(patchUserVideo(env, 10, "owner", { title: "Edited" })).rejects.toThrow();
      expect(await video()).toEqual(before);
      expect(await vectors()).toEqual(beforeVectors);
    } finally {
      await admin.query("ALTER TABLE unavailable_tags RENAME TO tags");
    }
  });

  it("compares metadata without transferring the unchanged transcript", async () => {
    const transcript = "A long lecture transcript. ".repeat(40_000);
    await admin.query("UPDATE videos SET transcript = $1 WHERE id = 10", [transcript]);
    const before = await vectors();
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(updateVideo(env, 10, "owner", { description: "Edited" })).resolves.toMatchObject({ row: { id: 10 }, reindexTaskId: null });
    expect(query).toHaveBeenCalledTimes(4); // BEGIN, row lock/comparison, UPDATE, COMMIT.
    const comparison = await query.mock.results[1].value;
    const responseBytes = JSON.stringify(comparison.rows).length;
    query.mockRestore();
    expect(responseBytes).toBeLessThan(128);
    expect(await video()).toMatchObject({ description: "Edited", transcript });
    expect(await vectors()).toEqual(before);
    expect(await tasks()).toEqual([]);
  });

  it.each([
    {}, { title: "Original" }, { description: "Description" }, { transcript: originalTranscript },
    { title: "Original", description: "Description", transcript: originalTranscript },
  ])("does not write or enqueue when submitted fields are unchanged: %j", async fields => {
    const before = await video();
    const beforeVectors = await vectors();
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(updateVideo(env, 10, "owner", fields)).resolves.toMatchObject({ row: { id: 10 }, reindexTaskId: null });
    expect(query).toHaveBeenCalledTimes(4); // BEGIN, comparison, response, COMMIT; no UPDATE.
    query.mockRestore();
    expect(await video()).toEqual(before);
    expect(await vectors()).toEqual(beforeVectors);
    expect(await tasks()).toEqual([]);
  });

  it("treats an absent transcript and an empty transcript as the same content", async () => {
    await admin.query("UPDATE videos SET transcript = NULL WHERE id = 10");
    const before = await video();
    await expect(updateVideo(env, 10, "owner", { transcript: "" })).resolves.toMatchObject({ row: { id: 10 }, reindexTaskId: null });
    expect(await video()).toEqual(before);
    expect(await tasks()).toEqual([]);
  });

  it("updates title metadata while preserving other scene fields and videos", async () => {
    await expect(updateVideo(env, 10, "owner", { title: "Updated" })).resolves.toMatchObject({ row: { id: 10 }, reindexTaskId: null });
    expect(await video()).toMatchObject({ title: "Updated", description: "Description", transcript: originalTranscript });
    expect(await vectors()).toEqual([
      { id: 1, video_id: "10", langchain_metadata: { video_title: "Updated", scene_index: 3 } },
      { id: 2, video_id: "10", langchain_metadata: { video_title: "Updated" } },
      { id: 3, video_id: "20", langchain_metadata: { video_title: "Private" } },
    ]);
    expect(await tasks()).toEqual([]);
  });

  it("writes only changed columns from a full editor payload", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(updateVideo(env, 10, "owner", {
      title: "Updated", description: "Description", transcript: originalTranscript,
    })).resolves.toMatchObject({ row: { id: 10 }, reindexTaskId: null });
    const statements = query.mock.calls.map(([input]) => typeof input === "string" ? input : input.text);
    const update = statements.find(statement => statement.startsWith('update "videos"'));
    expect(update).toContain('"title" =');
    expect(update).not.toContain('"description" =');
    expect(update).not.toContain('"transcript" =');
    query.mockRestore();
    expect(await video()).toMatchObject({ title: "Updated", description: "Description", transcript: originalTranscript });
    expect(await tasks()).toEqual([]);
  });

  it("enqueues one reindex for concurrent identical transcript edits", async () => {
    const results = await Promise.all([
      updateVideo(env, 10, "owner", { transcript: "New transcript" }),
      updateVideo(env, 10, "owner", { transcript: "New transcript" }),
    ]);
    const stored = await tasks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "sqs_job", payload: { message: { type: "reindex_video_transcript", payload: { video_id: 10 } } } });
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: expect.objectContaining({ id: 10 }), reindexTaskId: null }),
      expect.objectContaining({ row: expect.objectContaining({ id: 10 }), reindexTaskId: Number(stored[0].id) }),
    ]));
    expect(await video()).toMatchObject({ transcript: "New transcript" });
  });

  it("preserves independent edits when title and description updates overlap", async () => {
    await Promise.all([
      updateVideo(env, 10, "owner", { title: "Updated" }),
      updateVideo(env, 10, "owner", { description: "Edited" }),
    ]);
    expect(await video()).toMatchObject({ title: "Updated", description: "Edited", transcript: originalTranscript });
    expect((await vectors())[0].langchain_metadata.video_title).toBe("Updated");
    expect(await tasks()).toEqual([]);
  });

  it("keeps explicit empty fields and schedules a reindex when clearing subtitles", async () => {
    const result = await updateVideo(env, 10, "owner", { title: "", description: "", transcript: "" });
    expect(result).toMatchObject({ row: { id: 10 }, reindexTaskId: expect.any(Number) });
    expect(await video()).toMatchObject({ title: "", description: "", transcript: "" });
    expect((await vectors())[0].langchain_metadata.video_title).toBe("");
    expect(await tasks()).toHaveLength(1);
  });

  it.each([[10, "outsider"], [20, "owner"], [99, "owner"]] as const)("hides missing or foreign videos %i / %s", async (id, user) => {
    const before = await video();
    const beforeVectors = await vectors();
    await expect(updateVideo(env, id, user, { title: "Changed", transcript: "Changed" })).resolves.toEqual({ notFound: true });
    expect(await video()).toEqual(before);
    expect(await vectors()).toEqual(beforeVectors);
    expect(await tasks()).toEqual([]);
  });

  it("rolls back video and vector updates when reindex enqueueing fails", async () => {
    const before = await video();
    const beforeVectors = await vectors();
    await admin.query(`
      CREATE FUNCTION reject_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'job rejected'; END $$;
      CREATE TRIGGER reject_job BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION reject_job();
    `);
    try {
      await expect(updateVideo(env, 10, "owner", { title: "Updated", transcript: "New transcript" })).rejects.toMatchObject({ cause: { code: "P0001", message: "job rejected" } });
      expect(await video()).toEqual(before);
      expect(await vectors()).toEqual(beforeVectors);
      expect(await tasks()).toEqual([]);
    } finally {
      await admin.query("DROP TRIGGER reject_job ON external_tasks");
      await admin.query("DROP FUNCTION reject_job()");
    }
  });
});
