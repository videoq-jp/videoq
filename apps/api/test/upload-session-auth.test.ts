import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "../src/db/pool";
import type { AppEnv, Bindings } from "../src/types/bindings";

const store = vi.hoisted(() => ({ data: {} }));
const query = vi.hoisted(() => vi.fn());
vi.mock("@better-auth/drizzle-adapter", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store.data) };
});
vi.mock("../src/db/pool", () => ({
  withClient: (_env: unknown, fn: (client: object) => unknown) => fn({ query }),
  withDb: (_env: unknown, fn: (db: object) => unknown) => fn({}),
}));
import { createAuth } from "../src/lib/auth";
import { uploadSessionMethod, isUploadControlRequest } from "../src/middleware/upload-session-auth";
import { requireAuth } from "../src/middleware/auth";

const base = "https://upload-auth.example";
const env = { ENVIRONMENT: "production", BETTER_AUTH_URL: base, FRONTEND_URL: base,
  CORS_ALLOW_ORIGIN: base, BETTER_AUTH_SECRET: "test-upload-session-secret-012345678901234567890" } as Bindings;
let cookie: string;
const app = new Hono<AppEnv>().get("/who", requireAuth(uploadSessionMethod), c => c.json({ id: c.var.userId }));
const request = (value = cookie, bindings = env) => app.request(`${base}/who`, { headers: { cookie: value } }, bindings);

beforeEach(async () => {
  store.data = { user: [], session: [], account: [], verification: [] };
  const now = new Date();
  store.data.user.push({ id: "owner", email: "test@example.com", emailVerified: true,
    username: "tester", name: "Tester", role: "user", banned: false, createdAt: now, updatedAt: now });
  store.data.account.push({ id: "account", userId: "owner", accountId: "owner", providerId: "credential",
    password: await hashPassword("test-password-123456"), createdAt: now, updatedAt: now });
  const auth = createAuth(env, {} as Db, "browser");
  const login = await auth.handler(new Request(`${base}/api/auth/sign-in/username`, {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "test-password-123456" }),
  }));
  expect(login.status).toBe(200);
  cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  query.mockReset().mockResolvedValue({ rows: [{ id: "owner", banned: false, banExpires: null }] });
});

describe("bounded upload session authorization", () => {
  it("accepts a cookie issued by native Better Auth and checks current DB state", async () => {
    expect((await request()).status).toBe(200);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("s.expires_at > now()"), [store.data.session[0].token]);
    query.mockResolvedValue({ rows: [] });
    expect((await request()).status).toBe(401); // revoked, expired or deleted owner
  });
  it("rejects forged signatures, wrong secrets, insecure cookies and absent credentials before DB access", async () => {
    for (const value of ["", "__Secure-better-auth.session_token=forged", cookie.replace("__Secure-", ""), cookie.replace("session_token=", "session_token=wrong")]) {
      expect((await request(value)).status).toBe(401);
    }
    expect((await request(cookie, { ...env, BETTER_AUTH_SECRET: "a-different-secret" })).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it("enforces permanent and temporary bans without caching an earlier decision", async () => {
    expect((await request()).status).toBe(200);
    for (const banExpires of [null, new Date(Date.now() + 60000)]) {
      query.mockResolvedValue({ rows: [{ id: "owner", banned: true, banExpires }] });
      expect((await request()).status).toBe(401);
    }
    query.mockResolvedValue({ rows: [{ id: "owner", banned: true, banExpires: new Date(Date.now() - 60000) }] });
    expect((await request()).status).toBe(200);
  });
  it("does not accept test auth headers in production", async () => {
    expect((await app.request(`${base}/who`, { headers: { "X-VideoQ-Test-User-Id": "owner" } }, env)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it("keeps non-upload and mixed batches on the native auth path", () => {
    expect(isUploadControlRequest("/api/trpc/videos.uploadPartUrl,videos.uploadPartUrl")).toBe(true);
    for (const path of ["/api/trpc/videos.uploadPartUrl,account.me", "/api/trpc/admin.patchFlags", "/api/trpc/", "/elsewhere/videos.uploadPartUrl"]) {
      expect(isUploadControlRequest(path)).toBe(false);
    }
  });
});
