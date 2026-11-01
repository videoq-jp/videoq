import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCourseWithMembers } from "../src/repositories/chat-repository";
import { getCourseInfo } from "../src/repositories/course-repository";
import { courseInfoTool, COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT } from "../src/lib/rag-course-info";
import { openSceneSearch } from "../src/repositories/vector-repository";
import { getVideoEvidence } from "../src/repositories/video-evidence-repository";
import { embedding as testEmbedding } from "./helpers/embedding";
import type { Bindings } from "../src/types/bindings";

vi.mock("../src/lib/embeddings", () => ({ embedQuery: vi.fn(async () => testEmbedding(1, 0)) }));

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("course metadata and scene selection on PostgreSQL", () => {
  const databaseName = `rag_metadata_${crypto.randomUUID().replaceAll("-", "")}`;
  const quotedDatabase = `"${databaseName}"`;
  let admin: pg.Client;
  let databaseClient: pg.Client;
  let env: Bindings;
  let databaseCreated = false;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotedDatabase}`);
    databaseCreated = true;
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.pathname = `/${databaseName}`;
    databaseClient = new pg.Client({ connectionString: scopedUrl.toString() });
    await databaseClient.connect();
    await databaseClient.query("CREATE EXTENSION vector");
    await databaseClient.query(`
      CREATE TABLE video_courses (
        id integer PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
        display_order integer NOT NULL DEFAULT 0, share_slug text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE videos (
        id integer PRIMARY KEY, user_id text NOT NULL, file text NOT NULL DEFAULT 'private.mp4',
        title text NOT NULL, description text NOT NULL DEFAULT '', transcript text NOT NULL DEFAULT '',
        uploaded_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'completed',
        source_type text NOT NULL DEFAULT 'uploaded', source_url text NOT NULL DEFAULT '',
        youtube_video_id text NOT NULL DEFAULT ''
      );
      CREATE TABLE video_course_members (
        id integer PRIMARY KEY, course_id integer NOT NULL, video_id integer NOT NULL,
        "order" integer NOT NULL DEFAULT 0, added_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE video_course_memberships (course_id integer NOT NULL, user_id text NOT NULL);
      CREATE TABLE scene_embeddings (
        langchain_id uuid PRIMARY KEY, content text NOT NULL, embedding vector(1536),
        user_id text NOT NULL, video_id bigint NOT NULL, langchain_metadata json NOT NULL
      );
      INSERT INTO video_courses (id, user_id, name, description, share_slug) VALUES
        (3, 'owner', 'Digital circuits', 'Registered course description', 'public-course'),
        (4, 'outsider', 'Private course', '', NULL),
        (5, 'owner', 'Empty course', '', NULL);
      INSERT INTO videos (id, user_id, title, description, status) VALUES
        (60, 'owner', 'Lecture 7', 'First listed video', 'completed'),
        (61, 'owner', 'Lecture 8', '', 'processing'),
        (62, 'owner', 'Other course video', '', 'completed'),
        (99, 'outsider', 'Private video', '', 'completed');
      INSERT INTO video_course_members (id, course_id, video_id, "order", added_at) VALUES
        (1, 3, 60, 10, '2026-09-14'), (2, 3, 61, 10, '2026-09-14'),
        (3, 4, 99, 0, '2026-09-14');
      INSERT INTO video_course_memberships VALUES (3, 'member');
      INSERT INTO scene_embeddings VALUES
        ('00000000-0000-4000-8000-000000000060', 'allowed scene', '${JSON.stringify(testEmbedding(1, 0))}', 'owner', 60,
         '{"video_title":"Lecture 7","start_time":"00:00:00","end_time":"00:00:10"}'),
        ('00000000-0000-4000-8000-000000000061', 'selected scene', '${JSON.stringify(testEmbedding(0.9, 0.1))}', 'owner', 61,
         '{"video_title":"Lecture 8","start_time":"00:00:10","end_time":"00:00:20"}'),
        ('00000000-0000-4000-8000-000000000062', 'same owner other course', '${JSON.stringify(testEmbedding(1, 0))}', 'owner', 62, '{}'),
        ('00000000-0000-4000-8000-000000000099', 'foreign owner', '${JSON.stringify(testEmbedding(1, 0))}', 'outsider', 60, '{}');
    `);
    env = { HYPERDRIVE: { connectionString: scopedUrl.toString() } } as Bindings;
  });

  afterAll(async () => {
    await databaseClient?.end();
    try { if (databaseCreated) await admin.query(`DROP DATABASE ${quotedDatabase} WITH (FORCE)`); }
    finally { await admin?.end(); }
  });

  it("reads evidence only from completed videos within the authorized owner and course scope", async () => {
    const scope = { ownerUserId: "owner", videoIds: [60, 61] };
    expect(await getVideoEvidence(env, scope, 60)).toMatchObject({ id: 60, title: "Lecture 7", transcript: "", transcriptTooLarge: false });
    expect(await getVideoEvidence(env, scope, 61)).toBeNull();
    expect(await getVideoEvidence(env, scope, 62)).toBeNull();
    expect(await getVideoEvidence(env, scope, 99)).toBeNull();
    expect(await getVideoEvidence(env, { ownerUserId: "outsider", videoIds: [60] }, 60)).toBeNull();
  });

  it("does not transfer oversized transcripts from the database", async () => {
    await databaseClient.query("UPDATE videos SET transcript = repeat('x', 2097153) WHERE id = 60");
    try {
      expect(await getVideoEvidence(env, { ownerUserId: "owner", videoIds: [60] }, 60))
        .toMatchObject({ transcript: null, transcriptTooLarge: true });
    } finally {
      await databaseClient.query("UPDATE videos SET transcript = '' WHERE id = 60");
    }
  });

  it.each([{ userId: "owner" }, { userId: "member" }, { shareToken: "public-course" }])("uses the authorized course for %j with stable pagination and compact evidence", async (access) => {
      const scope = await getCourseWithMembers(env, { courseId: 3, ...access });
      expect(scope).toMatchObject({ id: 3, userId: "owner", memberVideoIds: [60, 61] });
      const contexts: string[] = [];
      const tool = courseInfoTool(env, { courseId: scope!.id, ownerUserId: scope!.userId }, (s) => contexts.push(s));
      const first = JSON.parse(await tool.invoke({ video_limit: 1, video_offset: 0 }));
      const second = JSON.parse(await tool.invoke({ video_limit: 1, video_offset: first.videos_meta.next_offset }));
      expect(first).toMatchObject({ name: "Digital circuits", video_count: 2,
        videos: [{ id: 60, title: "Lecture 7", position: 1, order: 10 }],
        videos_meta: { total: 2, has_more: true, next_offset: 1 },
      });
      expect(second).toMatchObject({ videos: [{ id: 61, position: 2, order: 10, description: "", status: "processing" }],
        videos_meta: { total: 2, has_more: false, next_offset: null },
      });
      const beyond = JSON.parse(await tool.invoke({ video_limit: 1, video_offset: 20 }));
      expect(beyond).toMatchObject({ videos: [], video_count: 2, videos_meta: { has_more: false, next_offset: null } });
      for (const forbidden of ["private.mp4", "public-course", "user_id", "share_slug", "Private video", "Other course video"]) {
        expect(contexts.join("\n")).not.toContain(forbidden);
      }
    });

  it.each([
    { courseId: 3 },
    { courseId: 3, userId: null, shareToken: null },
    { courseId: 3, userId: "", shareToken: "" },
    { courseId: 3, userId: "outsider" },
    { courseId: 4, userId: "member" },
    { courseId: 4, shareToken: "public-course" },
  ])("denies access to the course for %j before constructing tools", async (access) => {
    expect(await getCourseWithMembers(env, access)).toBeNull();
  });

  it.each(["member", "outsider"])("does not accept %s as the course owner", async (ownerUserId) => {
    expect(await getCourseInfo(env, 3, ownerUserId, {
      videoLimit: 20, videoOffset: 0,
      courseDescriptionLimit: COURSE_DESCRIPTION_LIMIT, videoDescriptionLimit: VIDEO_DESCRIPTION_LIMIT,
    })).toBeNull();
  });

  it("retrieves a course with no videos, description, embeddings", async () => {
    const tool = courseInfoTool(env, { courseId: 5, ownerUserId: "owner" }, () => {});
    expect(JSON.parse(await tool.invoke({ video_limit: 20, video_offset: 0 }))).toMatchObject({
      name: "Empty course", description: "", video_count: 0, videos: [],
      videos_meta: { total: 0, has_more: false, next_offset: null },
    });
  });

  it.each([
    { name: "empty", text: (_limit: number) => "" },
    { name: "short Unicode", text: (_limit: number) => "日本語 e\u0301 😀" },
    { name: "below the limit", text: (limit: number) => "あ".repeat(limit - 1) },
    { name: "exactly the limit", text: (limit: number) => "あ".repeat(limit) },
    { name: "above the limit", text: (limit: number) => "あ".repeat(limit + 1) },
    { name: "exact UTF-16 limit", text: (limit: number) => "😀".repeat(limit / 2) },
    { name: "extra surrogate pair", text: (limit: number) => "😀".repeat(limit / 2 + 1) },
    { name: "split surrogate pair", text: (limit: number) => "a".repeat(limit - 1) + "😀tail" },
    { name: "split combining sequence", text: (limit: number) => "a".repeat(limit - 1) + "e\u0301tail" },
    { name: "large Unicode text", text: (_limit: number) => "説明😀".repeat(100_000) },
  ])("bounds database replies while preserving $name descriptions", async ({ text }) => {
    const courseDescription = text(COURSE_DESCRIPTION_LIMIT);
    const videoDescription = text(VIDEO_DESCRIPTION_LIMIT);
    await databaseClient.query("UPDATE video_courses SET description = $1 WHERE id = 3", [courseDescription]);
    await databaseClient.query("UPDATE videos SET description = $1 WHERE id = 60", [videoDescription]);
    const query = vi.spyOn(pg.Client.prototype, "query");
    try {
      const contexts: string[] = [];
      const tool = courseInfoTool(env, { courseId: 3, ownerUserId: "owner" }, s => contexts.push(s));
      const result = JSON.parse(await tool.invoke({ video_limit: 1, video_offset: 0 }));
      expect(result).toMatchObject({
        description: courseDescription.slice(0, COURSE_DESCRIPTION_LIMIT),
        description_truncated: courseDescription.length > COURSE_DESCRIPTION_LIMIT,
        videos: [{
          description: videoDescription.slice(0, VIDEO_DESCRIPTION_LIMIT),
          description_truncated: videoDescription.length > VIDEO_DESCRIPTION_LIMIT,
        }],
      });
      expect(contexts).toEqual([`Course metadata (not subtitle scenes): ${JSON.stringify(result)}`]);
      expect(query).toHaveBeenCalledTimes(2);
      for (const [index, limit] of [COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT].entries()) {
        // Inspect the actual PostgreSQL response, before application-side slicing.
        const reply = await query.mock.results[index].value as pg.QueryResult;
        const descriptionIndex = reply.fields.findIndex(field => field.name === "description");
        expect(descriptionIndex).toBeGreaterThanOrEqual(0);
        const description = reply.rows[0][descriptionIndex] as string;
        expect([...description].length).toBeLessThanOrEqual(limit + 1);
      }
    } finally {
      query.mockRestore();
      await databaseClient.query("UPDATE video_courses SET description = 'Registered course description' WHERE id = 3");
      await databaseClient.query("UPDATE videos SET description = 'First listed video' WHERE id = 60");
    }
  });

  it("intersects selection with the fixed course/owner scope and preserves default whole-course search", async () => {
    const search = await openSceneSearch(env, { userId: "owner", videoIds: [60, 61] });
    try {
      expect((await search.search("scene")).map((hit) => hit.content)).toEqual(["allowed scene", "selected scene"]);
      expect((await search.search("scene", [61])).map((hit) => hit.content)).toEqual(["selected scene"]);
      expect((await search.search("scene", [60, 60])).map((hit) => hit.content)).toEqual(["allowed scene"]);
      for (const ids of [[], [62], [99], [60, 99]]) {
        await expect(search.search("scene", ids)).rejects.toThrow("subset");
      }
    } finally {
      await search.close();
    }
  });
});
