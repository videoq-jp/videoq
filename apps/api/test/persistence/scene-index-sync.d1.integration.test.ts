import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Vectorize } from "@cloudflare/workers-types";
import { createD1Fixture } from "./d1-fixture";
import { createD1SceneIndexWriter } from "../../src/persistence/d1/scene-index-writer";
import { createD1SceneIndexTaskRepository } from "../../src/persistence/d1/scene-index-tasks";
import { synchronizeD1SceneIndex } from "../../src/persistence/d1/scene-index-sync";
import { reconcileMissingSceneVectors } from "../../src/persistence/d1/scene-index-reconciliation";
import { createD1MaintenanceRepository } from "../../src/persistence/d1/maintenance-repository";
import { createD1SceneSearchRepository } from "../../src/persistence/d1/scene-search";
import { deleteVideoCascade } from "../../src/repositories/video-repository";
import type { Bindings } from "../../src/types/bindings";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
let writer: ReturnType<typeof createD1SceneIndexWriter>;
let sourceRevision: string;
type Vector = { id: string; values: number[]; metadata: Record<string, string | number> };
const vectors = new Map<string, Vector>();
let upsertHook: (() => Promise<void>) | undefined;
let deleteHook: (() => Promise<void>) | undefined;
const upsert = vi.fn(async (values: Vector[]) => {
  await upsertHook?.();
  values.forEach(value => vectors.set(value.id, value));
  return { mutationId: "upsert-fixture" };
});
const deleteByIds = vi.fn(async (ids: string[]) => {
  await deleteHook?.();
  ids.forEach(id => vectors.delete(id));
  return { mutationId: "delete-fixture" };
});
const getByIds = vi.fn((ids: string[]) => Promise.resolve(ids.flatMap(id => vectors.has(id) ? [vectors.get(id)!] : [])));
const index = { upsert, deleteByIds, getByIds, query: () => Promise.resolve({ matches: [...vectors.values()].map(value => ({ ...value, score: value.id === "forged-version" ? 0.99 : 0.9 })) }) } as unknown as Vectorize;
const embedding = Array.from({ length: 1536 }, () => 0.25);
const scene = (content = "Authoritative D1 content", dimensions = 1536) => ({ id: "scene", content, startTime: "00:01", endTime: "00:02", embedding: embedding.slice(0, dimensions) });
const sync = (limit = 10) => synchronizeD1SceneIndex(fixture.database, { 1536: index, 768: index }, limit);
const publish = async (runId: string, content = "Authoritative D1 content", dimensions: 768 | 1536 = 1536) => {
  expect(await writer.start({ runId, userId: "owner", videoId: 1, sourceRevision, dimensions, expectedScenes: 1 })).toBe(true);
  expect(await writer.stage(runId, "owner", [scene(content, dimensions)])).toBe(true);
  expect(await writer.publish(runId, "owner")).toBe(true);
};
beforeEach(async () => {
  fixture = await createD1Fixture(); vectors.clear(); upsertHook = undefined; deleteHook = undefined;
  upsert.mockClear(); deleteByIds.mockClear(); getByIds.mockClear();
  await fixture.database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
    VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
  await fixture.database.prepare(`INSERT INTO videos(id,user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
    VALUES (1,'owner','','Lesson','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'Source','completed','','uploaded','','')`).run();
  writer = createD1SceneIndexWriter(fixture.database);
  sourceRevision = (await writer.readSource(1, "owner"))!.sourceRevision;
}, 20_000);
afterEach(async () => { await fixture?.dispose(); });
const search = () => createD1SceneSearchRepository(fixture.database, index, 1536).search({ queryEmbedding: embedding, userId: "owner", videoIds: [1], limit: 20 });

