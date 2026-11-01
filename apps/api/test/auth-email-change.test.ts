import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";

// Keep the production auth endpoints and token verification. Replace only
// persistence and outbound email, so no real account or mailbox is touched.
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

const BASE = "https://email-change.example";
const CURRENT_EMAIL = "owner@example.test";
const NEW_EMAIL = "new-address@example.test";
const PASSWORD = "isolated-email-change-password";
const env = {
  ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: "isolated-email-change-secret-01234567890123456789",
  BETTER_AUTH_URL: BASE,
  FRONTEND_URL: BASE,
  CORS_ALLOW_ORIGIN: BASE,
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
    id: "email-owner", email: CURRENT_EMAIL, emailVerified: true,
    name: "Email owner", username: "emailowner", displayUsername: "emailowner",
    role: "user", isActive: true, banned: false, createdAt: now, updatedAt: now,
  });
  store.data.account.push({
    id: "credential-account", userId: "email-owner", accountId: "email-owner",
    providerId: "credential", issuer: "local:credential",
    password: await hashPassword(PASSWORD), createdAt: now, updatedAt: now,
  });
});

function post(auth: Auth, path: string, body: unknown, cookie = "") {
  return auth.handler(new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie, "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify(body),
  }));
}

async function login(auth: Auth) {
  const response = await post(auth, "/sign-in/username", { username: "emailowner", password: PASSWORD });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

function mail(index: number) {
  const call = vi.mocked(sendMail).mock.calls[index];
  expect(call).toBeDefined();
  const url = call[3].find((line) => line.startsWith(`${BASE}/api/auth/verify-email?`));
  expect(url).toBeDefined();
  return { to: call[1], url: new URL(url!) };
}

describe("email change approval", () => {
  it("sends approval only to the current verified address", async () => {
    const auth = makeAuth();
    const response = await post(auth, "/change-email", {
      newEmail: NEW_EMAIL, callbackURL: `${BASE}/change-email`,
    }, await login(auth));

    expect(response.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(mail(0).to).toBe(CURRENT_EMAIL);
    expect(store.data.user[0].email).toBe(CURRENT_EMAIL);
  });

  it.each(["/change-email", "/en/change-email?source=settings#email"])(
    "requires both mailboxes and shows the correct stage at %s", async (callbackPath) => {
      const auth = makeAuth();
      const callbackURL = `${BASE}${callbackPath}`;
      await post(auth, "/change-email", { newEmail: NEW_EMAIL, callbackURL }, await login(auth));

      const approval = await auth.handler(new Request(mail(0).url));
      expect(approval.status).toBe(302);
      expect(store.data.user[0].email).toBe(CURRENT_EMAIL);
      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(mail(1).to).toBe(NEW_EMAIL);
      const pending = new URL(callbackURL);
      pending.searchParams.set("step", "verify-new");
      expect(approval.headers.get("location")).toBe(pending.href);

      const verification = await auth.handler(new Request(mail(1).url));
      expect(verification.status).toBe(302);
      expect(verification.headers.get("location")).toBe(callbackURL);
      expect(store.data.user[0]).toMatchObject({ email: NEW_EMAIL, emailVerified: true });
    },
  );

  it("does not start a change without an authenticated session", async () => {
    const response = await post(makeAuth(), "/change-email", { newEmail: NEW_EMAIL });
    expect(response.status).toBe(401);
    expect(sendMail).not.toHaveBeenCalled();
    expect(store.data.user[0].email).toBe(CURRENT_EMAIL);
  });

  it("returns an updated user only after final verification in a token handoff", async () => {
    const auth = makeAuth();
    await post(auth, "/change-email", { newEmail: NEW_EMAIL }, await login(auth));
    const approvalUrl = mail(0).url;
    approvalUrl.searchParams.delete("callbackURL");
    const approval = await auth.handler(new Request(approvalUrl));
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual({ status: true });
    expect(store.data.user[0].email).toBe(CURRENT_EMAIL);

    const verificationUrl = mail(1).url;
    verificationUrl.searchParams.delete("callbackURL");
    const verification = await auth.handler(new Request(verificationUrl));
    expect(verification.status).toBe(200);
    expect(await verification.json()).toMatchObject({ status: true, user: { email: NEW_EMAIL } });
  });

  it("preserves callback pages outside the app's email-change screen", async () => {
    const auth = makeAuth();
    await post(auth, "/change-email", {
      newEmail: NEW_EMAIL, callbackURL: "/settings?tab=account",
    }, await login(auth));

    const approval = await auth.handler(new Request(mail(0).url));
    expect(approval.headers.get("location")).toBe("/settings?tab=account");
    expect(mail(1).url.searchParams.get("callbackURL")).toBe("/settings?tab=account");
  });

  it("rejects a forged approval without sending verification to the new address", async () => {
    const auth = makeAuth();
    await post(auth, "/change-email", {
      newEmail: NEW_EMAIL, callbackURL: `${BASE}/change-email`,
    }, await login(auth));
    const forged = mail(0).url;
    forged.searchParams.set("token", "invalid-token");

    const response = await auth.handler(new Request(forged));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(store.data.user[0].email).toBe(CURRENT_EMAIL);
  });
});
