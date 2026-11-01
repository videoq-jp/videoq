import { URL } from "node:url";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/lib/auth";
import {
  createMemoryRateLimitBackend,
  setRateLimitBackendForTests,
} from "../src/lib/rate-limit";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const migrationDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

function migrationFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "videoq-ba17-migrations-"));
  mkdirSync(join(directory, "meta"));
  const tags = [
    "0017_invalidate_legacy_oauth_grants",
    "0018_better_auth_1_7_and_mcp_idempotency",
    "0019_backfill_better_auth_issuer",
    "0020_finalize_better_auth_issuer",
    "0029_better_auth_1_7_7_schema",
  ];
  for (const tag of tags) {
    cpSync(join(migrationDirectory, `${tag}.sql`), join(directory, `${tag}.sql`));
  }
  const journal = JSON.parse(
    readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8"),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ tag: string }>;
  };
  writeFileSync(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({
      version: journal.version,
      dialect: journal.dialect,
      entries: journal.entries.filter((entry) => tags.includes(entry.tag)),
    }),
  );
  return directory;
}

const migrationDescribe = databaseUrl ? describe : describe.skip;

migrationDescribe("Better Auth 1.7 Drizzle migration", () => {
  it("invalidates old clients and accepts Better Auth DCR resource identifiers", async () => {
    const databaseName = `videoq_ba17_${crypto.randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: databaseUrl });
    // node-postgres requires a Pool error listener; without one, a background
    // error on an idle client crashes the process instead of just being ignored.
    // `DROP DATABASE ... WITH (FORCE)` in the `finally` block below races with our
    // own `pool.end()` above it and can surface exactly such an error here.
    adminPool.on("error", () => {});
    const adminDb = drizzle(adminPool);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${databaseName}`;
    const fixture = migrationFixture();
    let targetPool: Pool | undefined;

    try {
      await adminDb.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
      targetPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
      targetPool.on("error", () => {});
      const db = drizzle(targetPool);

      // Minimal Better Auth 1.6 schema touched by the 1.7 upgrade migrations.
      await db.execute(sql.raw(`
        CREATE TABLE "users" ("id" text PRIMARY KEY);
        CREATE TABLE "session" ("id" text PRIMARY KEY);
        CREATE TABLE "account" (
          "id" text PRIMARY KEY,
          "account_id" text NOT NULL,
          "provider_id" text NOT NULL
        );
        CREATE TABLE "oauth_client" (
          "id" text PRIMARY KEY,
          "client_id" text NOT NULL UNIQUE,
          "client_secret" text,
          "disabled" boolean DEFAULT false,
          "skip_consent" boolean,
          "enable_end_session" boolean,
          "subject_type" text,
          "scopes" text[],
          "user_id" text,
          "created_at" timestamp with time zone DEFAULT now(),
          "updated_at" timestamp with time zone DEFAULT now(),
          "name" text,
          "uri" text,
          "icon" text,
          "contacts" text[],
          "tos" text,
          "policy" text,
          "software_id" text,
          "software_version" text,
          "software_statement" text,
          "redirect_uris" text[] NOT NULL,
          "post_logout_redirect_uris" text[],
          "token_endpoint_auth_method" text,
          "grant_types" text[],
          "response_types" text[],
          "public" boolean,
          "type" text,
          "require_pkce" boolean,
          "reference_id" text,
          "metadata" jsonb
        );
        CREATE TABLE "oauth_refresh_token" (
          "id" text PRIMARY KEY,
          "token" text NOT NULL,
          "client_id" text NOT NULL,
          "session_id" text
        );
        CREATE TABLE "oauth_access_token" (
          "id" text PRIMARY KEY,
          "token" text,
          "client_id" text NOT NULL,
          "session_id" text,
          "refresh_id" text
        );
        CREATE TABLE "oauth_consent" ("id" text PRIMARY KEY);
        CREATE TABLE "jwks" (
          "id" text PRIMARY KEY,
          "public_key" text NOT NULL,
          "private_key" text NOT NULL,
          "created_at" timestamp with time zone NOT NULL DEFAULT now(),
          "expires_at" timestamp with time zone
        );

        INSERT INTO "jwks" ("id", "public_key", "private_key")
        VALUES ('existing-key', 'existing-public-key', 'existing-private-key');

        INSERT INTO "session" ("id") VALUES ('session-old');
        INSERT INTO "account" ("id", "account_id", "provider_id") VALUES
          ('account-credential', 'user-1', 'credential'),
          ('account-google', 'google-subject', 'google');
        INSERT INTO "oauth_client" ("id", "client_id", "redirect_uris") VALUES
          ('client-row', 'claude-code-existing', ARRAY['http://127.0.0.1/callback']);
        INSERT INTO "oauth_consent" ("id") VALUES ('consent-old');
        INSERT INTO "oauth_refresh_token" ("id", "token", "client_id", "session_id") VALUES
          ('refresh-old', 'refresh-token-old', 'claude-code-existing', 'session-old');
        INSERT INTO "oauth_access_token" ("id", "token", "client_id", "session_id", "refresh_id") VALUES
          ('access-old', 'access-token-old', 'claude-code-existing', 'session-old', 'refresh-old');
      `));

      await migrate(db, { migrationsFolder: fixture });

      const result = await db.execute(sql.raw(`
        SELECT
          (SELECT issuer FROM account WHERE id = 'account-credential') AS credential_issuer,
          (SELECT issuer FROM account WHERE id = 'account-google') AS google_issuer,
          (SELECT count(*)::integer FROM oauth_resource) AS resource_count,
          (SELECT count(*)::integer FROM oauth_client) AS client_count,
          (SELECT count(*)::integer FROM oauth_consent) AS consent_count,
          (SELECT count(*)::integer FROM oauth_access_token) AS access_token_count,
          (SELECT count(*)::integer FROM oauth_refresh_token) AS refresh_token_count
      `));
      expect(result.rows[0]).toMatchObject({
        credential_issuer: "local:credential",
        google_issuer: "local:oauth:google",
        resource_count: 0,
        client_count: 0,
        consent_count: 0,
        access_token_count: 0,
        refresh_token_count: 0,
      });

      // Better Auth >=1.7.3 no longer writes issuer. Keep existing accounts
      // and signing keys readable while accepting the new persistence shape.
      await db.execute(sql`
        INSERT INTO account (id, account_id, provider_id)
        VALUES ('new-google', 'new-subject', 'google')
      `);
      expect((await db.execute(sql`
        SELECT issuer FROM account WHERE id = 'new-google'
      `)).rows[0]).toEqual({ issuer: null });
      expect((await db.execute(sql`
        SELECT public_key, private_key, alg, crv FROM jwks WHERE id = 'existing-key'
      `)).rows[0]).toEqual({
        public_key: "existing-public-key", private_key: "existing-private-key",
        alg: null, crv: null,
      });
      await db.execute(sql`
        INSERT INTO jwks (id, public_key, private_key, alg, crv)
        VALUES ('new-key', 'new-public-key', 'new-private-key', 'EdDSA', 'Ed25519')
      `);
      expect((await db.execute(sql`
        SELECT alg, crv FROM jwks WHERE id = 'new-key'
      `)).rows[0]).toEqual({ alg: "EdDSA", crv: "Ed25519" });

      setRateLimitBackendForTests(createMemoryRateLimitBackend());
      const auth = createAuth(
        {
          ENVIRONMENT: "test",
          BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
          BETTER_AUTH_URL: "https://videoq.jp",
          FRONTEND_URL: "https://videoq.jp",
          CORS_ALLOW_ORIGIN: "https://videoq.jp",
        } as Bindings,
        db,
      );
      const dcrResponse = await auth.handler(
        new Request("https://videoq.jp/api/auth/oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Claude Code",
            application_type: "native",
            token_endpoint_auth_method: "none",
            redirect_uris: ["http://127.0.0.1:5173/callback"],
          }),
        }),
      );
      expect(dcrResponse.status).toBe(201);
      const registered = (await dcrResponse.json<{
        client_id: string;
        resources: string[];
      }>());
      expect(registered.resources).toEqual(["https://videoq.jp/api/mcp"]);

      const resourceLink = await db.execute(sql`
        SELECT resource_id
        FROM oauth_client_resource
        WHERE client_id = ${registered.client_id}
      `);
      expect(resourceLink.rows[0]).toEqual({
        resource_id: "https://videoq.jp/api/mcp",
      });
      await db.execute(sql`
        INSERT INTO oauth_access_token (id, token, client_id)
        VALUES ('access-new', 'access-token-new', ${registered.client_id})
      `);
      await expect(
        db.execute(sql`
          INSERT INTO oauth_access_token (id, token, client_id)
          VALUES ('access-duplicate', 'access-token-new', ${registered.client_id})
        `),
      ).rejects.toThrow();
    } finally {
      setRateLimitBackendForTests(undefined);
      await targetPool?.end();
      await adminDb.execute(
        sql.raw(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
      );
      await adminPool.end();
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