describe("LangChain Vectorize synchronization from durable D1 tasks", () => {
  it("writes supplied embeddings and minimal metadata, then hydrates text from D1", async () => {
    await publish("run");
    expect(await sync()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    const vector = [...vectors.values()][0];
    expect(vector.values).toEqual(embedding);
    expect(vector.metadata).toMatchObject({ user_id: "owner", video_id: 1, scene_id: "scene", revision: "run", vector_id: vector.id, text: "" });
    expect(JSON.stringify(vector.metadata)).not.toContain("Authoritative D1 content");
    expect(await search()).toMatchObject([{ content: "Authoritative D1 content", videoTitle: "Lesson" }]);
    expect(await fixture.database.prepare("SELECT embedding FROM scene_index_tasks WHERE operation='upsert'").first("embedding")).toBeNull();
  });
  it("persists safe retry state after provider failure and succeeds on replay", async () => {
    await publish("run");
    upsertHook = () => Promise.reject(new Error("test-secret-provider-diagnostic"));
    expect(await sync()).toMatchObject({ failed: 1, completed: 0 });
    const task = await fixture.database.prepare("SELECT last_error_code,embedding,completed_at FROM scene_index_tasks").first<{ last_error_code: string; embedding: string; completed_at: string | null }>();
    expect(task).toMatchObject({ last_error_code: "VECTORIZE_WRITE_FAILED", completed_at: null });
    expect(task!.embedding).not.toBeNull();
    expect(JSON.stringify(task)).not.toContain("test-secret-provider-diagnostic");
    expect((await sync()).claimed).toBe(0);
    upsertHook = undefined;
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect(await sync()).toMatchObject({ completed: 1, failed: 0 });
  });
  it("does not fall back to another dimension's index when a binding is missing", async () => {
    await publish("private", "Private", 768);
    expect(await synchronizeD1SceneIndex(fixture.database, { 1536: index })).toMatchObject({ failed: 1, completed: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(await fixture.database.prepare("SELECT last_error_code FROM scene_index_tasks").first("last_error_code")).toBe("VECTORIZE_BINDING_MISSING");
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect((await sync()).completed).toBe(1);
    expect([...vectors.values()][0].values).toHaveLength(768);
  });
  it("compensates an upsert whose response arrives after video deletion", async () => {
    await publish("run");
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    upsertHook = () => { started(); return pending; };
    const processing = sync(1);
    await entered;
    expect((await deleteVideoCascade({ DEPLOYMENT_EDITION: "cloud", DB: fixture.database } as Bindings, 1, "owner")).deleted).toBe(true);
    release();
    expect(await processing).toMatchObject({ completed: 1 });
    expect(vectors.size).toBe(0);
    expect(await search()).toEqual([]);
  });
  it("an old delayed delete cannot remove a new run's vector", async () => {
    await publish("old", "Old"); await sync();
    const oldId = [...vectors.keys()][0];
    await publish("new", "New");
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE operation='delete' AND completed_at IS NULL").run();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    deleteHook = () => { started(); return pending; };
    const oldDelete = sync(1);
    await entered;
    deleteHook = undefined;
    expect((await sync(1)).completed).toBe(1);
    const newId = [...vectors.keys()].find(id => id !== oldId)!;
    expect(newId).toBeTruthy();
    release(); await oldDelete;
    expect([...vectors.keys()]).toEqual([newId]);
    expect(await search()).toMatchObject([{ content: "New" }]);
  });
  it("rejects a mismatched vector version even with a matching scene/run ID", async () => {
    await publish("run"); await sync();
    const current = [...vectors.values()][0];
    vectors.set("forged-version", { ...current, id: "forged-version", metadata: { ...current.metadata, vector_id: current.id } });
    expect(await search()).toHaveLength(1);
  });
  it("fences old task lease holders and reconciles obsolete accepted writes", async () => {
    await publish("run");
    const tasks = createD1SceneIndexTaskRepository(fixture.database);
    const first = (await tasks.claim())!;
    await fixture.database.prepare("UPDATE scene_index_tasks SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(first.id).run();
    const replacement = (await tasks.claim())!;
    expect(await tasks.complete(first)).toBe(false);
    expect(await tasks.retry(first, "VECTORIZE_WRITE_FAILED")).toBe(false);
    // Complete the replacement's real provider work before testing reconciliation.
    await index.upsert([{ id: replacement.vectorId, values: replacement.embedding!, metadata: { scene_id: replacement.sceneId } }]);
    expect(await tasks.complete(replacement)).toBe(true);
    await fixture.database.prepare("DELETE FROM scenes").run();
    expect(await tasks.reconcileObsolete()).toBe(1);
    expect((await sync()).completed).toBe(1);
    expect(vectors.size).toBe(0);
    expect(await tasks.reconcileObsolete()).toBe(0);
  });
  it("accepts identical staging retries but refuses different data for the same run/scene", async () => {
    expect(await writer.start({ runId: "immutable", videoId: 1, userId: "owner", sourceRevision, dimensions: 1536, expectedScenes: 1 })).toBe(true);
    expect(await writer.stage("immutable", "owner", [scene("First")])).toBe(true);
    expect(await writer.stage("immutable", "owner", [scene("First")])).toBe(true);
    await expect(writer.stage("immutable", "owner", [scene("Different")])).rejects.toThrow();
    expect(await writer.publish("immutable", "owner")).toBe(true);
    await sync();
    expect(await search()).toMatchObject([{ content: "First" }]);
  });
  it("verifies missing vectors after propagation grace and queues one repair job per source", async () => {
    await publish("run"); await sync();
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 0, repairQueued: 0 });
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert'").run();
    const windows = { leaseMs: 300000, abandonedUploadMs: 3600000, staleInvitationMs: 60000 };
    const maintenance = createD1MaintenanceRepository(fixture.database, false);
    expect((await maintenance.getNextWakeup(windows)).nextAt!.getTime()).toBeLessThan(Date.now());
    vectors.clear();
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 1, repairQueued: 1 });
    const task = await fixture.database.prepare("SELECT payload FROM external_tasks").first<{ payload: string }>();
    expect(JSON.parse(task!.payload)).toMatchObject({ message: { type: "reindex_video_transcript", payload: { video_id: 1 } } });
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 0, repairQueued: 0 });
    await fixture.database.prepare("UPDATE scene_index_tasks SET verified_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert'").run();
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 1, repairQueued: 0 });
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM external_tasks").first("count")).toBe(1);
  });

  it("keeps verification retryable without storing raw provider errors", async () => {
    await publish("run"); await sync();
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert'").run();
    getByIds.mockRejectedValueOnce(new Error("test-provider-secret"));
    await expect(reconcileMissingSceneVectors(fixture.database, index, 1536)).rejects.toThrow("Vectorize index verification failed");
    expect(await fixture.database.prepare("SELECT verified_at FROM scene_index_tasks WHERE operation='upsert'").first("verified_at")).toBeNull();
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 1, repairQueued: 0 });
  });

});
