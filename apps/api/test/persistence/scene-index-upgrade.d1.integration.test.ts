import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Vectorize, VectorizeVector } from "@cloudflare/workers-types";
import { createD1Fixture } from "./d1-fixture";
import { synchronizeD1SceneIndex } from "../../src/persistence/d1/scene-index-sync";
import { finishD1WorkerSceneIndex } from "../../src/persistence/d1/scene-index-writer";

let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
beforeAll(async () => { fixture = await createD1Fixture({ beforeMigration: "0019_scene_search_readiness.sql" }); });
afterAll(async () => { await fixture?.dispose(); });

it("upgrades populated pre-readiness tables and resumes only the affected video without new embeddings", async () => {
  const db = fixture.database;
  await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)").run();
  for (const id of [1, 2]) await db.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(?,'owner','Legacy','legacy.mp4','completed','original','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'','uploaded','','')").bind(id).run();
  await db.prepare("INSERT INTO video_index_versions(video_id,revision) VALUES(1,'source')").run();
  await db.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status) VALUES('legacy',1,'owner','source',1536,2,'published')").run();
  await db.prepare("INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(1,1536,'legacy')").run();
  const stored = new Map<string, VectorizeVector>();
  for (const [i, id] of ["a".repeat(64), "b".repeat(64)].entries()) {
    const sceneId = "scene-" + i;
    await db.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision,vector_id) VALUES(?,1,?,'00:01','00:02',1536,'legacy',?)").bind(sceneId, "Original " + i, id).run();
    await db.prepare("INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions,embedding,completed_at,attempts) VALUES(?,'upsert',?,?,'legacy',1,'owner',1536,NULL,'2026-11-14T00:00:00Z',2)").bind("u:1536:" + id, id, sceneId).run();
    stored.set(id, { id, values: Float32Array.from({ length: 1536 }, () => .123456789), metadata: { user_id: "owner", video_id: 1, scene_id: sceneId, revision: "legacy", vector_id: id, text: "" } });
  }
  const sql = readFileSync(new URL("../../drizzle-d1/0019_scene_search_readiness.sql", import.meta.url), "utf8");
  await db.batch(sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean).map(value => db.prepare(value)));
  expect((await db.prepare("SELECT id,status FROM videos ORDER BY id").all()).results).toEqual([{ id: 1, status: "indexing" }, { id: 2, status: "completed" }]);
  expect(await db.prepare("SELECT pending_vectors FROM scene_index_runs").first("pending_vectors")).toBe(2);
  expect(await db.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE accepted_at IS NULL AND completed_at IS NULL").first("n")).toBe(2);
  const input = { videoId: 1, userId: "owner", sourceRevision: "source", fileKey: "legacy.mp4", dimensions: 1536 as const };
  expect(await finishD1WorkerSceneIndex(db, input)).toBe("pending");
  let writes = 0;
  const index = {
    getByIds: async (ids: string[]) => ids.flatMap(id => stored.has(id) ? [stored.get(id)!] : []),
    upsert: async (vectors: VectorizeVector[]) => { for (const vector of vectors) { writes++; stored.set(vector.id, vector); } return { mutationId: "synthetic" }; },
    queryById: async (id: string) => ({ matches: [{ ...stored.get(id)!, score: 1 }] }),
  } as unknown as Vectorize;
  expect(await synchronizeD1SceneIndex(db, { 1536: index })).toMatchObject({ completed: 2, pending: 0, failed: 0 });
  expect(writes).toBe(2);
  expect([...stored.values()].every(vector => Array.from(vector.values).every(value => value === Math.fround(.123456789)))).toBe(true);
  expect(await db.prepare("SELECT pending_vectors FROM scene_index_runs").first("pending_vectors")).toBe(0);
  expect(await db.prepare("SELECT count(*) AS n FROM external_tasks").first("n")).toBe(1);
  expect(await finishD1WorkerSceneIndex(db, input)).toBe("completed");
  expect((await db.prepare("SELECT content FROM scenes ORDER BY id").all()).results).toEqual([{ content: "Original 0" }, { content: "Original 1" }]);
}, 20_000);
