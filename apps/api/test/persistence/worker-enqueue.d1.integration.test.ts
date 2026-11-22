import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { workerInternalRoutes } from '../../src/features/worker-internal/routes';
import type { AppEnv,Bindings } from '../../src/types/bindings';
const app=new Hono<AppEnv>().route('/internal/worker',workerInternalRoutes);
const secret='synthetic-enqueue-key-at-least-32-bytes';
const origin='https://internal.example.test',path='/internal/worker/jobs/enqueue';
const job={type:'index_video_transcript',job_id:'durable-index-job',payload:{video_id:42}};
let fixture:Awaited<ReturnType<typeof createD1Fixture>>;
function request(input:unknown,signed=true){
  const body=JSON.stringify(input),timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${path}\n${body}`).digest('hex');
  return new Request(origin+path,{method:'POST',body,headers:signed?{'x-videoq-worker-timestamp':timestamp,'x-videoq-worker-signature':signature}:{}});
}
beforeEach(async()=>{fixture=await createD1Fixture();});
afterEach(async()=>{await fixture.dispose();});
describe('media-to-TypeScript durable search handoff',()=>{
  it('persists the existing job identity before dispatch and deduplicates retries',async()=>{
    const send=vi.fn(async()=>{});
    const env={DB:fixture.database,DEPLOYMENT_EDITION:'cloud',WORKER_INTERNAL_API_SECRET:secret,SEARCH_JOB_BACKEND:'cloudflare',SEARCH_JOBS:{send}} as unknown as Bindings;
    for(let i=0;i<2;i++){
      const result=await app.fetch(request(job),env);expect(result.status).toBe(200);expect(await result.json()).toEqual({messageId:job.job_id});
    }
    expect(send).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledWith(job);
    expect(await fixture.database.prepare('SELECT count(*) AS n FROM external_tasks').first('n')).toBe(1);
  });
  it('keeps a durable pending task when queue delivery fails',async()=>{
    const env={DB:fixture.database,DEPLOYMENT_EDITION:'cloud',WORKER_INTERNAL_API_SECRET:secret,SEARCH_JOB_BACKEND:'cloudflare',SEARCH_JOBS:{send:async()=>{throw new Error('queue unavailable');}}} as unknown as Bindings;
    expect((await app.fetch(request(job),env)).status).toBe(200);
    const row=await fixture.database.prepare('SELECT completed_at,dead_at FROM external_tasks').first();
    expect(row).toEqual({completed_at:null,dead_at:null});
  });
  it('rejects unsigned requests, media execution and account deletion before persisting',async()=>{
    const env={DB:fixture.database,DEPLOYMENT_EDITION:'cloud',WORKER_INTERNAL_API_SECRET:secret} as unknown as Bindings;
    expect((await app.fetch(request(job,false),env)).status).toBe(401);
    for(const input of [{...job,type:'transcribe_video'},{type:'delete_account_data',job_id:'delete',payload:{user_id:'owner'}}]){
      expect((await app.fetch(request(input),env)).status).toBe(400);
    }
    expect(await fixture.database.prepare('SELECT count(*) AS n FROM external_tasks').first('n')).toBe(0);
  });
});
