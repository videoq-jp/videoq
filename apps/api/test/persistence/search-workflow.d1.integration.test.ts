import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { createD1Fixture } from './d1-fixture';
import type { Bindings } from '../../src/types/bindings';

// Use the real workflow body and D1 migrations, with a durable-step simulator to
// inject a lost acknowledgement. Workerd platform tests cover the entrypoint.
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {
  constructor(_ctx: unknown, public env: Bindings) {}
} }));
const { SearchIndexWorkflow } = await import('../../src/workflows/search-index');
let fixture: Awaited<ReturnType<typeof createD1Fixture>>;
let objects: Map<string, string>;
let calls: number;
let env: Bindings;
const job = { type:'reindex_video_transcript',job_id:'workflow-test',payload:{video_id:1} };
const event = { payload:job } as WorkflowEvent<unknown>;
function simulator(lostAck?: string) {
  const results = new Map<string,unknown>();
  let injected = false;
  return {
    results,
    step: { sleep: vi.fn(() => Promise.resolve()), do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
      if (results.has(name)) return structuredClone(results.get(name));
      const value = await callback();
      if (name === lostAck && !injected) { injected = true; throw new Error('Lost step acknowledgement'); }
      results.set(name,structuredClone(value));return value;
    } } as WorkflowStep,
  };
}
const workflow = () => new SearchIndexWorkflow({} as ExecutionContext,env);
beforeEach(async()=>{
  fixture=await createD1Fixture();objects=new Map();calls=0;
  await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.invalid',0,0,0,0)").run();
  await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Synthetic','','','2026-01-01',?,'completed','','uploaded','','')").bind('1\n00:00:00,000 --> 00:00:01,000\n標本化とは\n').run();
  env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:fixture.database,EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_PROFILE:'embeddinggemma2',
    VIDEO_BUCKET:{
      put:async(key:string,value:string)=>{objects.set(key,value);return {};},
      head:async(key:string)=>objects.has(key)?{}:null,
      list:async(options:{prefix:string})=>({objects:[...objects.keys()].filter(key=>key.startsWith(options.prefix)).map(key=>({key})),truncated:false}),
      get:async(key:string)=>{const value=objects.get(key);return value===undefined?null:{json:async()=>JSON.parse(value)};},
      delete:async(keys:string[])=>{for(const key of keys)objects.delete(key);},
    },
    AI:{run:async(_model:unknown,input:{input:string[]})=>{calls++;return Response.json({data:input.input.map((_,index)=>({index,embedding:[1,...Array(767).fill(0)]}))});}},
  } as unknown as Bindings;
});
afterEach(async()=>{await fixture.dispose();});
describe('resumable search workflow with actual D1 persistence',()=>{
  it('publishes scenes, completes the stable job and removes intermediate artifacts',async()=>{
    const {step}=simulator();await workflow().run(event,step);
    expect(calls).toBe(1);expect(objects.size).toBe(0);
    expect(await fixture.database.prepare("SELECT status FROM job_executions WHERE job_id='workflow-test'").first('status')).toBe('completed');
    expect(await fixture.database.prepare("SELECT content FROM scenes WHERE video_id=1").first('content')).toBe('標本化とは');
    await workflow().run(event,step);expect(calls).toBe(1);
  });
  it('reuses exact saved vectors after stage succeeds but its acknowledgement is lost',async()=>{
    const {step}=simulator('embed-stage-0');
    await expect(workflow().run(event,step)).rejects.toThrow('Lost step acknowledgement');
    expect(calls).toBe(1);expect(objects.size).toBe(3);
    await workflow().run(event,step);
    expect(calls).toBe(1);expect(objects.size).toBe(0);
    expect(await fixture.database.prepare('SELECT count(*) AS n FROM scenes WHERE video_id=1').first('n')).toBe(1);
  });
  it.each(['load-source','prepare-scenes','start-scene-run','publish-scene-run','complete-job','remove-workflow-artifacts'])('recovers a lost %s acknowledgement',async phase=>{
    const {step}=simulator(phase);
    await expect(workflow().run(event,step)).rejects.toThrow('Lost step acknowledgement');
    await workflow().run(event,step);
    expect(calls).toBe(1);expect(objects.size).toBe(0);
    expect(await fixture.database.prepare("SELECT status FROM job_executions WHERE job_id='workflow-test'").first('status')).toBe('completed');
  });
  it('checkpoints semantic splitting batches before preparing scenes',async()=>{
    const text='標本化と量子化を用いて画像を離散的に表現します。'.repeat(18);
    const transcript=Array.from({length:3},(_,i)=>`${i+1}\n00:00:0${i},000 --> 00:00:0${i+1},000\n${text}\n`).join('\n');
    await fixture.database.prepare('UPDATE videos SET transcript=? WHERE id=1').bind(transcript).run();
    const {step}=simulator('split-embeddings-0');
    await expect(workflow().run(event,step)).rejects.toThrow('Lost step acknowledgement');
    expect(calls).toBe(1);
    await workflow().run(event,step);
    expect(calls).toBe(2);expect(objects.size).toBe(0);
    expect(await fixture.database.prepare("SELECT status FROM job_executions WHERE job_id='workflow-test'").first('status')).toBe('completed');
  });
  it('retries transient artifact reads without checkpointing large data',async()=>{
    vi.spyOn(env.VIDEO_BUCKET!, 'get').mockRejectedValueOnce(new Error('temporary R2 failure'));
    const {step}=simulator();await workflow().run(event,step);
    expect(step.sleep).toHaveBeenCalledOnce();expect(calls).toBe(1);expect(objects.size).toBe(0);
  });
  it('records exhausted workflows in the failure queue with the stable job identity',async()=>{
    const send=vi.fn(async()=>{});env.SEARCH_FAILURES={send} as unknown as Queue;
    const {step}=simulator('embed-stage-0');
    await expect(workflow().run(event,step)).rejects.toThrow('Lost step acknowledgement');
    expect(send).toHaveBeenCalledWith({workflowId:event.instanceId,message:job,errorCode:'SEARCH_WORKFLOW_FAILED'});
  });
  it('does not reuse a prepared manifest from an older run after an explicit restart',async()=>{
    await expect(workflow().run(event,simulator('embed-stage-0').step)).rejects.toThrow();
    await fixture.database.prepare('UPDATE videos SET transcript=? WHERE id=1').bind('1\n00:00:00,000 --> 00:00:01,000\n新しい字幕\n').run();
    await fixture.database.prepare('UPDATE video_index_versions SET revision=? WHERE video_id=1').bind(crypto.randomUUID()).run();
    await workflow().run(event,simulator().step);
    expect(await fixture.database.prepare('SELECT content FROM scenes WHERE video_id=1').first('content')).toBe('新しい字幕');
    expect(calls).toBe(2);expect(objects.size).toBe(0);
  });
  it('rejects a source revision change between preparation and publication',async()=>{
    const {step}=simulator('embed-stage-0');
    await expect(workflow().run(event,step)).rejects.toThrow();
    await fixture.database.prepare("UPDATE video_index_versions SET revision=? WHERE video_id=1").bind(crypto.randomUUID()).run();
    await expect(workflow().run(event,step)).rejects.toThrow('source changed');
    expect(await fixture.database.prepare('SELECT count(*) AS n FROM scenes WHERE video_id=1').first('n')).toBe(0);
  });
});
