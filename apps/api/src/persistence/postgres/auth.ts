import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/pool";
import * as schema from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { createAuthWithPersistence } from "../../lib/auth";

/** PostgreSQL-only adapter construction. The caller owns the connection lifetime. */
export function createAuth(env: Bindings, db: Db, profile: "full" | "browser" = "full", delivery?: { passwordReset: (link: { url: string; token: string }) => Promise<void> }) {
  return createAuthWithPersistence(env, {
    adapter: drizzleAdapter(db, {
      provider: "pg",
      transaction: true,
      schema: {
        user: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        apikey: schema.apikey,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    usernameExists: async candidate => {
      const rows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, candidate)).limit(1);
      return rows.length > 0;
    },
  }, profile, delivery);
}

