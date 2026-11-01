import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { Hono } from "hono";
import { auth as authorizeMcpClient, extractWWWAuthenticateParams, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// Exercise the production Better Auth configuration and real HTTP endpoints.
// Persistence and mail delivery are replaced; credential verifiers are real.
vi.mock("../src/lib/mail", () => ({ sendMail: vi.fn() }));
const store = vi.hoisted(() => ({ data: {} }));
vi.mock("@better-auth/drizzle-adapter", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store.data) };
});
vi.mock("../src/db/pool", () => ({
  withDb: (_env: unknown, fn: (db: object) => unknown) => fn({}),
}));

import { createAuth } from "../src/lib/auth";
import { createApp } from "../src/app";
import type { AppEnv, Bindings } from "../src/types/bindings";
import type { Db } from "../src/db/pool";
import { requireAuth, sessionMethod } from "../src/middleware/auth";
import { onError } from "../src/middleware/error-handler";

const BASE = "https://auth-security.example";
const RESOURCE = `${BASE}/api/mcp`;
const USER_ID = "10000000-0000-4000-8000-000000000001";
const PASSWORD = "isolated-test-password-123";
const VERIFIER = "isolated-test-pkce-verifier-with-at-least-43-characters";
const SCOPES = ["offline_access", "videoq.read", "videoq.write"];
const OIDC_SCOPES = ["openid", "profile", "email", ...SCOPES];
type OAuthTestOptions = { includeResource?: boolean; scopes?: string[]; confidential?: boolean; registrationScope?: string };
let env = {
  ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: "isolated-test-secret-012345678901234567890123456789",
  BETTER_AUTH_URL: BASE,
  FRONTEND_URL: BASE,
  CORS_ALLOW_ORIGIN: BASE,
} as Bindings;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  // createAuth uses the environment identity as the JWKS cache key. Reset it
  // along with the database so each test sees its own newly generated keys.
  env = { ...env };
  store.data = Object.fromEntries([
    "user", "account", "session", "verification", "apikey", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken",
    "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ].map((model) => [model, []]));
  const now = new Date();
  store.data.user.push({
    id: USER_ID, email: "security@example.test", emailVerified: true,
    name: "Test user", username: "testuser", displayUsername: "testuser",
    role: "admin", isActive: true, banned: false,
    createdAt: now, updatedAt: now,
  });
  store.data.account.push({
    id: "test-account", userId: USER_ID, accountId: USER_ID,
    providerId: "credential", issuer: "local:credential",
    password: await hashPassword(PASSWORD), createdAt: now, updatedAt: now,
  });
});

function makeAuth() { return createAuth(env, {} as Db); }
type Auth = ReturnType<typeof makeAuth>;
async function post(auth: Auth, path: string, body: unknown, cookie = "", origin = BASE) {
  return auth.handler(new Request(`${BASE}/api/auth${path}`, {
    method: "POST", headers: {
      "content-type": "application/json", origin,
      "cf-connecting-ip": "192.0.2.1", ...(cookie ? { cookie } : {}),
    }, body: JSON.stringify(body),
  }));
}
async function login(auth: Auth) {
  const response = await post(auth, "/sign-in/username", { username: "testuser", password: PASSWORD });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}
