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
 await db.batch([db.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) VALUES('accepted','video_transcript_update',1)"),db.prepare("UPDATE video_index_versions SET revision='r1' WHERE video_id=1"),db.prepare("DELETE FROM mutation_receipts")]);
 expect(await db.prepare('SELECT source_revision,ready_at FROM policy_readiness').first()).toEqual({source_revision:'r1',ready_at:null});
 await db.prepare("UPDATE videos SET status='indexing' WHERE id=1").run();
 await db.prepare("UPDATE videos SET status='completed' WHERE id=1").run();
 expect(await db.prepare('SELECT ready_at FROM policy_readiness').first('ready_at')).toBeNull();
 await db.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status) VALUES('run',1,'o','r1',768,0,'published')").run();
 await db.prepare("INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(1,768,'run')").run();
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
