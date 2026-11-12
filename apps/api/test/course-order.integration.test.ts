import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { reorderGroupVideos } from "../src/features/membership/service";
import { reorderCourses } from "../src/repositories/course-repository";
import type { Bindings } from "../src/types/bindings";
import { testAuthHeaders } from "./helpers/auth";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const success = { ok: true, message: "Video order updated" };
const mismatch = { badRequest: "Specified video IDs do not match videos in course" };
const missing = { notFound: "Course not found" };

(databaseUrl ? describe : describe.skip)("course and video order on PostgreSQL", () => {
  const schema = `course_order_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE videos (id bigint PRIMARY KEY, user_id text NOT NULL);
      CREATE TABLE video_courses (
        id bigint PRIMARY KEY, user_id text NOT NULL, display_order integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE video_course_members (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        course_id bigint NOT NULL REFERENCES video_courses ON DELETE CASCADE,
        video_id bigint NOT NULL REFERENCES videos ON DELETE CASCADE,
        "order" integer NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(course_id, video_id)
      );
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = { ENVIRONMENT: "development", HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`
      TRUNCATE videos, video_courses, video_course_members RESTART IDENTITY;
      INSERT INTO videos VALUES (1, 'owner'), (2, 'owner'), (3, 'owner'), (4, 'owner');
      INSERT INTO video_courses (id, user_id, display_order) VALUES (10, 'owner', 2), (20, 'outsider', 9), (30, 'owner', 0);
      INSERT INTO video_course_members (course_id, video_id, "order")
      VALUES (10, 1, 0), (10, 2, 1), (10, 3, 2), (20, 2, 8);
    `);
  });
  afterEach(() => vi.restoreAllMocks());
  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function members(courseId = 10) {
    return (await admin.query(`SELECT *, xmin::text AS version FROM video_course_members WHERE course_id = $1 ORDER BY video_id`, [courseId])).rows;
  }

  async function courses() {
    return (await admin.query("SELECT *, xmin::text AS version FROM video_courses ORDER BY id")).rows;
  }

  it("reassigns existing course slots only to the selected owned courses", async () => {
    await admin.query("INSERT INTO video_courses (id, user_id, display_order) VALUES (40, 'owner', 5)");
    const before = await courses();
    expect(await reorderCourses(env, "owner", [10, 30])).toEqual({ ok: true });
    const reordered = await courses();
    expect(reordered.map(row => row.display_order)).toEqual([0, 9, 2, 5]);
    expect(reordered[1]).toEqual(before[1]);
    expect(reordered[3]).toEqual(before[3]);
    expect(await reorderCourses(env, "owner", [10, 30])).toEqual({ ok: true });
    expect(await courses()).toEqual(reordered);
  });

  it("does not rewrite an unchanged course order", async () => {
    const before = await courses();
    expect(await reorderCourses(env, "owner", [30, 10])).toEqual({ ok: true });
    expect(await courses()).toEqual(before);
  });

  it.each([{ ids: [] }, { ids: [10, 10] }, { ids: [10, 20] }, { ids: [10, 99] }])("rejects missing, unowned or repeated course IDs: %j", async ({ ids }) => {
    const before = await courses();
    expect(await reorderCourses(env, "owner", ids)).toEqual({ mismatch: true });
    expect(await courses()).toEqual(before);
  });

  it("uses the latest sorted course slots after waiting for another reorder", async () => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM video_courses WHERE user_id = 'owner' ORDER BY id FOR UPDATE");
      pending = reorderCourses(env, "owner", [30, 10]).catch(error => error);
      await waitForWriter();
      await writer.query("UPDATE video_courses SET display_order = CASE WHEN id = 10 THEN 0 ELSE 2 END WHERE user_id = 'owner'");
      await writer.query("COMMIT");
      expect(await pending).toEqual({ ok: true });
      expect((await courses()).map(row => row.display_order)).toEqual([2, 9, 0]);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });

  async function waitForWriter() {
    await vi.waitFor(async () => {
      const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema]);
      expect(blocked.rowCount).toBe(1);
    });
  }

  it("checks ownership and membership in the same connection and transaction as the update", async () => {
    const before = await members();
    const other = await members(20);
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    expect(await reorderGroupVideos(env, "owner", 10, [3, 1, 2])).toEqual(success);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(5); // BEGIN, course lock, member locks, UPDATE, COMMIT.
    query.mockRestore();
    const after = await members();
    expect(after.map(row => row.order)).toEqual([1, 2, 0]);
    expect(after.map(({ order: _order, version: _version, ...row }) => row))
      .toEqual(before.map(({ order: _order, version: _version, ...row }) => row));
    expect(await members(20)).toEqual(other);
  });

  it("does not rewrite rows whose order is unchanged, including repeated requests", async () => {
    const before = await members();
    expect(await reorderGroupVideos(env, "owner", 10, [1, 3, 2])).toEqual(success);
    const reordered = await members();
    expect(reordered[0]).toEqual(before[0]);
    expect(reordered.map(row => row.order)).toEqual([0, 2, 1]);
    expect(await reorderGroupVideos(env, "owner", 10, [1, 3, 2])).toEqual(success);
    expect(await members()).toEqual(reordered);
  });

  it.each([[1, 1, 3], [1, 2], [1, 2, 3, 4], [1, 2, 99], []])("rejects a mismatched list %j without writing", async (...videoIds) => {
    const before = await members();
    expect(await reorderGroupVideos(env, "owner", 10, videoIds)).toEqual(mismatch);
    expect(await members()).toEqual(before);
  });

  it("allows an empty order only for an empty owned course", async () => {
    expect(await reorderGroupVideos(env, "owner", 30, [])).toEqual(success);
    expect(await reorderGroupVideos(env, "owner", 30, [1])).toEqual(mismatch);
    expect(await members(30)).toEqual([]);
  });

  it.each([
    { userId: "outsider", courseId: 10 }, { userId: "member", courseId: 10 },
    { userId: "owner", courseId: 20 }, { userId: "owner", courseId: 99 },
  ])("rejects a missing or unowned course: %j", async ({ userId, courseId }) => {
    const before = await members();
    const other = await members(20);
    expect(await reorderGroupVideos(env, userId, courseId, [1, 2, 3])).toEqual(missing);
    expect(await members()).toEqual(before);
    expect(await members(20)).toEqual(other);
  });

  it.each([
    { change: "addition", sql: 'INSERT INTO video_course_members (course_id, video_id, "order") VALUES (10, 4, 3)', expected: mismatch },
    { change: "removal", sql: "DELETE FROM video_course_members WHERE course_id = 10 AND video_id = 2", expected: mismatch },
    { change: "course deletion", sql: "DELETE FROM video_courses WHERE id = 10", expected: missing },
    { change: "ownership change", sql: "UPDATE video_courses SET user_id = 'outsider' WHERE id = 10", expected: missing },
  ])("rechecks a concurrent $change after acquiring the course lock", async ({ sql, expected }) => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM video_courses WHERE id = 10 FOR UPDATE");
      pending = reorderGroupVideos(env, "owner", 10, [3, 1, 2]).catch(error => error);
      await waitForWriter();
      await writer.query(sql);
      await writer.query("COMMIT");
      const before = await members();
      expect(await pending).toEqual(expected);
      expect(await members()).toEqual(before);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });

  it("rechecks membership when video deletion cascades without taking the course lock", async () => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query("DELETE FROM videos WHERE id = 2");
      pending = reorderGroupVideos(env, "owner", 10, [3, 1, 2]).catch(error => error);
      await waitForWriter();
      await writer.query("COMMIT");
      expect(await pending).toEqual(mismatch);
      expect((await members()).map(row => [row.video_id, row.order])).toEqual([["1", 0], ["3", 2]]);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });

  it("rolls back every order change if a row update fails", async () => {
    await admin.query(`
      CREATE FUNCTION reject_order() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.video_id = 2 THEN RAISE EXCEPTION 'order rejected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_order BEFORE UPDATE ON video_course_members FOR EACH ROW EXECUTE FUNCTION reject_order();
    `);
    try {
      const before = await members();
      await expect(reorderGroupVideos(env, "owner", 10, [3, 1, 2])).rejects.toThrow();
      expect(await members()).toEqual(before);
    } finally {
      await admin.query("DROP TRIGGER reject_order ON video_course_members; DROP FUNCTION reject_order()");
    }
  });

  it("serializes overlapping reorders into a complete order", async () => {
    const orders = [[3, 1, 2], [2, 3, 1]];
    const results = await Promise.all(orders.map(order => reorderGroupVideos(env, "owner", 10, order)));
    expect(results).toEqual([success, success]);
    const rows = (await members()).sort((a, b) => a.order - b.order);
    expect(orders).toContainEqual(rows.map(row => Number(row.video_id)));
    expect(rows.map(row => row.order)).toEqual([0, 1, 2]);
  });

  it.each([
    { courseId: 10, videoIds: [3, 1, 2], status: 200, expected: { result: { data: { message: success.message } } } },
    { courseId: 10, videoIds: [1], status: 400, expected: { error: { message: mismatch.badRequest } } },
    { courseId: 20, videoIds: [2], status: 404, expected: { error: { message: missing.notFound } } },
  ])("preserves the tRPC response for status $status", async ({ courseId, videoIds, status, expected }) => {
    const response = await createApp().request("/api/trpc/memberships.reorderVideos", {
      method: "POST", headers: { ...testAuthHeaders("owner"), "content-type": "application/json" },
      body: JSON.stringify({ courseId, videoIds }),
    }, env);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject(expected);
  });
});