async function register(auth: Auth, confidential = false, scope?: string) {
  const response = await post(auth, "/oauth2/register", {
    client_name: "Test client", application_type: "native",
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    redirect_uris: ["http://127.0.0.1:54321/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    ...(scope ? { scope } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json<{ client_id: string; client_secret?: string }>();
}
async function authorize(auth: Auth, cookie: string, clientId: string, options: OAuthTestOptions = {}) {
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: "http://127.0.0.1:54321/callback",
    response_type: "code", scope: (options.scopes ?? SCOPES).join(" "),
    ...(options.includeResource === false ? {} : { resource: RESOURCE }),
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256", state: "test-state",
  });
  const response = await auth.handler(new Request(`${BASE}/api/auth/oauth2/authorize?${query.toString()}`, {
    headers: { cookie, "cf-connecting-ip": "192.0.2.1" },
  }));
  expect(response.status, await response.clone().text()).toBe(302);
  let redirect = new URL(response.headers.get("location")!, BASE);
  if (redirect.pathname === "/consent") {
    const accepted = await post(auth, "/oauth2/consent", {
      accept: true, oauth_query: redirect.search.slice(1),
    }, cookie);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const result = await accepted.json<{ url: string }>();
    redirect = new URL(result.url);
  }
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}
async function tokenRequest(auth: Auth, clientId: string, params: Record<string, string>, includeResource = true) {
  return auth.handler(new Request(`${BASE}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.2" },
    body: new URLSearchParams({ client_id: clientId, ...(includeResource ? { resource: RESOURCE } : {}),
      ...(params.grant_type?.trim() === "authorization_code" ? { redirect_uri: "http://127.0.0.1:54321/callback" } : {}), ...params }),
  }));
}
async function tokensFrom(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json<{ access_token: string; refresh_token: string; id_token?: string; expires_in: number }>();
}
async function connect(auth: Auth, cookie: string, options: OAuthTestOptions = {}) {
  const client = await register(auth, options.confidential, options.registrationScope);
  const code = await authorize(auth, cookie, client.client_id, options);
  const grantId = store.data.oauthConsent.find((row) => row.clientId === client.client_id)!.id as string;
  const tokens = await tokensFrom(await tokenRequest(auth, client.client_id, {
    grant_type: "authorization_code", code, code_verifier: VERIFIER,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  }, options.includeResource));
  return { clientId: client.client_id, clientSecret: client.client_secret, grantId, ...tokens };
}

async function userInfo(auth: Auth, token: string, method: "GET" | "POST" = "GET") {
  return auth.handler(new Request(`${BASE}/api/auth/oauth2/userinfo`, method === "GET" ? {
    headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "192.0.2.3" },
  } : {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.3" },
    body: new URLSearchParams({ access_token: token }),
  }));
}

async function introspect(auth: Auth, linked: Awaited<ReturnType<typeof connect>>, token: string, hint: string, secret = linked.clientSecret) {
  return auth.handler(new Request(`${BASE}/api/auth/oauth2/introspect`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "192.0.2.4" },
    body: new URLSearchParams({ client_id: linked.clientId, client_secret: secret ?? "", token, token_type_hint: hint }),
  }));
}

describe("MCP OAuth permission negotiation", () => {
  it.each([
    ["missing", undefined],
    ["malformed", "invalid-token"],
    ["invalid signature", "eyJhbGciOiJFZERTQSIsImtpZCI6InVua25vd24ifQ.e30.c2lnbmF0dXJl"],
  ])("lets the official MCP client obtain read/write permissions after %s credentials", async (_credentials, token) => {
    const app = createApp();
    const challenge = await app.request(RESOURCE, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, env);
    expect(challenge.status).toBe(401);
    const saveClient = vi.fn<(value: OAuthClientInformationMixed) => void>();
    const saveTokens = vi.fn<(value: OAuthTokens) => void>();
    const saveVerifier = vi.fn<(value: string) => void>();
    const redirect = vi.fn<(url: URL) => void>();
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:54321/callback",
      clientMetadata: {
        client_name: "MCP SDK test", application_type: "native",
        redirect_uris: ["http://127.0.0.1:54321/callback"],
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      clientInformation: () => saveClient.mock.lastCall?.[0],
      saveClientInformation: saveClient,
      tokens: () => saveTokens.mock.lastCall?.[0],
      saveTokens,
      redirectToAuthorization: redirect,
      saveCodeVerifier: saveVerifier,
      codeVerifier: () => saveVerifier.mock.lastCall![0],
    };
    const options = {
      serverUrl: RESOURCE,
      ...extractWWWAuthenticateParams(challenge),
      fetchFn: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        // Never let this integration test use a real external OAuth server.
        expect(new URL(request.url).origin).toBe(BASE);
        return app.fetch(request, env);
      },
    };
    expect(await authorizeMcpClient(provider, options)).toBe("REDIRECT");
    const authorizationUrl = redirect.mock.lastCall![0];
    expect(authorizationUrl.searchParams.get("scope")).toBe("videoq.read videoq.write");
    const auth = makeAuth();
    const cookie = await login(auth);
    const authorization = await auth.handler(new Request(authorizationUrl, { headers: { cookie } }));
    expect(authorization.status).toBe(302);
    const consentUrl = new URL(authorization.headers.get("location")!, BASE);
    expect(consentUrl.pathname).toBe("/consent");
    expect(consentUrl.searchParams.get("scope")).toBe("videoq.read videoq.write");
    const consent = await post(auth, "/oauth2/consent", {
      accept: true, oauth_query: consentUrl.search.slice(1),
    }, cookie);
    expect(consent.status).toBe(200);
    const authorizationCode = new URL((await consent.json<{ url: string }>()).url).searchParams.get("code")!;
    expect(await authorizeMcpClient(provider, { ...options, authorizationCode })).toBe("AUTHORIZED");
    const accessToken = saveTokens.mock.lastCall![0].access_token;
    expect(await auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${accessToken}`, method: "POST", url: RESOURCE,
    } })).toMatchObject({ kind: "ok", accessLevel: "all" });
  });

  it("upgrades a read-only DCR request through native consent without re-registering the client", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie, { scopes: ["videoq.read"], registrationScope: "videoq.read" });
    expect(store.data.oauthClient).toHaveLength(1);
    expect(store.data.oauthClient[0].scopes).toContain("videoq.write");
    expect(store.data.oauthConsent[0].scopes).toEqual(["videoq.read"]);
    const challenge = await createApp().request(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${linked.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "create_course", arguments: { name: "Physics", idempotency_key: "course-write-scope-test" },
      } }),
    }, env);
    expect(challenge.status).toBe(403);
    const { scope, error } = extractWWWAuthenticateParams(challenge);
    expect(error).toBe("insufficient_scope");
    expect(scope).toBe("videoq.read videoq.write");
    const code = await authorize(auth, cookie, linked.clientId, { scopes: scope!.split(" ") });
    const upgraded = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "authorization_code", code, code_verifier: VERIFIER,
    }));
    expect(await auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${upgraded.access_token}`, method: "POST", url: RESOURCE,
    } })).toMatchObject({ kind: "ok", accessLevel: "all" });
    expect(store.data.oauthClient).toHaveLength(1);
    // A challenge never elevates the old token without explicit consent.
    expect(await auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${linked.access_token}`, method: "POST", url: RESOURCE,
    } })).toMatchObject({ kind: "ok", accessLevel: "read_only" });
  });
});

