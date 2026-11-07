import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/types/bindings";
import { ensureNativeSession } from "../src/features/lms/native-session";
import { recordScopeVideos } from "../src/features/lti/store";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("Moodle native session lifecycle on PostgreSQL", () => {
  const database = "videoq_native_" + crypto.randomUUID().replaceAll("-", "");
  let admin: pg.Pool, pool: pg.Pool, env: Bindings;
  type Input = Parameters<typeof ensureNativeSession>[1];
  const input = (): Input => ({
    ownerUserId: "owner", sessionHash: "a".repeat(64), markerHash: "b".repeat(64),
    nonceHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    nonceExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Math.ceil(Date.now() / 1000) * 1000 + 3500_000),
    grant: { transport: "native", registrationId: "db:school", registrationHash: "c".repeat(64), subjectHash: "d".repeat(64),
      deploymentId: "2", contextId: "42", resourceLinkId: "entry", courseId: 12, resourceGeneration: 1,
      serviceSubject: "11", roles: [], locale: "ja", scopeVideoIds: [3] },
  });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = "/" + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
    env = { DATABASE_POOL: pool } as Bindings;
    await pool.query(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE lti_credentials(id text PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,expires_at timestamptz NOT NULL)`);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE lti_credentials,users; INSERT INTO users VALUES('owner')");
  });
  afterAll(async () => {
    await pool?.end();
    try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); }
    finally { await admin?.end(); }
  });

  it("creates one data session and one metadata-free marker across concurrent signed requests", async () => {
    const first = input(), second = { ...first, nonceHash: "e".repeat(64) };
    await Promise.all([ensureNativeSession(env, first), ensureNativeSession(env, second)]);
    const rows = (await pool.query("SELECT kind,count(*)::int AS count FROM lti_credentials GROUP BY kind")).rows;
    expect(Object.fromEntries(rows.map(r => [r.kind, r.count]))).toEqual({ session: 1, "moodle-native-started": 1, "moodle-native-request": 2 });
    expect((await pool.query("SELECT payload FROM lti_credentials WHERE kind<>'session'")).rows.every(r => JSON.stringify(r.payload) === "{}")).toBe(true);
  });

  it("atomically rejects a concurrent replay of the same signed request", async () => {
    const request = input();
    const results = await Promise.allSettled([ensureNativeSession(env, request), ensureNativeSession(env, request)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ status: "rejected", reason: { status: 403 } });
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials WHERE kind='moodle-native-request'")).rows[0].n).toBe(1);
  });

  it("preserves the atomic union of earlier learning scopes on subsequent requests", async () => {
    const request = input();
    await ensureNativeSession(env, request);
    await Promise.all([recordScopeVideos(env, request.sessionHash, [7]),
      ensureNativeSession(env, { ...request, nonceHash: "e".repeat(64) })]);
    const payload = (await pool.query("SELECT payload FROM lti_credentials WHERE id=$1", [request.sessionHash])).rows[0].payload;
    expect(payload.scopeVideoIds.sort((a: number, b: number) => a - b)).toEqual([3, 7]);
  });

  it("cannot resurrect a revoked session while its original Moodle session remains live", async () => {
    const request = input();
    await ensureNativeSession(env, request);
    await pool.query("DELETE FROM lti_credentials WHERE id=$1", [request.sessionHash]);
    await expect(ensureNativeSession(env, { ...request, nonceHash: "e".repeat(64) })).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials WHERE kind='session'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials WHERE kind='moodle-native-started'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials WHERE id=$1", ["e".repeat(64)])).rows[0].n).toBe(0);
  });

  it("never replaces an expired session or extends its original lifetime", async () => {
    const request = input();
    await ensureNativeSession(env, request);
    await expect(ensureNativeSession(env, { ...request, nonceHash: "e".repeat(64),
      expiresAt: new Date(request.expiresAt.getTime() + 1000) })).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE lti_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [request.sessionHash]);
    await expect(ensureNativeSession(env, { ...request, nonceHash: "f".repeat(64) })).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT expires_at<now() AS expired FROM lti_credentials WHERE id=$1", [request.sessionHash])).rows[0].expired).toBe(true);
  });

  it.each(["registrationHash", "subjectHash", "resourceGeneration", "contextId", "courseId"] as const)(
    "refuses to reuse a native session with a changed %s", async field => {
      const request = input();
      await ensureNativeSession(env, request);
      const altered = { ...request.grant, [field]: typeof request.grant[field] === "number" ? 999 : "other" };
      await expect(ensureNativeSession(env, { ...request, nonceHash: "e".repeat(64), grant: altered })).rejects.toMatchObject({ status: 403 });
    });

  it("waits for the owner's erasure lock and then refuses the deleted data session", async () => {
    const request = input();
    await ensureNativeSession(env, request);
    const eraser = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await eraser.query("BEGIN; SELECT id FROM users WHERE id='owner' FOR UPDATE");
      pending = ensureNativeSession(env, { ...request, nonceHash: "e".repeat(64) });
      // Attach rejection handling before releasing the barrier.
      const result = pending.then(() => ({ passed: true }), error => ({ passed: false, status: error.status }));
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'", [database])).rowCount! > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await eraser.query("DELETE FROM lti_credentials WHERE id=$1", [request.sessionHash]);
      await eraser.query("COMMIT");
      expect(await result).toEqual({ passed: false, status: 403 });
      expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials WHERE kind='session'")).rows[0].n).toBe(0);
    } finally {
      await eraser.query("ROLLBACK"); eraser.release();
      await pending?.catch(() => {});
    }
  });

  it("does not create credentials for a missing owner", async () => {
    await expect(ensureNativeSession(env, { ...input(), ownerUserId: "absent" })).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_credentials")).rows[0].n).toBe(0);
  });
});
