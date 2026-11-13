import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1VisualCheckpoints } from "../../src/persistence/d1/visual-checkpoints";
let f: Awaited<ReturnType<typeof createD1Fixture>>;
let repo: ReturnType<typeof createD1VisualCheckpoints>;
beforeEach(async () => {
  f = await createD1Fixture();
  repo = createD1VisualCheckpoints(f.database);
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  await f.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
});
afterEach(async () => { await f?.dispose(); });
async function publish(videoId:number,runId:string,index:number,count:number,version:string) {
  await repo.beginObject(videoId,runId,version,index);
  return repo.publishChunk(videoId,runId,index,count,version);
}
async function ready(videoId:number,runId:string) {
  const version=(await repo.load(videoId,runId))?.publicationVersion ?? crypto.randomUUID();
  await repo.beginObject(videoId,runId,version);
  return repo.ready(videoId,runId,version);
}
describe("D1 visual checkpoint publication", () => {
  it("initializes one bounded plan across concurrent deliveries", async () => {
    const runs = await Promise.all(Array.from({length:8},()=>repo.initialize(1,'file.mp4',120_000)));
    expect(new Set(runs.map(r=>r!.runId)).size).toBe(1);
    expect(await repo.load(1)).toEqual(runs[0]);
    expect(await repo.pending(runs[0]!.runId)).toEqual([0,1]);
    expect(await repo.initialize(1,'old.mp4',120_000)).toBeNull();
    await expect(repo.initialize(1,'file.mp4',36_000_001)).rejects.toThrow("duration");
  });
  it("keeps only the first immutable chunk version and requires all chunks before ready", async () => {
    const run = (await repo.initialize(1,'file.mp4',120_000))!;
    const first = crypto.randomUUID();
    expect(await publish(1,run.runId,0,20,first)).toEqual({current:true,objectVersion:first});
    expect(await publish(1,run.runId,0,10,crypto.randomUUID())).toEqual({current:true,objectVersion:first});
    expect(await ready(1,run.runId)).toBe(false);
    await publish(1,run.runId,1,0,crypto.randomUUID());
    expect(await ready(1,run.runId)).toBe(true);
    expect(await ready(1,run.runId)).toBe(true);
    expect((await repo.load(1))!.status).toBe('ready');
    expect((await repo.chunks(1,run.runId))![0].frameCount).toBe(20);
    await repo.failure(1,run.runId,0);
    expect((await repo.load(1))!.status).toBe('ready');
  });
  it("does not claim a completely empty video is ready", async () => {
    const run = (await repo.initialize(1,'file.mp4',60_000))!;
    await publish(1,run.runId,0,0,crypto.randomUUID());
    expect(await ready(1,run.runId)).toBe(false);
  });
  it("fences old source, stale runs and deleted videos", async () => {
    const run = (await repo.initialize(1,'file.mp4',60_000))!;
    await f.database.prepare("UPDATE videos SET file='new.mp4'").run();
    expect(await repo.load(1,run.runId)).toBeNull();
    expect(await publish(1,run.runId,0,1,crypto.randomUUID())).toEqual({current:false,objectVersion:null});
    expect(await ready(1,run.runId)).toBe(false);
    const next = (await repo.initialize(1,'new.mp4',60_000))!;
    expect(next.runId).not.toBe(run.runId);
    expect(await repo.chunks(1,run.runId)).toBeNull();
    await f.database.prepare("DELETE FROM videos").run();
    expect(await repo.pending(next.runId)).toEqual([]);
    expect(await publish(1,next.runId,0,1,crypto.randomUUID())).toEqual({current:false,objectVersion:null});
  });
  it("does not let a late failed delivery erase a published chunk", async () => {
    const run = (await repo.initialize(1,'file.mp4',120_000))!;
    await repo.failure(1,run.runId,0);
    expect((await repo.load(1))!.status).toBe('error');
    await publish(1,run.runId,0,1,crypto.randomUUID());
    expect((await repo.load(1))!.status).toBe('processing');
    await repo.failure(1,run.runId,0);
    expect((await repo.load(1))!.status).toBe('processing');
    expect((await repo.chunks(1,run.runId))![0].frameCount).toBe(1);
  });
  it("rolls back plan and guards when chunk creation fails", async () => {
    await f.database.prepare("CREATE TRIGGER reject_chunk BEFORE INSERT ON video_visual_chunks BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
    await expect(repo.initialize(1,'file.mp4',120_000)).rejects.toThrow();
    expect(await repo.load(1)).toBeNull();
    expect(await f.database.prepare("SELECT count(*) AS n FROM mutation_receipts").first('n')).toBe(0);
  });
});
