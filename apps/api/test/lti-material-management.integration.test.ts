import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { manageLtiMaterial, type ManagedMaterialScope } from '../src/features/lti/material-management';
import type { Bindings } from '../src/types/bindings';

const databaseUrl=process.env.QUOTA_TEST_DATABASE_URL;
const srt='1\n00:00:00,000 --> 00:00:01,000\nOriginal lesson\n';
(databaseUrl?describe:describe.skip)('verified teacher material management on PostgreSQL',()=>{
  const database='videoq_teacher_'+crypto.randomUUID().replaceAll('-','');
  let admin:pg.Pool,pool:pg.Pool,env:Bindings,scope:ManagedMaterialScope;
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:databaseUrl});admin.on('error',()=>{});
    await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname='/'+database;
    pool=new pg.Pool({connectionString:url.toString(),max:5});pool.on('error',()=>{});env={DATABASE_POOL:pool} as Bindings;
    const client=await pool.connect();try{await migrateDatabase(client);}finally{client.release();}
  },60000);
  beforeEach(async()=>{
    await pool.query(`TRUNCATE users,external_tasks CASCADE;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
        VALUES('owner','owner','owner@example.test',false,0,0,0,1,2);
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
        VALUES('school','owner','Moodle','https://lms.example','client','deployment','https://lms.example/auth','https://lms.example/keys','${'c'.repeat(64)}');`);
    const resource=await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'source',{contextId:'course',resourceLinkId:'launch',
      generation:1,enabled:true,title:'Moodle title',file:{filename:'lesson.mp4',contentType:'video/mp4',size:10,contentHash:'a'.repeat(40)}});
    scope={installationId:'school',ownerUserId:'owner',courseId:resource.courseId!,contextId:'course',resourceLinkId:'launch',
      videoId:resource.videoId!,generation:1,actorKey:'b'.repeat(64)};
    await pool.query("UPDATE videos SET status='completed',transcript=$1 WHERE id=$2",[srt,scope.videoId]);
  });
  afterAll(async()=>{await pool?.end();try{await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);}finally{await admin?.end();}});
  const get=()=>manageLtiMaterial(env,scope,{action:'get',videoId:scope.videoId});
  const update=async(fields:{description?:string;transcript?:string},revision?:string,operationId=crypto.randomUUID())=>
    manageLtiMaterial(env,scope,{action:'update',videoId:scope.videoId,fields,revision:revision??(await get()).material.revision,operationId});

  it('projects bounded teaching data without credentials, storage paths or account/actor identities',async()=>{
    const result=await get();expect(result.material).toMatchObject({title:'Moodle title',transcript:srt,status:'completed',canEdit:true});
    expect(result.material.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.material)).not.toMatch(/owner@example|ownerUserId|actorKey|file|token|installationId|resourceId/);
    expect((await pool.query('SELECT * FROM lti_material_operations')).rows).toEqual([]);
  });
  it('saves a description without retranscription and leaves canonical Moodle fields intact',async()=>{
    const result=await update({description:'AI teaching notes'});
    expect(result.material).toMatchObject({description:'AI teaching notes',title:'Moodle title',transcript:srt,status:'completed'});
    expect(result.externalTaskId).toBeNull();
    const audit=(await pool.query('SELECT actor_key,action,source_generation FROM lti_material_operations')).rows;
    expect(audit).toEqual([{actor_key:scope.actorKey,action:'update',source_generation:'1'}]);
  });
  it('atomically queues a changed SRT and removes it from learning until indexing completes',async()=>{
    const result=await update({transcript:srt.replace('Original','Edited')});
    expect(result.material.status).toBe('indexing');
    const task=(await pool.query('SELECT payload FROM external_tasks WHERE id=$1',[result.externalTaskId])).rows[0];
    expect(task.payload.message).toMatchObject({type:'index_video_transcript',payload:{video_id:scope.videoId}});
    expect(result.material.canEdit).toBe(false);
  });
  it('requires explicit manual-clear intent and skips duplicate indexing for an unchanged SRT',async()=>{
    const unchanged=await update({transcript:srt});expect(unchanged.externalTaskId).toBeNull();
    const cleared=await update({transcript:''});
    expect((await pool.query('SELECT payload FROM external_tasks WHERE id=$1',[cleared.externalTaskId])).rows[0].payload.message.payload)
      .toEqual({video_id:scope.videoId,allow_empty:true});
  });
  it('rejects stale editor revisions and keeps the winning text after concurrent teachers save',async()=>{
    const revision=(await get()).material.revision;
    const results=await Promise.allSettled([update({description:'First'},revision),update({description:'Second'},revision)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    await expect(update({description:'Old draft'},revision)).rejects.toMatchObject({status:409});
    expect((await get()).material.description).not.toBe('Old draft');
  });
  it('replays one operation without duplicate jobs and rejects reuse by another actor or payload',async()=>{
    const revision=(await get()).material.revision,id=crypto.randomUUID();
    const first=await update({transcript:srt.replace('Original','Saved')},revision,id);
    const again=await update({transcript:srt.replace('Original','Saved')},revision,id);
    expect(again.reused).toBe(true);expect(again.externalTaskId).toBe(first.externalTaskId);
    await expect(update({description:'Different'},revision,id)).rejects.toMatchObject({status:409});
    await expect(manageLtiMaterial(env,{...scope,actorKey:'d'.repeat(64)},{action:'update',videoId:scope.videoId,
      fields:{transcript:srt.replace('Original','Saved')},revision,operationId:id})).rejects.toMatchObject({status:409});
    expect((await pool.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n).toBe(1);
  });
  it('rejects invalid SRT and rolls back content/outbox when durable audit cannot be saved',async()=>{
    await expect(update({transcript:'Not SRT'})).rejects.toMatchObject({status:400});
    await pool.query(`CREATE FUNCTION reject_teacher_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_teacher_audit BEFORE INSERT ON lti_material_operations FOR EACH ROW EXECUTE FUNCTION reject_teacher_audit()`);
    try{await expect(update({transcript:srt.replace('Original','Rollback')})).rejects.toThrow('Failed query');}
    finally{await pool.query('DROP TRIGGER reject_teacher_audit ON lti_material_operations;DROP FUNCTION reject_teacher_audit()');}
    expect((await get()).material).toMatchObject({transcript:srt,status:'completed'});
    expect((await pool.query('SELECT * FROM external_tasks')).rows).toEqual([]);
  });
  it('does not cross current generation, owner, context, membership or resource boundaries',async()=>{
    for(const patch of [{generation:2},{ownerUserId:'other'},{contextId:'other'},{resourceLinkId:'other'},{courseId:999}])
      await expect(manageLtiMaterial(env,{...scope,...patch},{action:'get',videoId:scope.videoId})).rejects.toBeDefined();
    await pool.query('DELETE FROM video_course_members WHERE video_id=$1',[scope.videoId]);
    await expect(get()).rejects.toMatchObject({status:409});
  });
  it('refuses delegated edits that would affect a second course and never returns its identity',async()=>{
    const course=(await pool.query(`INSERT INTO video_courses(user_id,name,description,created_at,updated_at,display_order)
      VALUES('owner','Unrelated private name','',now(),now(),0) RETURNING id`)).rows[0];
    await pool.query('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES($1,$2,0,now())',[course.id,scope.videoId]);
    await expect(get()).rejects.toMatchObject({status:409});
    expect((await pool.query('SELECT * FROM lti_material_operations')).rows).toEqual([]);
  });
  it('uses the same vector writer locks and never waits on active provider work',async()=>{
    const client=await pool.connect();
    try{
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['videoq:vector:video:'+scope.videoId]);
      await expect(update({description:'Busy'})).rejects.toMatchObject({status:409});
      expect((await get()).material.description).toBe('');
    }finally{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['videoq:vector:video:'+scope.videoId]);client.release();}
  });
  it('retries transcription with its original job identity and immutable payload',async()=>{
    const jobId=crypto.randomUUID(),message={type:'transcribe_video',job_id:jobId,payload:{video_id:scope.videoId}};
    await pool.query("UPDATE videos SET status='error' WHERE id=$1",[scope.videoId]);
    await pool.query("INSERT INTO external_tasks(kind,dedupe_key,payload,completed_at) VALUES('sqs_job','original',$1,now())",[JSON.stringify({message})]);
    const revision=(await get()).material.revision;
    const result=await manageLtiMaterial(env,scope,{action:'retry',videoId:scope.videoId,operationId:crypto.randomUUID(),revision});
    expect(result.material.status).toBe('pending');
    expect((await pool.query('SELECT payload FROM external_tasks WHERE id=$1',[result.externalTaskId])).rows[0].payload.message).toEqual(message);
  });
  it('does not queue an already-completed transcription receipt that the worker would ignore',async()=>{
    const jobId=crypto.randomUUID(),message={type:'transcribe_video',job_id:jobId,payload:{video_id:scope.videoId}};
    await pool.query("UPDATE videos SET status='error' WHERE id=$1",[scope.videoId]);
    await pool.query("INSERT INTO external_tasks(kind,dedupe_key,payload,completed_at) VALUES('sqs_job','completed-original',$1,now())",[JSON.stringify({message})]);
    await pool.query("INSERT INTO job_executions(job_id,job_type,payload_sha256,status) VALUES($1,'transcribe_video',$2,'completed')",[jobId,'a'.repeat(64)]);
    const before=(await get()).material;
    expect(before.canRetry).toBe(false);
    await expect(manageLtiMaterial(env,scope,{action:'retry',videoId:scope.videoId,operationId:crypto.randomUUID(),revision:before.revision}))
      .rejects.toMatchObject({status:409});
    expect((await get()).material.status).toBe('error');
    expect((await pool.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT * FROM lti_material_operations')).rows).toEqual([]);
  });
});
