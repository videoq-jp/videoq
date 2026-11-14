import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { getCookies } from "better-auth/cookies";
import { uploadSessionMethod } from "../../../src/middleware/upload-session-auth";
import { requireAuth } from "../../../src/middleware/auth";
import type { AppEnv, Bindings } from "../../../src/types/bindings";

export type UploadSessionFixture = {
  env: Bindings;
  execute(sql: string, args?: unknown[]): Promise<void>;
  snapshot(): Promise<unknown>;
  dispose(): Promise<void>;
};
const base = "https://upload-session-contract.example";
const secret = "synthetic-upload-session-contract-secret-012345678901234567890";
const cookieName = getCookies({ advanced: { useSecureCookies: true } }).sessionToken.name;
const app = new Hono<AppEnv>().get("/who", requireAuth(uploadSessionMethod), c => c.json({ id: c.var.userId }));

async function signedCookie(token: string) {
  const issuer = new Hono().get("/", async c => {
    await setSignedCookie(c, cookieName, token, secret, { secure: true, path: "/", httpOnly: true });
    return c.text("signed");
  });
  const response = await issuer.request(base);
  return response.headers.get("set-cookie")!.split(";")[0];
}

/** Exercise the production middleware with real database state and signed cookies.
 * The separate native Better Auth unit test covers interoperability with its issuer. */
export function uploadSessionContract(name: string, setup: () => Promise<UploadSessionFixture>) {
  describe(`${name}: authoritative upload session authorization`, () => {
    let f: UploadSessionFixture;
    let cookie: string;
    const request = (value = cookie) => app.request(`${base}/who`, { headers: { cookie: value } }, f.env);
    beforeEach(async () => {
      f = await setup();
      Object.assign(f.env, { ENVIRONMENT: "production", BETTER_AUTH_SECRET: secret });
      for (const id of ["owner", "peer"]) {
        await f.execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)", [id, id, `${id}@example.invalid`, false]);
        await f.execute("INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)", [
          `session-${id}`, id, `private-test-token-${id}`, new Date(Date.now() + 3600000).toISOString(),
          "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z",
        ]);
      }
      cookie = await signedCookie("private-test-token-owner");
    });
    afterEach(async () => { await f?.dispose(); });

    it("authorizes repeated requests without changing user state or refreshing sessions", async () => {
      const before = await f.snapshot();
      for (let i = 0; i < 3; i++) {
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "owner" });
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(await f.snapshot()).toEqual(before);
    });
    it("immediately refuses a revoked session after an earlier successful request", async () => {
      expect((await request()).status).toBe(200);
      await f.execute("DELETE FROM session WHERE id=?", ["session-owner"]);
      expect((await request()).status).toBe(401);
    });
    it("checks expiry in the database on every request", async () => {
      expect((await request()).status).toBe(200);
      await f.execute("UPDATE session SET expires_at=? WHERE id=?", ["2000-01-01T00:00:00.000Z", "session-owner"]);
      expect((await request()).status).toBe(401);
      await f.execute("UPDATE session SET expires_at=? WHERE id=?", [new Date(Date.now() + 3600000).toISOString(), "session-owner"]);
      expect((await request()).status).toBe(200);
    });
    it("checks current permanent and temporary bans and allows expired bans", async () => {
      expect((await request()).status).toBe(200);
      for (const expires of [null, new Date(Date.now() + 3600000).toISOString(), "2000-01-01T00:00:00.000Z"]) {
        await f.execute("UPDATE users SET banned=?,ban_expires=? WHERE id=?", [true, expires, "owner"]);
        expect((await request()).status).toBe(expires?.startsWith("2000-") ? 200 : 401);
      }
      await f.execute("UPDATE users SET banned=?,ban_expires=? WHERE id=?", [false, null, "owner"]);
      expect((await request()).status).toBe(200);
    });
    it("refuses a deleted owner", async () => {
      expect((await request()).status).toBe(200);
      await f.execute("DELETE FROM users WHERE id=?", ["owner"]);
      expect((await request()).status).toBe(401);
    });
    it("takes identity only from the matching session and parameterizes its token", async () => {
      const peer = await request(await signedCookie("private-test-token-peer"));
      expect(peer.status).toBe(200);
      expect(await peer.json()).toEqual({ id: "peer" });
      const before = await f.snapshot();
      for (const token of ["unknown-token", "' OR 1=1 --"]) expect((await request(await signedCookie(token))).status).toBe(401);
      expect(await f.snapshot()).toEqual(before);
    });
  });
}
