import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getCourseChatAnalytics, getCourseChatHistory, iterateCourseChatHistoryForExport } from "../src/repositories/chat-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("chat reads on PostgreSQL", () => {
  const schema = `chat_reads_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;
  const storedAnswer = {
    segments: [{ text: "Answer", sourceIds: [4, 9] }, { text: "\n\n`a[1]` = 20. ", sourceIds: [4] }],
    // IDs deliberately differ from array positions, and from reference order.
    sources: [
      { id: 9, video_id: 43, title: "Next", start_time: null, end_time: "00:00:10" },
      { id: 4, video_id: 42, title: "Source", start_time: "00:00:03", end_time: null },
    ],
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL, email text NOT NULL);
      CREATE TABLE video_courses (id bigint PRIMARY KEY, user_id text NOT NULL);
      CREATE TABLE video_course_memberships (course_id bigint NOT NULL, user_id text NOT NULL);
      CREATE TABLE chat_logs (
        id bigint PRIMARY KEY, course_id bigint NOT NULL REFERENCES video_courses,
        user_id text, question text NOT NULL DEFAULT 'Question', response jsonb NOT NULL DEFAULT '{"segments":[{"text":"Answer","sourceIds":[]}],"sources":[]}', is_shared_origin boolean NOT NULL DEFAULT false,
        feedback text, created_at timestamptz NOT NULL
      );
      CREATE TABLE lti_chat_log_subjects (chat_log_id bigint PRIMARY KEY, classroom_author jsonb);
      CREATE INDEX ON chat_logs (course_id);
      CREATE INDEX ON chat_logs (course_id, created_at DESC);
      INSERT INTO users VALUES
        ('owner', 'Owner', 'owner@example.com'), ('member', 'Member', 'member@example.com'),
        ('outsider', 'Outsider', 'outsider@example.com');
      INSERT INTO video_courses VALUES (10, 'owner'), (20, 'outsider'), (30, 'owner');
      INSERT INTO video_course_memberships VALUES (10, 'member');
      INSERT INTO chat_logs (id, course_id, user_id, created_at, feedback, is_shared_origin) VALUES
        (1, 10, 'owner', '2026-09-21T23:59:59.999Z', 'good', false),
        (2, 10, 'member', '2026-09-21T23:59:59.999Z', 'bad', false),
        (3, 10, 'owner', '2026-09-21T23:59:59.999Z', NULL, true),
        (4, 10, 'deleted-user', '2026-09-22T00:00:00Z', NULL, false),
        (5, 10, 'owner', '2026-09-22T01:00:00Z', '', false),
        (6, 10, 'owner', '2026-09-22T02:00:00Z', 'good', false),
        (7, 20, 'outsider', '2000-01-01T00:00:00Z', 'bad', false);
    `);
    await admin.query("UPDATE chat_logs SET response = $1::jsonb WHERE id = 6", [JSON.stringify(storedAnswer)]);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema} -c timezone=Asia/Tokyo`);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  it("summarizes feedback and UTC days with one query", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await getCourseChatAnalytics(env, 10, "owner")).toEqual({
      summary: {
        total_questions: 6,
        date_range: { first: "2026-09-21T23:59:59.999Z", last: "2026-09-22T02:00:00.000Z" },
      },
      time_series: [{ date: "2026-09-21", count: 3 }, { date: "2026-09-22", count: 3 }],
      feedback: { good: 2, bad: 1, none: 2 },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an empty owned course from a missing course in one query", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await getCourseChatAnalytics(env, 30, "owner")).toEqual({
      summary: { total_questions: 0, date_range: { first: null, last: null } },
      time_series: [], feedback: { good: 0, bad: 0, none: 0 },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { courseId: 10, userId: "member" },
    { courseId: 10, userId: "outsider" },
    { courseId: 20, userId: "owner" },
    { courseId: 99, userId: "owner" },
  ])("does not expose history or analytics for %j", async ({ courseId, userId }) => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await getCourseChatHistory(env, courseId, userId, 2, 0)).toEqual({ notFound: true });
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    expect(await getCourseChatAnalytics(env, courseId, userId)).toEqual({ notFound: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 4])("keeps equal timestamps stable across history pages of size %s", async limit => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    const ids: number[] = [];
    const queries: number[] = [];
    for (let offset = 0; offset < 6; offset += limit) {
      const page = await getCourseChatHistory(env, 10, "owner", limit, offset);
      if ("notFound" in page) throw new Error("Expected authorized history");
      expect(page.count).toBe(6);
      ids.push(...page.results.map(row => row.id));
      queries.push(query.mock.calls.length);
      query.mockClear();
    }
    expect(ids).toEqual([6, 5, 4, 3, 2, 1]);
    expect(queries.every(count => count === 2)).toBe(true);
  });

  it.each([
    { courseId: 30, offset: 0, count: 0 },
    { courseId: 10, offset: 6, count: 6 },
    { courseId: 10, offset: 100, count: 6 },
  ])("skips fetching an empty history page for %j", async ({ courseId, offset, count }) => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await getCourseChatHistory(env, courseId, "owner", 2, offset)).toEqual({ count, results: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("preserves citation formatting and author privacy in history and CSV rows", async () => {
    const page = await getCourseChatHistory(env, 10, "owner", 100, 0);
    if ("notFound" in page) throw new Error("Expected authorized history");
    const byId = new Map(page.results.map(row => [row.id, row]));
    expect(byId.get(6)).toMatchObject({
      course: 10, question: "Question", feedback: "good",
      created_at: "2026-09-22T02:00:00.000Z",
      answer: storedAnswer,
    });
    expect(byId.get(1)?.asked_by).toEqual({ user_id: "owner", username: "Owner", email: "owner@example.com" });
    expect(byId.get(2)?.asked_by).toEqual({ user_id: "member", username: "Member", email: "member@example.com" });
    expect(byId.get(3)?.asked_by).toBeNull();
    expect(byId.get(4)?.asked_by).toBeNull();
    expect(byId.get(5)?.feedback).toBeNull();
    const exported = [];
    for await (const row of iterateCourseChatHistoryForExport(env, 10, "owner")) exported.push(row);
    expect(exported).toHaveLength(6);
    expect(exported[2].asked_by).toBeNull();
    expect(exported[3].asked_by).toBeNull();
    expect(exported[5].citations).toEqual(byId.get(6)?.answer.sources);
    expect(exported[5].answer).toBe("Answer\n\n`a[1]` = 20. ");
  });
});
