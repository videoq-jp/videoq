import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { createD1JobRepository } from '../../src/persistence/d1/job-repository';
import { createWorkerScenePersistence } from '../../src/persistence/factory';
import { inspectSearchWorkflowRecovery,recoverSearchWorkflow } from '../../src/integrations/background-jobs/recovery';
import { canonicalBackgroundJob } from '../../src/application/background-job';
import { sha256 } from '../../src/integrations/background-jobs/execute';
import type { Bindings } from '../../src/types/bindings';
let fixture:Awaited<ReturnType<typeof createD1Fixture>>,env:Bindings;
const job={type:'reindex_video_transcript',job_id:'guarded-recovery',payload:{video_id:1}} as const;
const restart=vi.fn(async()=>{}),status=vi.fn(async()=>({status:'errored'}));
let root:string;
beforeEach(async()=>{
 fixture=await createD1Fixture({r2:true});restart.mockClear();status.mockResolvedValue({status:'errored'});
 env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:fixture.database,VIDEO_BUCKET:fixture.bucket,SEARCH_INDEX_WORKFLOW:{get:async()=>({status,restart})}} as unknown as Bindings;
 await fixture.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','guard@example.invalid',0,0,0,0)").run();
 await fixture.database.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Synthetic','','','2026-01-01',?,'completed','','uploaded','','')").bind('1\n00:00:00,000 --> 00:00:01,000\nprivate-transcript\n').run();
 root=`internal/search-index/${await sha256(job.job_id)}/`;
 const source=await(await createWorkerScenePersistence(env)).readSource(1);
 await fixture.bucket!.put(`${root}source.json`,JSON.stringify(source));
});
afterEach(async()=>{expect(restart).not.toHaveBeenCalled();await fixture.dispose();});
it('rejects changed sources and preserves their saved artifacts',async()=>{
 await fixture.database.prepare("UPDATE videos SET transcript='new private transcript' WHERE id=1").run();
 await expect(inspectSearchWorkflowRecovery(env,job)).rejects.toThrow('RECOVERY_SOURCE_CHANGED');
 expect(await fixture.bucket!.get(`${root}source.json`)).not.toBeNull();
});
it('binds the review to origin and artifact state',async()=>{
 const before=await inspectSearchWorkflowRecovery(env,job,'https://isolated.example');
 expect(JSON.stringify(before)).not.toContain('private-transcript');
 await expect(recoverSearchWorkflow(env,job,before.inspection,'https://other.example')).rejects.toThrow('RECOVERY_INSPECTION_CHANGED');
 await fixture.bucket!.put(`${root}prepared.json`,'{"changed":true}');
 await expect(recoverSearchWorkflow(env,job,before.inspection,'https://isolated.example')).rejects.toThrow('RECOVERY_INSPECTION_CHANGED');
});
it.each(['running','completed','conflict'] as const)('rejects %s ledger owners without restarting',async state=>{
 const repository=createD1JobRepository(fixture.database);
 const claim=await repository.claim({jobId:job.job_id,jobType:job.type,payloadSha256:state==='conflict'?'b'.repeat(64):await sha256(canonicalBackgroundJob(job))});
 expect(claim.status).toBe('claimed');if(claim.status!=='claimed')throw new Error('fixture');
 if(state==='completed')await repository.complete(job.job_id,claim.leaseToken);
 await expect(inspectSearchWorkflowRecovery(env,job)).rejects.toThrow(state==='running'?'RECOVERY_JOB_BUSY':state==='completed'?'RECOVERY_JOB_COMPLETED':'RECOVERY_IDENTITY_CONFLICT');
});
it.each(['running','queued','complete'])('rejects %s Workflow status',async current=>{
 status.mockResolvedValue({status:current});await expect(inspectSearchWorkflowRecovery(env,job)).rejects.toThrow('RECOVERY_TERMINAL_WORKFLOW_REQUIRED');
});
