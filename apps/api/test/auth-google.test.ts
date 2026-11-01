import { requestBodyText } from "./helpers/request-body";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

// Keep Google's actual ID-token verifier and the production auth routes. Supply
// a local signing key through a mocked JWKS response; never contact Google/mail.
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

const BASE = "https://google-auth.example";
const CLIENT_ID = "isolated-google-client";
const USER_ID = "google-test-owner";
const ISSUER = "https://accounts.google.com";
const env = {
  ENVIRONMENT: "production", BETTER_AUTH_URL: BASE, FRONTEND_URL: BASE, CORS_ALLOW_ORIGIN: BASE,
  BETTER_AUTH_SECRET: "isolated-google-auth-secret-012345678901234567890123",
  GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "isolated-google-client-secret",
} as Bindings;
// Only the username-allocation query uses Drizzle directly. Fixture names are
// distinct from the provider's candidate; all auth persistence uses memoryAdapter.
const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Db;
type Auth = ReturnType<typeof createAuth>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: object;
let tokenResponse: Record<string, unknown> | undefined;
let tokenRequests: URLSearchParams[];

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  otherKeys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "local-google-key", alg: "RS256", use: "sig" }] };
});
beforeEach(() => {
  vi.clearAllMocks();
  tokenResponse = undefined;
  tokenRequests = [];
  store.data = Object.fromEntries([
    "user", "account", "session", "verification", "apikey", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken",
    "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ].map((model) => [model, []]));
  const now = new Date();
  store.data.user.push({
    id: USER_ID, email: "owner@gmail.com", emailVerified: true, name: "Owner",
    username: "localowner", displayUsername: "localowner", isActive: true, banned: false,
    role: "user", createdAt: now, updatedAt: now,
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://oauth2.googleapis.com/token" && tokenResponse) {
      tokenRequests.push(new URLSearchParams(requestBodyText(init?.body)));
      return Response.json(tokenResponse);
    }
    if (url !== "https://www.googleapis.com/oauth2/v3/certs") throw new Error(`Unexpected outbound request: ${url}`);
    return Response.json(jwks);
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function idToken(claims: JWTPayload = {}, wrongSignature = false) {
  return new SignJWT({
    iss: ISSUER, aud: CLIENT_ID, sub: "google-subject", email: store.data.user[0]?.email ?? "new@external.test",
    email_verified: true, name: "Google owner", iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "local-google-key" })
    .sign(wrongSignature ? otherKeys.privateKey : keys.privateKey);
}
function signIn(auth: Auth, token: string, accessToken?: string) {
  return auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
    method: "POST", headers: { origin: BASE, "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ provider: "google", idToken: { token, accessToken } }),
  }));
}

const cookieFrom = (response: Response) => response.headers.getSetCookie()
  .map((value) => value.split(";")[0]).join("; ");
const ACCESS_TOKEN = "isolated-google-access-token";
const REFRESH_TOKEN = "isolated-google-refresh-token";

async function browserSignIn(auth: Auth) {
  const start = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
    method: "POST", headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: `${BASE}/settings` }),
  }));
  expect(start.status).toBe(200);
  const authorization = new URL((await start.json()).url);
  const nonce = authorization.searchParams.get("nonce");
  tokenResponse = {
    access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer",
    expires_in: 3600, scope: "openid email profile", id_token: await idToken(nonce ? { nonce } : {}),
  };
  const response = await auth.handler(new Request(
    `${BASE}/api/auth/callback/google?code=isolated-code&state=${authorization.searchParams.get("state")}`,
    { headers: { cookie: cookieFrom(start) } },
  ));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${BASE}/settings`);
  expect(tokenRequests).toHaveLength(1);
  expect(tokenRequests[0].get("grant_type")).toBe("authorization_code");
  expect(tokenRequests[0].get("code_verifier")).toBeTruthy();
  return cookieFrom(response);
}

function requestAccountToken(auth: Auth, route: string, cookie: string, accountId = store.data.account[0].id, userId?: string) {
  return auth.handler(new Request(`${BASE}/api/auth/${route}`, {
    method: "POST", headers: { origin: BASE, "content-type": "application/json", cookie },
    body: JSON.stringify({ accountId, userId }),
  }));
}

function expectEncrypted(value: unknown, plaintext: string) {
  expect(value).toEqual(expect.any(String));
  expect(value).not.toBe(plaintext);
  expect(value).not.toContain(plaintext);
}

describe.each(["full", "browser"] as const)("Google account ownership (%s)", (profile) => {
  const makeAuth = () => createAuth(env, db, profile);
  it.each([false, undefined, "false"])("does not link an email whose verification claim is %j", async (email_verified) => {
    const response = await signIn(makeAuth(), await idToken({ email_verified }));
    expect(response.status).toBe(401);
    expect(store.data.account).toHaveLength(0);
    expect(store.data.session).toHaveLength(0);
  });

  it("does not auto-link a third-party email based only on Google's historical verification", async () => {
    store.data.user[0].email = "owner@external.test";
    const response = await signIn(makeAuth(), await idToken());
    expect(response.status).toBe(401);
    expect(store.data.account).toHaveLength(0);
    expect(store.data.session).toHaveLength(0);
  });

  it.each([
    { email: "owner@gmail.com", email_verified: true },
    { email: "owner@workspace.test", email_verified: true, hd: "workspace.test" },
  ])("links an authoritative verified Google email: %j", async (claims) => {
    store.data.user[0].email = claims.email;
    const response = await signIn(makeAuth(), await idToken(claims));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).user.id).toBe(USER_ID);
    expect(store.data.account).toEqual([expect.objectContaining({
      userId: USER_ID, providerId: "google", accountId: "google-subject",
    })]);
  });

  it("requires mailbox verification for a new third-party Google account", async () => {
    store.data.user = [];
    const auth = makeAuth();
    const token = await idToken();
    const response = await signIn(auth, token);
    expect(response.status).toBe(403);
    expect(store.data.session).toHaveLength(0);
    expect(store.data.user[0].emailVerified).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0];
    expect(mail[1]).toBe("new@external.test");
    const url = mail[3].find((line) => line.startsWith(`${BASE}/api/auth/verify-email?`));
    expect(url).toBeDefined();
    expect((await auth.handler(new Request(url!))).status).toBe(302);
    expect(store.data.user[0].emailVerified).toBe(true);
    expect((await signIn(auth, token)).status).toBe(200);
  });

  it("keeps an existing third-party Google identity bound to its subject", async () => {
    store.data.user[0].email = "owner@external.test";
    store.data.account.push({
      id: "existing-google", userId: USER_ID, providerId: "google", issuer: ISSUER,
      accountId: "google-subject", createdAt: new Date(), updatedAt: new Date(),
    });
    const response = await signIn(makeAuth(), await idToken({ email: "changed@external.test" }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).user.id).toBe(USER_ID);
    expect(store.data.user[0].email).toBe("owner@external.test");
    expect(store.data.account).toHaveLength(1);
  });

  it("does not auto-link an unverified local account", async () => {
    store.data.user[0].emailVerified = false;
    expect((await signIn(makeAuth(), await idToken())).status).toBe(401);
    expect(store.data.account).toHaveLength(0);
    expect(store.data.session).toHaveLength(0);
  });

  it.each([
    { aud: "another-client" },
    { iss: "https://untrusted.example" },
    { exp: 1 },
  ])("rejects an invalid signed ID token: %j", async (claims) => {
    expect((await signIn(makeAuth(), await idToken(claims))).status).toBe(401);
    expect(store.data.account).toHaveLength(0);
    expect(store.data.session).toHaveLength(0);
  });

  it("rejects a token with an invalid signature", async () => {
    expect((await signIn(makeAuth(), await idToken({}, true))).status).toBe(401);
    expect(store.data.account).toHaveLength(0);
    expect(store.data.session).toHaveLength(0);
  });
});

describe.each(["full", "browser"] as const)("Google provider token storage (%s)", (profile) => {
  const makeAuth = () => createAuth(env, db, profile);
  it("encrypts access and refresh tokens from the browser callback without exposing them in session/account listings", async () => {
    const auth = makeAuth();
    const cookie = await browserSignIn(auth);
    const account = store.data.account[0];
    expectEncrypted(account.accessToken, ACCESS_TOKEN);
    expectEncrypted(account.refreshToken, REFRESH_TOKEN);
    const response = await requestAccountToken(auth, "get-access-token", cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).accessToken).toBe(ACCESS_TOKEN);

    for (const route of ["get-session", "list-accounts"]) {
      const listing = await auth.handler(new Request(`${BASE}/api/auth/${route}`, { headers: { cookie } }));
      expect(listing.status).toBe(200);
      const body = await listing.text();
      for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, account.accessToken, account.refreshToken, account.idToken]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("encrypts access tokens supplied through ID-token sign-in", async () => {
    const auth = makeAuth();
    const response = await signIn(auth, await idToken(), ACCESS_TOKEN);
    expect(response.status).toBe(200);
    expectEncrypted(store.data.account[0].accessToken, ACCESS_TOKEN);
    const token = await requestAccountToken(auth, "get-access-token", cookieFrom(response));
    expect(token.status).toBe(200);
    expect((await token.json()).accessToken).toBe(ACCESS_TOKEN);
  });

  it.each(["get-access-token", "refresh-token"])("decrypts stored credentials when refreshing via %s", async (route) => {
    const auth = makeAuth();
    const cookie = await browserSignIn(auth);
    store.data.account[0].accessTokenExpiresAt = new Date(0);
    tokenResponse = {
      access_token: "rotated-access-token", refresh_token: "rotated-refresh-token",
      token_type: "Bearer", expires_in: 3600,
    };
    const response = await requestAccountToken(auth, route, cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).accessToken).toBe("rotated-access-token");
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[1].get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[1].get("refresh_token")).toBe(REFRESH_TOKEN);
    expectEncrypted(store.data.account[0].accessToken, "rotated-access-token");
    expectEncrypted(store.data.account[0].refreshToken, "rotated-refresh-token");
  });

  it("keeps existing plaintext credentials usable and encrypts their replacements", async () => {
    const auth = makeAuth();
    const cookie = cookieFrom(await signIn(auth, await idToken()));
    Object.assign(store.data.account[0], {
      accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    const response = await requestAccountToken(auth, "get-access-token", cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).accessToken).toBe(ACCESS_TOKEN);
    tokenResponse = {
      access_token: "replacement-access-token", refresh_token: "replacement-refresh-token",
      token_type: "Bearer", expires_in: 3600,
    };
    expect((await requestAccountToken(auth, "refresh-token", cookie)).status).toBe(200);
    expect(tokenRequests[0].get("refresh_token")).toBe(REFRESH_TOKEN);
    expectEncrypted(store.data.account[0].accessToken, "replacement-access-token");
    expectEncrypted(store.data.account[0].refreshToken, "replacement-refresh-token");
  });

  it("retains an encrypted refresh token when Google omits a replacement", async () => {
    const auth = makeAuth();
    const cookie = await browserSignIn(auth);
    const encryptedRefreshToken = store.data.account[0].refreshToken;
    expectEncrypted(encryptedRefreshToken, REFRESH_TOKEN);
    tokenResponse = { access_token: "replacement-access-token", token_type: "Bearer", expires_in: 3600 };
    const response = await requestAccountToken(auth, "refresh-token", cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).refreshToken).toBe(REFRESH_TOKEN);
    expect(store.data.account[0].refreshToken).toBe(encryptedRefreshToken);
    expectEncrypted(store.data.account[0].accessToken, "replacement-access-token");
  });

  it("encrypts credentials updated by a subsequent Google sign-in", async () => {
    const auth = makeAuth();
    expect((await signIn(auth, await idToken())).status).toBe(200);
    const accountId = store.data.account[0].id;
    Object.assign(store.data.account[0], { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    await browserSignIn(auth);
    expect(store.data.account).toHaveLength(1);
    expect(store.data.account[0].id).toBe(accountId);
    expectEncrypted(store.data.account[0].accessToken, ACCESS_TOKEN);
    expectEncrypted(store.data.account[0].refreshToken, REFRESH_TOKEN);
  });

  it.each([
    ["get-access-token", "accessToken", "FAILED_TO_GET_ACCESS_TOKEN"],
    ["refresh-token", "refreshToken", "FAILED_TO_REFRESH_ACCESS_TOKEN"],
  ])("rejects corrupted ciphertext via %s without sending it to Google", async (route, field, code) => {
    const auth = makeAuth();
    const cookie = await browserSignIn(auth);
    const encrypted = store.data.account[0][field] as string;
    store.data.account[0][field] = encrypted.slice(0, -2) + (encrypted.endsWith("00") ? "01" : "00");
    const response = await requestAccountToken(auth, route, cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(code);
    expect(tokenRequests).toHaveLength(1);
  });

  it.each(["get-access-token", "refresh-token"])("rejects anonymous, revoked and foreign-account requests to %s", async (route) => {
    const auth = makeAuth();
    const cookie = await browserSignIn(auth);
    const ownAccount = { ...store.data.account[0] };
    store.data.account.push({ ...ownAccount, id: "foreign-account", userId: "foreign-owner", accountId: "foreign-subject" });
    const foreign = await requestAccountToken(auth, route, cookie, "foreign-account", "foreign-owner");
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).code).toBe("ACCOUNT_NOT_FOUND");
    expect((await requestAccountToken(auth, route, "", ownAccount.id, USER_ID)).status).toBe(401);
    store.data.session = [];
    expect((await requestAccountToken(auth, route, cookie, ownAccount.id, USER_ID)).status).toBe(401);
    expect(store.data.account[0]).toEqual(ownAccount);
    expect(tokenRequests).toHaveLength(1);
  });
});
