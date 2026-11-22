import { afterEach,describe,expect,it,vi } from 'vitest';
import type { Bindings } from '../src/types/bindings';
vi.mock('../src/lib/sqs',()=>({sendSqsMessage:vi.fn(async()=> 'sqs-id')}));
vi.mock('../src/integrations/background-jobs/execute',()=>({runBackgroundJob:vi.fn(async()=>{}),sha256:async(value:string)=>value}));
import { sendSqsMessage } from '../src/lib/sqs';
import { deliverJob } from '../src/integrations/background-jobs/delivery';
import { consumeBackgroundJobs } from '../src/integrations/background-jobs/queue';
import { runBackgroundJob } from '../src/integrations/background-jobs/execute';
const search={type:'reindex_video_transcript',job_id:'job',payload:{video_id:1}};
const account={type:'delete_account_data',job_id:'delete',payload:{user_id:'owner'}};
afterEach(()=>vi.clearAllMocks());
describe('background transport cutover',()=>{
  it('keeps legacy delivery until explicitly switched',async()=>{
    expect(await deliverJob({} as Bindings,JSON.stringify(search))).toBe('sqs-id');
    expect(sendSqsMessage).toHaveBeenCalledOnce();
  });
  it('routes selected groups without moving media jobs',async()=>{
    const send=vi.fn(async()=>{});
    const env={SEARCH_JOB_BACKEND:'cloudflare',SEARCH_JOBS:{send}} as unknown as Bindings;
    expect(await deliverJob(env,JSON.stringify(search))).toBe('job');expect(send).toHaveBeenCalledWith(search);
    await deliverJob(env,JSON.stringify({type:'transcribe_video',job_id:'media',payload:{video_id:1}}));
    expect(sendSqsMessage).toHaveBeenCalledOnce();
  });
  it('does not silently send work to SQS after a selected Cloudflare queue fails',async()=>{
    const env={SEARCH_JOB_BACKEND:'cloudflare',SEARCH_JOBS:{send:vi.fn(async()=>{throw new Error('queue unavailable');})}} as unknown as Bindings;
    await expect(deliverJob(env,JSON.stringify(search))).rejects.toThrow('queue unavailable');expect(sendSqsMessage).not.toHaveBeenCalled();
  });
});
function message(body:unknown){return {body,attempts:1,ack:vi.fn(),retry:vi.fn()};}
function batch(value:ReturnType<typeof message>){return {messages:[value]} as unknown as MessageBatch<unknown>;}
describe('Cloudflare queue acknowledgement',()=>{
  it('acknowledges account work only after successful mutation',async()=>{
    const value=message(account);await consumeBackgroundJobs(batch(value),{} as Bindings);
    expect(runBackgroundJob).toHaveBeenCalledWith({},account);expect(value.ack).toHaveBeenCalledOnce();expect(value.retry).not.toHaveBeenCalled();
  });
  it('retries failed account work',async()=>{
    vi.mocked(runBackgroundJob).mockRejectedValueOnce(new Error('failure'));
    const value=message(account);await consumeBackgroundJobs(batch(value),{} as Bindings);
    expect(value.ack).not.toHaveBeenCalled();expect(value.retry).toHaveBeenCalledOnce();
  });
  it('creates one durable search workflow before acknowledging',async()=>{
    const create=vi.fn(async()=>({}));const value=message(search);
    await consumeBackgroundJobs(batch(value),{SEARCH_INDEX_WORKFLOW:{create}} as unknown as Bindings);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({params:search}));expect(value.ack).toHaveBeenCalledOnce();
  });
  it.each(['running','complete','errored','terminated'])('handles existing %s workflow safely',async status=>{
    const create=vi.fn(async()=>{throw new Error('exists');});
    const get=vi.fn(async()=>({status:async()=>({status})}));const value=message(search);
    await consumeBackgroundJobs(batch(value),{SEARCH_INDEX_WORKFLOW:{create,get}} as unknown as Bindings);
    if(['errored','terminated'].includes(status)){expect(value.ack).not.toHaveBeenCalled();expect(value.retry).toHaveBeenCalledOnce();}
    else expect(value.ack).toHaveBeenCalledOnce();
  });
});
