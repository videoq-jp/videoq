import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const store = vi.hoisted(() => ({ data: {} }));
vi.mock("@better-auth/drizzle-adapter", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store.data) };
});

import { createAuth } from "../src/lib/auth";
import type { Bindings } from "../src/types/bindings";
import type { Db } from "../src/db/pool";

const BASE = "https://auth-logging.example";
const makeAuth = () => createAuth({
  ENVIRONMENT: "production", BETTER_AUTH_URL: BASE, FRONTEND_URL: BASE, CORS_ALLOW_ORIGIN: BASE,
  BETTER_AUTH_SECRET: "isolated-auth-logging-secret-012345678901234567890123",
  GOOGLE_CLIENT_ID: "isolated-client", GOOGLE_CLIENT_SECRET: "isolated-client-secret",
} as Bindings, {} as Db);

beforeEach(() => {
  store.data = Object.fromEntries([
    "user", "account", "session", "verification", "apikey", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken",
    "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ].map((model) => [model, []]));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected outbound request"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const recordedLogs = () => inspect([
  vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.log).mock.calls,
], { depth: null });

describe("production auth library logging", () => {
  it("rejects a callback with a missing state cookie without logging its valid state", async () => {
    const auth = makeAuth();
    const start = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST", headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: `${BASE}/settings` }),
    }));
    expect(start.status).toBe(200);
    const state = new URL((await start.json()).url).searchParams.get("state")!;
    expect(state).toBeTruthy();
    const response = await auth.handler(new Request(
      `${BASE}/api/auth/callback/google?code=isolated-code&state=${state}`,
    ));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("state_mismatch");
    expect(console.error).toHaveBeenCalled();
    expect(recordedLogs()).not.toContain(state);
    expect(store.data.session).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps DB diagnostics without logging SQL, parameters, nested errors or stack messages", async () => {
    const auth = makeAuth();
    const context = await auth.$context;
    const sensitive = "CANARY_DB_CREDENTIAL";
    const cause = Object.assign(new Error(`database error ${sensitive}`), {
      code: "23505", constraint: "verification_identifier_key",
      detail: `Key (identifier)=(${sensitive}) already exists.`,
    });
    const error = Object.assign(new Error(`Failed query: SELECT '${sensitive}'`), {
      name: "DrizzleQueryError", cause, params: [sensitive],
    });
    vi.spyOn(context.internalAdapter, "findVerificationValue").mockRejectedValueOnce(error);
    const response = await auth.handler(new Request(
      `${BASE}/api/auth/callback/google?code=isolated-code&state=isolated-state`,
    ));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("internal_server_error");
    expect(console.error).toHaveBeenCalled();
    expect(recordedLogs()).not.toContain(sensitive);
    expect(recordedLogs()).toContain("23505");
    expect(recordedLogs()).toContain("verification_identifier_key");
  });

  it("does not log callback parameters supplied as an error string", async () => {
    const response = await makeAuth().handler(new Request(
      `${BASE}/api/auth/callback/google?error=CANARY_PROVIDER_RESPONSE`,
    ));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("state_not_found");
    expect(console.error).toHaveBeenCalled();
    expect(recordedLogs()).not.toContain("CANARY_PROVIDER_RESPONSE");
  });

  it("rejects an untrusted redirect without logging the URL embedded in the library message", async () => {
    const response = await makeAuth().handler(new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST", headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google", callbackURL: "https://untrusted.example/CANARY_REDIRECT?token=private-value",
      }),
    }));
    expect(response.status).toBe(403);
    expect(console.error).toHaveBeenCalled();
    expect(recordedLogs()).not.toContain("CANARY_REDIRECT");
    expect(recordedLogs()).not.toContain("private-value");
    expect(store.data.verification).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves warning severity and omits arbitrary metadata", async () => {
    const context = await makeAuth().$context;
    context.logger.warn("Invalid password", {
      email: "CANARY_EMAIL@example.test", password: "CANARY_PASSWORD", body: { code: "CANARY_CODE" },
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toEqual({
      level: "warn", event: "better_auth_library_log", message: "Invalid password", errors: [],
    });
    expect(recordedLogs()).not.toContain("CANARY_");
  });
});
