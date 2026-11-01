import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const migration = readFileSync(new URL("../drizzle/0021_better_auth_permissions_and_account_state.sql", import.meta.url), "utf8");
const removeLegacyRoles = readFileSync(new URL("../drizzle/0028_remove_legacy_user_roles.sql", import.meta.url), "utf8");

(databaseUrl ? describe : describe.skip)("native authentication policy migration", () => {
  it("removes obsolete role columns while preserving native roles, including previously demoted admins", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE users (id text PRIMARY KEY, role text NOT NULL,
        is_staff boolean, is_superuser boolean);
        INSERT INTO users VALUES ('admin', 'admin', false, false), ('staff', 'user', true, false),
          ('demoted', 'user', true, true), ('user', 'user', false, false);`);
      await client.query(removeLegacyRoles);
      expect((await client.query("SELECT * FROM users ORDER BY id")).rows).toEqual([
        { id: "admin", role: "admin" }, { id: "demoted", role: "user" },
        { id: "staff", role: "user" }, { id: "user", role: "user" },
      ]);
    } finally {
      await client.end();
    }
  });

  it("preserves legacy permissions, key secrets and suspended/admin accounts", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE apikey (id text PRIMARY KEY, key text, metadata text, permissions text);
        CREATE TEMP TABLE users (id text PRIMARY KEY, is_active boolean, is_superuser boolean,
          banned boolean, ban_expires timestamptz, role text);`);
      const cases: Array<[string | null, string[]]> = [
        [JSON.stringify({ accessLevel: "all" }), ["read", "write"]],
        [JSON.stringify({ access_level: "all" }), ["read", "write"]],
        [JSON.stringify(JSON.stringify({ access_level: "all" })), ["read", "write"]],
        [JSON.stringify({ accessLevel: "read_only", access_level: "all" }), ["read"]],
        [JSON.stringify({ accessLevel: null, access_level: "all" }), ["read", "write"]],
        [JSON.stringify({ accessLevel: "", access_level: "all" }), []],
        [JSON.stringify({ accessLevel: "unknown" }), []],
        [JSON.stringify({ accessLevel: 42 }), ["read"]],
        [JSON.stringify({}), ["read"]],
        [null, ["read"]],
        ["invalid-json", []],
      ];
      for (const [index, [metadata]] of cases.entries()) {
        await client.query("INSERT INTO apikey VALUES ($1, $2, $3, NULL)", [String(index), `unchanged-hash-${index}`, metadata]);
      }
      await client.query(`INSERT INTO apikey VALUES ('native', 'unchanged-native-hash', '{"accessLevel":"read_only"}', '{"videoq":["read","write"]}');
        INSERT INTO users VALUES
        ('inactive-admin', false, true, false, now() - interval '1 day', 'user'),
        ('banned', true, false, true, NULL, 'user'),
        ('active', true, false, false, NULL, 'user');`);
      await client.query(migration);
      for (const [index, [, permissions]] of cases.entries()) {
        const { rows: [key] } = await client.query("SELECT * FROM apikey WHERE id = $1", [String(index)]);
        expect(JSON.parse(key.permissions)).toEqual({ videoq: permissions });
        expect(key.key).toBe(`unchanged-hash-${index}`);
      }
      expect((await client.query("SELECT permissions FROM apikey WHERE id = 'native'")).rows[0].permissions).toBe('{"videoq":["read"]}');
      expect((await client.query("SELECT id, banned, ban_expires, role FROM users ORDER BY id")).rows).toEqual([
        { id: "active", banned: false, ban_expires: null, role: "user" },
        { id: "banned", banned: true, ban_expires: null, role: "user" },
        { id: "inactive-admin", banned: true, ban_expires: null, role: "admin" },
      ]);
    } finally {
      await client.end();
    }
  });
});