describe("account suspension across Better Auth endpoints", () => {
  it.each(["/admin/set-role", "/admin/update-user"].flatMap(path => [
    { path, userId: USER_ID }, { path, userId: [USER_ID] },
  ]))("prevents self-demotion through $path with userId=$userId", async ({ path, userId }) => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const body = path === "/admin/set-role"
      ? { userId, role: "user" }
      : { userId, data: { role: "user" } };
    expect((await post(auth, path, body, cookie)).status).toBe(400);
    expect(store.data.user[0].role).toBe("admin");
  });

  it("enforces the role policy for server-only administrator creation", async () => {
    await expect(makeAuth().api.createUser({ body: {
      name: "Other", email: "other@example.test", role: "staff", data: { username: "other" },
    } })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.data.user).toHaveLength(1);
  });

  it.each(["/admin/set-role", "/admin/update-user"])("allows promotion and demotion of another user through %s", async (path) => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const other = { ...store.data.user[0], id: "other", username: "other", email: "other@example.test", role: "user" };
    store.data.user.push(other);
    for (const role of ["admin", "user"]) {
      const body = path === "/admin/set-role" ? { userId: other.id, role } : { userId: other.id, data: { role } };
      expect((await post(auth, path, body, cookie)).status).toBe(200);
      expect(store.data.user.find(user => user.id === other.id)?.role).toBe(role);
    }
  });

  it.each(["staff", "unknown", "user,admin", ["user", "admin"], []].map(role => ({ role })))("rejects roles outside the two account types (%j)", async ({ role }) => {
    const auth = makeAuth();
    const cookie = await login(auth);
    for (const [path, body] of [
      ["/admin/set-role", { userId: USER_ID, role }],
      ["/admin/update-user", { userId: USER_ID, data: { role } }],
      ["/admin/create-user", { name: "Other", email: "other@example.test", role }],
      ["/admin/create-user", { name: "Other", email: "other@example.test", data: { role } }],
    ] as const) {
      expect((await post(auth, path, body, cookie)).status).toBe(400);
    }
    expect(store.data.user).toHaveLength(1);
    expect(store.data.user[0].role).toBe("admin");
  });

  it("uses native signup field protection and the Admin plugin's default role", async () => {
    const auth = makeAuth();
    const body = {
      email: "signup@example.test", username: "newsignup", name: "New signup", password: PASSWORD,
    };
    expect((await post(auth, "/sign-up/email", { ...body, role: "admin" })).status).toBe(400);
    const response = await post(auth, "/sign-up/email", { ...body, banned: true, isSuperuser: true, isActive: false });
    expect(response.status, await response.clone().text()).toBe(200);
    const user = store.data.user.find((row) => row.email === "signup@example.test");
    expect(user).toMatchObject({ role: "user", banned: false });
  });

  it("uses native bans immediately and lets unbanned users resume valid integrations", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    const key = await auth.api.createApiKey({ body: { userId: USER_ID } });
    const adminId = "10000000-0000-4000-8000-000000000002";
    store.data.user.push({ ...store.data.user[0], id: adminId, username: "otheradmin", email: "admin@example.test" });
    store.data.account.push({ ...store.data.account[0], id: "other-admin-account", userId: adminId, accountId: adminId });
    const adminLogin = await post(auth, "/sign-in/username", { username: "otheradmin", password: PASSWORD });
    expect(adminLogin.status).toBe(200);
    const adminCookie = adminLogin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const headers = new Headers({ cookie: adminCookie });

    await auth.api.banUser({ body: { userId: USER_ID }, headers });
    expect(store.data.user[0].banned).toBe(true);
    expect(store.data.session.some((row) => row.userId === USER_ID)).toBe(false);
    expect(store.data.oauthConsent).toHaveLength(1);
    expect((await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    })).status).toBe(400);
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("invalid");
    expect((await auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${linked.access_token}`, method: "POST", url: RESOURCE,
    } })).kind).toBe("invalid");

    await auth.api.unbanUser({ body: { userId: USER_ID }, headers });
    expect(store.data.user[0].banned).toBe(false);
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("ok");
    await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    }));
    expect((await auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${linked.access_token}`, method: "POST", url: RESOURCE,
    } })).kind).toBe("ok");

    await auth.api.setRole({ body: { userId: USER_ID, role: "user" }, headers });
    const downgradedCookie = await login(auth);
    expect((await post(auth, "/admin/unban-user", { userId: adminId }, downgradedCookie)).status).toBe(403);
  });

  it("honors the official temporary-ban expiry for sessions and API keys", async () => {
    const auth = makeAuth();
    const key = await auth.api.createApiKey({ body: { userId: USER_ID } });
    store.data.user[0].banned = true;
    store.data.user[0].banExpires = new Date(Date.now() - 60_000);
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("ok");
    await login(auth);
    expect(store.data.user[0].banned).toBe(false);
  });

  it.each(["active", "banned", "revoked"])("maps a real %s session to the application API's auth result", async (state) => {
    const cookie = await login(makeAuth());
    if (state === "banned") store.data.user[0].banned = true;
    if (state === "revoked") store.data.session = [];
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.get("/private", requireAuth(sessionMethod), (c) => c.json({ userId: c.var.userId }));
    const response = await app.request(`${BASE}/private`, { headers: { cookie } }, env);
    expect(response.status).toBe(state === "active" ? 200 : 401);
    expect(await response.json()).toMatchObject(state === "active"
      ? { userId: USER_ID }
      : { error: { code: "UNAUTHORIZED" } });
  });

  it.each(["/sign-in/username", "/sign-in/email"])("rejects new sessions for inactive users at %s", async (path) => {
    store.data.user[0].banned = true;
    const response = await post(makeAuth(), path, {
      username: "testuser", email: "security@example.test", password: PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(store.data.session).toHaveLength(0);
  });

  it.each(["active", "banned", "revoked"])("reads a %s browser session without reseeding OAuth resources", async (state) => {
    const cookie = await login(makeAuth());
    store.data.oauthResource = [];
    if (state === "banned") store.data.user[0].banned = true;
    if (state === "revoked") store.data.session = [];
    const response = await createApp().request(`${BASE}/api/auth/get-session`, { headers: { cookie } }, env);
    expect(response.status).toBe(state === "banned" ? 403 : 200);
    const body = await response.json();
    if (state === "active") expect(body).toMatchObject({ user: { id: USER_ID } });
    if (state === "revoked") expect(body).toBeNull();
    if (state === "banned") expect(body).toMatchObject({ code: "USER_INACTIVE" });
    expect(store.data.oauthResource).toEqual([]);
  });

  it("blocks self-reactivation and key creation even if a session survived suspension", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    store.data.user[0].banned = true;
    expect((await post(auth, "/admin/update-user", { userId: USER_ID, data: { banned: false } }, cookie)).status).toBe(403);
    expect((await post(auth, "/api-key/create", { name: "test", metadata: { accessLevel: "all" } }, cookie)).status).toBe(403);
    expect(store.data.user[0].banned).toBe(true);
    expect(store.data.apikey).toHaveLength(0);
    expect((await post(auth, "/sign-out", {}, cookie)).status).toBe(200);
  });

  it("rejects banned users and still allows an active administrator", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    expect((await post(auth, "/admin/update-user", { userId: USER_ID, data: { name: "Updated" } }, cookie)).status).toBe(200);
    store.data.user[0].banned = true;
    expect((await post(auth, "/admin/update-user", { userId: USER_ID, data: { banned: false } }, cookie)).status).toBe(403);
  });

  it("does not authorize an ordinary user or a revoked session", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    store.data.user[0].role = "user";
    expect((await post(auth, "/admin/update-user", { userId: USER_ID, data: { role: "admin" } }, cookie)).status).toBe(403);
    store.data.session = [];
    expect((await post(auth, "/api-key/create", { name: "test" }, cookie)).status).toBe(401);
  });
});

