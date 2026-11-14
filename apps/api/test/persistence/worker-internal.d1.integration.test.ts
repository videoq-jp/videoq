import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { workerInternalRoutes } from "../../src/features/worker-internal/routes";
import type { AppEnv, Bindings } from "../../src/types/bindings";
import { createD1Fixture } from "./d1-fixture";

const secret = "worker-test-key-0123456789-abcdefghijklmnop";
const origin = "https://api.example.test";
function signed(action: string, input: unknown, timestamp = Math.floor(Date.now() / 1000)) {
  const path = (action.startsWith("scene-index/") || action.startsWith("processing/") || action.startsWith("transcription/") || action.startsWith("checkpoints/") || action.startsWith("visual/") || action.startsWith("reindex/")) ? `/internal/worker/${action}` : `/internal/worker/jobs/${action}`;
  const body = JSON.stringify(input);
  const signature = createHmac("sha256", secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${path}\n${body}`).digest("hex");
  return new Request(origin + path, { method: "POST", body, headers: {
    "x-videoq-worker-timestamp": String(timestamp), "x-videoq-worker-signature": signature,
  } });
}

describe("signed Worker job API with D1", () => {
  let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
  let env: Bindings;
  const app = new Hono<AppEnv>().route("/internal/worker", workerInternalRoutes);
  beforeAll(async () => {
    fixture = await createD1Fixture();
    env = { DEPLOYMENT_EDITION: "cloud", DB: fixture.database, WORKER_INTERNAL_API_SECRET: secret } as Bindings;
  });
  afterAll(async () => { await fixture?.dispose(); });
  const identity = { jobId: "job-internal", jobType: "index_video_transcript", payloadSha256: "a".repeat(64) };
  it("claims, rejects duplicates/conflicts, fences leases and completes", async () => {
    const call = async (action: string, input: unknown) => {
      const res = await app.fetch(signed(action, input), env);
      expect(res.status).toBe(200);
      return res.json<Record<string, unknown>>();
    };
    const claim = await call("claim", identity);
    expect(claim.status).toBe("claimed");
    expect(await call("claim", identity)).toEqual({ status: "busy" });
    expect(await call("claim", { ...identity, payloadSha256: "b".repeat(64) })).toEqual({ status: "conflict" });
    const lease = { jobId: identity.jobId, leaseToken: claim.leaseToken };
    expect(await call("heartbeat", lease)).toEqual({ updated: true });
    expect(await call("complete", { ...lease, leaseToken: crypto.randomUUID() })).toEqual({ updated: false });
    expect(await call("complete", lease)).toEqual({ updated: true });
    expect(await call("claim", identity)).toEqual({ status: "completed" });
    expect(await call("fail", { ...lease, errorCode: "WORKER_EXECUTION_FAILED" })).toEqual({ updated: false });
  });
  it("rejects expired, unsigned, modified body, operation and audience", async () => {
    expect((await app.fetch(signed("claim", identity, Math.floor(Date.now() / 1000) - 61), env)).status).toBe(401);
    const valid = signed("claim", identity);
    for (const req of [
      new Request(valid.url, { method: "POST", body: JSON.stringify(identity) }),
      new Request(valid.url, { method: "POST", headers: valid.headers, body: "{}" }),
      new Request(valid.url.replace("/claim", "/complete"), { method: "POST", headers: valid.headers, body: JSON.stringify(identity) }),
      new Request(valid.url.replace(origin, "https://other.test"), { method: "POST", headers: valid.headers, body: JSON.stringify(identity) }),
    ]) expect((await app.fetch(req, env)).status).toBe(401);
    expect((await app.fetch(signed("claim", identity), { ...env, WORKER_INTERNAL_API_SECRET: undefined })).status).toBe(401);
  });
  it("rejects arbitrary failure text and oversized signed payloads", async () => {
    const req = signed("fail", { jobId: "j", leaseToken: crypto.randomUUID(), errorCode: "token=secret" });
    expect((await app.fetch(req, env)).status).toBe(400);
    expect((await app.fetch(signed("claim", { body: "x".repeat(9000) }), env)).status).toBe(413);
  });
});


describe("signed scene ingestion with D1", () => {
  let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
  let env: Bindings;
  const app = new Hono<AppEnv>().route("/internal/worker", workerInternalRoutes);
  beforeAll(async () => {
    fixture = await createD1Fixture();
    env = { DEPLOYMENT_EDITION: "cloud", DB: fixture.database, WORKER_INTERNAL_API_SECRET: secret } as Bindings;
    await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
    await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Lesson','video.mp4','completed','original','','2026-11-13T00:00:00.000Z','','uploaded','','')").run();
  });
  afterAll(async () => { await fixture?.dispose(); });
  const call = async (action: string, input: unknown) => {
    const res = await app.fetch(signed(`scene-index/${action}`, input), env);
    expect(res.status).toBe(200);
    return res.json<Record<string, unknown>>();
  };
  it("publishes only the current source and enqueues actual vector work", async () => {
    const source = (await call("source", { videoId: 1 })).source as { userId: string; sourceRevision: string };
    const runId = crypto.randomUUID();
    const run = { runId, videoId: 1, userId: source.userId, sourceRevision: source.sourceRevision, dimensions: 1536, expectedScenes: 1 };
    expect(await call("start", run)).toEqual({ accepted: true });
    expect(await call("publish", { runId, userId: "owner" })).toEqual({ accepted: false });
    const scenes = [{ id: crypto.randomUUID(), content: "本文", startTime: "00:00:00,000", endTime: "00:00:01,000", embedding: Array(1536).fill(0.5) }];
    expect(await call("stage", { runId, userId: "foreign", scenes })).toEqual({ accepted: false });
    expect(await call("stage", { runId, userId: "owner", scenes })).toEqual({ accepted: true });
    expect(await call("publish", { runId, userId: "owner" })).toEqual({ accepted: true });
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scenes").first("n")).toBe(1);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE operation='upsert'").first("n")).toBe(1);
    await fixture.database.prepare("UPDATE video_index_versions SET revision=? WHERE video_id=1").bind(crypto.randomUUID()).run();
    expect(await call("start", { ...run, runId: crypto.randomUUID() })).toEqual({ accepted: false });
    expect(await call("source", { videoId: 999 })).toEqual({ source: null });
  });
  it("waits for delivery, resumes completion and rejects a stale source/file", async () => {
    await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (2,'owner','Initial','two.mp4','indexing','original','','2026-11-13T00:00:00.000Z','','uploaded','','')").run();
    const source = (await call("source", { videoId: 2 })).source as { sourceRevision: string };
    const input = { videoId: 2, userId: "owner", fileKey: "two.mp4", sourceRevision: source.sourceRevision, dimensions: 1536 };
    expect(await call("finish", input)).toEqual({ status: "missing" });
    const runId = crypto.randomUUID();
    expect(await call("start", { ...input, fileKey: undefined, runId, expectedScenes: 1 })).toEqual({ accepted: true });
    await call("stage", { runId, userId: "owner", scenes: [{ id: crypto.randomUUID(), content: "Initial", startTime: "00:00:00,000", endTime: "00:00:01,000", embedding: Array(1536).fill(0.1) }] });
    await call("publish", { runId, userId: "owner" });
    expect(await call("finish", input)).toEqual({ status: "pending" });
    expect(await fixture.database.prepare("SELECT status FROM videos WHERE id=2").first("status")).toBe("indexing");
    expect(await call("finish", { ...input, fileKey: "old.mp4" })).toEqual({ status: "stale" });
    expect(await call("finish", { ...input, dimensions: 768 })).toEqual({ status: "missing" });
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at='2026-11-13T00:00:00.000Z' WHERE video_id=2 AND operation='upsert'").run();
    expect(await call("finish", { ...input, sourceRevision: crypto.randomUUID() })).toEqual({ status: "stale" });
    expect(await call("finish", input)).toEqual({ status: "completed" });
    expect(await call("finish", input)).toEqual({ status: "completed" });
  });

  it("reserves processing through the signed API exactly once", async () => {
    const input = { videoId: 1, seconds: 20 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await app.fetch(signed("processing/reserve", input), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ allowed: true, limitSeconds: null });
    }
    expect(await fixture.database.prepare("SELECT used_processing_seconds FROM users WHERE id='owner'").first("used_processing_seconds")).toBe(20);
    expect((await app.fetch(signed("processing/reserve", { videoId: 1, seconds: -1 }), env)).status).toBe(400);
  });

  it("exposes metadata without subtitles and saves via the signed transcription API", async () => {
    await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (3,'owner','Transcribe','three.mp4','pending','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
    const request = async (action: string, input: unknown) => {
      const res = await app.fetch(signed(`transcription/${action}`, input), env);
      expect(res.status).toBe(200);
      return res.json<Record<string, unknown>>();
    };
    const source = (await request("source", { videoId: 3 })).source as { sourceRevision: string };
    expect(source).not.toHaveProperty("transcript");
    const snapshot = { videoId: 3, userId: "owner", fileKey: "three.mp4", sourceRevision: source.sourceRevision };
    expect(await request("begin", { ...snapshot, expectedStatus: "pending" })).toEqual({ accepted: true });
    expect(await request("finish", { ...snapshot, transcript: "Generated", errorCode: null })).toEqual({ status: "indexing" });
    expect(await request("finish", { ...snapshot, transcript: "Duplicate", errorCode: null })).toEqual({ status: "indexing" });
    expect(await fixture.database.prepare("SELECT transcript FROM videos WHERE id=3").first("transcript")).toBe("Generated");
  });

  it("initializes, saves, reads and finalizes checkpoints through signed operations", async () => {
    await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (4,'owner','Chunks','four.mp4','pending','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
    const sourceRes = await app.fetch(signed("transcription/source", {videoId:4}),env);
    const source = (await sourceRes.json<{ source:{sourceRevision:string} }>()).source;
    const request = async (action: string, input: unknown) => {
      const res = await app.fetch(signed(`checkpoints/${action}`, input), env);
      expect(res.status).toBe(200);
      return res.json<Record<string, unknown>>();
    };
    const result = await request("initialize", {videoId:4,userId:'owner',sourceRevision:source.sourceRevision,fileKey:'four.mp4',durationMs:300000,chunkSeconds:300});
    const run = result.run as {runId:string};
    const id = {videoId:4,runId:run.runId};
    expect(await request("state", {...id,index:0})).toEqual({active:true,completed:false});
    expect(await request("save", {...id,index:0,segments:[{start:0,end:1,text:'caption'}]})).toEqual({accepted:true});
    expect(await request("pending", {runId:run.runId})).toEqual({indices:[]});
    expect(await request("segments", {...id,afterIndex:-1})).toMatchObject({active:true,done:true});
    expect(await request("finish", {...id,transcript:'caption'})).toEqual({completed:true,stale:false,status:'indexing'});
  });

  it("publishes immutable visual chunk references through signed operations", async () => {
    const request = async (action: string, input: unknown) => {
      const res = await app.fetch(signed(`visual/${action}`, input), env);
      expect(res.status).toBe(200);
      return res.json<Record<string, unknown>>();
    };
    const run = (await request("initialize", {videoId:1,fileKey:'video.mp4',durationMs:60000})).run as {runId:string};
    const id = {videoId:1,runId:run.runId};
    expect(await request("pending",id)).toEqual({indices:[0]});
    expect(await request("ready",{...id,objectVersion:run.runId})).toEqual({accepted:false,objectVersion:null});
    const version = crypto.randomUUID();
    expect(await request("begin-object",{...id,index:0,objectVersion:version})).toEqual({accepted:true});
    expect(await request("publish",{...id,index:0,frameCount:1,objectVersion:version})).toEqual({current:true,objectVersion:version});
    expect(await request("begin-object",{...id,objectVersion:run.runId})).toEqual({accepted:true});
    expect(await request("ready",{...id,objectVersion:run.runId})).toEqual({accepted:true,objectVersion:run.runId});
    expect(await request("chunks",id)).toEqual({chunks:[{index:0,frameCount:1,objectVersion:version}]});
  });

  it("preflights the active Vectorize dimension and returns only reindex IDs",async()=>{
    const input={afterId:0,dimensions:1536,profile:'openai',model:'text-embedding-3-small'};
    const index={describe:async()=>({dimensions:1536})} as NonNullable<Bindings['SCENE_VECTORIZE_1536']>;
    const configured={...env,SCENE_VECTORIZE_1536:index};
    const response=await app.fetch(signed('reindex/page',input),configured);
    expect(response.status).toBe(200);
    const page=await response.json<{ids:number[]}>();
    expect(Object.keys(page)).toEqual(['ids']);
    expect(page.ids).toContain(1);
    expect(page.ids).not.toContain(3);
    expect(page.ids.length).toBeLessThanOrEqual(26);
    for (const [body,bindings] of [
      [input,env],
      [{...input,model:'different-model'},configured],
      [input,{...configured,SCENE_VECTORIZE_1536:{describe:async()=>({dimensions:768})}}],
    ] as const) {
      const failed=await app.fetch(signed('reindex/page',body),bindings);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({error:'INDEX_NOT_READY'});
    }
    expect((await app.fetch(signed('reindex/page',{...input,afterId:-1}),configured)).status).toBe(400);
    const empty=await app.fetch(signed('reindex/page',{...input,afterId:Number.MAX_SAFE_INTEGER}),env);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ids:[]});
    const gemma=await app.fetch(signed('reindex/page',{afterId:0,dimensions:768,profile:'embeddinggemma2',model:'custom-gemma'}),{
      ...env,EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'custom-gemma',EMBEDDING_BASE_URL:'https://embeddings.example/v1',
      SCENE_VECTORIZE_768:{describe:async()=>({dimensions:768})},
      SCENE_VECTORIZE_1536:{describe:async()=>{throw new Error('wrong dimension binding');}},
    });
    expect(gemma.status).toBe(200);
  });

});
