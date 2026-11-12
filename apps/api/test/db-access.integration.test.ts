import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { updateUserTag } from "../src/features/tags/service";
import { removeTagFromVideo } from "../src/features/membership/service";
import { authorizeMediaPath } from "../src/features/media/service";
import { getSearchApiKeyStatus } from "../src/repositories/user-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("database access and authorization on PostgreSQL", () => {
  const schemaName = `db_access_${crypto.randomUUID().replaceAll("-", "")}`;
  const quotedSchema = `"${schemaName}"`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`SET search_path TO ${quotedSchema}`);
    await admin.query(`
      CREATE TABLE users (id text PRIMARY KEY, searchapi_api_key_encrypted text);
      INSERT INTO users VALUES ('owner', NULL);
      CREATE TABLE tags (
        id integer PRIMARY KEY, user_id text NOT NULL, name text NOT NULL,
        color text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(user_id, name)
      );
      CREATE TABLE videos (
        id integer PRIMARY KEY, user_id text NOT NULL, file text NOT NULL,
        title text NOT NULL DEFAULT 'Video', description text NOT NULL DEFAULT '',
        uploaded_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'completed',
        source_type text NOT NULL DEFAULT 'uploaded', source_url text NOT NULL DEFAULT '',
        youtube_video_id text NOT NULL DEFAULT '', transcript text
      );
      CREATE TABLE video_tags (id integer PRIMARY KEY, video_id integer, tag_id integer);
      CREATE TABLE video_courses (id integer PRIMARY KEY, share_slug text UNIQUE);
      CREATE TABLE video_course_members (id integer PRIMARY KEY, video_id integer, course_id integer);
      CREATE TABLE video_course_memberships (course_id integer, user_id text);
      INSERT INTO tags (id, user_id, name, color) VALUES
        (1, 'owner', 'Original', '#legacy'), (2, 'owner', 'Taken', 'blue'),
        (3, 'outsider', 'Private', 'blue');
      INSERT INTO videos (id, user_id, file) VALUES
        (10, 'owner', 'videos/owned.mp4'), (20, 'outsider', 'videos/private.mp4');
      INSERT INTO video_tags VALUES (1, 10, 1);
      INSERT INTO video_courses VALUES (100, 'shared'), (200, 'empty');
      INSERT INTO video_course_members VALUES (1, 10, 100);
      INSERT INTO video_course_memberships VALUES (100, 'member');
    `);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    env = { HYPERDRIVE: { connectionString: scopedUrl.toString() } } as Bindings;
  });

  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await admin.query("UPDATE tags SET name = 'Original', color = '#legacy' WHERE id = 1");
    await admin.query("INSERT INTO video_tags VALUES (1, 10, 1) ON CONFLICT (id) DO NOTHING");
  });
  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`); }
    finally { await admin.end(); }
  });

  it("updates tag metadata with one connection, preserving legacy colors", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const result = await updateUserTag(env, 1, "owner", { name: " Updated " });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tag: {
      id: 1, name: "Updated", color: "#legacy", video_count: 1,
    } });
    expect(result).not.toHaveProperty("tag.videos");
  });

  it.each([null, "", " ", "encrypted-key".repeat(10_000)])("checks key presence without transferring ciphertext (case %#)", async encryptedKey => {
    await admin.query("UPDATE users SET searchapi_api_key_encrypted = $1 WHERE id = 'owner'", [encryptedKey]);
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await getSearchApiKeyStatus(env, "owner")).toBe(Boolean(encryptedKey));
    expect(query).toHaveBeenCalledTimes(1);
    const response = await query.mock.results[0].value;
    expect(response.rows).toEqual([[Boolean(encryptedKey)]]);
  });

  it("distinguishes a missing user from an unset search API key", async () => {
    expect(await getSearchApiKeyStatus(env, "missing")).toBeNull();
  });

  it("removes a video tag with ownership checks and one deletion query", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(removeTagFromVideo(env, "owner", 10, 1)).resolves.toEqual({
      ok: true, message: "Tag removed from video",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(5);
    await expect(removeTagFromVideo(env, "owner", 10, 1)).resolves.toEqual({
      notFound: "Resource not found",
    });
  });

  it("reports exactly one deletion when detach requests race", async () => {
    const results = await Promise.all([
      removeTagFromVideo(env, "owner", 10, 1),
      removeTagFromVideo(env, "owner", 10, 1),
    ]);
    expect(results).toEqual(expect.arrayContaining([
      { ok: true, message: "Tag removed from video" },
      { notFound: "Resource not found" },
    ]));
    expect((await admin.query("SELECT id FROM video_tags WHERE video_id = 10 AND tag_id = 1")).rows).toEqual([]);
  });

  it.each([
    { userId: "outsider", videoId: 10, tagId: 1, message: "Video not found" },
    { userId: "owner", videoId: 20, tagId: 1, message: "Video not found" },
    { userId: "owner", videoId: 10, tagId: 99, message: "Tag not found" },
    { userId: "owner", videoId: 10, tagId: 3, message: "Tag not found" },
  ])("keeps tag ownership checks for %j", async ({ userId, videoId, tagId, message }) => {
    await expect(removeTagFromVideo(env, userId, videoId, tagId)).resolves.toEqual({ notFound: message });
    expect((await admin.query("SELECT id FROM video_tags WHERE video_id = 10 AND tag_id = 1")).rows).toEqual([{ id: 1 }]);
  });

  it("keeps missing/foreign tags as 404 before domain validation", async () => {
    await expect(updateUserTag(env, 1, "outsider", { name: " " })).resolves.toEqual({ notFound: true });
    await expect(updateUserTag(env, 99, "owner", { color: "invalid" })).resolves.toEqual({ notFound: true });
    await expect(updateUserTag(env, 1, "owner", { name: " " })).resolves.toHaveProperty("error");
  });

  it("rolls back a failed update and still supports an empty patch", async () => {
    await expect(updateUserTag(env, 1, "owner", { name: "Taken" })).rejects.toThrow();
    const result = await updateUserTag(env, 1, "owner", {});
    expect(result).toMatchObject({ tag: { name: "Original", color: "#legacy" } });
  });

  it.each([
    { userId: "owner" },
    { userId: "member" },
    { shareSlug: "shared" },
  ])("authorizes the same file with one query for %j", async (access) => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(authorizeMediaPath(env, "videos/owned.mp4", access)).resolves.toEqual({
      ok: true, objectKey: "media/videos/owned.mp4",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["videos/owned.mp4", { userId: "outsider" }],
    ["videos/private.mp4", { userId: "member" }],
    ["videos/private.mp4", { shareSlug: "shared" }],
    ["videos/owned.mp4", { shareSlug: "empty", userId: "owner" }],
    ["videos/missing.mp4", { userId: "owner" }],
  ])("rejects unauthorized file %s for %j", async (path, access) => {
    await expect(authorizeMediaPath(env, path, access)).resolves.toEqual({ notFound: true });
  });

  it("rejects invalid paths and absent credentials before connecting", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(authorizeMediaPath(env, "../private", { userId: "owner" })).resolves.toEqual({ notFound: true });
    await expect(authorizeMediaPath(env, "videos/owned.mp4", {})).resolves.toEqual({ notFound: true });
    expect(connect).not.toHaveBeenCalled();
  });
});