describe("API key credential boundaries", () => {
  async function createKey(auth: Auth, cookie: string, accessLevel = "read_only") {
    const response = await post(auth, "/api-key/create", {
      name: "test-key", configId: accessLevel === "all" ? "read-write" : "default",
    }, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json<{ id: string; key: string }>();
  }

  it.each(["active", "banned", "missing"])("applies %s account policy through the server-only extension", async (status) => {
    const auth = makeAuth();
    const key = await createKey(auth, await login(auth));
    if (status === "banned") store.data.user[0].banned = true;
    if (status === "missing") store.data.user = [];
    const result = await auth.api.verifyVideoqApiKey({ body: { key: key.key } });
    expect(result.kind).toBe(status === "active" ? "ok" : "invalid");
  });

  it.each(["read_only", "all"])("creates and enforces the official %s permission profile", async (accessLevel) => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const key = await createKey(auth, cookie, accessLevel);
    expect(await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).toMatchObject({
      kind: "ok", userId: USER_ID, accessLevel,
    });
    expect((await auth.api.verifyApiKey({ body: { key: key.key, permissions: { videoq: ["write"] } } })).valid)
      .toBe(accessLevel === "all");
    const configId = accessLevel === "all" ? "read-write" : "default";
    const listed = await auth.api.listApiKeys({ headers: new Headers({ cookie }) });
    expect(listed.apiKeys).toEqual([expect.objectContaining({ id: key.id, configId })]);
    expect((await post(auth, "/api-key/delete", { keyId: key.id, configId }, cookie)).status).toBe(200);
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("invalid");
  });

  it("uses native permissions even when legacy metadata disagrees", async () => {
    const auth = makeAuth();
    const key = await createKey(auth, await login(auth));
    store.data.apikey[0].metadata = { accessLevel: "all" };
    expect(await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).toMatchObject({
      kind: "ok", accessLevel: "read_only",
    });
    store.data.apikey[0].permissions = JSON.stringify({ videoq: [] });
    expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("invalid");
  });

  it("rejects missing/corrupt native permissions instead of falling back to metadata", async () => {
    const auth = makeAuth();
    const key = await createKey(auth, await login(auth));
    for (const permissions of [null, "invalid-json", "{}", '{"videoq":["write"]}']) {
      store.data.apikey[0].permissions = permissions;
      expect((await auth.api.verifyVideoqApiKey({ body: { key: key.key } })).kind).toBe("invalid");
    }
  });

  it("does not let client-side permission or metadata injection change the selected profile", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    expect((await post(auth, "/api-key/create", {
      name: "injected", permissions: { videoq: ["read", "write"] },
    }, cookie)).status).toBe(400);
    expect((await post(auth, "/api-key/create", {
      name: "injected", metadata: { accessLevel: "all" },
    }, cookie)).status).toBe(400);
    expect(store.data.apikey).toHaveLength(0);
  });

  it("does not expose resource verification as a public auth endpoint", async () => {
    const auth = makeAuth();
    for (const path of ["/verify-videoq-api-key", "/verify-videoq-oauth"]) {
      expect((await post(auth, path, {})).status).toBe(404);
    }
  });

  it.each(["read_only", "all"])("does not turn a %s key into an account-management session", async (accessLevel) => {
    const auth = makeAuth();
    const key = await createKey(auth, await login(auth), accessLevel);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(true);
    const headers = { origin: BASE, "x-api-key": key.key };

    const session = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }));
    expect(await session.json()).toBeNull();
    const list = await auth.handler(new Request(`${BASE}/api/auth/api-key/list`, { headers }));
    expect(list.status).toBe(401);
    for (const procedure of ["integrationApiKeys", "connectedApps"]) {
      const response = await createApp().request(`${BASE}/api/trpc/account.${procedure}`, { headers }, env);
      expect(response.status).toBe(401);
    }

    for (const [path, body] of [
      ["/api-key/create", { name: "injected", userId: USER_ID, metadata: { accessLevel: "all" } }],
      ["/api-key/update", { keyId: key.id, userId: USER_ID, metadata: { accessLevel: "all" } }],
      ["/api-key/delete", { keyId: key.id }],
      ["/update-user", { name: "Changed through API key" }],
    ] as const) {
      const response = await auth.handler(new Request(`${BASE}/api/auth${path}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status, path).toBe(401);
    }
    expect(store.data.apikey).toHaveLength(1);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).key?.permissions)
      .toEqual({ videoq: accessLevel === "all" ? ["read", "write"] : ["read"] });
    expect(store.data.user[0].name).toBe("Test user");
  });

  it("immediately rejects disabled and deleted keys", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const key = await createKey(auth, cookie);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(true);

    expect((await post(auth, "/api-key/update", { keyId: key.id, enabled: false }, cookie)).status).toBe(200);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(false);
    expect((await post(auth, "/api-key/update", { keyId: key.id, enabled: true }, cookie)).status).toBe(200);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(true);
    expect((await post(auth, "/api-key/delete", { keyId: key.id }, cookie)).status).toBe(200);
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(false);
  });
});

describe("OAuth grant revocation", () => {
  it.each([Error, TypeError])("does not report a JWKS database outage as invalid credentials (%s)", async (ErrorType) => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth));
    const jwt = (await auth.$context).getPlugin("jwt")!;
    const unavailable = new ErrorType("JWKS database unavailable");
    vi.spyOn(jwt.endpoints, "getJwks").mockRejectedValueOnce(unavailable);
    // Better Auth normalizes source TypeErrors to avoid exposing runtime
    // details, but the outage must still reject rather than deny credentials.
    await expect(auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${linked.access_token}`, method: "POST", url: RESOURCE,
    } })).rejects.toThrow(ErrorType === TypeError ? "JWKS fetch failed" : unavailable);
  });

  it("issues standard five-minute JWTs and refresh tokens without private consent identifiers", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth));
    const payload = await verifyJwsAccessToken(linked.access_token, {
      jwksFetch: () => auth.api.getJwks(), verifyOptions: { issuer: `${BASE}/api/auth`, audience: RESOURCE },
    });
    expect(payload.videoq_grant).toBeUndefined();
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(linked.expires_in).toBe(300);
    expect(store.data.oauthRefreshToken[0].referenceId).toBeFalsy();
    const refreshed = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    }));
    expect(decodeJwt(refreshed.access_token).videoq_grant).toBeUndefined();
    expect(store.data.oauthRefreshToken.every((row) => !row.referenceId)).toBe(true);
  });

  it("lets an issued JWT expire within five minutes of disconnect while refusing renewal", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(200);
    const verify = () => auth.api.verifyVideoqOAuth({ body: {
      authorizationHeader: `Bearer ${linked.access_token}`, method: "POST", url: RESOURCE,
    } });
    expect(await verify()).toMatchObject({ kind: "ok" });
    expect((await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    })).status).toBe(400);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date((decodeJwt(linked.access_token).exp! + 1) * 1000));
    expect(await verify()).toMatchObject({ kind: "invalid" });
  });

  it("disconnects only the selected app and rejects refresh and cached rotation replay", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    const other = await connect(auth, cookie);
    const refreshed = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    }));
    const response = await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(store.data.oauthConsent.map((row) => row.id)).toEqual([other.grantId]);
    expect(store.data.oauthRefreshToken.every((row) => row.clientId === other.clientId)).toBe(true);
    for (const refresh_token of [linked.refresh_token, refreshed.refresh_token]) {
      const rejected = await tokenRequest(auth, linked.clientId, { grant_type: "refresh_token", refresh_token });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
    }
    await tokensFrom(await tokenRequest(auth, other.clientId, {
      grant_type: "refresh_token", refresh_token: other.refresh_token,
    }));
  });

  it("accepts a still-valid pending code after explicit re-consent, without resurrecting deleted refresh tokens", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    const oldCode = await authorize(auth, cookie, linked.clientId);
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(200);
    await authorize(auth, cookie, linked.clientId);
    const tokens = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "authorization_code", code: oldCode, code_verifier: VERIFIER,
    }));
    expect(decodeJwt(tokens.access_token).videoq_grant).toBeUndefined();
    expect((await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    })).status).toBe(400);
  });

  it("rejects an in-flight refresh left behind after disconnect until consent is granted again", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    const oldRows = structuredClone(store.data.oauthRefreshToken);
    await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie);
    // Simulate a rotation persisting after disconnect deleted the original rows.
    store.data.oauthRefreshToken.push(...oldRows);
    const refresh = { grant_type: "refresh_token", refresh_token: linked.refresh_token };
    const rejected = await tokenRequest(auth, linked.clientId, refresh);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
    const narrowed = ["offline_access", "videoq.read"];
    await authorize(auth, cookie, linked.clientId, { scopes: narrowed });
    expect((await tokenRequest(auth, linked.clientId, refresh)).status).toBe(400);
    const tokens = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      ...refresh, scope: narrowed.join(" "),
    }));
    expect(decodeJwt(tokens.access_token).scope).toBe(narrowed.join(" "));
  });

  it("rejects refresh for banned credentials before persisting new tokens", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth));
    store.data.user[0].banned = true;
    const before = structuredClone(store.data.oauthRefreshToken);
    const response = await tokenRequest(auth, linked.clientId, { grant_type: "refresh_token", refresh_token: linked.refresh_token });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthRefreshToken).toEqual(before);
  });

  it("checks ownership, authentication and CSRF before deleting anything", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie);
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId })).status).toBe(401);
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie, "https://evil.example")).status).toBe(403);
    store.data.oauthConsent[0].userId = "different-user";
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(404);
    expect(store.data.oauthRefreshToken).toHaveLength(1);
    expect(store.data.oauthConsent).toHaveLength(1);
  });
});

