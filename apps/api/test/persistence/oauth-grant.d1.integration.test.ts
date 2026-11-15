import { createD1Fixture } from "./d1-fixture";
import { oauthGrantContract } from "./contracts/oauth-grant.contract";
import type { Bindings } from "../../src/types/bindings";

oauthGrantContract("D1 workerd", async () => {
  const f = await createD1Fixture();
  const ids = async (table: string) => (await f.database.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(row => row.id);
  return {
    env: { DEPLOYMENT_EDITION: "cloud", DB: f.database } as Bindings,
    encodeArray: value => JSON.stringify(value),
    execute: async (sql, args = []) => { await f.database.prepare(sql).bind(...args.map(value => typeof value === "boolean" ? Number(value) : value)).run(); },
    snapshot: async () => ({ consents: await ids("oauth_consent"), refresh: await ids("oauth_refresh_token"), access: await ids("oauth_access_token") }),
    failDeletion: async table => { await f.database.prepare(`CREATE TRIGGER fail_grant BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic-secret-failure-canary'); END`).run(); },
    clearFailure: async () => { await f.database.prepare("DROP TRIGGER fail_grant").run(); },
    dispose: f.dispose,
  };
});
