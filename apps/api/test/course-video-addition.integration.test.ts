import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addVideosToCourseBulk, addVideoToCourseOne, removeVideoFromCourseOne } from "../src/features/membership/service";
import { addVideosBulk } from "../src/repositories/membership-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("bulk course video additions on PostgreSQL", () => {
  const schema = `course_add_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      CREATE TABLE videos (id bigint PRIMARY KEY, user_id text NOT NULL);
      CREATE TABLE video_courses (id bigint PRIMARY KEY, user_id text NOT NULL);
      CREATE TABLE video_course_members (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        course_id bigint NOT NULL REFERENCES video_courses ON DELETE CASCADE,
        video_id bigint NOT NULL REFERENCES videos ON DELETE CASCADE,
        "order" integer NOT NULL, added_at timestamptz NOT NULL,
        UNIQUE(course_id, video_id)
      );
      INSERT INTO videos VALUES (1, 'owner'), (2, 'owner'), (3, 'owner'), (4, 'owner'), (5, 'outsider');
      INSERT INTO video_courses VALUES (10, 'owner'), (20, 'outsider'), (30, 'owner');
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE video_course_members, videos, video_courses;
      INSERT INTO videos VALUES (1, 'owner'), (2, 'owner'), (3, 'owner'), (4, 'owner'), (5, 'outsider');
      INSERT INTO video_courses VALUES (10, 'owner'), (20, 'outsider'), (30, 'owner')`);
    await admin.query(`
      INSERT INTO video_course_members (course_id, video_id, "order", added_at)
      VALUES (10, 1, 0, now()), (10, 3, 4, now()), (20, 2, 0, now())
    `);
  });
  afterEach(() => vi.restoreAllMocks());
  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function members(courseId = 10) {
    return (await admin.query(
      `SELECT * FROM video_course_members WHERE course_id = $1 ORDER BY "order"`, [courseId],
    )).rows;
  }

  it("appends new videos in request order without re-reading all members", async () => {
    const before = await members();
    const otherCourse = await members(20);
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(addVideosToCourseBulk(env, "owner", 10, [3, 4, 4, 1, 2])).resolves.toEqual({
      ok: true, message: "Added 2 videos to course", added_count: 2, skipped_count: 3,
    });
    // BEGIN, locked ownership checks for course/videos, INSERT, COMMIT.
    expect(query).toHaveBeenCalledTimes(5);
    expect(connect).toHaveBeenCalledTimes(1);
    query.mockRestore();
    connect.mockRestore();
    const rows = await members();
    expect(rows.slice(0, 2)).toEqual(before);
    expect(rows.map(row => [row.video_id, row.order])).toEqual([["1", 0], ["3", 4], ["4", 5], ["2", 6]]);
    expect(await members(20)).toEqual(otherCourse);
  });

  it("starts an empty course at zero and preserves repeated-request counts", async () => {
    await expect(addVideosToCourseBulk(env, "owner", 30, [4, 2, 4])).resolves.toMatchObject({ added_count: 2, skipped_count: 1 });
    const before = await members(30);
    expect(before.map(row => [row.video_id, row.order])).toEqual([["4", 0], ["2", 1]]);
    await expect(addVideosToCourseBulk(env, "owner", 30, [2, 4, 2])).resolves.toMatchObject({ added_count: 0, skipped_count: 3 });
    expect(await members(30)).toEqual(before);
  });

  it("counts overlapping concurrent requests once and keeps each batch ordered", async () => {
    const results = await Promise.all([
      addVideosToCourseBulk(env, "owner", 10, [4, 2, 4]),
      addVideosToCourseBulk(env, "owner", 10, [2, 4, 2]),
    ]);
    expect(results.map(result => "added_count" in result ? result.added_count : -1).sort()).toEqual([0, 2]);
    expect(results.map(result => "skipped_count" in result ? result.skipped_count : -1).sort()).toEqual([1, 3]);
    const rows = (await members()).slice(2);
    expect(rows.map(row => row.order)).toEqual([5, 6]);
    expect([["4", "2"], ["2", "4"]]).toContainEqual(rows.map(row => row.video_id));
  });

  it("checks membership after a concurrent removal releases the course lock", async () => {
    const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, application_name: `${schema}_holder` });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM video_courses WHERE id = 10 FOR UPDATE");
      pending = addVideosToCourseBulk(env, "owner", 10, [1, 2]).catch(error => error);
      await vi.waitFor(async () => {
        const waiting = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema],
        );
        expect(waiting.rowCount).toBe(1);
      });
      await writer.query("DELETE FROM video_course_members WHERE course_id = 10 AND video_id = 1");
      await writer.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ added_count: 2, skipped_count: 0 });
      expect((await members()).map(row => [row.video_id, row.order])).toEqual([["3", 4], ["1", 5], ["2", 6]]);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });

  it("rejects a batch containing a missing video without partially adding the others", async () => {
    const before = await members();
    await expect(addVideosBulk(env, 10, [99, 4, 1, 2], "owner")).resolves.toEqual({ notFound: "Some videos not found" });
    expect(await members()).toEqual(before);
  });

  it("rolls back the whole batch if a later row cannot be inserted", async () => {
    await admin.query(`UPDATE video_course_members SET "order" = 2147483646 WHERE course_id = 10 AND video_id = 3`);
    const before = await members();
    await expect(addVideosBulk(env, 10, [4, 2], "owner")).rejects.toMatchObject({ cause: { code: "22003" } });
    expect(await members()).toEqual(before);
  });

  it.each([
    ["outsider", 10, [2], "Course not found"],
    ["owner", 20, [2], "Course not found"],
    ["owner", 99, [2], "Course not found"],
    ["owner", 10, [2, 5], "Some videos not found"],
    ["owner", 10, [2, 99], "Some videos not found"],
  ] as const)("rejects unauthorized or missing resources: %s / %i / %j", async (userId, courseId, videoIds, message) => {
    const before = await members();
    await expect(addVideosToCourseBulk(env, userId, courseId, [...videoIds])).resolves.toEqual({ notFound: message });
    expect(await members()).toEqual(before);
  });

  it("checks course ownership for an empty batch", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(addVideosBulk(env, 10, [], "owner")).resolves.toEqual({ added: 0 });
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(addVideosToCourseBulk(env, "outsider", 10, [])).resolves.toEqual({ notFound: "Course not found" });
  });

  const operations = {
    bulk: (courseId = 10, videoId = 2) => addVideosToCourseBulk(env, "owner", courseId, [videoId]),
    add: (courseId = 10, videoId = 2) => addVideoToCourseOne(env, "owner", courseId, videoId),
    remove: (courseId = 10, videoId = 1) => removeVideoFromCourseOne(env, "owner", courseId, videoId),
  };

  it.each(["bulk", "add", "remove"] as const)("uses one connection for %s with ownership checks", async action => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    expect(await operations[action]()).toHaveProperty("ok", true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reuses existing single memberships without changing their identity or position", async () => {
    const original = (await members())[0];
    expect(await addVideoToCourseOne(env, "owner", 10, 1)).toMatchObject({ id: Number(original.id), reused: true });
    expect((await members())[0]).toEqual(original);
    expect(await addVideoToCourseOne(env, "owner", 10, 2)).toMatchObject({ reused: false });
    expect((await members()).at(-1)).toMatchObject({ video_id: "2", order: 5 });
    expect(await removeVideoFromCourseOne(env, "owner", 10, 2)).toEqual({ ok: true });
    expect(await removeVideoFromCourseOne(env, "owner", 10, 2)).toEqual({ notFound: "This video is not added to the course" });
  });

  it.each(["bulk", "add", "remove"] as const)("preserves authorization errors for %s", async action => {
    expect(await operations[action](20)).toEqual({ notFound: "Course not found" });
    expect(await operations[action](10, 5)).toEqual({ notFound: action === "bulk" ? "Some videos not found" : "Video not found" });
    expect(await operations[action](10, 99)).toEqual({ notFound: action === "bulk" ? "Some videos not found" : "Video not found" });
  });

  it.each((["bulk", "add", "remove"] as const).flatMap(action =>
    (["video_courses", "videos"] as const).flatMap(table =>
      (["transfer", "delete"] as const).map(change => ({ action, table, change })),
    ),
  ))("rechecks ownership after concurrent $action / $table / $change", async ({ action, table, change }) => {
    const id = table === "video_courses" ? 10 : action === "remove" ? 1 : 2;
    const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, application_name: `${schema}_holder` });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      if (action === "remove") await writer.query("SELECT id FROM video_course_members WHERE course_id = 10 AND video_id = 1 FOR UPDATE");
      pending = operations[action]().catch(error => error);
      await vi.waitFor(async () => {
        expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema])).rowCount).toBe(1);
      });
      await writer.query(change === "transfer"
        ? `UPDATE ${table} SET user_id = 'outsider' WHERE id = $1`
        : `DELETE FROM ${table} WHERE id = $1`, [id]);
      await writer.query("COMMIT");
      expect(await pending).toEqual({ notFound: table === "video_courses" ? "Course not found" : action === "bulk" ? "Some videos not found" : "Video not found" });
      if (change === "transfer") expect((await members()).map(row => row.video_id)).toEqual(["1", "3"]);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });
});
