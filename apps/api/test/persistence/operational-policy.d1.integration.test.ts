import {it,expect,vi} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {observeOperationalPolicy} from '../../src/integrations/operational-policy/observe';
import {deliverPolicyNotification} from '../../src/integrations/operational-policy/notifications';
import type {Bindings} from '../../src/types/bindings';
it('records only accepted source receipts, resets current clock, and preserves deletion cleanup facts',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database;
 await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('o','o','o@example.test',0,0,0,0)").run();
 await db.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'o','Synthetic','private-key','','2026-11-25','','completed','','upload','','')").run();
 await db.prepare("INSERT INTO video_index_versions(video_id,revision) VALUES(1,'unaccepted')").run();
 expect(await db.prepare('SELECT * FROM policy_readiness').all()).toMatchObject({results:[]});
 await db.prepare("UPDATE videos SET transcript='accepted nonempty fixture transcript' WHERE id=1").run();
 await db.batch([db.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) VALUES('accepted','video_transcript_update',1)"),db.prepare("UPDATE video_index_versions SET revision='r1' WHERE video_id=1"),db.prepare("DELETE FROM mutation_receipts")]);
 expect(await db.prepare('SELECT source_revision,ready_at FROM policy_readiness').first()).toEqual({source_revision:'r1',ready_at:null});
 await db.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
 await db.prepare("UPDATE videos SET status='completed' WHERE id=1").run();
 expect(await db.prepare('SELECT ready_at FROM policy_readiness').first('ready_at')).toBeNull();
 await db.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status,embedding_fingerprint,embedding_identity) VALUES('run',1,'o','r1',768,0,'staging','fingerprint','identity')").run();
 await db.prepare("INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(1,768,'run')").run();
 await db.prepare("UPDATE scene_index_runs SET status='published' WHERE id='run'").run();
 await db.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();await db.prepare("UPDATE videos SET status='completed' WHERE id=1").run();
 expect(await db.prepare('SELECT ready_at FROM policy_readiness').first('ready_at')).toBeTruthy();
 await db.batch([db.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) VALUES('worker','transcription_saved',1)"),db.prepare("UPDATE video_index_versions SET revision='r2' WHERE video_id=1"),db.prepare("DELETE FROM mutation_receipts")]);
 expect(await db.prepare('SELECT source_revision,ready_at FROM policy_readiness').first()).toEqual({source_revision:'r2',ready_at:null});
 await db.prepare("INSERT INTO external_tasks(id,kind,payload,dedupe_key) VALUES(1,'storage_cleanup','{}','storage:video:1'),(2,'storage_cleanup','{}','other-origin')").run();
 await db.prepare("INSERT INTO scene_index_tasks(id,operation,vector_id,scene_id,revision,video_id,user_id,dimensions) VALUES('delete-task','delete','physical','s','r1',1,'o',768)").run();
 await db.prepare('DELETE FROM videos WHERE id=1').run();
 expect((await db.prepare('SELECT id FROM policy_cleanup ORDER BY id').all()).results).toEqual([{id:'index:delete-task'},{id:'object:1'}]);
 expect(await db.prepare('SELECT * FROM policy_readiness').all()).toMatchObject({results:[]});
 await db.prepare("UPDATE external_tasks SET completed_at='2026-11-25T12:00:00Z' WHERE id=1").run();
 expect(await db.prepare("SELECT completed_at FROM policy_cleanup WHERE id='object:1'").first('completed_at')).toBe('2026-11-25T12:00:00Z');
 }finally{await f.dispose();}
},60000);
it('delivers private deduplicated notifications; failed and concurrent send remain retry safe',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database;
 await db.prepare("INSERT INTO policy_cleanup(id,scope,task_id,logical_deleted_at) VALUES('private-object-identifier','active-object','1','2026-11-23T00:00:00Z')").run();
 const env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:db,OPERATIONAL_POLICY_WEBHOOK_URL:'https://operator.example.test/events',OPERATIONAL_POLICY_WEBHOOK_TOKEN:'synthetic-token'} as Bindings;
 const send=vi.fn(async(_input:unknown,init?:RequestInit)=>{expect(init?.redirect).toBe('error');expect(init?.body).not.toContain('private-object');return new Response(null,{status:204});});
 const results=await Promise.all([observeOperationalPolicy(env,new Date('2026-11-25T00:00:00Z'),send),observeOperationalPolicy(env,new Date('2026-11-25T00:00:00Z'),send)]);
 expect(results.reduce((n,r)=>n+r.delivered,0)).toBe(1);expect(send).toHaveBeenCalledTimes(1);
 await observeOperationalPolicy(env,new Date('2026-11-25T00:00:00Z'),send);expect(send).toHaveBeenCalledTimes(1);
 await db.prepare("INSERT INTO policy_cleanup(id,scope,task_id,logical_deleted_at) VALUES('retry','active-object','2','2026-11-23T00:00:00Z')").run();
 await expect(observeOperationalPolicy(env,new Date('2026-11-25T00:00:00Z'),async()=>new Response('sensitive remote error',{status:503}))).rejects.toThrow('Policy notification delivery failed');
 expect(await db.prepare("SELECT state,attempts FROM policy_notifications WHERE id='cleanup:retry:incident'").first()).toEqual({state:'pending',attempts:1});
 await db.prepare("UPDATE policy_notifications SET lease_until=NULL WHERE id='cleanup:retry:incident'").run();
 await observeOperationalPolicy(env,new Date('2026-11-25T00:00:00Z'),send);expect(send).toHaveBeenCalledTimes(2);
 expect(await observeOperationalPolicy({...env,OPERATIONAL_POLICY_WEBHOOK_URL:undefined},new Date())).toMatchObject({status:'notification_sink_unconfigured'});
 }finally{await f.dispose();}
},60000);
it('rejects insecure webhook targets without sending and masks transport details',async()=>{
 const send=vi.fn(),event={kind:'active_cleanup_incident',id:'private',severity:'incident' as const,ageMs:1,owner:'yukiharada1228',policyDate:'2026-11-25'};
 await expect(deliverPolicyNotification({url:'http://operator.test',token:'secret'},event,'id',send)).rejects.toThrow('Invalid policy notification configuration');expect(send).not.toHaveBeenCalled();
 await expect(deliverPolicyNotification({url:'https://operator.test',token:'secret'},event,'id',async()=>{throw Error('secret remote URL')})).rejects.toThrow(/^Policy notification delivery failed$/);
});
it('respects delivery backoff/live leases without starving eligible rows beyond the first hundred',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database;
 const {policyMaintenanceWakeup}=await import('../../src/persistence/d1/policy-wakeup');
 const {createD1OperationalPolicyRepository}=await import('../../src/persistence/d1/operational-policy');
 const env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:db,OPERATIONAL_POLICY_WEBHOOK_URL:'https://operator.example.test',OPERATIONAL_POLICY_WEBHOOK_TOKEN:'synthetic'} as Bindings;
 const deleted=new Date(Date.now()-49*3600000).toISOString();
 for(let i=0;i<101;i++) {
  const id='leased-'+i;
  await db.prepare("INSERT INTO policy_cleanup(id,scope,task_id,logical_deleted_at) VALUES(?,'active-object',?,?)").bind(id,id,deleted).run();
  await db.prepare("INSERT INTO policy_notifications(id,severity,state,attempts,lease_until) VALUES(?,'incident',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))").bind('cleanup:'+id+':incident',i%2?'sending':'pending').run();
 }
 const before=Date.now(),wake=await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null});
 expect(wake.nextAt!.getTime()).toBeGreaterThan(before+4*60000);
 expect(wake.nextFutureAt!.getTime()).toBeGreaterThan(before+4*60000);
 expect((await createD1OperationalPolicyRepository(db).read(new Date().toISOString())).cleanup).toEqual([]);
 await db.prepare("INSERT INTO policy_cleanup(id,scope,task_id,logical_deleted_at) VALUES('eligible','active-object','eligible',?)").bind(deleted).run();
 const snapshot=await createD1OperationalPolicyRepository(db).read(new Date().toISOString());expect(snapshot.cleanup.map(row=>row.id)).toEqual(['eligible']);
 expect((await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null})).nextAt!.getTime()).toBeLessThan(Date.now());
 const send=vi.fn(async()=>new Response(null,{status:204}));await observeOperationalPolicy(env,new Date(),send);expect(send).toHaveBeenCalledOnce();
 const after=await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null});expect(after.nextAt!.getTime()).toBeGreaterThan(before+4*60000);
 }finally{await f.dispose();}
},60000);
it('schedules completed late cleanup without pending jobs, while successful delivery removes its wakeup',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database,{policyMaintenanceWakeup}=await import('../../src/persistence/d1/policy-wakeup');
 const env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:db,OPERATIONAL_POLICY_WEBHOOK_URL:'https://operator.example.test',OPERATIONAL_POLICY_WEBHOOK_TOKEN:'synthetic'} as Bindings;
 await db.prepare("INSERT INTO policy_cleanup(id,scope,task_id,logical_deleted_at,completed_at) VALUES('late','active-index','late',?,?)").bind(new Date(Date.now()-49*3600000).toISOString(),new Date(Date.now()-1000).toISOString()).run();
 expect((await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null})).nextAt!.getTime()).toBeLessThan(Date.now());
 await observeOperationalPolicy(env,new Date(),async()=>new Response(null,{status:204}));
 expect(await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null})).toEqual({nextAt:null,nextFutureAt:null});
 }finally{await f.dispose();}
},60000);
it('real manual clear and empty worker result remove the searchable expectation while invalid nonempty input remains observable',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database;
 const {createD1VideoMutationRepository}=await import('../../src/persistence/d1/video-mutation-repository');
 const {createD1WorkerTranscriptionRepository}=await import('../../src/persistence/d1/worker-transcription');
 await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('o','o','o@example.test',0,0,0,0)").run();
 await db.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'o','Synthetic','file','','2026-11-25','original','completed','','upload','','')").run();
 const edits=createD1VideoMutationRepository(db);
 await edits.update(1,'o',{transcript:'invalid but nonempty accepted content'});
 expect(await db.prepare('SELECT source_revision FROM policy_readiness').first('source_revision')).toBeTruthy();
 await edits.update(1,'o',{transcript:''});
 expect((await db.prepare('SELECT * FROM policy_readiness').all()).results).toEqual([]);
 await edits.update(1,'o',{transcript:'\n\t  \r'});
 expect((await db.prepare('SELECT * FROM policy_readiness').all()).results).toEqual([]);
 await db.prepare("UPDATE videos SET status='pending',transcript='old' WHERE id=1").run();
 const worker=createD1WorkerTranscriptionRepository(db),source=await worker.readSource(1);expect(source).not.toBeNull();
 expect(await worker.begin(source!,'pending')).toBe(true);
 await worker.finish(source!,'',null);
 expect((await db.prepare('SELECT * FROM policy_readiness').all()).results).toEqual([]);
 }finally{await f.dispose();}
},60000);
it('records completed-status manual reindex readiness only after actual source/fingerprint/vector verification and ignores superseded clocks',async()=>{
 const f=await createD1Fixture();try {
 const db=f.database;
 const {createD1VideoMutationRepository}=await import('../../src/persistence/d1/video-mutation-repository');
 const {createD1SceneIndexWriter}=await import('../../src/persistence/d1/scene-index-writer');
 const {synchronizeD1SceneIndex}=await import('../../src/persistence/d1/scene-index-sync');
 const {createD1OperationalPolicyRepository}=await import('../../src/persistence/d1/operational-policy');
 const {policyMaintenanceWakeup}=await import('../../src/persistence/d1/policy-wakeup');
 const {embeddingFingerprint,embeddingIdentity,resolveEmbeddingConfig}=await import('../../src/lib/embedding-contract');
 const config=resolveEmbeddingConfig({EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_PROFILE:'embeddinggemma2'}),fingerprint=await embeddingFingerprint(config);
 await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('o','o','o@example.test',0,0,0,0)").run();
 await db.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'o','Synthetic','','','2026-11-25','old','completed','','upload','','')").run();
 await createD1VideoMutationRepository(db).update(1,'o',{transcript:'1\n00:00:00,000 --> 00:00:01,000\nNew accepted source\n'});
 expect(await db.prepare('SELECT status FROM videos').first('status')).toBe('completed');
 const writer=createD1SceneIndexWriter(db,fingerprint,embeddingIdentity(config),768),source=await writer.readSource(1,'o');if(!source)throw Error('Missing source');
 expect(await writer.start({runId:'policy-ready-run',videoId:1,userId:'o',sourceRevision:source.sourceRevision,dimensions:768,expectedScenes:1,embeddingFingerprint:fingerprint})).toBe(true);
 expect(await writer.stage('policy-ready-run','o',[{id:'scene',content:'New accepted source',startTime:'00:01',endTime:'00:02',embedding:[1,...Array<number>(767).fill(0)]}])).toBe(true);
 expect(await writer.publish('policy-ready-run','o')).toBe(true);
 expect(await db.prepare('SELECT ready_at FROM policy_readiness').first('ready_at')).toBeNull();
 const vectors=new Map<string,import('@cloudflare/workers-types').VectorizeVector>();let visible=false;
 const index={upsert:(rows:import('@cloudflare/workers-types').VectorizeVector[])=>{rows.forEach(row=>vectors.set(row.id,row));return Promise.resolve({mutationId:'fixture'});},
  getByIds:(ids:string[])=>Promise.resolve(ids.flatMap(id=>vectors.has(id)?[vectors.get(id)!]:[])),
  queryById:(id:string)=>Promise.resolve({matches:visible&&vectors.has(id)?[{...vectors.get(id)!,score:1}]:[]})} as unknown as import('@cloudflare/workers-types').Vectorize;
 await synchronizeD1SceneIndex(db,{768:index},10,{fingerprint});
 expect(await db.prepare('SELECT ready_at FROM policy_readiness').first('ready_at')).toBeNull();
 visible=true;await db.prepare("UPDATE scene_index_tasks SET available_at='2000-01-01T00:00:00Z'").run();
 await synchronizeD1SceneIndex(db,{768:index},10,{fingerprint});
 const ready=await db.prepare('SELECT ready_at,ready_fingerprint,ready_dimensions,ready_run_id FROM policy_readiness').first();
 expect(ready).toMatchObject({ready_fingerprint:fingerprint,ready_dimensions:768,ready_run_id:'policy-ready-run'});expect(ready?.ready_at).toBeTruthy();
 const env={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',DB:db,EMBEDDING_PROVIDER:'workers-ai',EMBEDDING_PROFILE:'embeddinggemma2',OPERATIONAL_POLICY_WEBHOOK_URL:'https://operator.example.test',OPERATIONAL_POLICY_WEBHOOK_TOKEN:'synthetic'} as Bindings;
 expect(await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null})).toEqual({nextAt:null,nextFutureAt:null});
 const expected=createD1OperationalPolicyRepository(db,{fingerprint,dimensions:768});expect((await expected.read(new Date().toISOString())).readiness).toEqual([]);
 await db.prepare("UPDATE video_index_versions SET revision='superseded-without-accepted-receipt' WHERE video_id=1").run();
 expect(await policyMaintenanceWakeup(env,{nextAt:null,nextFutureAt:null})).toEqual({nextAt:null,nextFutureAt:null});
 expect((await expected.read(new Date().toISOString())).readiness).toEqual([]);
 }finally{await f.dispose();}
},60000);
