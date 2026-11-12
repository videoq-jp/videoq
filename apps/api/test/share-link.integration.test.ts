import { nativeCourseAuthorityFixture } from './helpers/native-course-authority-fixture';
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearShareLink, saveShareLink } from "../src/features/courses/service";
import { INVALID_SLUG_MESSAGE, SLUG_ALREADY_EXISTS_MESSAGE } from "../src/lib/share-slug";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("share links on PostgreSQL", () => {
  const schema = `share_link_${crypto.randomUUID().replaceAll("-", "")}`;
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
    // Match the case-insensitive unique index in 0016_rename_groups_to_courses.sql.
    await admin.query(`
      CREATE TABLE video_courses (id integer PRIMARY KEY, user_id text NOT NULL, share_slug varchar(64));
      CREATE UNIQUE INDEX video_courses_share_slug_ci_uniq ON video_courses (lower(share_slug)) WHERE share_slug IS NOT NULL;
      INSERT INTO video_courses VALUES (1, 'owner', 'original-link'), (2, 'owner', 'TaKeN-LiNk'), (3, 'outsider', 'private-link');
      CREATE TABLE share_updates (id integer);
      CREATE FUNCTION track_share_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO share_updates VALUES (NEW.id); RETURN NEW; END;
      $$;
      CREATE TRIGGER track_share_update AFTER UPDATE ON video_courses FOR EACH ROW EXECUTE FUNCTION track_share_update();
    `);
  });
  afterEach(() => vi.restoreAllMocks());
  nativeCourseAuthorityFixture(() => env);
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  it("normalizes and saves a link with one query and connection", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(saveShareLink(env, 1, "owner", "  NEW-Link  ")).resolves.toEqual({ share_slug: "new-link" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ share_slug: "new-link" }]);
    await expect(saveShareLink(env, 1, "owner", "new-link")).resolves.toEqual({ share_slug: "new-link" });
  });

  it("reports case-insensitive conflicts without replacing the existing link", async () => {
    await expect(saveShareLink(env, 1, "owner", "taken-link")).resolves.toEqual({ conflict: SLUG_ALREADY_EXISTS_MESSAGE });
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ share_slug: "original-link" }]);
  });

  it.each([3, 99])("keeps missing or foreign course %s hidden even for invalid slugs", async id => {
    for (const slug of ["new-link", "!"]) {
      await expect(saveShareLink(env, id, "owner", slug)).resolves.toEqual({ notFound: true });
    }
    await expect(clearShareLink(env, id, "owner")).resolves.toEqual({ notFound: true });
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 3")).rows)
      .toEqual([{ share_slug: "private-link" }]);
  });

  it("rejects invalid slugs and preserves the existing link", async () => {
    await expect(saveShareLink(env, 1, "owner", "!")).resolves.toEqual({ error: INVALID_SLUG_MESSAGE });
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ share_slug: "original-link" }]);
  });

  it("clears a link and distinguishes an already unconfigured link", async () => {
    await expect(clearShareLink(env, 1, "owner")).resolves.toEqual({ ok: true });
    await expect(clearShareLink(env, 1, "owner")).resolves.toEqual({ notConfigured: true });
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ share_slug: null }]);
  });

  it.each(["original-link", null, ""])("clears or reports an unconfigured link in one query (slug=%s)", async slug => {
    await admin.query("UPDATE video_courses SET share_slug = $1 WHERE id = 1", [slug]);
    await admin.query("TRUNCATE share_updates");
    const query = vi.spyOn(pg.Client.prototype, "query");
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(clearShareLink(env, 1, "owner")).resolves.toEqual(slug ? { ok: true } : { notConfigured: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect((await admin.query("SELECT id FROM share_updates")).rows).toEqual(slug ? [{ id: 1 }] : []);
  });

  it.each([
    { initial: "original-link", next: null, expected: { notConfigured: true }, updates: 1 },
    { initial: null, next: "new-link", expected: { ok: true }, updates: 2 },
  ])("uses the current link after a concurrent change from $initial to $next", async ({ initial, next, expected, updates }) => {
    await admin.query("UPDATE video_courses SET share_slug = $1 WHERE id = 1", [initial]);
    await admin.query("TRUNCATE share_updates");
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let update: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query("UPDATE video_courses SET share_slug = $1 WHERE id = 1", [next]);
      update = clearShareLink(env, 1, "owner").catch(error => error);
      await vi.waitFor(async () => {
        expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema])).rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      await expect(update).resolves.toEqual(expected);
      expect((await admin.query("SELECT id FROM share_updates")).rows).toEqual(Array.from({ length: updates }, () => ({ id: 1 })));
      expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows).toEqual([{ share_slug: null }]);
    } finally {
      await writer.query("ROLLBACK");
      await update;
      await writer.end();
    }
  });

  it.each([
    { operation: "save", change: "delete" },
    { operation: "clear", change: "delete" },
    { operation: "save", change: "transfer" },
    { operation: "clear", change: "transfer" },
  ])("returns notFound on a concurrent $change during $operation", async ({ operation, change }) => {
    const writer = new pg.Client({ connectionString: databaseUrl });
    await writer.connect();
    let update: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query("BEGIN");
      await writer.query(change === "delete"
        ? "DELETE FROM video_courses WHERE id = 1"
        : "UPDATE video_courses SET user_id = 'outsider' WHERE id = 1");
      update = (operation === "save"
        ? saveShareLink(env, 1, "owner", "new-link")
        : clearShareLink(env, 1, "owner")).catch(error => error);
      await vi.waitFor(async () => {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema]);
        expect(result.rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      await expect(update).resolves.toEqual({ notFound: true });
      expect((await admin.query("SELECT user_id, share_slug FROM video_courses WHERE id = 1")).rows)
        .toEqual(change === "delete" ? [] : [{ user_id: "outsider", share_slug: "original-link" }]);
    } finally {
      await writer.query("ROLLBACK");
      await update;
      await writer.end();
    }
  });

  it.each(["save", "clear"] as const)("does not hide database failures during %s", async operation => {
    await admin.query(`
      CREATE FUNCTION reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'update rejected'; END $$;
      CREATE TRIGGER reject_update BEFORE UPDATE ON video_courses FOR EACH ROW EXECUTE FUNCTION reject_update();
    `);
    await expect(operation === "save" ? saveShareLink(env, 1, "owner", "new-link") : clearShareLink(env, 1, "owner")).rejects.toThrow();
    expect((await admin.query("SELECT share_slug FROM video_courses WHERE id = 1")).rows)
      .toEqual([{ share_slug: "original-link" }]);
    expect((await admin.query("SELECT id FROM share_updates")).rows).toEqual([]);
  });
});
