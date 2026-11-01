import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";

// Exercise real reset/verification endpoints and password hashing. Only
// persistence and outbound mail are replaced; no real mailbox is contacted.
const store = vi.hoisted(() => ({ data: {} }));
vi.mock("@better-auth/drizzle-adapter", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store.data) };
});
vi.mock("../src/lib/mail", () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));

import { createAuth } from "../src/lib/auth";
import { sendMail } from "../src/lib/mail";
import type { Bindings } from "../src/types/bindings";
import type { Db } from "../src/db/pool";

const BASE = "https://recovery.example";
const EMAIL = "owner@example.test";
const NEW_EMAIL = "new-owner@example.test";
const PASSWORD = "isolated-recovery-password";
const NEW_PASSWORD = "replacement-recovery-password";
const env = {
  ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: "isolated-recovery-secret-012345678901234567890123",
  BETTER_AUTH_URL: BASE, FRONTEND_URL: BASE, CORS_ALLOW_ORIGIN: BASE,
} as Bindings;
const makeAuth = () => createAuth(env, {} as Db);
type Auth = ReturnType<typeof makeAuth>;

beforeEach(async () => {
  vi.clearAllMocks();
  store.data = Object.fromEntries([
    "user", "account", "session", "verification", "apikey", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken",
    "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ].map((model) => [model, []]));
  const now = new Date();
  store.data.user.push({
    id: "recovery-owner", email: EMAIL, emailVerified: true,
    name: "Recovery owner", username: "recoveryowner", displayUsername: "recoveryowner",
    role: "user", isActive: true, banned: false, passwordResetRequired: true,
    createdAt: now, updatedAt: now,
  });
  store.data.account.push({
    id: "credential-account", userId: "recovery-owner", accountId: "recovery-owner",
    providerId: "credential", issuer: "local:credential", password: await hashPassword(PASSWORD),
    createdAt: now, updatedAt: now,
  });
});

function post(auth: Auth, path: string, body: unknown, cookie = "") {
  return auth.handler(new Request(`${BASE}/api/auth${path}`, {
    method: "POST", headers: {
      "content-type": "application/json", origin: BASE, cookie, "cf-connecting-ip": "192.0.2.1",
    }, body: JSON.stringify(body),
  }));
}

async function login(auth: Auth, password = PASSWORD) {
  return post(auth, "/sign-in/username", { username: "recoveryowner", password });
}

const cookieFrom = (response: Response) => response.headers.getSetCookie()
  .map((value) => value.split(";")[0]).join("; ");

function mailUrl(index: number) {
  const lines = vi.mocked(sendMail).mock.calls[index]?.[3];
  const url = lines?.find((line) => line.startsWith(`${BASE}/api/auth/`));
  expect(url).toBeDefined();
  return new URL(url!);
}

async function requestReset(auth: Auth, email = EMAIL) {
  const index = vi.mocked(sendMail).mock.calls.length;
  const response = await post(auth, "/request-password-reset", {
    email, redirectTo: `${BASE}/reset-password`,
  });
  expect(response.status).toBe(200);
  expect(vi.mocked(sendMail).mock.calls[index][1]).toBe(email);
  return { url: mailUrl(index), token: mailUrl(index).pathname.split("/").at(-1)! };
}

const reset = (auth: Auth, token: string) => post(auth, "/reset-password", { token, newPassword: NEW_PASSWORD });

function legacyReset(token = "previously-issued-reset-token") {
  store.data.verification.push({
    id: `legacy-${token}`, identifier: `reset-password:${token}`, value: "recovery-owner",
    expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
  });
  return token;
}

describe("standard password recovery", () => {
  it("stores no usable reset token in the verification row", async () => {
    const auth = makeAuth();
    const issued = await requestReset(auth);
    const stored = store.data.verification.find((row) => row.value === "recovery-owner")!;
    expect(stored.identifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetime = new Date(stored.expiresAt as Date).getTime() - new Date(stored.createdAt as Date).getTime();
    expect(lifetime).toBeGreaterThan(899_000);
    expect(lifetime).toBeLessThanOrEqual(900_000);
    expect(vi.mocked(sendMail).mock.calls[0][3]).toContain("15分以内に、以下のURLから新しいパスワードを設定してください。");
    expect(JSON.stringify(stored)).not.toContain(issued.token);

    // A database reader must not be able to submit either the stored identifier
    // or its digest through Better Auth's legacy plaintext lookup fallback.
    for (const token of [String(stored.identifier), String(stored.identifier).split(":").at(-1)!]) {
      const callback = new URL(issued.url);
      callback.pathname = `/api/auth/reset-password/${token}`;
      const rejected = await auth.handler(new Request(callback));
      expect(rejected.status).toBe(302);
      expect(new URL(rejected.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN");
      expect((await reset(auth, token)).status).toBe(400);
    }
    const callback = await auth.handler(new Request(issued.url));
    expect(new URL(callback.headers.get("location")!).searchParams.get("token")).toBe(issued.token);
    expect((await reset(auth, issued.token)).status).toBe(200);
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
  });

  it("accepts legacy plaintext links and consumes each independently", async () => {
    const auth = makeAuth();
    const old = legacyReset();
    const otherOld = legacyReset("second-previously-issued-token");
    const current = await requestReset(auth);
    const callback = await auth.handler(new Request(
      `${BASE}/api/auth/reset-password/${old}?callbackURL=${encodeURIComponent(`${BASE}/reset-password`)}`,
    ));
    expect(new URL(callback.headers.get("location")!).searchParams.get("token")).toBe(old);
    expect((await reset(auth, old)).status).toBe(200);
    expect((await reset(auth, old)).status).toBe(400);
    for (const token of [otherOld, current.token]) {
      expect((await reset(auth, token)).status).toBe(200);
      expect((await reset(auth, token)).status).toBe(400);
    }
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
  });

  it("uses native link expiry after an authenticated password change", async () => {
    const auth = makeAuth();
    const cookie = cookieFrom(await login(auth));
    const oldReset = await requestReset(auth);
    const legacy = legacyReset();
    const changed = await post(auth, "/change-password", {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
    }, cookie);
    expect(changed.status).toBe(200);
    expect((await reset(auth, oldReset.token)).status).toBe(200);
    expect((await reset(auth, legacy)).status).toBe(200);
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
  });

  it("keeps recovery available when the current password is wrong", async () => {
    const auth = makeAuth();
    const cookie = cookieFrom(await login(auth));
    const issued = await requestReset(auth);
    const changed = await post(auth, "/change-password", {
      currentPassword: "incorrect-current-password", newPassword: NEW_PASSWORD,
    }, cookie);
    expect(changed.status).toBe(400);
    expect((await login(auth)).status).toBe(200);
    expect((await reset(auth, issued.token)).status).toBe(200);
  });

  it("cannot revoke recovery links through an unauthenticated password change", async () => {
    const auth = makeAuth();
    const issued = await requestReset(auth);
    const changed = await post(auth, "/change-password", {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
    });
    expect(changed.status).toBe(401);
    expect((await reset(auth, issued.token)).status).toBe(200);
  });

  it("preserves native password-change session rotation", async () => {
    const auth = makeAuth();
    const firstCookie = cookieFrom(await login(auth));
    const secondCookie = cookieFrom(await login(auth));
    const issued = await requestReset(auth);
    const changed = await post(auth, "/change-password", {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true,
    }, firstCookie);
    expect(changed.status).toBe(200);
    for (const cookie of [firstCookie, secondCookie]) {
      const session = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }));
      expect(await session.json()).toBeNull();
    }
    const current = await auth.handler(new Request(`${BASE}/api/auth/get-session`, {
      headers: { cookie: cookieFrom(changed) },
    }));
    expect((await current.json()).user.id).toBe("recovery-owner");
    expect((await reset(auth, issued.token)).status).toBe(200);
  });

  it("keeps native short-lived recovery links valid across an approved email change", async () => {
    const auth = makeAuth();
    const oldReset = await requestReset(auth);
    const legacy = legacyReset();
    const response = await post(auth, "/change-email", { newEmail: NEW_EMAIL }, cookieFrom(await login(auth)));
    expect(response.status).toBe(200);
    expect((await auth.handler(new Request(mailUrl(1)))).status).toBe(302);
    expect(store.data.user[0].email).toBe(EMAIL);
    const pendingReset = await auth.handler(new Request(oldReset.url));
    expect(new URL(pendingReset.headers.get("location")!).searchParams.get("token")).toBe(oldReset.token);
    expect((await auth.handler(new Request(mailUrl(2)))).status).toBe(302);
    expect(store.data.user[0].email).toBe(NEW_EMAIL);

    expect((await reset(auth, oldReset.token)).status).toBe(200);
    expect((await reset(auth, legacy)).status).toBe(200);
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
    const freshReset = await requestReset(auth, NEW_EMAIL);
    expect((await reset(auth, freshReset.token)).status).toBe(200);
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
  });

  it("revokes all prior sessions while each outstanding link retains its own single-use expiry", async () => {
    const auth = makeAuth();
    const cookie = cookieFrom(await login(auth));
    await login(auth);
    expect(store.data.session).toHaveLength(2);
    const first = await requestReset(auth);
    const second = await requestReset(auth);

    expect((await reset(auth, first.token)).status).toBe(200);
    expect(store.data.user[0].passwordResetRequired).toBe(false);
    expect(store.data.session).toHaveLength(0);
    const session = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }));
    expect(await session.json()).toBeNull();
    expect((await reset(auth, second.token)).status).toBe(200);
    expect((await reset(auth, first.token)).status).toBe(400);
    expect((await login(auth)).status).toBe(401);
    expect((await post(auth, "/sign-in/email", { email: EMAIL, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("preserves another user's reset links and verification values for other purposes", async () => {
    store.data.user.push({
      ...store.data.user[0], id: "another-owner", email: "another@example.test", username: "anotherowner",
    });
    store.data.account.push({
      ...store.data.account[0], id: "another-credential", userId: "another-owner", accountId: "another-owner",
    });
    const auth = makeAuth();
    const own = await requestReset(auth);
    const other = await requestReset(auth, "another@example.test");
    const unrelated = {
      id: "other-purpose", identifier: "unrelated-verification", value: "recovery-owner",
      expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
    };
    store.data.verification.push(unrelated);

    expect((await reset(auth, own.token)).status).toBe(200);
    expect(store.data.verification).toContainEqual(unrelated);
    expect(store.data.user[1].passwordResetRequired).toBe(true);
    expect((await reset(auth, other.token)).status).toBe(200);
    expect(store.data.user[1].passwordResetRequired).toBe(false);
  });

  it.each(["expired", "forged"])("rejects a %s link without changing credentials", async (reason) => {
    const auth = makeAuth();
    const issued = await requestReset(auth);
    const originalHash = store.data.account[0].password;
    if (reason === "expired") store.data.verification[0].expiresAt = new Date(Date.now() - 1_000);

    expect((await reset(auth, reason === "forged" ? `${issued.token}-forged` : issued.token)).status).toBe(400);
    expect(store.data.account[0].password).toBe(originalHash);
    expect(store.data.user[0].passwordResetRequired).toBe(true);
    expect((await login(auth)).status).toBe(200);
  });

  // Concurrent reset consumption is covered with the real PostgreSQL adapter
  // in onprem-edition.integration.test.ts. The memory adapter's transaction
  // snapshots do not provide production write-conflict isolation.

  it("can set a password for a verified Google account while retaining its linked identity", async () => {
    const google = {
      ...store.data.account[0], id: "google-account", providerId: "google",
      issuer: "https://accounts.google.com", accountId: "google-subject", password: null,
    };
    store.data.account = [google];
    const auth = makeAuth();
    const issued = await requestReset(auth);

    expect((await reset(auth, issued.token)).status).toBe(200);
    expect(store.data.account).toContainEqual(google);
    expect(store.data.account).toHaveLength(2);
    expect(store.data.user[0].passwordResetRequired).toBe(false);
    expect((await login(auth, NEW_PASSWORD)).status).toBe(200);
  });
});
