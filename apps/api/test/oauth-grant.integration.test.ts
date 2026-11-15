import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/schema";
import { createAuth } from "../src/persistence/postgres/auth";
import { deleteOAuthGrant, hasOAuthConsent } from "../src/lib/auth-security";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("OAuth grant persistence with PostgreSQL", () => {
  const client = new Client({ connectionString: databaseUrl });
  const db = drizzle(client, { schema });
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    await client.connect();
    // Connection-local fixtures never alter application tables.
    await client.query(`
      CREATE TEMP TABLE oauth_client (id text PRIMARY KEY, client_id text UNIQUE NOT NULL, disabled boolean DEFAULT false);
      CREATE TEMP TABLE oauth_resource (
        id text PRIMARY KEY, identifier text UNIQUE NOT NULL, name text NOT NULL,
        access_token_ttl integer, refresh_token_ttl integer, signing_algorithm text,
        signing_key_id text, allowed_scopes text[], custom_claims jsonb,
        dpop_bound_access_tokens_required boolean NOT NULL DEFAULT false,
        disabled boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), policy_version integer NOT NULL DEFAULT 1, metadata jsonb
      );
      CREATE TEMP TABLE oauth_consent (
        id text PRIMARY KEY, client_id text REFERENCES oauth_client(client_id),
        user_id text, reference_id text, resources text[], requested_user_info_claims text[],
        scopes text[] NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TEMP TABLE oauth_refresh_token (id text PRIMARY KEY, user_id text, client_id text, rotation_replay_response text);
      CREATE TEMP TABLE oauth_access_token (id text PRIMARY KEY, user_id text, client_id text, refresh_id text REFERENCES oauth_refresh_token(id));
    `);
    auth = createAuth({
      ENVIRONMENT: "production", BETTER_AUTH_URL: "https://auth-test.example",
      BETTER_AUTH_SECRET: "isolated-pg-test-secret-012345678901234567890123456789",
    } as Bindings, db);
    await auth.$context;
  });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query(`
      TRUNCATE oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client;
      INSERT INTO oauth_client VALUES ('client-row', 'client', false), ('other-row', 'other-client', false);
      INSERT INTO oauth_consent (id, client_id, user_id, scopes) VALUES
        ('grant', 'client', 'user', ARRAY['videoq.read', 'videoq.write']),
        ('other-grant', 'other-client', 'user', ARRAY['videoq.read']);
      INSERT INTO oauth_refresh_token VALUES ('refresh', 'user', 'client', 'cached-response'), ('other-refresh', 'user', 'other-client', NULL);
      INSERT INTO oauth_access_token VALUES ('access', 'user', 'client', 'refresh'), ('other-access', 'user', 'other-client', 'other-refresh');
    `);
  });

  it("requires current consent for the subject, client and scopes", async () => {
    const read = ["videoq.read"];
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", read)).toBe(true);
    expect(await hasOAuthConsent((await auth.$context).adapter, "other-user", "client", read)).toBe(false);
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "missing-client", read)).toBe(false);
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", ["ungranted"])).toBe(false);
  });

  it("removes all credentials for the selected app without affecting another app", async () => {
    await deleteOAuthGrant((await auth.$context).adapter, "user", "grant");
    expect((await client.query("SELECT id FROM oauth_refresh_token")).rows).toEqual([{ id: "other-refresh" }]);
    expect((await client.query("SELECT id FROM oauth_access_token")).rows).toEqual([{ id: "other-access" }]);
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", ["videoq.read"])).toBe(false);
    await client.query("INSERT INTO oauth_consent (id, client_id, user_id, scopes) VALUES ('new-grant', 'client', 'user', ARRAY['videoq.read'])");
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", ["videoq.read"])).toBe(true);
  });

  it("does not let another user revoke a grant", async () => {
    await expect(deleteOAuthGrant((await auth.$context).adapter, "attacker", "grant")).rejects.toMatchObject({ status: "NOT_FOUND" });
    expect((await client.query("SELECT id FROM oauth_refresh_token")).rows).toHaveLength(2);
    expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", ["videoq.read"])).toBe(true);
  });

  it("revokes every grant for the selected client while preserving another user's grants", async () => {
    await client.query(`
      INSERT INTO oauth_consent (id, client_id, user_id, scopes, resources) VALUES
        ('resource-grant', 'client', 'user', ARRAY['videoq.read'], ARRAY['https://other-resource.example']),
        ('other-user-grant', 'client', 'other-user', ARRAY['videoq.read'], NULL);
      INSERT INTO oauth_refresh_token VALUES ('other-user-refresh', 'other-user', 'client', NULL);
      INSERT INTO oauth_access_token VALUES ('other-user-access', 'other-user', 'client', 'other-user-refresh');
    `);

    await deleteOAuthGrant((await auth.$context).adapter, "user", "grant");

    expect((await client.query("SELECT id FROM oauth_consent ORDER BY id")).rows).toEqual([
      { id: "other-grant" }, { id: "other-user-grant" },
    ]);
    expect((await client.query("SELECT id FROM oauth_refresh_token ORDER BY id")).rows).toEqual([
      { id: "other-refresh" }, { id: "other-user-refresh" },
    ]);
    expect((await client.query("SELECT id FROM oauth_access_token ORDER BY id")).rows).toEqual([
      { id: "other-access" }, { id: "other-user-access" },
    ]);
  });

  it("rolls back every deletion if revocation fails midway", async () => {
    await client.query("CREATE TEMP TABLE revoke_blocker (refresh_id text REFERENCES oauth_refresh_token(id)); INSERT INTO revoke_blocker VALUES ('refresh')");
    try {
      await expect(deleteOAuthGrant((await auth.$context).adapter, "user", "grant")).rejects.toThrow();
      expect((await client.query("SELECT id FROM oauth_access_token WHERE id = 'access'")).rows).toHaveLength(1);
      expect((await client.query("SELECT id FROM oauth_refresh_token WHERE id = 'refresh'")).rows).toHaveLength(1);
      expect(await hasOAuthConsent((await auth.$context).adapter, "user", "client", ["videoq.read"])).toBe(true);
    } finally {
      await client.query("DROP TABLE revoke_blocker");
    }
  });
});
