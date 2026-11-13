import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { createD1Connection } from "../../src/db/d1/connection";
import { users, account, oauthClient } from "../../src/db/schema/sqlite";
import { createD1Auth } from "../../src/persistence/d1/auth";
import { createD1Fixture } from "./d1-fixture";
import type { Bindings } from "../../src/types/bindings";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
const env = {
  DEPLOYMENT_EDITION: "cloud", BETTER_AUTH_URL: "https://auth.example.test",
  BETTER_AUTH_SECRET: "test-only-secret-for-d1-auth-validation-123456",
  CORS_ALLOW_ORIGIN: "https://auth.example.test", ENVIRONMENT: "test",
} as Bindings;
beforeAll(async () => {
  fixture = await createD1Fixture();
  const db = createD1Connection(fixture.database);
  await db.insert(users).values({ id: "auth-user", username: "authuser", email: "auth@example.test", emailVerified: true,
    isOverQuota: false, usedAiAnswers: 0, usedProcessingSeconds: 0, usedStorageBytes: 0, passwordResetRequired: false });
  await db.insert(account).values({ id: "credential", accountId: "auth-user", providerId: "credential", userId: "auth-user",
    password: await hashPassword("D1-contract-password-123") });
});
afterAll(async () => { await fixture?.dispose(); });

describe("Better Auth on D1", () => {
  it("uses an existing credential hash to log in, read and revoke a session", async () => {
    const auth = createD1Auth(env, fixture.database, "browser");
    const signedIn = await auth.api.signInEmail({ body: { email: "auth@example.test", password: "D1-contract-password-123" }, returnHeaders: true });
    expect(signedIn.response.user.id).toBe("auth-user");
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token=");
    const session = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
    expect(session?.user.id).toBe("auth-user");
    expect(session?.session.expiresAt).toBeInstanceOf(Date);
    await auth.api.signOut({ headers: new Headers({ cookie }) });
    expect(await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })).toBeNull();
  });
  it("creates and verifies an API key and rejects a banned owner", async () => {
    const auth = createD1Auth(env, fixture.database);
    const key = await auth.api.createApiKey({ body: { userId: "auth-user" } });
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("ok");
    const db = createD1Connection(fixture.database);
    try {
      await db.update(users).set({ banned: true }).where(eq(users.id, "auth-user"));
      expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("invalid");
    } finally {
      await db.update(users).set({ banned: false }).where(eq(users.id, "auth-user"));
    }
  });
  it("round-trips OAuth array, JSON, Boolean and Date fields in SQLite", async () => {
    const db = createD1Connection(fixture.database);
    const createdAt = new Date("2026-11-13T01:02:03.456Z");
    const auth = createD1Auth(env, fixture.database);
    const { adapter } = await auth.$context;
    await adapter.create({ model: "oauthClient", data: {
      id: "client-row", clientId: "client-id", userId: "auth-user",
      redirectUris: ["https://client.example.test/callback"], scopes: ["videoq.read", "openid"],
      metadata: { source: "migration", nested: [1, true] }, disabled: false, createdAt,
    } });
    const client = await adapter.findOne<Record<string, unknown>>({ model: "oauthClient", where: [{ field: "clientId", value: "client-id" }] });
    expect(client?.scopes).toEqual(["videoq.read", "openid"]);
    expect(client?.redirectUris).toEqual(["https://client.example.test/callback"]);
    expect(client?.metadata).toEqual({ source: "migration", nested: [1, true] });
    expect(client?.disabled).toBe(false);
    expect(client?.createdAt).toEqual(createdAt);
    const [stored] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, "client-id"));
    expect(stored.scopes).toBe(JSON.stringify(["videoq.read", "openid"]));
    expect(stored.metadata).toBe(JSON.stringify({ source: "migration", nested: [1, true] }));
  });
});