describe.each([
  { name: "JWT", includeResource: true },
  { name: "opaque", includeResource: false },
])("OAuth policy for $name access tokens", ({ includeResource }) => {
  it("checks current consent scopes after native PKCE validation and before storing any tokens", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const client = await register(auth);
    const code = await authorize(auth, cookie, client.client_id, { includeResource, scopes: OIDC_SCOPES });
    store.data.oauthConsent[0].scopes = OIDC_SCOPES.filter((scope) => scope !== "videoq.write");
    const response = await tokenRequest(auth, client.client_id, {
      grant_type: "authorization_code", code, code_verifier: VERIFIER,
    }, includeResource);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthAccessToken).toHaveLength(0);
    expect(store.data.oauthRefreshToken).toHaveLength(0);
  });

  it("uses Better Auth's refresh-token rotation and reuse detection", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth), { includeResource, scopes: OIDC_SCOPES });
    const params = { grant_type: "refresh_token", refresh_token: linked.refresh_token };
    const rotated = await tokensFrom(await tokenRequest(auth, linked.clientId, params, includeResource));
    const response = await tokenRequest(auth, linked.clientId, params, includeResource);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    const family = await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: rotated.refresh_token,
    }, includeResource);
    expect(family.status).toBe(400);
    expect(await family.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("supports OIDC code exchange, refresh and both UserInfo transports", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth), { includeResource, scopes: OIDC_SCOPES });
    expect(linked.id_token).toBeTruthy();
    expect(linked.expires_in).toBe(300);
    expect(linked.access_token.includes(".")).toBe(includeResource);
    for (const method of ["GET", "POST"] as const) {
      const response = await userInfo(auth, linked.access_token, method);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ sub: USER_ID, email: "security@example.test" });
    }
    const refreshed = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    }, includeResource));
    expect(refreshed.id_token).toBeTruthy();
    expect((await userInfo(auth, refreshed.access_token)).status).toBe(200);
  });

  it("uses native UserInfo revocation: stored opaque tokens are deleted, JWTs expire", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const options = { includeResource, scopes: OIDC_SCOPES };
    const linked = await connect(auth, cookie, options);
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(200);
    for (const method of ["GET", "POST"] as const) {
      const response = await userInfo(auth, linked.access_token, method);
      expect(response.status).toBe(includeResource ? 200 : 401);
      if (!includeResource) {
        expect(await response.json()).toMatchObject({ error: "invalid_token" });
        expect(response.headers.get("www-authenticate")).toContain("invalid_token");
      }
    }
    const code = await authorize(auth, cookie, linked.clientId, options);
    const reconnected = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "authorization_code", code, code_verifier: VERIFIER,
    }, includeResource));
    expect((await userInfo(auth, linked.access_token)).status).toBe(includeResource ? 200 : 401);
    expect((await userInfo(auth, reconnected.access_token)).status).toBe(200);
    if (includeResource) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date((decodeJwt(linked.access_token).exp! + 1) * 1000));
      expect((await userInfo(auth, linked.access_token)).status).toBe(401);
    }
  });

  it("rejects UserInfo for a banned owner even when its browser session still exists", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth), { includeResource, scopes: OIDC_SCOPES });
    store.data.user[0].banned = true;
    expect((await userInfo(auth, linked.access_token)).status).toBe(401);
  });

  it("applies reduced consent scopes on renewal while preserving issued-token expiry", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth), { includeResource, scopes: OIDC_SCOPES });
    const narrowed = OIDC_SCOPES.filter((scope) => scope !== "videoq.write");
    store.data.oauthConsent[0].scopes = narrowed;
    expect((await userInfo(auth, linked.access_token)).status).toBe(200);
    const rejected = await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token,
    }, includeResource);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
    const refreshed = await tokensFrom(await tokenRequest(auth, linked.clientId, {
      grant_type: "refresh_token", refresh_token: linked.refresh_token, scope: narrowed.join(" "),
    }, includeResource));
    expect(refreshed.expires_in).toBe(300);
    if (includeResource) {
      expect(await auth.api.verifyVideoqOAuth({ body: {
        authorizationHeader: `Bearer ${refreshed.access_token}`, method: "POST", url: RESOURCE,
      } })).toMatchObject({ kind: "ok", accessLevel: "read_only" });
    }
  });

  it("uses native introspection after disconnect: JWTs expire, stored tokens become inactive", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie, { includeResource, scopes: OIDC_SCOPES, confidential: true });
    for (const [token, hint] of [[linked.access_token, "access_token"], [linked.refresh_token, "refresh_token"]]) {
      const response = await introspect(auth, linked, token, hint);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ active: true, sub: USER_ID });
      const unauthorized = await introspect(auth, linked, token, hint, "incorrect-secret");
      expect(unauthorized.status).toBe(400);
      expect(await unauthorized.json()).toMatchObject({ error: "invalid_client" });
    }
    expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(200);
    for (const [token, hint] of [[linked.access_token, "access_token"], [linked.refresh_token, "refresh_token"]]) {
      const response = await introspect(auth, linked, token, hint);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ active: includeResource && hint === "access_token" });
    }
  });

  it("reports suspended user credentials as inactive at introspection", async () => {
    const auth = makeAuth();
    const linked = await connect(auth, await login(auth), { includeResource, confidential: true });
    store.data.user[0].banned = true;
    for (const [token, hint] of [[linked.access_token, "access_token"], [linked.refresh_token, "refresh_token"]]) {
      const response = await introspect(auth, linked, token, hint);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ active: false });
    }
  });
});

