import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const store = vi.hoisted(() => ({ data: {} }));
vi.mock("@better-auth/drizzle-adapter", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store.data) };
});
vi.mock("../src/db/pool", () => ({
  withDb: (_env: unknown, fn: (db: object) => unknown) => fn({}),
}));

import { deriveDpopAth, deriveDpopJkt } from "better-auth/oauth2";
import { Hono } from "hono";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { oauthBearerMethod, requireAuth } from "../src/middleware/auth";
import { mcpRoutes } from "../src/features/mcp/routes";
import type { AppEnv } from "../src/types/bindings";
import { TEST_USER_ID } from "./helpers/auth";

const ISSUER = "https://videoq.jp/api/auth";
const AUDIENCE = "https://videoq.jp/api/mcp";
const KEY_ID = "oauth-access-token-test-key";

let accessTokenPrivateKey: CryptoKey;
let accessTokenPublicJwk: JWK;

beforeAll(async () => {
  // Better Auth's jwt() plugin signs OAuth access tokens with EdDSA by default.
  const keyPair = await generateKeyPair("EdDSA", { extractable: true });
  accessTokenPrivateKey = keyPair.privateKey;
  accessTokenPublicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    alg: "EdDSA",
    kid: KEY_ID,
    use: "sig",
  };
});

beforeEach(() => {
  store.data = Object.fromEntries([
    "user", "account", "session", "verification", "apikey", "jwks",
    "oauthClient", "oauthResource", "oauthClientResource", "oauthRefreshToken",
    "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
  ].map((model) => [model, []]));
  store.data.user.push({ id: TEST_USER_ID, banned: false, isActive: true });
  store.data.oauthClient.push({ id: "client-row", clientId: "test-client", disabled: false });
  store.data.oauthConsent.push({
    id: "test-consent", userId: TEST_USER_ID, clientId: "test-client",
    scopes: ["videoq.read", "videoq.write"],
  });
  store.data.jwks.push({
    id: KEY_ID, publicKey: JSON.stringify(accessTokenPublicJwk), privateKey: "unused",
    createdAt: new Date(), alg: "EdDSA", crv: "Ed25519",
  });
});

afterEach(() => vi.unstubAllGlobals());

function app() {
  const instance = new Hono<AppEnv>();
  instance.route("/api/mcp", mcpRoutes);
  instance.get("/who", requireAuth(oauthBearerMethod), (c) =>
    c.json({
      userId: c.var.userId,
      authVia: c.var.authVia,
      accessLevel: c.var.apiKeyAccessLevel,
    }),
  );
  return instance;
}

async function signAccessToken(
  scope: string,
  extraClaims: Record<string, unknown> = {},
) {
  return new SignJWT({ scope, client_id: "test-client", ...extraClaims })
    .setProtectedHeader({ alg: "EdDSA", kid: KEY_ID })
    .setSubject(TEST_USER_ID)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(accessTokenPrivateKey);
}

async function request(
  accessToken: string,
  headers: Record<string, string> = {},
  path = "/who",
) {
  // A distinct env also proves the verifier can load key material directly
  // instead of relying on a prior cache entry.
  const env = {
    ENVIRONMENT: "production", BETTER_AUTH_URL: "https://videoq.jp",
    BETTER_AUTH_SECRET: "isolated-oauth-test-secret-01234567890123456789",
  } as AppEnv["Bindings"];
  return app().request(
    `https://videoq.jp${path}`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, ...headers },
    },
    env,
  );
}

