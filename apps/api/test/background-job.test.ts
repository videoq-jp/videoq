import { describe, expect, it, vi } from 'vitest';
import { canonicalBackgroundJob, executeBackgroundJob, parseBackgroundJob } from '../src/application/background-job';
import type { JobClaim } from '../src/application/job-execution-port';
const job = { type:'reindex_video_transcript',job_id:'stable-id',payload:{video_id:42} } as const;
function dependencies(claim: JobClaim = { status:'claimed',leaseToken:'lease' }) {
  return { sha256:vi.fn(async()=> 'a'.repeat(64)),execute:vi.fn(async()=>{}),repository:{
    claim:vi.fn(async()=>claim),complete:vi.fn(async()=>true),fail:vi.fn(async()=>true),heartbeat:vi.fn(async()=>true),
  } };
}
describe('TypeScript job identity and replay safety',()=>{
  it('uses the same canonical identity bytes as Python',()=>{
    expect(canonicalBackgroundJob(parseBackgroundJob({type:'index_video_transcript',job_id:'id',payload:{video_id:2,allow_empty:false}})))
      .toBe('{"payload":{"allow_empty":false,"video_id":2},"type":"index_video_transcript"}');
    expect(canonicalBackgroundJob(parseBackgroundJob({type:'delete_account_data',job_id:'id',payload:{user_id:'日本語'}})))
      .toBe('{"payload":{"user_id":"日本語"},"type":"delete_account_data"}');
  });
  it.each([
    {...job,payload:{video_id:true}}, {...job,payload:{video_id:1.5}}, {...job,payload:{video_id:42,extra:1}},
    {...job,type:'transcribe_video'}, {...job,job_id:''}, {...job,payload:null},
    {...job,type:'reindex_all_videos_embeddings',payload:{root_job_id:'id'}},
  ])('rejects invalid work before claiming %#',async input=>{
    const deps=dependencies();await expect(executeBackgroundJob(input,deps)).rejects.toThrow();expect(deps.repository.claim).not.toHaveBeenCalled();
  });
  it('acknowledges completed duplicates without repeating side effects',async()=>{
    const deps=dependencies({status:'completed'});await executeBackgroundJob(job,deps);expect(deps.execute).not.toHaveBeenCalled();
  });
  it.each(['busy','conflict'] as const)('retries %s instead of acknowledging',async status=>{
    const deps=dependencies({status});await expect(executeBackgroundJob(job,deps)).rejects.toThrow(status);expect(deps.execute).not.toHaveBeenCalled();
  });
  it('completes only after successful work using the claimed lease',async()=>{
    const deps=dependencies();await executeBackgroundJob(job,deps);expect(deps.execute).toHaveBeenCalledWith(job,'lease');expect(deps.repository.complete).toHaveBeenCalledWith('stable-id','lease');
  });
  it('releases failed work for retry and preserves the original error',async()=>{
    const deps=dependencies();const error=new Error('provider unavailable');deps.execute.mockRejectedValue(error);deps.repository.fail.mockRejectedValue(new Error('DB unavailable'));
    await expect(executeBackgroundJob(job,deps)).rejects.toBe(error);expect(deps.repository.complete).not.toHaveBeenCalled();
  });
  it('does not report success after losing the completion lease',async()=>{
    const deps=dependencies();deps.repository.complete.mockResolvedValue(false);await expect(executeBackgroundJob(job,deps)).rejects.toThrow('lease was lost');
  });
});

it.each([
  [Object.assign(new Error('secret'),{status:429}),'PROVIDER_RATE_LIMITED'],
  [Object.assign(new Error('secret'),{code:'08006'}),'DATABASE_UNAVAILABLE'],
  [Object.assign(new Error('secret'),{name:'TimeoutError'}),'DEADLINE_EXCEEDED'],
])('persists the same safe cause as diagnostics for %s',async(error,code)=>{
  const deps=dependencies();deps.execute.mockRejectedValueOnce(error);
  await expect(executeBackgroundJob(job,deps)).rejects.toBe(error);
  expect(deps.repository.fail).toHaveBeenCalledWith(job.job_id,'lease',code);
});
