import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { listConnectedApps, listIntegrationApiKeys } from "../src/repositories/account-integrations-repository";
import type { Bindings } from "../src/types/bindings";
import { TEST_USER_ID, testAuthHeaders } from "./helpers/auth";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("account integration metadata on PostgreSQL", () => {
  const schema = `account_integrations_${crypto.randomUUID().replaceAll("-", "")}`;
  let db: pg.Client;
  let env: Bindings;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE apikey (
        id text PRIMARY KEY, reference_id text NOT NULL, config_id text NOT NULL,
        name text, start text, prefix text, permissions text, last_request timestamptz,
        created_at timestamptz NOT NULL DEFAULT '2026-09-01T00:00:00Z',
        key text DEFAULT 'private-key-hash', metadata text DEFAULT 'private-metadata'
      );
      CREATE TABLE oauth_client (client_id text PRIMARY KEY, name text, client_secret text DEFAULT 'private-client-secret');
      CREATE TABLE oauth_consent (
        id text PRIMARY KEY, client_id text NOT NULL, user_id text,
        scopes text[] NOT NULL, created_at timestamptz DEFAULT '2026-09-01T00:00:00Z'
      );
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    env = {
      ENVIRONMENT: "development", HYPERDRIVE: { connectionString: url.toString() },
      BETTER_AUTH_URL: "https://integrations-test.example",
      BETTER_AUTH_SECRET: "isolated-integration-test-secret-012345678901234567890",
    } as Bindings;
  });
  beforeEach(async () => { await db.query("TRUNCATE apikey, oauth_consent, oauth_client"); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await db.end(); }
  });

  async function seedKeys(count = 1) {
    await db.query(`
      INSERT INTO apikey (id, reference_id, config_id, name, permissions)
      SELECT 'key-' || lpad(i::text, 3, '0'), $1, CASE WHEN i % 2 = 0 THEN 'read-write' ELSE 'default' END,
             'Key ' || i, CASE WHEN i % 2 = 0 THEN '{"videoq":["read","write"]}' ELSE '{"videoq":["read"]}' END
      FROM generate_series(1, $2) AS i
    `, [TEST_USER_ID, count]);
  }

  it("returns all 105 owned API keys through tRPC with stable ordering and no secret fields", async () => {
    await seedKeys(105);
    await db.query("INSERT INTO apikey (id, reference_id, config_id) VALUES ('foreign', 'other-user', 'default'), ('other-config', $1, 'organization')", [TEST_USER_ID]);
    await db.query("UPDATE apikey SET created_at = '2026-09-02T00:00:00Z', start = 'vq_preview' WHERE id = 'key-105'");
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await createApp().request("/api/trpc/account.integrationApiKeys", { headers: testAuthHeaders() }, env);
    expect(response.status).toBe(200);
    const body = await response.json<{ result: { data: Awaited<ReturnType<typeof listIntegrationApiKeys>> } }>();
    expect(body.result.data).toHaveLength(105);
    expect(body.result.data.map(row => row.id)).toEqual(["key-105", ...Array.from({ length: 104 }, (_, i) => `key-${String(i + 1).padStart(3, "0")}`)]);
    expect(body.result.data[0]).toEqual({ id: "key-105", config_id: "default", name: "Key 105", access_level: "read_only", prefix: "vq_preview", last_used_at: null, created_at: "2026-09-02T00:00:00.000Z" });
    expect(body.result.data.find(row => row.id === "key-002")?.access_level).toBe("all");
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(query).toHaveBeenCalledTimes(1);
    const sql = JSON.stringify(query.mock.calls[0][0]);
    expect(sql).not.toMatch(/\\"(?:key|metadata)\\"/);
  });

  it.each([
    ['{"videoq":["read","write"]}', "all"], ['{"videoq":["read"]}', "read_only"],
    ['{"videoq":["write"]}', "read_only"], [null, "read_only"], ["{}", "read_only"],
    ["invalid-json", "read_only"], ['{"videoq":"read write"}', "read_only"],
  ])("displays native permissions %s independently of profile and metadata", async (permissions, expected) => {
    await seedKeys();
    await db.query("UPDATE apikey SET permissions = $1, config_id = 'read-write', metadata = '{\"accessLevel\":\"all\"}'", [permissions]);
    expect(await listIntegrationApiKeys(env, TEST_USER_ID)).toEqual([
      expect.objectContaining({ access_level: expected, config_id: "read-write" }),
    ]);
  });

  it("normalizes dates and absent API key display fields", async () => {
    await seedKeys();
    await db.query("UPDATE apikey SET name = NULL, prefix = 'custom_', last_request = '2026-09-02T09:00:00+09:00'");
    expect(await listIntegrationApiKeys(env, TEST_USER_ID)).toEqual([
      expect.objectContaining({ name: "", prefix: "custom_", last_used_at: "2026-09-02T00:00:00.000Z" }),
    ]);
  });

  it("loads all 105 owned OAuth grants and their names in one query", async () => {
    await db.query("INSERT INTO oauth_client (client_id, name) VALUES ('client', 'Learning app')");
    await db.query(`
      INSERT INTO oauth_consent (id, client_id, user_id, scopes)
      SELECT 'grant-' || lpad(i::text, 3, '0'), 'client', $1, ARRAY['videoq.read'] FROM generate_series(1, 105) AS i
    `, [TEST_USER_ID]);
    await db.query("INSERT INTO oauth_consent (id, client_id, user_id, scopes) VALUES ('foreign-grant', 'client', 'other-user', ARRAY['videoq.write'])");
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await createApp().request("/api/trpc/account.connectedApps", { headers: testAuthHeaders() }, env);
    expect(response.status).toBe(200);
    const body = await response.json<{ result: { data: Awaited<ReturnType<typeof listConnectedApps>> } }>();
    expect(body.result.data).toHaveLength(105);
    expect(body.result.data.map(row => row.id)).toEqual(Array.from({ length: 105 }, (_, i) => `grant-${String(i + 1).padStart(3, "0")}`));
    expect(body.result.data[104]).toEqual({ id: "grant-105", client_id: "client", client_name: "Learning app", scope: "videoq.read", issued_at: "2026-09-01T00:00:00.000Z" });
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(query.mock.calls[0][0])).not.toContain("client_secret");
  });

  it("retains separate grants, falls back to client IDs, and preserves unknown issue dates", async () => {
    await db.query("INSERT INTO oauth_client (client_id, name) VALUES ('client', ''), ('unnamed', NULL)");
    await db.query(`
      INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at) VALUES
        ('read', 'client', $1, ARRAY['videoq.read'], NULL),
        ('write', 'client', $1, ARRAY['videoq.read','videoq.write'], NULL),
        ('missing', 'missing-client', $1, ARRAY[]::text[], NULL),
        ('unnamed', 'unnamed', $1, ARRAY[]::text[], NULL);
    `, [TEST_USER_ID]);
    expect(await listConnectedApps(env, TEST_USER_ID)).toEqual([
      { id: "missing", client_id: "missing-client", client_name: "missing-client", scope: "", issued_at: null },
      { id: "read", client_id: "client", client_name: "client", scope: "videoq.read", issued_at: null },
      { id: "unnamed", client_id: "unnamed", client_name: "unnamed", scope: "", issued_at: null },
      { id: "write", client_id: "client", client_name: "client", scope: "videoq.read videoq.write", issued_at: null },
    ]);
    await db.query("UPDATE oauth_client SET name = 'Updated app' WHERE client_id = 'client'");
    expect((await listConnectedApps(env, TEST_USER_ID)).filter(row => row.client_id === "client").map(row => row.client_name)).toEqual(["Updated app", "Updated app"]);
  });

  it.each(["integrationApiKeys", "connectedApps"])("returns an empty %s list for an account with no integrations", async (name) => {
    const response = await createApp().request(`/api/trpc/account.${name}`, { headers: testAuthHeaders() }, env);
    expect(await response.json()).toEqual({ result: { data: [] } });
  });
});
