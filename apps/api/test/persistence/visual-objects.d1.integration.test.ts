import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { createD1Fixture } from "./d1-fixture";
import { createD1VisualCheckpoints } from "../../src/persistence/d1/visual-checkpoints";
import { createVisualObjectCleanup } from "../../src/persistence/d1/visual-objects";
import { maintainD1VisualObjects,visualObjectKeys } from "../../src/persistence/d1/visual-object-maintenance";
import { createD1MaintenanceRepository } from "../../src/persistence/d1/maintenance-repository";
let f:Awaited<ReturnType<typeof createD1Fixture>>;
let repo:ReturnType<typeof createD1VisualCheckpoints>;
let runId:string;
beforeEach(async()=>{
  f=await createD1Fixture(); repo=createD1VisualCheckpoints(f.database);
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  await f.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
  runId=(await repo.initialize(1,'file.mp4',60_000))!.runId;
});
afterEach(async()=>{await f?.dispose();});
const expire=async()=>{await f.database.prepare("UPDATE visual_object_attempts SET expires_at='2000-01-01T00:00:00Z',available_at='2000-01-01T00:00:00Z'").run();};
describe('D1 durable visual object recovery',()=>{
  it('requires registration and collects an expired PUT attempt without publishing it',async()=>{
    const version=crypto.randomUUID();
    expect(await repo.publishChunk(1,runId,0,1,version)).toEqual({current:true,objectVersion:null});
    expect(await repo.beginObject(1,runId,version,0)).toBe(true);
    await expire();
    const remove=vi.fn(async(key:string)=>{expect(key).toContain(".visual-v2/");});
    expect(await maintainD1VisualObjects(f.database,remove)).toEqual({claimed:1,cleaned:1,failed:0});
    expect(remove.mock.calls.map(call=>call[0])).toEqual([
      `file.mp4.visual-v2/${runId}/0/${version}.bin`,`file.mp4.visual-v2/${runId}/0/${version}.json`,
    ]);
    expect((await repo.publishChunk(1,runId,0,1,version)).objectVersion).toBeNull();
    expect(await repo.beginObject(1,runId,version,0)).toBe(false);
  });
  it('protects the adopted version and retains cleanup identity after deletion',async()=>{
    const version=crypto.randomUUID();
    await repo.beginObject(1,runId,version,0);
    await repo.publishChunk(1,runId,0,1,version);
    await expire();
    const remove=vi.fn(async(key:string)=>{expect(key).toContain(".visual-v2/");});
    expect((await maintainD1VisualObjects(f.database,remove)).claimed).toBe(0);
    await f.database.prepare('DELETE FROM videos').run();
    expect((await maintainD1VisualObjects(f.database,remove)).cleaned).toBe(1);
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('fences cleanup leases and blocks adoption while deletion is active',async()=>{
    const version=crypto.randomUUID();
    await repo.beginObject(1,runId,version,0); await expire();
    const cleanup=createVisualObjectCleanup(f.database);
    const old=(await cleanup.claim())!;
    expect((await repo.publishChunk(1,runId,0,1,version)).objectVersion).toBeNull();
    await f.database.prepare("UPDATE visual_object_attempts SET lease_until='2000-01-01T00:00:00Z'").run();
    const next=(await cleanup.claim())!;
    expect(await cleanup.complete(old)).toBe(false);
    expect(await cleanup.complete(next)).toBe(true);
  });
  it('recovers an expired manifest and permits a new immutable publication',async()=>{
    await repo.beginObject(1,runId,runId);
    await expire();
    const cleanup=createVisualObjectCleanup(f.database);
    const task=(await cleanup.claim())!;
    expect(await repo.beginObject(1,runId,runId)).toBe(false);
    expect(await repo.ready(1,runId,runId)).toBe(false);
    await cleanup.complete(task);
    expect(await repo.beginObject(1,runId,runId)).toBe(false);
    const publication=crypto.randomUUID();
    expect(await repo.beginObject(1,runId,publication)).toBe(true);
    const version=crypto.randomUUID();
    await repo.beginObject(1,runId,version,0); await repo.publishChunk(1,runId,0,1,version);
    expect(await repo.ready(1,runId,publication)).toBe(true);
    expect(visualObjectKeys(task).every(key=>!key.includes(publication))).toBe(true);
    expect(visualObjectKeys(task).every(key=>key.includes(runId+'/publications/'+runId))).toBe(true);
    await expire();
    expect(await cleanup.claim()).toBeNull();
  });
  it('retries partial deletion without persisting raw provider errors',async()=>{
    await repo.beginObject(1,runId,crypto.randomUUID(),0); await expire();
    let calls=0;
    expect((await maintainD1VisualObjects(f.database,async()=>{if (++calls===2) throw new Error('token=secret');})).failed).toBe(1);
    expect(calls).toBe(2);
    expect(await f.database.prepare('SELECT last_error_code FROM visual_object_attempts').first('last_error_code')).toBe('VISUAL_OBJECT_DELETE_FAILED');
    await f.database.prepare("UPDATE visual_object_attempts SET available_at='2000-01-01T00:00:00Z'").run();
    expect((await maintainD1VisualObjects(f.database,async()=>{})).cleaned).toBe(1);
  });
  it('schedules expired writes but stops waking for current published objects',async()=>{
    const windows={leaseMs:300000,abandonedUploadMs:900000,staleInvitationMs:900000};
    const maintenance=createD1MaintenanceRepository(f.database,false);
    const version=crypto.randomUUID(); await repo.beginObject(1,runId,version,0);
    const wake=await maintenance.getNextWakeup(windows);
    expect(wake.nextAt!.getTime()).toBeGreaterThan(Date.now()+3_500_000);
    await repo.publishChunk(1,runId,0,1,version);
    expect((await maintenance.getNextWakeup(windows)).nextAt).toBeNull();
  });
  it('keeps the first manifest pointer and collects only a concurrent losing publication',async()=>{
    const chunk=crypto.randomUUID();
    await repo.beginObject(1,runId,chunk,0); await repo.publishChunk(1,runId,0,1,chunk);
    const first=crypto.randomUUID(),second=crypto.randomUUID();
    await repo.beginObject(1,runId,first); await repo.beginObject(1,runId,second);
    expect(await repo.ready(1,runId,first)).toBe(true);
    expect(await repo.ready(1,runId,second)).toBe(true);
    expect((await repo.load(1))!.publicationVersion).toBe(first);
    await expire();
    const removed:string[]=[];
    expect((await maintainD1VisualObjects(f.database,async key=>{removed.push(key);})).cleaned).toBe(1);
    expect(removed.every(key=>key.includes('/publications/'+second+'/'))).toBe(true);
  });

});
