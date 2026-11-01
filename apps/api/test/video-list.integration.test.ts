import { visualSchema } from "./helpers/visual-schema";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listVideosPage, type VideoListCriteria } from "../src/repositories/video-repository";
import { listUserVideos } from "../src/features/videos/service";
import { callMcpTool } from "../src/lib/mcp-tools";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const criteria: VideoListCriteria = { keyword: "", statusFilter: "", sortKey: "", tagIds: null };

(databaseUrl ? describe : describe.skip)("video list pagination on PostgreSQL", () => {
  const schema = `video_list_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      CREATE TABLE videos (
        id bigint PRIMARY KEY, user_id text NOT NULL, title text NOT NULL, uploaded_at timestamptz NOT NULL,
        description text NOT NULL DEFAULT '', file text NOT NULL DEFAULT 'videos/example.mp4',
        status text NOT NULL DEFAULT 'completed', source_type text NOT NULL DEFAULT 'uploaded',
        source_url text NOT NULL DEFAULT '', youtube_video_id text NOT NULL DEFAULT '',
        transcript text, error_message text NOT NULL DEFAULT ''
      );
      CREATE TABLE tags (id bigint PRIMARY KEY, name text NOT NULL, color text NOT NULL);
      CREATE TABLE video_tags (video_id bigint REFERENCES videos, tag_id bigint REFERENCES tags);
      INSERT INTO videos (id, user_id, title, uploaded_at) VALUES
        (1, 'owner', 'Same', '2026-09-02T00:00:00Z'),
        (2, 'owner', 'Same', '2026-09-02T00:00:00Z'),
        (3, 'owner', 'Alpha', '2026-09-01T00:00:00Z'),
        (4, 'owner', 'Zulu', '2026-09-03T00:00:00Z'),
        (5, 'owner', 'Same', '2026-09-02T00:00:00Z'),
        (20, 'outsider', 'Same', '2026-09-02T00:00:00Z');
      UPDATE videos SET description = '100%_done' WHERE id IN (2, 20);
      INSERT INTO tags VALUES (1, 'Tag', 'blue');
      INSERT INTO video_tags VALUES (1, 1), (2, 1), (5, 1), (20, 1);
    `);
    await admin.query(visualSchema);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  it.each([
    { sortKey: "", ids: [4, 5, 2, 1, 3] },
    { sortKey: "uploaded_at_desc", ids: [4, 5, 2, 1, 3] },
    { sortKey: "uploaded_at_asc", ids: [3, 5, 2, 1, 4] },
    { sortKey: "title_asc", ids: [3, 5, 2, 1, 4] },
    { sortKey: "title_desc", ids: [4, 5, 2, 1, 3] },
  ])("keeps tied rows stable across pages for $sortKey", async ({ sortKey, ids }) => {
    const results = [];
    for (const offset of [0, 2, 4]) {
      const page = await listVideosPage(env, "owner", { ...criteria, sortKey }, 2, offset);
      expect(page.count).toBe(5);
      results.push(...page.results.map(video => video.id));
    }
    expect(results).toEqual(ids);
    expect(new Set(results).size).toBe(5);
  });

  it.each([
    { userId: "missing", offset: 0, keyword: "", count: 0 },
    { userId: "owner", offset: 0, keyword: "no match", count: 0 },
    { userId: "owner", offset: 5, keyword: "", count: 5 },
    { userId: "owner", offset: 100, keyword: "", count: 5 },
  ])("skips fetching an empty page for %j", async ({ userId, offset, keyword, count }) => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(listVideosPage(env, userId, { ...criteria, keyword }, 2, offset))
      .resolves.toEqual({ count, results: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("preserves literal search, tag and status filters without exposing another user's video", async () => {
    const filter = { ...criteria, keyword: "100%_", tagIds: [1], statusFilter: "completed,processing" };
    const page = await listUserVideos(env, "owner", { q: "100%_", tags: [1], status: "completed,processing" }, 2, 0);
    expect(page.count).toBe(1);
    expect(page.results).toMatchObject([{
      id: 2, description: "100%_done", file: "/api/media/videos/example.mp4",
      tags: [{ id: 1, name: "Tag", color: "blue" }],
    }]);
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(listVideosPage(env, "owner", filter, 2, 1)).resolves.toEqual({ count: 1, results: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "null", transcript: null },
    { name: "empty", transcript: "" },
    { name: "whitespace", transcript: " \r\n " },
    { name: "BMP and combining marks", transcript: "日本語e\u0301\r\n字幕" },
    { name: "surrogate pairs", transcript: "A😊𠮷B" },
    { name: "Unicode range boundaries", transcript: "\uffff\u{10000}\u{10ffff}" },
  ])("MCP metadata preserves UTF-16 counts without fetching $name transcript text", async ({ transcript }) => {
    await admin.query("UPDATE videos SET transcript = $1 WHERE id = 1", [transcript]);
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const end = vi.spyOn(pg.Client.prototype, "end");

    const { video } = await callMcpTool("get_video", { video_id: 1 }, { env, userId: "owner", canWrite: false });

    expect(video).toMatchObject({
      id: 1, title: "Same", tags: [{ id: 1, name: "Tag", color: "blue" }],
      error_message: null,
      transcript_available: (transcript?.length ?? 0) > 0,
      transcript_total_chars: transcript?.length ?? 0,
    });
    expect(video).not.toHaveProperty("transcript");
    expect(video).not.toHaveProperty("file");
    expect(video).not.toHaveProperty("user");
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    const reply = await query.mock.results[0].value as pg.QueryResult;
    expect(reply.fields.map(field => field.name)).not.toContain("transcript");
  });

  it("MCP metadata keeps a large transcript out of the database response even with include_transcript=false", async () => {
    const transcript = "Large caption 😊\n".repeat(100_000);
    await admin.query("UPDATE videos SET transcript = $1 WHERE id = 1", [transcript]);
    const query = vi.spyOn(pg.Client.prototype, "query");

    const { video } = await callMcpTool("get_video", { video_id: 1, include_transcript: false },
      { env, userId: "owner", canWrite: false });

    expect(video).toMatchObject({ transcript_available: true, transcript_total_chars: transcript.length });
    const reply = await query.mock.results[0].value as pg.QueryResult;
    expect(JSON.stringify(reply.rows).length).toBeLessThan(1024);
  });

  it.each([20, 9999])("MCP metadata retains ownership checks for video %i", async (videoId) => {
    await expect(callMcpTool("get_video", { video_id: videoId }, { env, userId: "owner", canWrite: false }))
      .rejects.toMatchObject({ message: "Video not found", data: { status: 404, code: "NOT_FOUND" } });
  });

  it.each([{ offset: 0, limit: 3 }, { offset: 2, limit: 2 }, { offset: 4, limit: 20 }, { offset: 100, limit: 4 }])(
    "MCP requested transcript retains UTF-16 pagination for %j", async ({ offset, limit }) => {
      const transcript = "0😊𠮷e\u0301終";
      await admin.query("UPDATE videos SET transcript = $1 WHERE id = 1", [transcript]);

      const { video } = await callMcpTool("get_video", {
        video_id: 1, include_transcript: true, transcript_offset: offset, transcript_limit: limit,
      }, { env, userId: "owner", canWrite: false });

      const text = transcript.slice(offset, offset + limit);
      const hasMore = offset + text.length < transcript.length;
      expect(video).toMatchObject({
        transcript_available: true,
        transcript_total_chars: transcript.length,
        transcript: { text, offset, returned_chars: text.length, total_chars: transcript.length,
          has_more: hasMore, next_offset: hasMore ? offset + text.length : null },
      });
      expect(video).not.toHaveProperty("file");
      expect(video).not.toHaveProperty("user");
    },
  );
});