describe.each([
  { name: "OAuth", scopes: SCOPES },
  { name: "OIDC", scopes: OIDC_SCOPES },
])("$name token issuance without resource", ({ scopes }) => {
  it("rejects an old authorization code after disconnect and reconnect before persisting credentials", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const client = await register(auth);
    const options = { includeResource: false, scopes };
    const code = await authorize(auth, cookie, client.client_id, options);
    const grantId = store.data.oauthConsent[0].id;
    expect((await post(auth, "/oauth2/delete-consent", { id: grantId }, cookie)).status).toBe(200);
    const revoked = await tokenRequest(auth, client.client_id, {
      grant_type: "authorization_code", code, code_verifier: VERIFIER,
    }, false);
    expect(revoked.status).toBe(400);
    expect(await revoked.json()).toMatchObject({ error: "invalid_grant" });
    await authorize(auth, cookie, client.client_id, options);
    const response = await tokenRequest(auth, client.client_id, {
      grant_type: " authorization_code ", code, code_verifier: VERIFIER,
    }, false);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthRefreshToken).toHaveLength(0);
    expect(store.data.oauthAccessToken).toHaveLength(0);
  });

  it.each(["inactive", "banned", "consent removed"])("rejects refresh for %s credentials before rotation", async (reason) => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const linked = await connect(auth, cookie, { includeResource: false, scopes });
    if (reason === "inactive") {
      store.data.user[0].banned = true;
      store.data.session = [];
    }
    if (reason === "banned") store.data.user[0].banned = true;
    if (reason === "consent removed") {
      const oldRows = structuredClone(store.data.oauthRefreshToken);
      expect((await post(auth, "/oauth2/delete-consent", { id: linked.grantId }, cookie)).status).toBe(200);
      store.data.oauthRefreshToken.push(...oldRows);
    }
    const accessBefore = structuredClone(store.data.oauthAccessToken);
    const refreshBefore = structuredClone(store.data.oauthRefreshToken);
    const response = await tokenRequest(auth, linked.clientId, {
      grant_type: reason === "inactive" ? " refresh_token " : "refresh_token", refresh_token: linked.refresh_token,
    }, false);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthAccessToken).toEqual(accessBefore);
    expect(store.data.oauthRefreshToken).toEqual(refreshBefore);
  });
});

