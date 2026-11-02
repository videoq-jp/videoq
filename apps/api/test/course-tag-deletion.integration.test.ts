import pg from "pg";
import { visualSchema } from "./helpers/visual-schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCourseChatLogs } from "../src/repositories/chat-repository";
import { deleteCourse, updateCourse } from "../src/repositories/course-repository";
import { deleteTag } from "../src/repositories/tag-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const tables = ["video_courses", "tags", "videos", "video_tags", "video_course_members", "video_course_memberships", "video_course_invitations", "chat_logs", "chat_log_evaluations", "mcp_idempotency_records", "chat_conversations"];
const operations = [
  { name: "course", run: deleteCourse, table: "video_courses", queries: 5,
    deleted: ["video_courses", "video_course_members", "video_course_memberships", "video_course_invitations", "chat_logs", "chat_log_evaluations", "mcp_idempotency_records", "chat_conversations"] },
  { name: "tag", run: deleteTag, table: "tags", queries: 1, deleted: ["tags", "video_tags"] },
  { name: "chat history", run: deleteCourseChatLogs, table: "chat_logs", queries: 5, deleted: ["chat_logs", "chat_log_evaluations", "chat_conversations"] },
];

(databaseUrl ? describe : describe.skip)("course, tag and history deletion on PostgreSQL", () => {
  const schema = `course_tag_deletion_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    // FK actions match 0001_new_schema.sql, 0008_group_invitations.sql and the course rename.
    await admin.query(`
      CREATE TABLE video_courses (
        id integer PRIMARY KEY, user_id text NOT NULL, name text NOT NULL DEFAULT 'Original',
        description text NOT NULL DEFAULT 'Description', display_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), share_slug text
      );
      CREATE TABLE tags (id integer PRIMARY KEY, user_id text NOT NULL);
      CREATE TABLE videos (
        id integer PRIMARY KEY, user_id text NOT NULL, title text NOT NULL DEFAULT 'Video',
        description text NOT NULL DEFAULT '', file text NOT NULL DEFAULT '',
        uploaded_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'completed',
        source_type text NOT NULL DEFAULT 'uploaded', source_url text NOT NULL DEFAULT '', youtube_video_id text NOT NULL DEFAULT ''
      );
      CREATE TABLE video_tags (id integer PRIMARY KEY, tag_id integer NOT NULL REFERENCES tags ON DELETE CASCADE, video_id integer NOT NULL REFERENCES videos ON DELETE CASCADE);
      CREATE TABLE video_course_members (
        id integer PRIMARY KEY, course_id integer NOT NULL REFERENCES video_courses ON DELETE CASCADE,
        video_id integer NOT NULL REFERENCES videos ON DELETE CASCADE,
        "order" integer NOT NULL DEFAULT 0, added_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE video_course_memberships (id integer PRIMARY KEY, course_id integer NOT NULL REFERENCES video_courses ON DELETE CASCADE);
      CREATE TABLE video_course_invitations (id integer PRIMARY KEY, course_id integer NOT NULL REFERENCES video_courses ON DELETE CASCADE);
      CREATE TABLE chat_logs (id integer PRIMARY KEY, course_id integer NOT NULL REFERENCES video_courses ON DELETE CASCADE);
      CREATE TABLE chat_conversations (id integer PRIMARY KEY, course_id integer NOT NULL REFERENCES video_courses ON DELETE CASCADE);
      CREATE TABLE chat_log_evaluations (id integer PRIMARY KEY, chat_log_id integer NOT NULL UNIQUE REFERENCES chat_logs ON DELETE CASCADE);
      CREATE TABLE mcp_idempotency_records (id integer PRIMARY KEY, user_id text NOT NULL, action text NOT NULL, resource_id bigint NOT NULL);
      INSERT INTO video_courses (id, user_id) VALUES (1, 'owner'), (2, 'outsider');
      INSERT INTO tags VALUES (1, 'owner'), (2, 'outsider');
      INSERT INTO videos (id, user_id) VALUES (1, 'owner'), (2, 'outsider');
      INSERT INTO video_tags VALUES (1, 1, 1), (2, 2, 2);
      INSERT INTO video_course_members (id, course_id, video_id) VALUES (1, 1, 1), (2, 2, 2);
      INSERT INTO video_course_memberships VALUES (1, 1), (2, 2);
      INSERT INTO video_course_invitations VALUES (1, 1), (2, 2);
      INSERT INTO chat_logs VALUES (1, 1), (2, 2);
      INSERT INTO chat_conversations VALUES (1, 1), (2, 2);
      INSERT INTO chat_log_evaluations VALUES (1, 1), (2, 2);
      INSERT INTO mcp_idempotency_records VALUES (1, 'owner', 'create_course', 1), (2, 'outsider', 'create_course', 2), (3, 'owner', 'request_video_upload', 1);
    `);
    await admin.query(visualSchema);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function snapshot() {
    const data: Record<string, { id: number }[]> = {};
    for (const table of tables) data[table] = (await admin.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return data;
  }

  it.each(operations)("deletes $name and dependent rows without redundant queries", async operation => {
    const before = await snapshot();
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(operation.run(env, 1, "owner")).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(operation.queries);
    query.mockRestore();
    for (const table of operation.deleted) before[table] = before[table].filter(row => row.id !== 1);
    expect(await snapshot()).toEqual(before);
  });

  it.each(operations)("preserves all data for missing or foreign $name", async operation => {
    const before = await snapshot();
    await expect(operation.run(env, 2, "owner")).resolves.toEqual({ notFound: true });
    await expect(operation.run(env, 99, "owner")).resolves.toEqual({ notFound: true });
    expect(await snapshot()).toEqual(before);
  });

  it.each(operations)("rolls back $name deletion and dependent cleanup together", async operation => {
    await admin.query(`
      CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'delete rejected'; END $$;
      CREATE TRIGGER reject_delete BEFORE DELETE ON ${operation.table} FOR EACH ROW EXECUTE FUNCTION reject_delete();
    `);
    const before = await snapshot();
    await expect(operation.run(env, 1, "owner")).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("reports exactly one successful tag deletion under concurrent requests", async () => {
    const results = await Promise.all([deleteTag(env, 1, "owner"), deleteTag(env, 1, "owner")]);
    expect(results).toEqual(expect.arrayContaining([{ ok: true }, { notFound: true }]));
    expect((await admin.query("SELECT id FROM video_tags")).rows).toEqual([{ id: 2 }]);
  });

  it("updates only supplied course fields and returns the owned course", async () => {
    await expect(updateCourse(env, 1, "owner", { name: "Changed" }))
      .resolves.toMatchObject({ course: { id: 1, name: "Changed", description: "Description", videos: [{ id: 1 }] } });
    expect((await admin.query("SELECT name, description FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ name: "Changed", description: "Description" }]);
    await expect(updateCourse(env, 1, "owner", {})).resolves.toMatchObject({ course: { id: 1, name: "Changed" } });
    await expect(updateCourse(env, 2, "owner", {})).resolves.toEqual({ notFound: true });
    await expect(updateCourse(env, 2, "owner", { name: "Denied" })).resolves.toEqual({ notFound: true });
    await expect(updateCourse(env, 99, "owner", { name: "Missing" })).resolves.toEqual({ notFound: true });
    expect((await admin.query("SELECT name FROM video_courses WHERE id = 2")).rows).toEqual([{ name: "Original" }]);
  });

  it("returns notFound when deletion commits while a course update waits", async () => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let update: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query("DELETE FROM video_courses WHERE id = 1");
      update = updateCourse(env, 1, "owner", { name: "Changed" }).catch(error => error);
      await vi.waitFor(async () => {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema]);
        expect(result.rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      await expect(update).resolves.toEqual({ notFound: true });
    } finally {
      await writer.query("ROLLBACK");
      await update;
      await writer.end();
    }
  });
});
