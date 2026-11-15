import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1WorkerTranscriptionRepository } from "../../src/persistence/d1/worker-transcription";
import { createD1VideoMutationRepository } from "../../src/persistence/d1/video-mutation-repository";
import type { WorkerTranscriptionSource } from "../../src/persistence/contracts/worker-transcription";

let f: Awaited<ReturnType<typeof createD1Fixture>>;
let repo: ReturnType<typeof createD1WorkerTranscriptionRepository>;
let source: WorkerTranscriptionSource;
beforeEach(async () => {
  f = await createD1Fixture();
  await f.database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
    VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
  await f.database.prepare(`INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id)
    VALUES (1,'owner','Video','file.mp4','pending','original','','2026-11-13T00:00:00Z','','uploaded','','')`).run();
  repo = createD1WorkerTranscriptionRepository(f.database);
  source = (await repo.readSource(1))!;
});
afterEach(async () => { await f?.dispose(); });
const video = () => f.database.prepare("SELECT transcript,status,error_message FROM videos WHERE id=1").first();
const tasks = () => f.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n");

describe("D1 worker transcription snapshots", () => {
  it("saves once and atomically registers indexing, including concurrent replays", async () => {
    expect(source).not.toHaveProperty("transcript");
    expect(await repo.begin(source, "pending")).toBe(true);
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.finish(source, "generated", null)));
    expect(results.every(status => status === "indexing")).toBe(true);
    expect(await video()).toEqual({ transcript: "generated", status: "indexing", error_message: "" });
    expect(await tasks()).toBe(1);
    expect((await repo.readSource(1))!.sourceRevision).not.toBe(source.sourceRevision);
    expect(await f.database.prepare("SELECT count(*) AS n FROM mutation_receipts").first("n")).toBe(0);
  });
  it("preserves concurrent manual corrections and deliberate clears", async () => {
    expect(await repo.begin(source, "pending")).toBe(true);
    await createD1VideoMutationRepository(f.database).update(1, "owner", { transcript: "" });
    expect(await repo.finish(source, "generated", null)).toBe("completed");
    expect(await video()).toEqual({ transcript: "", status: "completed", error_message: "" });
    expect(await tasks()).toBe(1); // Only the edit's own reindex, not a second auto-index.
  });
  it("records only a safe failure code and allows retry", async () => {
    await repo.begin(source, "pending");
    expect(await repo.finish(source, null, "TRANSCRIPTION_FAILED")).toBe("error");
    expect(await video()).toEqual({ transcript: "original", status: "error", error_message: "TRANSCRIPTION_FAILED" });
    expect(await tasks()).toBe(0);
    expect(await repo.begin(source, "error")).toBe(true);
    expect(await repo.finish(source, "retry succeeded", null)).toBe("indexing");
    expect(await tasks()).toBe(1);
  });
  it("fences changed file, owner, status and deleted videos", async () => {
    expect(await repo.begin({ ...source, userId: "foreign" }, "pending")).toBe(false);
    await repo.begin(source, "pending");
    await f.database.prepare("UPDATE videos SET file='new-file.mp4'").run();
    expect(await repo.finish(source, "wrong", null)).toBeNull();
    expect((await video())?.transcript).toBe("original");
    await f.database.prepare("DELETE FROM videos").run();
    expect(await repo.readSource(1)).toBeNull();
    expect(await repo.finish(source, "deleted", null)).toBeNull();
    expect(await tasks()).toBe(0);
  });
  it("rolls back transcript and revision if outbox insertion fails", async () => {
    await repo.begin(source, "pending");
    await f.database.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
    await expect(repo.finish(source, "generated", null)).rejects.toThrow();
    expect(await video()).toEqual({ transcript: "original", status: "processing", error_message: "" });
    expect((await repo.readSource(1))!.sourceRevision).toBe(source.sourceRevision);
    expect(await tasks()).toBe(0);
  });
});
