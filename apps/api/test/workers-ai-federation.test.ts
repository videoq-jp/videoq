import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { createMemoryRateLimitBackend } from "../src/lib/rate-limit";
import { verifyWorkersAiIdentity, workersAiRoutes } from "../src/features/workers-ai/routes";
import type { AppEnv, Bindings } from "../src/types/bindings";

const trust = {
  WORKERS_AI_FEDERATION_ISSUER: "https://00000000-0000-0000-0000-000000000000.tokens.sts.global.api.aws",
  WORKERS_AI_FEDERATION_AUDIENCE: "https://videoq.jp/api/internal/workers-ai/transcribe",
  WORKERS_AI_FEDERATION_SUBJECT: "arn:aws:iam::123456789012:role/videoq-worker-prod",
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: "aws-key", alg: "RS256", use: "sig" }] };
});
afterEach(() => vi.unstubAllGlobals());
async function token(overrides: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: trust.WORKERS_AI_FEDERATION_ISSUER, sub: trust.WORKERS_AI_FEDERATION_SUBJECT,
    aud: trust.WORKERS_AI_FEDERATION_AUDIENCE, iat: now, exp: now + 900, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "aws-key" }).sign(pair.privateKey);
}

describe("Workers AI AWS identity trust", () => {
  it("accepts the configured signed role using only pinned AWS JWKS", async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(`${trust.WORKERS_AI_FEDERATION_ISSUER}/.well-known/jwks.json`);
      return Response.json(jwks);
    });
    vi.stubGlobal("fetch", fetch);
    await expect(verifyWorkersAiIdentity(await token(), trust)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { sub: "arn:aws:iam::123456789012:user/operator" },
    { iss: "https://attacker.invalid" }, { aud: "https://openrouter.ai" },
    { aud: [trust.WORKERS_AI_FEDERATION_AUDIENCE, "another-service"] },
    { exp: 1 }, { iat: Math.floor(Date.now()/1000) + 60 },
    { exp: Math.floor(Date.now()/1000) + 3600 }, { iat: undefined },
    { nbf: Math.floor(Date.now()/1000) + 60 },
  ])("rejects invalid trust/expiry claims %j", async overrides => {
    await expect(verifyWorkersAiIdentity(await token(overrides), trust, createLocalJWKSet(jwks))).rejects.toThrow();
  });
  it("rejects forged signatures and unsigned tokens", async () => {
    const fake = await generateKeyPair("RS256");
    const forged = await new SignJWT({}).setProtectedHeader({alg:"RS256",kid:"aws-key"}).sign(fake.privateKey);
    for (const value of [forged, "eyJhbGciOiJub25lIn0.e30."]) {
      await expect(verifyWorkersAiIdentity(value, trust, createLocalJWKSet(jwks))).rejects.toThrow();
    }
  });
  it("does not discover keys from arbitrary configured endpoints", async () => {
    await expect(verifyWorkersAiIdentity(await token(), {...trust,WORKERS_AI_FEDERATION_ISSUER:"https://attacker.invalid"})).rejects.toThrow();
  });
});

