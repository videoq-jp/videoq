import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { armMaintenance } from "../../lib/task-scheduler";
import type { AppEnv } from "../../types/bindings";
import { createJobRepository, createWorkerScenePersistence, createProcessingQuotaRepository, createWorkerTranscriptionRepository, createTranscriptionCheckpoints, finishWorkerTranscriptionRun, createVisualCheckpoints, readWorkerReindexPage } from "../../persistence/factory";

const identity = z.object({
  jobId: z.string().min(1).max(128),
  jobType: z.string().min(1).max(64),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const lease = z.object({ jobId: z.string().min(1).max(128), leaseToken: z.string().uuid() }).strict();
const failure = lease.extend({ errorCode: z.literal("WORKER_EXECUTION_FAILED") });
const actions = new Set(["claim", "complete", "fail", "heartbeat"]);
const encoder = new TextEncoder();

/** Sign the exact bytes, audience and operation. Credentials expire after 60s;
 * replays are fenced by the job identity and repository lease token. */
export async function verifyWorkerRequest(request: Request, secret: string | undefined, body: string, now = Date.now()): Promise<boolean> {
  if (!secret || encoder.encode(secret).length < 32) return false;
  const timestamp = request.headers.get("x-videoq-worker-timestamp") ?? "";
  const signature = request.headers.get("x-videoq-worker-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const age = Math.floor(now / 1000) - Number(timestamp);
  if (age < -5 || age > 60) return false;
  const url = new URL(request.url);
  if (url.search) return false;
  const message = `videoq-worker-v1\n${timestamp}\n${request.method}\n${url.origin}\n${url.pathname}\n${body}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(signature.match(/../g)!, value => parseInt(value, 16));
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message));
}

export const workerInternalRoutes = new Hono<AppEnv>();
workerInternalRoutes.use("/jobs/*", bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/jobs/:action", async c => {
  c.header("Cache-Control", "no-store");
  const action = c.req.param("action");
  if (!actions.has(action)) return c.json({ error: "NOT_FOUND" }, 404);
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) {
    return c.json({ error: "UNAUTHORIZED" }, 401);
  }
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  if (action === "claim") {
    const parsed = identity.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createJobRepository(c.env);
    return c.json(await repo.claim(parsed.data));
  }
  const parsed = (action === "fail" ? failure : lease).safeParse(input);
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
  const repo = await createJobRepository(c.env);
  const { jobId, leaseToken } = parsed.data;
  const updated = action === "complete" ? await repo.complete(jobId, leaseToken)
    : action === "heartbeat" ? await repo.heartbeat(jobId, leaseToken)
    : await repo.fail(jobId, leaseToken, "WORKER_EXECUTION_FAILED");
  return c.json({ updated });
});


const userId = z.string().min(1).max(128);
const runId = z.string().uuid();
const sourceRequest = z.object({ videoId: z.number().int().positive().safe() }).strict();
const startRequest = sourceRequest.extend({
  runId, userId, sourceRevision: z.string().uuid(), dimensions: z.union([z.literal(768), z.literal(1536)]),
  expectedScenes: z.number().int().min(0).max(1_000_000),
}).strict();
const finishRequest = sourceRequest.extend({ userId, sourceRevision: z.string().uuid(), fileKey: z.string().max(4096),
  dimensions: z.union([z.literal(768), z.literal(1536)]),
}).strict();
const publishRequest = z.object({ runId, userId }).strict();
const stageRequest = publishRequest.extend({ scenes: z.array(z.object({
  id: z.string().min(1).max(64), content: z.string().max(900_000),
  startTime: z.string().max(64), endTime: z.string().max(64),
  evidenceType: z.enum(["transcript", "visual"]).optional(),
  embedding: z.array(z.number().finite()).min(768).max(1536),
}).strict()).max(20) }).strict();
workerInternalRoutes.use("/scene-index/*", bodyLimit({ maxSize: 1_000_000, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/scene-index/:action", async c => {
  c.header("Cache-Control", "no-store");
  const action = c.req.param("action");
  if (!["source", "start", "stage", "publish", "finish"].includes(action)) return c.json({ error: "NOT_FOUND" }, 404);
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) return c.json({ error: "UNAUTHORIZED" }, 401);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  // Arm before mutations so a dropped request cannot strand durable index tasks.
  if (action !== "source" && c.env.TASK_SCHEDULER) await armMaintenance(c.env, Date.now() + 1000);
  if (action === "source") {
    const parsed = sourceRequest.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const persistence = await createWorkerScenePersistence(c.env);
    return c.json({ source: await persistence.readSource(parsed.data.videoId) });
  }
  if (action === "finish") {
    const parsed = finishRequest.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const persistence = await createWorkerScenePersistence(c.env);
    return c.json({ status: await persistence.finish(parsed.data) });
  }
  if (action === "start") {
    const parsed = startRequest.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const { writer } = await createWorkerScenePersistence(c.env);
    return c.json({ accepted: await writer.start(parsed.data) });
  }
  if (action === "stage") {
    const parsed = stageRequest.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const { writer } = await createWorkerScenePersistence(c.env);
    return c.json({ accepted: await writer.stage(parsed.data.runId, parsed.data.userId, parsed.data.scenes) });
  }
  const parsed = publishRequest.safeParse(input);
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
  const { writer } = await createWorkerScenePersistence(c.env);
  return c.json({ accepted: await writer.publish(parsed.data.runId, parsed.data.userId) });
});


workerInternalRoutes.use("/processing/*", bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/processing/reserve", async c => {
  c.header("Cache-Control", "no-store");
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) return c.json({ error: "UNAUTHORIZED" }, 401);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  const parsed = sourceRequest.extend({ seconds: z.number().int().positive().max(2_147_483_647) }).strict().safeParse(input);
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
  const repository = await createProcessingQuotaRepository(c.env);
  return c.json(await repository.reserve(parsed.data.videoId, parsed.data.seconds));
});


const transcriptionSnapshot = sourceRequest.extend({ userId, sourceRevision: z.string().uuid(), fileKey: z.string().max(4096) }).strict();
const transcriptionBegin = transcriptionSnapshot.extend({ expectedStatus: z.enum(["pending", "error", "processing"]) }).strict();
const transcriptionFinish = transcriptionSnapshot.extend({ transcript: z.string().max(1_800_000).nullable(),
  errorCode: z.enum(["TRANSCRIPTION_FAILED", "PROCESSING_QUOTA_EXCEEDED"]).nullable(),
}).strict();
workerInternalRoutes.use("/transcription/*", bodyLimit({ maxSize: 1_900_000, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/transcription/:action", async c => {
  c.header("Cache-Control", "no-store");
  const action = c.req.param("action");
  if (!["source", "begin", "finish"].includes(action)) return c.json({ error: "NOT_FOUND" }, 404);
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) return c.json({ error: "UNAUTHORIZED" }, 401);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  if (action === "source") {
    const parsed = sourceRequest.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createWorkerTranscriptionRepository(c.env);
    return c.json({ source: await repo.readSource(parsed.data.videoId) });
  }
  if (action === "begin") {
    const parsed = transcriptionBegin.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createWorkerTranscriptionRepository(c.env);
    return c.json({ accepted: await repo.begin(parsed.data, parsed.data.expectedStatus) });
  }
  const parsed = transcriptionFinish.safeParse(input);
  if (!parsed.success || (parsed.data.transcript === null && parsed.data.errorCode === null) ||
    (parsed.data.transcript !== null && new TextEncoder().encode(parsed.data.transcript).length > 1_800_000)) return c.json({ error: "INVALID_REQUEST" }, 400);
  if (c.env.TASK_SCHEDULER) await armMaintenance(c.env, Date.now() + 1000);
  const repo = await createWorkerTranscriptionRepository(c.env);
  return c.json({ status: await repo.finish(parsed.data, parsed.data.transcript, parsed.data.errorCode) });
});


const checkpointRun = sourceRequest.extend({ runId }).strict();
const checkpointChunk = checkpointRun.extend({ index: z.number().int().min(0).max(9999) }).strict();
const checkpointSave = checkpointChunk.extend({ segments: z.array(z.object({
  start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string(),
}).strict().refine(segment => segment.end >= segment.start)).max(10000) }).strict();
const checkpointInit = transcriptionSnapshot.extend({ durationMs: z.number().int().positive().max(3_000_000_000),
  chunkSeconds: z.number().int().min(30).max(300),
}).strict().refine(input => Math.ceil(input.durationMs / (input.chunkSeconds*1000)) <= 10000);
workerInternalRoutes.use("/checkpoints/*", bodyLimit({ maxSize: 1_900_000, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/checkpoints/:action", async c => {
  c.header("Cache-Control", "no-store");
  const action = c.req.param("action");
  if (!["load", "initialize", "pending", "state", "save", "failure", "segments", "reject", "finish"].includes(action)) return c.json({ error: "NOT_FOUND" }, 404);
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) return c.json({ error: "UNAUTHORIZED" }, 401);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  if (action === "load") {
    const parsed = sourceRequest.extend({ runId: runId.optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json({ run: await repo.load(parsed.data.videoId, parsed.data.runId) });
  }
  if (action === "initialize") {
    const parsed = checkpointInit.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json(await repo.initialize(parsed.data, parsed.data.durationMs, parsed.data.chunkSeconds));
  }
  if (action === "pending") {
    const parsed = z.object({ runId, afterIndex: z.number().int().min(0).max(9999).optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json({ indices: await repo.pendingHeads(parsed.data.runId, parsed.data.afterIndex) });
  }
  if (action === "segments") {
    const parsed = checkpointRun.extend({ afterIndex: z.number().int().min(-1).max(9999) }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json(await repo.readSegments(parsed.data.videoId, parsed.data.runId, parsed.data.afterIndex));
  }
  if (action === "reject") {
    const parsed = transcriptionSnapshot.extend({ runId: runId.optional(), index: z.number().int().min(0).max(9999).optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json({ accepted: await repo.rejectNoAudio(parsed.data, parsed.data.runId, parsed.data.index) });
  }
  if (action === "finish") {
    const parsed = checkpointRun.extend({ transcript: z.string().max(1_800_000).nullable() }).strict().safeParse(input);
    if (!parsed.success || parsed.data.transcript !== null && new TextEncoder().encode(parsed.data.transcript).length>1_800_000) return c.json({ error: "INVALID_REQUEST" }, 400);
    if (c.env.TASK_SCHEDULER) await armMaintenance(c.env, Date.now()+1000);
    return c.json(await finishWorkerTranscriptionRun(c.env, parsed.data.videoId, parsed.data.runId, parsed.data.transcript));
  }
  if (action === "save") {
    const parsed = checkpointSave.safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createTranscriptionCheckpoints(c.env);
    return c.json({ accepted: await repo.saveChunk(parsed.data.videoId, parsed.data.runId, parsed.data.index, parsed.data.segments) });
  }
  const parsed = checkpointChunk.safeParse(input);
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
  const repo = await createTranscriptionCheckpoints(c.env);
  if (action === "state") return c.json(await repo.chunkState(parsed.data.videoId, parsed.data.runId, parsed.data.index));
  await repo.recordFailure(parsed.data.videoId, parsed.data.runId, parsed.data.index);
  return c.json({ accepted: true });
});


const visualIdentity = sourceRequest.extend({ runId }).strict();
workerInternalRoutes.use("/visual/*", bodyLimit({ maxSize: 8192, onError: c => c.json({ error: "BODY_TOO_LARGE" }, 413) }));
workerInternalRoutes.post("/visual/:action", async c => {
  c.header("Cache-Control", "no-store");
  const action = c.req.param("action");
  if (!["load", "initialize", "pending", "chunks", "publish", "ready", "failure", "begin-object"].includes(action)) return c.json({ error: "NOT_FOUND" }, 404);
  const body = await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw, c.env.WORKER_INTERNAL_API_SECRET, body)) return c.json({ error: "UNAUTHORIZED" }, 401);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return c.json({ error: "INVALID_REQUEST" }, 400); }
  if (action === "load") {
    const parsed = sourceRequest.extend({ runId: runId.optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createVisualCheckpoints(c.env);
    return c.json({ run: await repo.load(parsed.data.videoId, parsed.data.runId) });
  }
  if (action === "initialize") {
    const parsed = sourceRequest.extend({ fileKey:z.string().min(1).max(4096),durationMs:z.number().int().positive().max(36_000_000) }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createVisualCheckpoints(c.env);
    return c.json({ run: await repo.initialize(parsed.data.videoId,parsed.data.fileKey,parsed.data.durationMs) });
  }
  if (action === "begin-object") {
    const parsed = visualIdentity.extend({ objectVersion:z.string().uuid(),index:z.number().int().min(0).max(599).optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({error:"INVALID_REQUEST"},400);
    if (c.env.TASK_SCHEDULER) await armMaintenance(c.env,Date.now()+3600_000);
    const repo=await createVisualCheckpoints(c.env);
    return c.json({accepted:await repo.beginObject(parsed.data.videoId,parsed.data.runId,parsed.data.objectVersion,parsed.data.index)});
  }
  if (action === "publish") {
    const parsed = visualIdentity.extend({ index:z.number().int().min(0).max(599), frameCount:z.number().int().min(0).max(60),objectVersion:z.string().uuid() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createVisualCheckpoints(c.env);
    return c.json(await repo.publishChunk(parsed.data.videoId,parsed.data.runId,parsed.data.index,parsed.data.frameCount,parsed.data.objectVersion));
  }
  if (action === "failure") {
    const parsed = visualIdentity.extend({ index:z.number().int().min(0).max(599).optional() }).strict().safeParse(input);
    if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
    const repo = await createVisualCheckpoints(c.env);
    await repo.failure(parsed.data.videoId,parsed.data.runId,parsed.data.index);
    return c.json({ accepted:true });
  }
  if (action === "ready") {
    const parsed=visualIdentity.extend({objectVersion:z.string().uuid()}).strict().safeParse(input);
    if (!parsed.success) return c.json({error:"INVALID_REQUEST"},400);
    const repo=await createVisualCheckpoints(c.env);
    const accepted=await repo.ready(parsed.data.videoId,parsed.data.runId,parsed.data.objectVersion);
    return c.json({accepted,objectVersion:accepted ? (await repo.load(parsed.data.videoId,parsed.data.runId))?.publicationVersion ?? null : null});
  }
  const parsed = visualIdentity.safeParse(input);
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);
  const repo = await createVisualCheckpoints(c.env);
  if (action === "pending") return c.json({ indices:await repo.pending(parsed.data.runId) });
  if (action === "chunks") return c.json({ chunks:await repo.chunks(parsed.data.videoId,parsed.data.runId) });
  return c.json({error:"NOT_FOUND"},404);
});


workerInternalRoutes.use("/reindex/*",bodyLimit({maxSize:8192,onError:c=>c.json({error:"BODY_TOO_LARGE"},413)}));
workerInternalRoutes.post("/reindex/page",async c=>{
  c.header("Cache-Control","no-store");
  const body=await c.req.text();
  if (!await verifyWorkerRequest(c.req.raw,c.env.WORKER_INTERNAL_API_SECRET,body)) return c.json({error:"UNAUTHORIZED"},401);
  let input:unknown;
  try {input=JSON.parse(body);} catch {return c.json({error:"INVALID_REQUEST"},400);}
  const parsed=z.object({afterId:z.number().int().nonnegative().safe(),dimensions:z.union([z.literal(768),z.literal(1536)]),
    profile:z.enum(["openai","embeddinggemma2"]),model:z.string().min(1).max(256)}).strict().safeParse(input);
  if (!parsed.success) return c.json({error:"INVALID_REQUEST"},400);
  try {return c.json({ids:await readWorkerReindexPage(c.env,parsed.data)});}
  catch {return c.json({error:"INDEX_NOT_READY"},503);}
});

const accountDeletionRequest=lease.extend({userId:z.string().min(1).max(128)}).strict();
workerInternalRoutes.use('/account-delete/*',bodyLimit({maxSize:8192,onError:c=>c.json({error:'BODY_TOO_LARGE'},413)}));
workerInternalRoutes.post('/account-delete/step',async c=>{
 c.header('Cache-Control','no-store');const body=await c.req.text();
 if(!await verifyWorkerRequest(c.req.raw,c.env.WORKER_INTERNAL_API_SECRET,body))return c.json({error:'UNAUTHORIZED'},401);
 let value:unknown;try{value=JSON.parse(body);}catch{return c.json({error:'INVALID_REQUEST'},400);}
 const parsed=accountDeletionRequest.safeParse(value);if(!parsed.success)return c.json({error:'INVALID_REQUEST'},400);
 const {stepWorkerAccountDeletion}=await import('../../persistence/factory');
 // Persisted storage/vector cleanup must retain a wake-up even if a response is lost.
 await armMaintenance(c.env,Date.now()+1000);
 return c.json(await stepWorkerAccountDeletion(c.env,parsed.data));
});
