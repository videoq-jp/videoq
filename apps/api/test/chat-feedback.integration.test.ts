import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { submitFeedback } from "../src/features/chat/service";
import { createChatFeedbackToken } from "../src/lib/chat-feedback-token";
import * as authMiddleware from "../src/middleware/auth";
import type { Bindings } from "../src/types/bindings";
import { testAuthHeaders } from "./helpers/auth";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const missing = { notFound: "Specified chat history not found" };
const forbidden = { forbidden: "No permission to access this history" };
const wrongShare = { forbidden: "Share token mismatch" };

(databaseUrl ? describe : describe.skip)("chat feedback on PostgreSQL", () => {
  const schema = `chat_feedback_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE video_courses (id bigint PRIMARY KEY, user_id text NOT NULL, share_slug text);
      CREATE TABLE chat_logs (
        id bigint PRIMARY KEY, course_id bigint NOT NULL REFERENCES video_courses ON DELETE CASCADE,
        user_id text, feedback text CHECK (feedback IN ('good', 'bad')),
        is_shared_origin boolean NOT NULL
      );
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema} -c application_name=${schema}`);
    env = { ENVIRONMENT: "development", BETTER_AUTH_SECRET: "test-chat-feedback-secret-0123456789", HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`
      TRUNCATE video_courses, chat_logs;
      INSERT INTO video_courses VALUES (10, 'owner', 'shared-course'), (20, 'outsider', NULL);
      INSERT INTO chat_logs VALUES (1, 10, 'author', NULL, false), (2, 10, NULL, 'good', true), (3, 20, 'outsider', NULL, false);
    `);
  });
  afterEach(() => vi.restoreAllMocks());
  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function rows() {
    return (await admin.query("SELECT id, course_id, user_id, feedback FROM chat_logs ORDER BY id")).rows;
  }

  it.each([
    { label: "owner", opts: { userId: "owner" }, id: 1 },
    { label: "question author", opts: { userId: "author" }, id: 1 },
    { label: "share visitor", opts: { shareSlug: "shared-course" }, id: 2 },
    { label: "signed-in share visitor", opts: { userId: "outsider", shareSlug: "shared-course" }, id: 2 },
  ])("authorizes the $label and writes feedback using one query and connection", async ({ opts, id }) => {
    const authorizedOpts = "shareSlug" in opts && opts.shareSlug
      ? { ...opts, feedbackToken: await createChatFeedbackToken(env, id, opts.shareSlug) }
      : opts;
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const end = vi.spyOn(pg.Client.prototype, "end");
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await submitFeedback(env, id, "bad", authorizedOpts)).toEqual({ ok: true, chat_log_id: id, feedback: "bad" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([
      { id: "1", course_id: "10", user_id: "author", feedback: id === 1 ? "bad" : null },
      { id: "2", course_id: "10", user_id: null, feedback: id === 2 ? "bad" : "good" },
      { id: "3", course_id: "20", user_id: "outsider", feedback: null },
    ]);
  });

  it.each(["good", "bad", null] as const)("preserves the feedback value %s", async feedback => {
    expect(await submitFeedback(env, 2, feedback, { userId: "owner" }))
      .toEqual({ ok: true, chat_log_id: 2, feedback });
    expect((await rows())[1].feedback).toBe(feedback);
  });

  it.each([
    { id: 1, opts: { userId: "outsider" }, expected: forbidden },
    { id: 2, opts: {}, expected: forbidden },
    { id: 2, opts: { userId: "null" }, expected: forbidden },
    { id: 3, opts: { userId: "owner" }, expected: forbidden },
    { id: 1, opts: { shareSlug: "wrong-course" }, expected: wrongShare },
    { id: 3, opts: { shareSlug: "shared-course" }, expected: wrongShare },
    { id: 1, opts: { shareSlug: "shared-course" }, expected: wrongShare },
    { id: 1, opts: { userId: "owner", shareSlug: "wrong-course" }, expected: wrongShare },
    { id: 99, opts: { userId: "owner" }, expected: missing },
    { id: 99, opts: { shareSlug: "shared-course" }, expected: missing },
  ])("rejects an unauthorized or missing target without modifying data: %j", async ({ id, opts, expected }) => {
    const authorizedOpts = "shareSlug" in opts && opts.shareSlug
      ? { ...opts, feedbackToken: await createChatFeedbackToken(env, id, opts.shareSlug) }
      : opts;
    const before = await rows();
    const query = vi.spyOn(pg.Client.prototype, "query");
    expect(await submitFeedback(env, id, "bad", authorizedOpts)).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(await rows()).toEqual(before);
  });

  it("rejects a revoked share link", async () => {
    await admin.query("UPDATE video_courses SET share_slug = NULL WHERE id = 10");
    expect(await submitFeedback(env, 2, "good", { shareSlug: "shared-course",
      feedbackToken: await createChatFeedbackToken(env, 2, "shared-course") })).toEqual(wrongShare);
    expect((await rows())[1].feedback).toBe("good");
  });

  it("requires the answer's feedback token for anonymous shared feedback", async () => {
    vi.spyOn(authMiddleware, "sessionMethod").mockResolvedValue({ kind: "absent" });
    const token = await createChatFeedbackToken(env, 2, "shared-course");
    for (const input of [
      { chatLogId: 2, shareSlug: "shared-course" },
      { chatLogId: 2, shareSlug: "shared-course", feedbackToken: "0".repeat(64) },
      { chatLogId: 1, shareSlug: "shared-course", feedbackToken: token },
    ]) {
      const response = await createApp().request("/api/trpc/chat.feedback", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, feedback: "bad" }),
      }, env);
      expect(response.status).toBe(403);
    }
    // Even a valid capability cannot change a non-shared answer.
    const privateResponse = await createApp().request("/api/trpc/chat.feedback", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatLogId: 1, feedback: "bad", shareSlug: "shared-course",
        feedbackToken: await createChatFeedbackToken(env, 1, "shared-course") }),
    }, env);
    expect(privateResponse.status).toBe(403);
    expect((await rows()).map(row => row.feedback)).toEqual([null, "good", null]);
  });

  it.each([
    { table: "chat_logs", commit: true }, { table: "video_courses", commit: true },
    { table: "chat_logs", commit: false }, { table: "video_courses", commit: false },
  ])("handles a concurrent deletion of $table (commit=$commit)", async ({ table, commit }) => {
    await admin.query("BEGIN");
    let saving: ReturnType<typeof submitFeedback> | undefined;
    try {
      await admin.query(`DELETE FROM ${table} WHERE id = $1`, [table === "chat_logs" ? 1 : 10]);
      saving = submitFeedback(env, 1, "good", { userId: "owner" });
      void saving.catch(() => {});
      await vi.waitFor(async () => {
        await admin.query("SELECT pg_stat_clear_snapshot()");
        const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema]);
        expect(blocked.rows).toHaveLength(1);
      });
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      await expect(saving).resolves.toEqual(commit ? missing : { ok: true, chat_log_id: 1, feedback: "good" });
      if (!commit) expect((await rows())[0].feedback).toBe("good");
    } finally {
      await admin.query("ROLLBACK");
      await saving?.catch(() => {});
    }
  });

  it.each([
    { shareSlug: "shared-course", status: 200, expected: { result: { data: { chat_log_id: 2, feedback: null } } } },
    { shareSlug: "wrong-course", status: 403, expected: { error: { message: wrongShare.forbidden, data: { code: "FORBIDDEN" } } } },
    { shareSlug: undefined, status: 401, expected: { error: { data: { code: "UNAUTHORIZED" } } } },
  ])("preserves anonymous feedback authorization (status=$status)", async ({ shareSlug, status, expected }) => {
    vi.spyOn(authMiddleware, "sessionMethod").mockResolvedValue({ kind: "absent" });
    const response = await createApp().request("/api/trpc/chat.feedback", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatLogId: 2, feedback: null, shareSlug,
        feedbackToken: shareSlug ? await createChatFeedbackToken(env, 2, shareSlug) : undefined }),
    }, env);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject(expected);
    expect((await rows())[1].feedback).toBe(status === 200 ? null : "good");
  });

  it.each([
    { userId: "owner", id: 1, status: 200, expected: { result: { data: { chat_log_id: 1, feedback: "good" } } } },
    { userId: "outsider", id: 1, status: 403, expected: { error: { message: forbidden.forbidden, data: { code: "FORBIDDEN" } } } },
    { userId: "owner", id: 99, status: 404, expected: { error: { message: missing.notFound, data: { code: "NOT_FOUND" } } } },
  ])("preserves the tRPC response and status $status", async ({ userId, id, status, expected }) => {
    const response = await createApp().request("/api/trpc/chat.feedback", {
      method: "POST", headers: { ...testAuthHeaders(userId), "content-type": "application/json" },
      body: JSON.stringify({ chatLogId: id, feedback: "good" }),
    }, env);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject(expected);
  });
});