describe("provider protocol checks remain authoritative", () => {
  it("preserves authorization-code replay detection and revocation of issued credentials", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const client = await register(auth);
    const code = await authorize(auth, cookie, client.client_id, { includeResource: false });
    const params = { grant_type: " authorization_code ", code, code_verifier: VERIFIER };
    const tokens = await tokensFrom(await tokenRequest(auth, client.client_id, params, false));
    expect(store.data.oauthAccessToken).toHaveLength(1);
    expect(store.data.oauthRefreshToken).toHaveLength(1);
    const replay = await tokenRequest(auth, client.client_id, params, false);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthAccessToken).toHaveLength(0);
    expect(store.data.oauthRefreshToken).toHaveLength(0);
    expect((await tokenRequest(auth, client.client_id, {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    }, false)).status).toBe(400);
  });

  it("still verifies PKCE before issuing credentials", async () => {
    const auth = makeAuth();
    const cookie = await login(auth);
    const client = await register(auth);
    const code = await authorize(auth, cookie, client.client_id, { includeResource: false });
    const response = await tokenRequest(auth, client.client_id, {
      grant_type: "authorization_code", code,
      code_verifier: "incorrect-pkce-verifier-with-at-least-43-characters",
    }, false);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(store.data.oauthAccessToken).toHaveLength(0);
    expect(store.data.oauthRefreshToken).toHaveLength(0);
  });
});
