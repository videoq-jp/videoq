import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { patchFlags } from "../src/features/admin/service";
import { createAuth } from "../src/persistence/postgres/auth";
import { schema, account, session, users } from "../src/db/schema";
import type { Db } from "../src/db/pool";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("admin flags with native Better Auth on PostgreSQL", () => {
  const databaseName = `admin_flags_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  let control: pg.Client;
  let client: pg.Client;
  let db: Db;
  let env: Bindings;
  let headers: Headers;
  const quota = { maxVideoUploadSizeMb: 500, isOverQuota: false, usedAiAnswers: 0, usedProcessingSeconds: 0, usedStorageBytes: 0 };

  beforeAll(async () => {
    control = new pg.Client({ connectionString: databaseUrl });
    await control.connect();
    await control.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    url.searchParams.set("application_name", databaseName);
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    const base = "https://admin-flags.example.test";
    env = {
      ENVIRONMENT: "test", BETTER_AUTH_URL: base, FRONTEND_URL: base, CORS_ALLOW_ORIGIN: base,
      BETTER_AUTH_SECRET: "admin-flags-test-secret-012345678901234567890123456789",
      HYPERDRIVE: { connectionString: url.toString() },
    } as Bindings;
    await db.insert(users).values({ ...quota, id: adminId, username: "admin", email: "admin@example.test", emailVerified: true, role: "admin" });
    const password = "admin-flags-test-password-123";
    await db.insert(account).values({
      id: crypto.randomUUID(), accountId: adminId, userId: adminId,
      issuer: "local:credential", providerId: "credential", password: await hashPassword(password),
    });
    const response = await createAuth(env, db).api.signInEmail({ body: { email: "admin@example.test", password }, asResponse: true });
    expect(response.status).toBe(200);
    headers = new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") });
  }, 30_000);

  beforeEach(async () => {
    await db.delete(users).where(eq(users.id, targetId));
    await db.insert(users).values({ ...quota, id: targetId, username: "target", email: "target@example.test", emailVerified: true, role: "user" });
    await addTargetSession();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      await client?.end();
      await control.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally { await control?.end(); }
  });

  async function addTargetSession() {
    await db.insert(session).values({
      id: crypto.randomUUID(), userId: targetId, token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  async function snapshot() {
    return {
      users: await db.select().from(users).orderBy(users.id),
      sessions: await db.select().from(session).orderBy(session.id),
    };
  }

  it("updates all flags and returns the updated user using one connection", async () => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    expect(await patchFlags(env, adminId, targetId, { is_active: false, is_admin: true }, headers))
      .toMatchObject({ user: { id: targetId, is_active: false, is_admin: true } });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await db.select().from(session).where(eq(session.userId, targetId))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, adminId))).toHaveLength(1);
  });

  it("unbans through the native API and clears expired ban metadata", async () => {
    await db.update(users).set({ banned: true, banReason: "test ban", banExpires: new Date(Date.now() - 1000) }).where(eq(users.id, targetId));
    expect(await patchFlags(env, adminId, targetId, { is_active: true }, headers))
      .toMatchObject({ user: { is_active: true } });
    expect((await db.select().from(users).where(eq(users.id, targetId)))[0])
      .toMatchObject({ banned: false, banReason: null, banExpires: null });
  });

  it("still revokes sessions when the same ban is requested again", async () => {
    await patchFlags(env, adminId, targetId, { is_active: false }, headers);
    await addTargetSession();
    await patchFlags(env, adminId, targetId, { is_active: false }, headers);
    expect(await db.select().from(session).where(eq(session.userId, targetId))).toEqual([]);
  });

  it("returns notFound for a missing target without changing other accounts", async () => {
    const before = await snapshot();
    expect(await patchFlags(env, adminId, crypto.randomUUID(), { is_admin: true }, headers)).toEqual({ notFound: true });
    expect(await snapshot()).toEqual(before);
  });

  it.each([{ is_active: false }, { is_admin: false }])("rejects self lockout before connecting (%j)", async patch => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    expect(await patchFlags(env, adminId, adminId, patch, headers)).toEqual({ selfLockout: true });
    expect(connect).not.toHaveBeenCalled();
  });

  it("preserves native authentication failures and leaves flags and sessions unchanged", async () => {
    const before = await snapshot();
    await expect(patchFlags(env, adminId, targetId, { is_active: false, is_admin: true }, new Headers()))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back earlier flag changes and session revocation if a later update fails", async () => {
    await client.query(`
      CREATE FUNCTION reject_admin_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.role = 'admin' THEN RAISE EXCEPTION 'role update failed'; END IF;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER reject_admin_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION reject_admin_update();
    `);
    try {
      const before = await snapshot();
      await expect(patchFlags(env, adminId, targetId, { is_active: false, is_admin: true }, headers)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.query("DROP TRIGGER reject_admin_update ON users; DROP FUNCTION reject_admin_update()");
    }
  });

  it("returns notFound when the target is deleted while waiting for its row lock", async () => {
    const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    await writer.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [targetId]);
      pending = patchFlags(env, adminId, targetId, { is_admin: true }, headers).catch(error => error);
      await vi.waitFor(async () => {
        const blocked = await client.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [databaseName]);
        expect(blocked.rowCount).toBe(1);
      });
      await writer.query("DELETE FROM users WHERE id = $1", [targetId]);
      await writer.query("COMMIT");
      expect(await pending).toEqual({ notFound: true });
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });
});
