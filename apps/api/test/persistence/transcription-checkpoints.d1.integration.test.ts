import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1TranscriptionCheckpoints } from "../../src/persistence/d1/transcription-checkpoints";
import { createD1WorkerTranscriptionRepository } from "../../src/persistence/d1/worker-transcription";
import { finishWorkerTranscriptionRun } from "../../src/persistence/factory";
import type { Bindings } from "../../src/types/bindings";
import type { WorkerTranscriptionSource } from "../../src/persistence/contracts/worker-transcription";
let f: Awaited<ReturnType<typeof createD1Fixture>>;
let repository: ReturnType<typeof createD1TranscriptionCheckpoints>;
let source: WorkerTranscriptionSource;
beforeEach(async () => {
  f = await createD1Fixture();
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,processing_limit_minutes) VALUES ('owner','owner','owner@example.test',0,0,0,0,60)").run();
  await f.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','pending','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
  source = (await createD1WorkerTranscriptionRepository(f.database).readSource(1))!;
  repository = createD1TranscriptionCheckpoints(f.database);
});
afterEach(async () => { await f?.dispose(); });
const usage = () => f.database.prepare("SELECT used_processing_seconds FROM users").first("used_processing_seconds");
describe("D1 transcription checkpoints", () => {
  it("initializes one plan and one quota debit across concurrent deliveries", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.initialize(source, 1_500_000, 300)));
    expect(new Set(results.map(r => r.run?.runId)).size).toBe(1);
    expect(results[0].run?.chunkCount).toBe(5);
    expect(await usage()).toBe(1500);
    expect(await repository.load(1)).toEqual(results[0].run);
    expect(await repository.load(1, crypto.randomUUID())).toBeNull();
    expect(await repository.pendingHeads(results[0].run!.runId)).toEqual([0, 1, 2, 3]);
  });
  it("keeps the first chunk result and advances only its lane", async () => {
    const { run } = await repository.initialize(source, 1_500_000, 300);
    const id = run!.runId;
    expect(await repository.chunkState(1, id, 0)).toEqual({ active: true, completed: false });
    expect(await repository.saveChunk(1, id, 0, [{ start: 0, end: 1, text: 'first' }])).toBe(true);
    expect(await repository.saveChunk(1, id, 0, [{ start: 0, end: 1, text: 'duplicate' }])).toBe(true);
    expect(await repository.chunkState(1, id, 0)).toEqual({ active: true, completed: true });
    expect(await f.database.prepare("SELECT segments FROM video_transcription_chunks WHERE run_id=? AND chunk_index=0").bind(id).first("segments")).toContain('first');
    expect(await repository.pendingHeads(id, 0)).toEqual([4]);
    expect(await repository.pendingHeads(id)).toEqual([4, 1, 2, 3]);
  });
  it("fences manual source changes and deleted videos", async () => {
    const { run } = await repository.initialize(source, 300_000, 300);
    await f.database.prepare("UPDATE video_index_versions SET revision=?").bind(crypto.randomUUID()).run();
    expect(await repository.chunkState(1, run!.runId, 0)).toEqual({ active: false, completed: false });
    expect(await repository.saveChunk(1, run!.runId, 0, [])).toBe(false);
    expect(await repository.initialize(source, 300_000, 300)).toEqual({ run: null, quotaExceeded: false });
    await f.database.prepare("DELETE FROM videos").run();
    expect(await repository.load(1)).toBeNull();
  });
  it("does not create a plan when quota is denied and rolls back failed chunk creation", async () => {
    expect(await repository.initialize(source, 3_601_000, 300)).toEqual({ run: null, quotaExceeded: true });
    expect(await usage()).toBe(0);
    await f.database.prepare("CREATE TRIGGER fail_chunk BEFORE INSERT ON video_transcription_chunks BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
    await expect(repository.initialize(source, 300_000, 300)).rejects.toThrow();
    expect(await usage()).toBe(0);
    expect(await repository.load(1)).toBeNull();
  });
  it("records bounded failure codes and permits a saved retry", async () => {
    const { run } = await repository.initialize(source, 300_000, 300);
    for (let i = 0; i < 5; i++) await repository.recordFailure(1, run!.runId, 0);
    expect(await f.database.prepare("SELECT status FROM videos").first("status")).toBe("error");
    expect(await repository.saveChunk(1, run!.runId, 0, [])).toBe(true);
    expect(await repository.pendingHeads(run!.runId)).toEqual([]);
    await f.database.prepare("UPDATE videos SET status='processing'").run();
    await repository.recordFailure(1,run!.runId,0);
    expect(await f.database.prepare("SELECT status FROM videos").first("status")).toBe("processing");
  });
  it("finalizes run, subtitles and outbox atomically only when all chunks exist", async () => {
    const env = { DEPLOYMENT_EDITION: "cloud", DB: f.database } as Bindings;
    const { run } = await repository.initialize(source, 300_000, 300);
    expect(await finishWorkerTranscriptionRun(env, 1, run!.runId, "incomplete")).toMatchObject({ completed: false });
    await repository.saveChunk(1, run!.runId, 0, [{ start: 0, end: 1, text: 'caption' }]);
    await f.database.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
    await expect(finishWorkerTranscriptionRun(env, 1, run!.runId, "caption")).rejects.toThrow();
    expect((await repository.load(1))!.completed).toBe(false);
    expect(await f.database.prepare("SELECT transcript FROM videos").first("transcript")).toBe("");
    await f.database.prepare("DROP TRIGGER fail_outbox").run();
    expect(await finishWorkerTranscriptionRun(env, 1, run!.runId, "caption")).toEqual({ completed: true, stale: false, status: 'indexing' });
    expect(await finishWorkerTranscriptionRun(env, 1, run!.runId, "duplicate")).toEqual({ completed: true, stale: false, status: 'indexing' });
    expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
  });
  it("stops all lanes on a fenced terminal no-audio result", async () => {
    const { run } = await repository.initialize(source, 300_000, 300);
    expect(await repository.rejectNoAudio({ ...source, fileKey: 'old.mp4' }, run!.runId, 0)).toBe(false);
    expect(await repository.rejectNoAudio(source, run!.runId, 0)).toBe(true);
    expect((await repository.load(1))!.completed).toBe(true);
    expect(await repository.chunkState(1, run!.runId, 0)).toEqual({ active: false, completed: false });
    expect(await f.database.prepare("SELECT error_message FROM videos").first("error_message")).toBe('NO_AUDIO_STREAM');
  });
  it("reads ordered bounded pages and rejects segments from stale runs", async () => {
    await f.database.prepare("UPDATE users SET processing_limit_minutes=NULL").run();
    const { run } = await repository.initialize(source, 6_300_000, 300);
    for (let i=0;i<21;i++) await repository.saveChunk(1,run!.runId,i,[]);
    const first = await repository.readSegments(1,run!.runId,-1);
    expect(first.rows).toHaveLength(20);
    expect(first.done).toBe(false);
    expect(await repository.readSegments(1,run!.runId,19)).toEqual({ active: true, rows: [{ index:20,segments:[] }], done:true });
  });

});
