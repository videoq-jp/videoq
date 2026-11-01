import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteVideoCascade } from "../src/repositories/video-repository";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const fixture = readFileSync(new URL("./fixtures/video-deletion.sql", import.meta.url), "utf8");
const relatedTables = [
  "video_tags", "video_course_members",
  "scene_embeddings", "mcp_idempotency_records",
];

(databaseUrl ? describe : describe.skip)("video deletion on PostgreSQL", () => {
  const schema = `video_deletion_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    env = { HYPERDRIVE: { connectionString: url.toString() } } as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(fixture);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function expectIntact() {
    expect((await admin.query("SELECT id FROM videos ORDER BY id")).rows).toEqual([{ id: 10 }, { id: 20 }]);
    for (const table of relatedTables) {
      const ids = [1, 2];
      expect((await admin.query(`SELECT id FROM ${table} ORDER BY id`)).rows).toEqual(ids.map(id => ({ id })));
    }
  }

  it("cascades related rows while explicitly cleaning vectors and idempotency records", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    await expect(deleteVideoCascade(env, 10, "owner")).resolves.toEqual({ deleted: true, cleanupTaskId: null });
    // BEGIN, owner/status lock, idempotency cleanup, vectors, video, COMMIT.
    expect(query).toHaveBeenCalledTimes(6);
    query.mockRestore();
    expect((await admin.query("SELECT id FROM videos")).rows).toEqual([{ id: 20 }]);
    for (const table of relatedTables) {
      expect((await admin.query(`SELECT id FROM ${table}`)).rows, table).toEqual([{ id: 2 }]);
    }
  });

  it.each([
    { id: 10, user: "outsider", options: {} },
    { id: 99, user: "owner", options: {} },
    { id: 10, user: "owner", options: { expectedStatus: "uploading" } },
    { id: 10, user: "owner", options: { expectedFileKey: "videos/replaced.mp4" } },
  ])("preserves all data when deletion preconditions fail: %j", async ({ id, user, options }) => {
    await expect(deleteVideoCascade(env, id, user, options)).resolves.toEqual({ deleted: false, cleanupTaskId: null });
    await expectIntact();
  });

  it("rolls back earlier cleanup if the final delete fails", async () => {
    await admin.query(`
      CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'delete rejected'; END $$;
      CREATE TRIGGER reject_delete BEFORE DELETE ON videos FOR EACH ROW EXECUTE FUNCTION reject_delete();
    `);
    await expect(deleteVideoCascade(env, 10, "owner")).rejects.toThrow();
    await expectIntact();
  });
});
