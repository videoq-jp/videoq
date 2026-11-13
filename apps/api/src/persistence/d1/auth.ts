import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import * as schema from "../../db/schema/sqlite";
import { createAuthWithPersistence } from "../../lib/auth";
import type { Bindings } from "../../types/bindings";

export function createD1Auth(env: Bindings, database: D1Database, profile: "full" | "browser" = "full") {
  const db = createD1Connection(database);
  return createAuthWithPersistence(env, {
    // D1 does not support interactive SQL transactions. Its batch mechanism is
    // used by business repositories; Better Auth must not issue BEGIN here.
    adapter: drizzleAdapter(db, {
      provider: "sqlite", transaction: false,
      schema: {
        user: schema.users, session: schema.session, account: schema.account,
        verification: schema.verification, apikey: schema.apikey, jwks: schema.jwks,
        oauthClient: schema.oauthClient, oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource, oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken, oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    usernameExists: async candidate => {
      const rows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, candidate)).limit(1);
      return rows.length > 0;
    },
  }, profile);
}
