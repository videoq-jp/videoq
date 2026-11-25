import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Vectorize } from "@cloudflare/workers-types";
import { createD1Fixture } from "./d1-fixture";
import { createD1SceneIndexWriter, finishD1WorkerSceneIndex } from "../../src/persistence/d1/scene-index-writer";
import { createD1SceneIndexTaskRepository } from "../../src/persistence/d1/scene-index-tasks";
import { synchronizeD1SceneIndex } from "../../src/persistence/d1/scene-index-sync";
import { maintainD1SceneIndex } from "../../src/persistence/d1/scene-index-maintenance";
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
const readVectors = async (ids: string[]) => {
  if (ids.length > 20) throw new Error("Vectorize getByIds accepts at most 20 IDs");
  return ids.flatMap(id => vectors.has(id) ? [vectors.get(id)!] : []);
};
const getByIds = vi.fn(readVectors);
const queryById = vi.fn(async (id: string) => ({ matches: vectors.has(id) ? [{ ...vectors.get(id)!, score: 1 }] : [] }));
const index = { upsert, deleteByIds, getByIds, queryById, query: () => Promise.resolve({ matches: [...vectors.values()].map(value => ({ ...value, score: value.id === "forged-version" ? 0.99 : 0.9 })) }) } as unknown as Vectorize;
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
  upsert.mockClear(); deleteByIds.mockClear(); getByIds.mockReset(); queryById.mockReset();
  getByIds.mockImplementation(readVectors);
  queryById.mockImplementation(async id => ({ matches: vectors.has(id) ? [{ ...vectors.get(id)!, score: 1 }] : [] }));
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
  it("finishes a propagated video while older bulk delivery and deletion backlogs both make progress", async () => {
    await fixture.database.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
    await publish("awaiting-propagation");
    queryById.mockResolvedValue({ matches: [] });
    expect(await sync(1)).toMatchObject({ pending: 1 });
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2001-01-01T00:00:00.000Z'").run();
    await fixture.database.prepare(`INSERT INTO videos(id,user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES (2,'owner','','Bulk','','2020-01-01','Source','indexing','','uploaded','','')`).run();
    const bulkSource = (await writer.readSource(2, "owner"))!;
    expect(await writer.start({ runId: "bulk", userId: "owner", videoId: 2, sourceRevision: bulkSource.sourceRevision, dimensions: 1536, expectedScenes: 20 })).toBe(true);
    expect(await writer.stage("bulk", "owner", Array.from({ length: 20 }, (_, i) => ({ ...scene(), id: "bulk-" + i })))).toBe(true);
    expect(await writer.publish("bulk", "owner")).toBe(true);
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE video_id=2").run();
    await fixture.database.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<20)
      INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,available_at)
      SELECT 'delete-backlog-'||n,'delete','old-vector-'||n,'old-scene-'||n,'obsolete',1,'owner',1536,
        '1999-01-01T00:00:00.000Z' FROM rows`).run();
    queryById.mockImplementation(async id => ({ matches: vectors.has(id) ? [{ ...vectors.get(id)!, score: 1 }] : [] }));
    upsert.mockClear();
    expect(await synchronizeD1SceneIndex(fixture.database, { 1536: index }, 3, { concurrency: 3 })).toMatchObject({ claimed: 3, completed: 3, failed: 0, leaseLost: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(await finishD1WorkerSceneIndex(fixture.database, { videoId: 1, userId: "owner", sourceRevision, fileKey: "", dimensions: 1536 })).toBe("completed");
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE video_id=2 AND attempts=0").first("n")).toBe(19);
  });

  it("retains the active fingerprint gate when scheduled maintenance drains a bulk page", async () => {
    await publish("legacy-maintenance");
    const result = await maintainD1SceneIndex(fixture.database, { 1536: index }, 1536, "a".repeat(64));
    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(upsert).not.toHaveBeenCalled();
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE completed_at IS NOT NULL").first("n")).toBe(0);
  });

  it("drains a bulk page concurrently with unique D1 leases and awaits every provider write", async () => {
    const count = 16;
    expect(await writer.start({ runId: "parallel-bulk", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: count })).toBe(true);
    expect(await writer.stage("parallel-bulk", "owner", Array.from({ length: count }, (_, i) => ({ ...scene(), id: "bulk-" + i })))).toBe(true);
    expect(await writer.publish("parallel-bulk", "owner")).toBe(true);
    let active = 0, maximum = 0;
    let release!: () => void;
    const firstPage = new Promise<void>(resolve => { release = resolve; });
    upsertHook = async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) release();
      await firstPage;
      active--;
    };
    expect(await maintainD1SceneIndex(fixture.database, { 1536: index }, 1536)).toMatchObject({ claimed: count, completed: count, failed: 0, leaseLost: 0 });
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(new Set(upsert.mock.calls.flatMap(([rows]) => rows.map(row => row.id))).size).toBe(count);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE attempts=1 AND completed_at IS NOT NULL").first("n")).toBe(count);
  }, 30_000);

  it("publishes an already-queryable staging run without a negative counter or a redundant completion job", async () => {
    await fixture.database.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
    expect(await writer.start({ runId: "ready-before-publish", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: 2 })).toBe(true);
    expect(await writer.stage("ready-before-publish", "owner", [0, 1].map(i => ({ ...scene(), id: "pre-" + i })))).toBe(true);
    expect(await sync()).toMatchObject({ completed: 2, pending: 0, failed: 0 });
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs").first("pending_vectors")).toBe(0);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(0);
    expect(await writer.publish("ready-before-publish", "owner")).toBe(true);
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs").first("pending_vectors")).toBe(0);
    expect(await finishD1WorkerSceneIndex(fixture.database, { videoId: 1, userId: "owner", sourceRevision, fileKey: "", dimensions: 1536 })).toBe("completed");
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(0);
  });
  it("requires every scene to be queryable, preserves accepted writes and queues completion exactly once", async () => {
    await fixture.database.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
    expect(await writer.start({ runId: "visibility", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: 3 })).toBe(true);
    expect(await writer.stage("visibility", "owner", [0, 1, 2].map(i => ({ ...scene(), id: "scene-" + i })))).toBe(true);
    expect(await writer.publish("visibility", "owner")).toBe(true);
    const visible = new Set<string>();
    queryById.mockImplementation(async id => ({ matches: visible.has(id) ? [{ ...vectors.get(id)!, score: 1 }] : [] }));
    const finish = () => finishD1WorkerSceneIndex(fixture.database, { videoId: 1, userId: "owner", sourceRevision, fileKey: "", dimensions: 1536 });
    expect(await sync()).toMatchObject({ claimed: 3, completed: 0, pending: 3, failed: 0 });
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs WHERE id='visibility'").first("pending_vectors")).toBe(3);
    expect(vectors.size).toBe(3);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE accepted_at IS NOT NULL AND completed_at IS NULL AND embedding IS NULL").first("n")).toBe(3);
    expect(await finish()).toBe("pending");
    visible.add([...vectors.keys()][0]);
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect(await sync()).toMatchObject({ completed: 1, pending: 2 });
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs WHERE id='visibility'").first("pending_vectors")).toBe(2);
    expect(await finish()).toBe("pending");
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(0);
    vectors.forEach((_, id) => visible.add(id));
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect(await sync()).toMatchObject({ completed: 2, pending: 0 });
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs WHERE id='visibility'").first("pending_vectors")).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
    expect(JSON.parse((await fixture.database.prepare("SELECT payload FROM external_tasks").first<string>("payload"))!)).toMatchObject({ message: { type: "index_video_transcript", payload: { video_id: 1 } } });
    expect(await finish()).toBe("completed");
    expect(await finish()).toBe("completed");
    expect((await sync()).claimed).toBe(0);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
  });
  it("replays a cleared legacy payload without regenerating embeddings after the readiness migration", async () => {
    await publish("legacy"); await sync();
    await fixture.database.prepare("UPDATE scene_index_tasks SET accepted_at=NULL WHERE operation='upsert'").run();
    const statements = readFileSync(new URL("../../drizzle-d1/0019_scene_search_readiness.sql", import.meta.url), "utf8")
      .split("--> statement-breakpoint").map(sql => sql.trim()).filter(sql => sql.startsWith("UPDATE"));
    await fixture.database.batch(statements.map(sql => fixture.database.prepare(sql)));
    expect(await fixture.database.prepare("SELECT status FROM videos WHERE id=1").first("status")).toBe("indexing");
    expect(await fixture.database.prepare("SELECT completed_at FROM scene_index_tasks WHERE operation='upsert'").first("completed_at")).toBeNull();
    upsert.mockClear();
    expect(await sync()).toMatchObject({ completed: 1, failed: 0, pending: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0][0].values).toEqual(embedding);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
    expect(await finishD1WorkerSceneIndex(fixture.database, { videoId: 1, userId: "owner", sourceRevision, fileKey: "", dimensions: 1536 })).toBe("completed");
  });
  it("rolls back readiness completion when its durable completion job cannot be recorded", async () => {
    await fixture.database.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
    await publish("atomic-ready");
    await fixture.database.prepare("CREATE TRIGGER fail_ready BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END").run();
    expect(await sync()).toMatchObject({ completed: 0, failed: 1 });
    expect(await fixture.database.prepare("SELECT pending_vectors FROM scene_index_runs WHERE id='atomic-ready'").first("pending_vectors")).toBe(1);
    expect(await fixture.database.prepare("SELECT completed_at FROM scene_index_tasks WHERE operation='upsert'").first("completed_at")).toBeNull();
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM mutation_receipts").first("n")).toBe(0);
    await fixture.database.prepare("DROP TRIGGER fail_ready").run();
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect(await sync()).toMatchObject({ completed: 1, pending: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
  });
  it("does not replay a stored vector whose ownership metadata differs from its durable task", async () => {
    await publish("replay-owner"); await sync();
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at=NULL,accepted_at=NULL").run();
    upsert.mockClear();
    const stored = [...vectors.values()][0];
    getByIds.mockResolvedValueOnce([{ ...stored, metadata: { ...stored.metadata, user_id: "foreign" } }]);
    expect(await sync()).toMatchObject({ completed: 0, failed: 1 });
    expect(upsert).not.toHaveBeenCalled();
    expect(await fixture.database.prepare("SELECT completed_at FROM scene_index_tasks").first("completed_at")).toBeNull();
    vectors.set(stored.id, { ...stored, metadata: { ...stored.metadata, user_id: "foreign" } });
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 1, repairQueued: 1 });
  });
  it("queues source reconstruction when a cleared legacy task has lost its stored vector", async () => {
    await publish("missing-legacy"); await sync();
    vectors.clear();
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at=NULL,accepted_at=NULL").run();
    expect(await sync()).toMatchObject({ completed: 0, failed: 1 });
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 1, repairQueued: 1 });
    const payload = await fixture.database.prepare("SELECT payload FROM external_tasks").first<string>("payload");
    expect(JSON.parse(payload!)).toMatchObject({ message: { type: "reindex_video_transcript", payload: { video_id: 1 } } });
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: 0, repairQueued: 0 });
  });
  it("does not enqueue completion for a source changed during the ANN check", async () => {
    await fixture.database.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
    await publish("changed-during-check");
    queryById.mockImplementationOnce(async id => {
      await fixture.database.prepare("UPDATE video_index_versions SET revision='new-source' WHERE video_id=1").run();
      return { matches: [{ ...vectors.get(id)!, score: 1 }] };
    });
    expect(await sync()).toMatchObject({ completed: 1 });
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(0);
    expect(await finishD1WorkerSceneIndex(fixture.database, { videoId: 1, userId: "owner", sourceRevision, fileKey: "", dimensions: 1536 })).toBe("stale");
    expect(await fixture.database.prepare("SELECT status FROM videos WHERE id=1").first("status")).toBe("indexing");
  });
  it("rechecks D1 authorization when an accepted mutation becomes queryable after account deactivation", async () => {
    await publish("delayed-visibility");
    const accepted: Vector[] = [];
    upsert.mockImplementationOnce(async values => {
      accepted.push(...values);
      return { mutationId: "accepted-not-queryable" };
    });
    expect(await sync()).toMatchObject({ completed: 0, pending: 1, failed: 0 });
    expect(accepted).toHaveLength(1);
    expect(vectors.size).toBe(0);
    // A successful V2 mutation receipt does not imply ANN visibility.
    expect(await search()).toEqual([]);
    await fixture.database.prepare("UPDATE users SET deactivated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='owner'").run();
    accepted.forEach(value => vectors.set(value.id, value));
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z'").run();
    expect(await sync()).toMatchObject({ completed: 1, pending: 0, failed: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(await index.getByIds(accepted.map(value => value.id))).toHaveLength(1);
    expect(await search()).toEqual([]);
    // Prove the empty result came from the D1 gate, rather than a missing candidate.
    await fixture.database.prepare("UPDATE users SET deactivated_at=NULL WHERE id='owner'").run();
    expect(await search()).toMatchObject([{ content: "Authoritative D1 content" }]);
  });
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
  it("bounds parallel workers, preserves the total claim limit and completes each immutable vector once", async () => {
    expect(await writer.start({ runId: "parallel", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: 8 })).toBe(true);
    expect(await writer.stage("parallel", "owner", Array.from({ length: 8 }, (_, i) => ({ ...scene(), id: "scene-" + i })))).toBe(true);
    expect(await writer.publish("parallel", "owner")).toBe(true);
    let active = 0, peak = 0;
    upsertHook = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 30)); active--; };
    expect(await synchronizeD1SceneIndex(fixture.database, {1536:index}, 6, {concurrency:3})).toEqual({claimed:6,completed:6,pending:0,failed:0,leaseLost:0});
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(3); expect(active).toBe(0); expect(vectors.size).toBe(6);
    expect(await synchronizeD1SceneIndex(fixture.database, {1536:index}, 10, {concurrency:4})).toEqual({claimed:2,completed:2,pending:0,failed:0,leaseLost:0});
    expect(vectors.size).toBe(8);
    expect(await fixture.database.prepare("SELECT count(*) FROM scene_index_tasks WHERE attempts<>1 OR completed_at IS NULL OR lease_token IS NOT NULL").first("count(*)")).toBe(0);
  });
  it("waits for an already started provider write when a parallel DB claim fails", async () => {
    await publish("parallel-failure");
    let release!: () => void, entered!: () => void, settled = false, calls = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    upsertHook = async () => { entered(); await waiting; };
    const database = new Proxy(fixture.database, {get(target,key) {
      if (key === "prepare") return (sql: string) => {
        if (/^update "?scene_index_tasks"? set .*"?attempts"?\s*=/i.test(sql) && ++calls === 2) throw new Error("synthetic-claim-failure");
        return target.prepare(sql);
      };
      const value: unknown = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
    }});
    const outcome = synchronizeD1SceneIndex(database,{1536:index},3,{concurrency:3}).then(
      value => { settled = true; return {value,error:undefined}; },
      (error: unknown) => { settled = true; return {value:undefined,error}; },
    );
    await started; expect(settled).toBe(false); release();
    expect((await outcome).error).toMatchObject({message:"synthetic-claim-failure"});
    expect(vectors.size).toBe(1);
    expect(await fixture.database.prepare("SELECT count(*) FROM scene_index_tasks WHERE completed_at IS NULL OR lease_token IS NOT NULL").first("count(*)")).toBe(0);
  });
  it("rejects invalid parallelism before claiming tasks", async () => {
    for (const concurrency of [0,-1,1.5,9,NaN]) await expect(synchronizeD1SceneIndex(fixture.database, {}, 10, {concurrency})).rejects.toThrow("concurrency");
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
  it("compensates a late write even after its expired lease was replaced and completed during deletion", async () => {
    await publish("late-expired");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    upsertHook = () => { entered(); return waiting; };
    const oldWorker = sync(1);
    await started;
    await fixture.database.prepare("UPDATE scene_index_tasks SET lease_until='2000-01-01T00:00:00.000Z'").run();
    const tasks = createD1SceneIndexTaskRepository(fixture.database), replacement = (await tasks.claim())!;
    expect(replacement).toBeTruthy();
    expect((await deleteVideoCascade({ DEPLOYMENT_EDITION: "cloud", DB: fixture.database } as Bindings, 1, "owner")).deleted).toBe(true);
    await index.deleteByIds([replacement.vectorId]);
    expect(await tasks.complete(replacement)).toBe(true);
    release();
    expect(await oldWorker).toMatchObject({ leaseLost: 1, completed: 0 });
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
    // Hold the new upsert until the old delete is in flight; ingestion now has
    // a reserved claim slot and would otherwise run before this race begins.
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2099-01-01T00:00:00.000Z' WHERE operation='upsert' AND completed_at IS NULL").run();
    const oldDelete = sync(1);
    await entered;
    deleteHook = undefined;
    await fixture.database.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert' AND completed_at IS NULL").run();
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
  it("reserves ingestion capacity while older deletion work still progresses", async () => {
    await fixture.database.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<20)
      INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,available_at)
      SELECT 'delete-backlog-'||n,'delete','old-vector-'||n,'old-scene-'||n,'obsolete',1,'owner',1536,
        '2020-01-01T00:00:00.000Z' FROM rows`).run();
    await publish("new-ingestion");
    const result = await sync(10);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(deleteByIds).toHaveBeenCalledTimes(9);
    expect(result.completed).toBe(10);
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM scene_index_tasks WHERE operation='delete' AND completed_at IS NULL").first("count")).toBe(11);
  });
  it("reconciles more than 100 obsolete vectors within D1's parameter limit", async () => {
    await publish("active"); await sync();
    await fixture.database.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<105)
      INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,completed_at)
      SELECT 'obsolete-'||n,'upsert','old-vector-'||n,'old-scene-'||n,'obsolete',1,'owner',1536,
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM rows`).run();
    let maximumParameters=0;
    const bounded=new Proxy(fixture.database, {get(target,key){
      if(key==='prepare')return (query:string)=>{
        const statement=target.prepare(query);
        return new Proxy(statement,{get(prepared,method){
          if(method==='bind')return (...parameters:unknown[])=>{
            maximumParameters=Math.max(maximumParameters,parameters.length);
            if(parameters.length>100)throw new Error('D1 bound parameter limit exceeded');
            return prepared.bind(...parameters);
          };
          const value=Reflect.get(prepared,method);
          return typeof value==='function'?value.bind(prepared):value;
        }});
      };
      const value=Reflect.get(target,key);
      return typeof value==='function'?value.bind(target):value;
    }});
    const tasks=createD1SceneIndexTaskRepository(bounded);
    expect(await tasks.reconcileObsolete()).toBe(100);
    expect(await tasks.reconcileObsolete()).toBe(5);
    expect(await tasks.reconcileObsolete()).toBe(0);
    expect(maximumParameters).toBeLessThanOrEqual(100);
    expect(await fixture.database.prepare("SELECT count(*) AS count FROM scene_index_tasks WHERE operation='delete'").first('count')).toBe(105);
    expect(await search()).toMatchObject([{content:'Authoritative D1 content'}]);
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

  it.each([21, 50, 100])("verifies all %i due scenes within Vectorize's request limit", async count => {
    expect(await writer.start({ runId: "batch-verification", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: count })).toBe(true);
    const scenes = Array.from({ length: count }, (_, i) => ({ ...scene(), id: "scene-" + i }));
    for (let offset = 0; offset < scenes.length; offset += 20) {
      expect(await writer.stage("batch-verification", "owner", scenes.slice(offset, offset + 20))).toBe(true);
    }
    expect(await writer.publish("batch-verification", "owner")).toBe(true);
    expect(await sync(count)).toMatchObject({ completed: count, failed: 0 });
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert'").run();
    getByIds.mockClear();
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536, count)).toEqual({ verified: count, repairQueued: 0 });
    const requested = getByIds.mock.calls.flatMap(([ids]) => ids);
    expect(getByIds.mock.calls.every(([ids]) => ids.length <= 20)).toBe(true);
    expect(new Set(requested)).toEqual(new Set(vectors.keys()));
    expect(requested).toHaveLength(count);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE verified_at IS NOT NULL").first("n")).toBe(count);
  }, 30_000);

  it("retries the whole verification page when a later Vectorize batch fails", async () => {
    const count = 21;
    expect(await writer.start({ runId: "batch-failure", userId: "owner", videoId: 1, sourceRevision, dimensions: 1536, expectedScenes: count })).toBe(true);
    const scenes = Array.from({ length: count }, (_, i) => ({ ...scene(), id: "scene-" + i }));
    for (let offset = 0; offset < scenes.length; offset += 20) {
      expect(await writer.stage("batch-failure", "owner", scenes.slice(offset, offset + 20))).toBe(true);
    }
    expect(await writer.publish("batch-failure", "owner")).toBe(true);
    expect(await sync(count)).toMatchObject({ completed: count });
    await fixture.database.prepare("UPDATE scene_index_tasks SET completed_at='2000-01-01T00:00:00.000Z' WHERE operation='upsert'").run();
    getByIds.mockImplementationOnce(readVectors).mockRejectedValueOnce(new Error("test-provider-secret"));
    await expect(reconcileMissingSceneVectors(fixture.database, index, 1536)).rejects.toThrow("Vectorize index verification failed");
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE verified_at IS NOT NULL").first("n")).toBe(0);
    expect(await fixture.database.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(0);
    expect(await reconcileMissingSceneVectors(fixture.database, index, 1536)).toEqual({ verified: count, repairQueued: 0 });
  }, 30_000);

});
