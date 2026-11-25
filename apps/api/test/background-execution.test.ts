import { describe,expect,it,vi } from 'vitest';
import type { Bindings } from '../src/types/bindings';
const {repository,step}=vi.hoisted(()=>({
  repository:{claim:vi.fn(async()=>({status:'claimed',leaseToken:'lease'})),complete:vi.fn(async()=>true),heartbeat:vi.fn(async()=>true),fail:vi.fn(async()=>true)},
  step:vi.fn(),
}));
vi.mock('../src/persistence/factory',()=>({createJobRepository:async()=>repository,createReindexRepository:vi.fn(),stepWorkerAccountDeletion:step}));
vi.mock('../src/integrations/search-index/index-transcript',()=>({indexTranscript:vi.fn()}));
import { runBackgroundJob } from '../src/integrations/background-jobs/execute';
describe('Node background worker cancellation',()=>{
  it('stops account deletion between steps, releases its lease and leaves completion unset',async()=>{
    const controller=new AbortController();const reason=new DOMException('Worker shutting down','AbortError');
    step.mockImplementationOnce(async()=>{controller.abort(reason);return{status:'progress'};});
    await expect(runBackgroundJob({} as Bindings,{type:'delete_account_data',job_id:'delete',payload:{user_id:'owner'}},controller.signal)).rejects.toBe(reason);
    expect(step).toHaveBeenCalledOnce();expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith('delete','lease','EXECUTION_ABORTED');
  });
});