describe("OAuth bearer authentication", () => {
  it.each(["invalid-token", "a.b.c", "bnVsbA.e30.signature", "W10.e30.signature"])("rejects malformed JWT headers with 401: %s", async (token) => {
    expect((await request(token)).status).toBe(401);
  });

  it("Better Auth の in-process JWKS で検証し、同一 Route を fetch しない", async () => {
    const networkFetch = vi.fn(() => {
      throw new Error("OAuth verification must not perform a same-zone fetch");
    });
    vi.stubGlobal("fetch", networkFetch);

    const response = await request(
      await signAccessToken("videoq.read videoq.write"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: TEST_USER_ID,
      authVia: "oauth",
      accessLevel: "all",
    });
    expect(networkFetch).not.toHaveBeenCalled();

  });

  it("accepts an unexpired standard JWT after consent deletion without a private grant claim", async () => {
    const token = await signAccessToken("videoq.read videoq.write");
    expect((await request(token)).status).toBe(200);
    store.data.oauthConsent = [];
    expect((await request(token)).status).toBe(200);
  });

  it.each(["bearer", "bEaReR"])("uses Better Auth's case-insensitive %s header parser", async (scheme) => {
    const token = await signAccessToken("videoq.read");
    expect((await request(token, { Authorization: `${scheme}\t${token}` })).status).toBe(200);
  });

  it.each(["banned", "missing user"])("rejects %s immediately", async (reason) => {
    if (reason === "banned") store.data.user[0].banned = true;
    if (reason === "missing user") store.data.user = [];
    expect((await request(await signAccessToken("videoq.read"))).status).toBe(401);
  });

  it.each(["", "videoq.read  videoq.write", "videoq.read\tvideoq.write", ["videoq.read"]])("rejects a malformed scope claim %j", async (scope) => {
    expect((await request(await signAccessToken("videoq.read", { scope }))).status).toBe(401);
  });

  it("keeps the standard JWT signature, issuer, audience and expiry checks", async () => {
    const token = await signAccessToken("videoq.read");
    const [header, body, signature] = token.split(".");
    const tampered = `${header}.${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect((await request(tampered)).status).toBe(401);
    for (const claims of [{ iss: "https://other.example" }, { aud: "other-resource" }, { exp: 1 }]) {
      const invalid = await new SignJWT({ scope: "videoq.read", client_id: "test-client" })
        .setProtectedHeader({ alg: "EdDSA", kid: KEY_ID })
        .setSubject(TEST_USER_ID).setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? AUDIENCE).setExpirationTime(claims.exp ?? "5m")
        .sign(accessTokenPrivateKey);
      expect((await request(invalid)).status).toBe(401);
    }
  });

  it.each([
    { client_id: undefined }, { client_id: "" },
  ])("rejects a malformed client identity %j", async (claims) => {
    expect((await request(await signAccessToken("videoq.read", claims))).status).toBe(401);
  });

  it("videoq.read が無い token は 403 にする", async () => {
    const response = await request(await signAccessToken("videoq.write"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "OAuth token lacks videoq.read scope",
      },
    });
  });

  it("DPoP-bound token の proof・ath・key binding を維持する", async () => {
    const dpopKeyPair = await generateKeyPair("ES256", { extractable: true });
    const dpopPublicJwk = await exportJWK(dpopKeyPair.publicKey);
    const jkt = await deriveDpopJkt(dpopPublicJwk);
    const accessToken = await signAccessToken("videoq.read", { cnf: { jkt } });
    const now = Math.floor(Date.now() / 1000);
    const proof = await new SignJWT({
      htu: "https://videoq.jp/who",
      htm: "GET",
      jti: crypto.randomUUID(),
      iat: now,
      ath: await deriveDpopAth(accessToken),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "dpop+jwt",
        jwk: dpopPublicJwk,
      })
      .sign(dpopKeyPair.privateKey);

    const response = await request(accessToken, {
      Authorization: `DPoP ${accessToken}`,
      DPoP: proof,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: TEST_USER_ID,
      authVia: "oauth",
      accessLevel: "read_only",
    });
    // Replay concurrency needs real primary-key uniqueness; it is covered by
    // the PostgreSQL integration test, not the in-memory adapter.
    expect((await request(accessToken)).status).toBe(401);
    const missingProof = await request(accessToken, { Authorization: `DPoP ${accessToken}` }, "/api/mcp");
    expect(missingProof.status).toBe(401);
    expect(missingProof.headers.get("WWW-Authenticate")).toMatch(/^DPoP /);
    expect(missingProof.headers.get("WWW-Authenticate")).toContain('algs="');
  });
});
