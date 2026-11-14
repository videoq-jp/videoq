import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { inspect } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { withAuth } from "../../../src/persistence/auth";
import { createMemoryRateLimitBackend } from "../../../src/lib/rate-limit";
import type { Bindings } from "../../../src/types/bindings";

export type GrantFailureStage = "oauth_refresh_token" | "oauth_consent";
export type OAuthGrantFixture = {
  env: Bindings;
  encodeArray(value: string[]): unknown;
  execute(sql: string, args?: unknown[]): Promise<void>;
  snapshot(): Promise<unknown>;
  failDeletion(table: GrantFailureStage): Promise<void>;
  clearFailure(table: GrantFailureStage): Promise<void>;
  dispose(): Promise<void>;
};
const base = "https://oauth-grant-contract.example";
const password = "Synthetic-grant-password-123456";
let passwordHash: Promise<string> | undefined;

/** Identical HTTP contract: real login, sensitive-session middleware, configured
 * auth adapter, real DB constraints and injected failures at late delete stages. */
export function oauthGrantContract(name: string, setup: () => Promise<OAuthGrantFixture>) {
  describe(`${name}: atomic OAuth app disconnect`, () => {
    let f: OAuthGrantFixture;
    let cookies: Record<string, string>;
    let errorLog: MockInstance<typeof console.error>;
    const post = (path: string, body: unknown, cookie = cookies.owner, origin = base) => withAuth(f.env, auth => auth.handler(new Request(`${base}/api/auth${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin, cookie, "cf-connecting-ip": "192.0.2.11" }, body: JSON.stringify(body),
    })));
    const disconnect = (id = "grant", cookie = cookies.owner) => post("/oauth2/delete-consent", { id }, cookie);
    beforeEach(async () => {
      f = await setup();
      errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      Object.assign(f.env, { ENVIRONMENT: "production", BETTER_AUTH_URL: base, FRONTEND_URL: base,
        CORS_ALLOW_ORIGIN: base, BETTER_AUTH_SECRET: "synthetic-grant-secret-012345678901234567890",
        RATE_LIMIT_BACKEND: createMemoryRateLimitBackend() });
      cookies = {};
      for (const id of ["owner", "peer"]) {
        await f.execute("INSERT INTO users(id,username,email,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,password_reset_required) VALUES(?,?,?,?,?,0,0,0,?)", [id, id, `${id}@example.invalid`, true, false, false]);
        await f.execute("INSERT INTO account(id,account_id,user_id,provider_id,password) VALUES(?,?,?,?,?)", [`account-${id}`, id, id, "credential", await (passwordHash ??= hashPassword(password))]);
        const login = await post("/sign-in/email", { email: `${id}@example.invalid`, password }, "");
        expect(login.status).toBe(200);
        cookies[id] = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      }
      for (const client of ["client", "other-client"]) await f.execute("INSERT INTO oauth_client(id,client_id,redirect_uris) VALUES(?,?,?)", [client, client, f.encodeArray([])]);
      for (const [id, owner, client] of [["grant", "owner", "client"], ["resource-grant", "owner", "client"], ["other-grant", "owner", "other-client"], ["peer-grant", "peer", "client"]]) {
        await f.execute("INSERT INTO oauth_consent(id,user_id,client_id,scopes) VALUES(?,?,?,?)", [id, owner, client, f.encodeArray(["videoq.read"])]);
        await f.execute("INSERT INTO oauth_refresh_token(id,user_id,client_id,token,scopes,rotation_replay_response) VALUES(?,?,?,?,?,?)", [`refresh-${id}`, owner, client, `synthetic-refresh-${id}`, f.encodeArray(["videoq.read"]), "synthetic-cached-rotation"]);
        await f.execute("INSERT INTO oauth_access_token(id,user_id,client_id,token,refresh_id,scopes) VALUES(?,?,?,?,?,?)", [`access-${id}`, owner, client, `synthetic-access-${id}`, `refresh-${id}`, f.encodeArray(["videoq.read"])]);
      }
    });
    afterEach(async () => {
      try { await f?.dispose(); } finally { errorLog?.mockRestore(); }
    });

    it("revokes every credential and resource grant for the selected owner/app only", async () => {
      expect((await disconnect()).status).toBe(200);
      expect(await f.snapshot()).toEqual({
        consents: ["other-grant", "peer-grant"],
        refresh: ["refresh-other-grant", "refresh-peer-grant"],
        access: ["access-other-grant", "access-peer-grant"],
      });
      expect((await disconnect()).status).toBe(404);
    });
    it("rejects another owner's grant and unknown ids without changing credentials", async () => {
      const before = await f.snapshot();
      expect((await disconnect("grant", cookies.peer)).status).toBe(404);
      expect((await disconnect("unknown")).status).toBe(404);
      expect(await f.snapshot()).toEqual(before);
    });
    it("requires a valid current session and trusted origin", async () => {
      const before = await f.snapshot();
      expect((await disconnect("grant", "")).status).toBe(401);
      expect((await post("/oauth2/delete-consent", { id: "grant" }, cookies.owner, "https://foreign.example")).status).toBe(403);
      await f.execute("DELETE FROM session WHERE user_id=?", ["owner"]);
      expect((await disconnect()).status).toBe(401);
      expect(await f.snapshot()).toEqual(before);
    });
    it.each(["oauth_refresh_token", "oauth_consent"] as const)("rolls back earlier deletions if %s fails, then allows a clean retry", async table => {
      const before = await f.snapshot();
      await f.failDeletion(table);
      try {
        const response = await disconnect();
        expect(response.status).toBe(500);
        const diagnostics = await response.text() + inspect(errorLog.mock.calls, { depth: 8 });
        expect(diagnostics).not.toContain("synthetic-secret-failure-canary");
        expect(diagnostics.toLowerCase()).not.toContain("delete from");
        expect(await f.snapshot()).toEqual(before);
      } finally { await f.clearFailure(table); }
      expect((await disconnect()).status).toBe(200);
    });
    it("handles concurrent disconnect requests without retaining partial credentials", async () => {
      const responses = await Promise.all([disconnect(), disconnect()]);
      expect(responses.some(response => response.status === 200)).toBe(true);
      expect(responses.every(response => [200, 404].includes(response.status))).toBe(true);
      expect(await f.snapshot()).toEqual({ consents: ["other-grant", "peer-grant"], refresh: ["refresh-other-grant", "refresh-peer-grant"], access: ["access-other-grant", "access-peer-grant"] });
    });
  });
}