const app = new Hono<AppEnv>().route("/api/internal/workers-ai", workersAiRoutes);
const url = trust.WORKERS_AI_FEDERATION_AUDIENCE;
const audio = btoa("audio fixture");
async function request(body: unknown, bearer = true) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? {Authorization:`Bearer ${await token()}`} : {}) }, body: JSON.stringify(body) });
}
function env(run = vi.fn(async () => ({segments:[{start:0,end:1,text:"テスト"}]}))) {
  return { ...trust, AI: {run}, RATE_LIMIT_BACKEND: createMemoryRateLimitBackend() } as unknown as Bindings;
}
it("rejects unauthenticated audio before inference", async () => {
  const settings=env(); const response=await app.fetch(await request({audio},false), settings);
  expect(response.status).toBe(401); expect(settings.AI!.run).not.toHaveBeenCalled();
});
it("runs only the fixed model/options and returns the compatible timestamp envelope", async () => {
  const settings=env();
  const response=await app.fetch(await request({audio,language:"ja",model:"other",task:"translate",vad_filter:false}),settings);
  expect(response.status).toBe(200);
  expect(settings.AI!.run).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", {audio,language:"ja",task:"transcribe",vad_filter:true,condition_on_previous_text:false});
  expect(await response.json()).toMatchObject({success:true,result:{segments:[{start:0,end:1,text:"テスト"}]}});
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it.each([{audio:"%%%"},{audio,language:"not-a-language"},{audio:""},null])("rejects invalid audio input %j",async body=>{
  const settings=env();expect((await app.fetch(await request(body),settings)).status).toBe(400);expect(settings.AI!.run).not.toHaveBeenCalled();
});
it("bounds input and redacts provider errors",async()=>{
  const settings=env(vi.fn(async()=>{throw Error("PRIVATE AUDIO SECRET");}));
  const failed=await app.fetch(await request({audio}),settings);expect(failed.status).toBe(502);expect(await failed.text()).not.toContain("PRIVATE");
  const large=await app.fetch(await request({audio:"A".repeat(6*1024*1024)}),settings);expect(large.status).toBe(413);
});

it("mounts the federation route in the real API without using browser session auth", async () => {
  const settings = env();
  const response = await createApp().fetch(await request({audio},false),settings);
  expect(response.status).toBe(401);
  expect(settings.AI!.run).not.toHaveBeenCalled();
});
it("fails closed when the binding or trust is absent", async () => {
  for (const settings of [{...trust}, {AI:{run:vi.fn()}}]) {
    expect((await app.fetch(await request({audio},false),settings as Bindings)).status).toBe(503);
  }
});
it("rate limits the verified role across requests before inference", async () => {
  const settings=env();
  const consume=vi.fn(async()=>({allowed:false,retryAfterSec:42}));
  settings.RATE_LIMIT_BACKEND={...settings.RATE_LIMIT_BACKEND!,consume};
  const response=await app.fetch(await request({audio}),settings);
  expect(response.status).toBe(429);expect(response.headers.get("retry-after")).toBe("42");
  expect(consume).toHaveBeenCalledWith(`workers-ai:inference:${trust.WORKERS_AI_FEDERATION_SUBJECT}`,120,60);
  expect(settings.AI!.run).not.toHaveBeenCalled();
});
it.each([false,true])("fails closed when the rate limiter is unavailable (throws=%s)", async throws=>{
  const settings=env();
  if(throws) settings.RATE_LIMIT_BACKEND={...settings.RATE_LIMIT_BACKEND!,consume:async()=>{throw Error("private infrastructure error");}};
  else delete settings.RATE_LIMIT_BACKEND;
  const response=await app.fetch(await request({audio}),settings);
  expect(response.status).toBe(503);expect(await response.text()).not.toContain("private");
  expect(settings.AI!.run).not.toHaveBeenCalled();
});
it.each(['document','query'])('authenticates embedding %s input and fixes model/preprocessing',async input_type=>{
 const run=vi.fn(async()=>({data:[{index:0,embedding:[1,...Array(767).fill(0)]}]}));
 const req=await request({texts:['字幕'],input_type,model:'attacker-model'});
 const embeddingRequest=new Request(url.replace(/\/transcribe$/,'/embeddings'),req);
 const response=await app.fetch(embeddingRequest,env(run));
 expect(response.status).toBe(200);
 expect(run).toHaveBeenCalledWith('@cf/google/embeddinggemma-2',{input:[input_type==='query'?'task: search result | query: 字幕':'title: none | text: 字幕'],dimensions:768,encoding_format:'float'});
});
it('rejects unauthenticated and oversized embedding batches before inference',async()=>{
 const settings=env();
 const endpoint=url.replace(/\/transcribe$/,'/embeddings');
 expect((await app.fetch(new Request(endpoint,await request({texts:['private'],input_type:'document'},false)),settings)).status).toBe(401);
 expect((await app.fetch(new Request(endpoint,await request({texts:Array(33).fill('private'),input_type:'document'})),settings)).status).toBe(400);
 expect(settings.AI!.run).not.toHaveBeenCalled();
});
