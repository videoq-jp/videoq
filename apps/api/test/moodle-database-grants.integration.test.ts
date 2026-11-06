import { pruneLtiAudit } from '../src/features/lti/audit-retention';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { lockConversationTestRoles } from './helpers/conversation-role-lock';
import { provisionLmsInstallation } from '../src/repositories/lms-installation-repository';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { manageLtiMaterial, type ManagedMaterialScope } from '../src/features/lti/material-management';
import { courseTags, type CourseTagScope } from '../src/features/lti/course-tags';
import { resolvedLtiConfig } from '../src/features/lti/registrations';
import { putCredential, readCredential } from '../src/features/lti/store';
import { toolJwks } from '../src/features/lti/tool-keys';
import { issueMoodlePairing } from '../src/features/lms/pairing';
import { listQuestions, mutate } from '../src/features/qa/service';
import type { Bindings } from '../src/types/bindings';

const databaseUrl=process.env.QUOTA_TEST_DATABASE_URL;
const roles=['videoq_migrate_20260918','videoq_worker_20261014','videoq_api_access','videoq_worker_access',
  'videoq_backup_access','videoq_audit_access','videoq_smoke_access','videoq_demo_access'];
const moodleTables=['lti_credentials','lti_tool_keys','lms_installations','lms_courses','lms_resources',
  'lti_operation_reservations','lti_material_operations','lti_course_tags','lti_course_video_tags','lti_course_tag_operations','course_questions','course_question_replies','course_question_votes',
  'course_question_lti_votes','course_qa_moderation'];

(databaseUrl?describe:describe.skip)('Moodle services using the deployed database security profile',()=>{
  const database='videoq_moodle_grants_'+crypto.randomUUID().replaceAll('-','');
  const apiLogin='videoq_moodle_api_'+crypto.randomUUID().replaceAll('-','');
  const workerLogin='videoq_moodle_worker_'+crypto.randomUUID().replaceAll('-','');
  const createdRoles:string[]=[];
  let admin:pg.Pool,owner:pg.Pool,api:pg.Pool,worker:pg.Pool,workerDatabaseUrl:string,env:Bindings,releaseRoles:(()=>Promise<void>)|undefined;
  beforeAll(async()=>{
    releaseRoles=await lockConversationTestRoles(databaseUrl!);
    admin=new pg.Pool({connectionString:databaseUrl});admin.on('error',()=>{});
    // The real profile uses fixed deployment roles. Do not alter existing roles
    // or reuse an unrelated database while preparing this isolated fixture.
    const existing=await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles]);
    if(existing.rowCount)throw new Error('This fixture needs an isolated cluster without deployed VideoQ roles.');
    for(const role of roles){
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      createdRoles.push(role);
    }
    await admin.query(`CREATE DATABASE "${database}" OWNER videoq_migrate_20260918`);
    const url=new URL(databaseUrl!);url.pathname='/'+database;
    const setup=new pg.Pool({connectionString:url.toString()});
    try{await setup.query('CREATE EXTENSION vector');}finally{await setup.end();}
    owner=new pg.Pool({connectionString:url.toString(),options:'-c role=videoq_migrate_20260918',max:3});owner.on('error',()=>{});
    const client=await owner.connect();try{await migrateDatabase(client);}finally{client.release();}
    // Create before security setup, so the profile's future-table defaults
    // cannot accidentally make this retired-table negative control readable.
    await owner.query("CREATE TABLE retired_permission_probe(secret text);INSERT INTO retired_permission_probe VALUES('fixture only')");
    const installer:pg.Pool=new pg.Pool({connectionString:url.toString()});
    try{
      // The deployed profile inherits a pre-existing legacy worker role. Model
      // only the read/lease baseline needed by this indexing fixture; this is
      // not a complete reconstruction of production transcription/deletion grants.
      await installer.query(`GRANT SELECT(id,user_id,title,transcript,status,source_type,file,youtube_video_id)
        ON videos TO videoq_worker_20261014;
        GRANT SELECT,INSERT ON job_executions TO videoq_worker_20261014`);
      const profile:string=readFileSync(new URL('../../../infra/sql/neon-security.sql',import.meta.url),'utf8');
      await installer.query(profile);await installer.query(profile);
    }
    finally{await installer.end();}
    const apiPassword=crypto.randomUUID();
    await admin.query(`CREATE ROLE "${apiLogin}" LOGIN PASSWORD '${apiPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(apiLogin);
    await admin.query(`GRANT videoq_api_access TO "${apiLogin}"`);
    const apiUrl=new URL(url);apiUrl.username=apiLogin;apiUrl.password=apiPassword;
    api=new pg.Pool({connectionString:apiUrl.toString(),options:'-c role=videoq_api_access',max:3});api.on('error',()=>{});
    const workerPassword=crypto.randomUUID();
    await admin.query(`CREATE ROLE "${workerLogin}" LOGIN PASSWORD '${workerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(workerLogin);
    await admin.query(`GRANT videoq_worker_access TO "${workerLogin}"`);
    const workerUrl=new URL(url);workerUrl.username=workerLogin;workerUrl.password=workerPassword;
    workerUrl.searchParams.set('options','-c role=videoq_worker_access');
    // libpq uses URI percent encoding, not URLSearchParams' form-style '+'.
    workerUrl.search=[...workerUrl.searchParams].map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&');
    workerDatabaseUrl=workerUrl.toString();
    worker=new pg.Pool({connectionString:workerDatabaseUrl,max:2});worker.on('error',()=>{});
    env={DATABASE_POOL:api,LTI_CONFIG:JSON.stringify({toolOrigin:'https://videoq.example',databaseRegistrations:true,registrations:[]}),
      USER_SECRET_ENCRYPTION_KEY:'A'.repeat(43),USE_S3_STORAGE:'true'} as Bindings;
    await owner.query(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','owner','owner@example.invalid',false,0,0,0,1,2)`);
  },60000);
  afterAll(async()=>{
    try{
      await worker?.end();await api?.end();await owner?.end();
      if(admin){
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);
        for(const role of createdRoles.reverse())await admin.query(`DROP ROLE "${role}"`);
      }
    }finally{try{await admin?.end();}finally{await releaseRoles?.();}}
  },60000);

  it('grants every existing Moodle runtime table without DDL or retired-table access',async()=>{
    const result=await api.query<{name:string;allowed:boolean}>(`SELECT name,
      bool_and(has_table_privilege(current_user,name,privilege)) AS allowed FROM unnest($1::text[]) AS name
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege GROUP BY name`,[moodleTables]);
    expect(result.rows.filter(row=>!row.allowed).map(row=>row.name)).toEqual([]);
    expect((await api.query("SELECT current_user AS role,has_schema_privilege(current_user,'public','CREATE') AS ddl")).rows)
      .toEqual([{role:'videoq_api_access',ddl:false}]);
    await expect(api.query('CREATE TABLE forbidden_runtime_ddl(id int)')).rejects.toMatchObject({code:'42501'});
    await expect(api.query('SELECT * FROM retired_permission_probe')).rejects.toMatchObject({code:'42501'});
    await expect(api.query('SET ROLE videoq_migrate_20260918')).rejects.toMatchObject({code:'42501'});
    expect((await api.query('SELECT session_user AS login')).rows).toEqual([{login:apiLogin}]);
  });

  it('runs binding, session storage, signing, Q&A and audited teacher edits through that API role',async()=>{
    const connection=await provisionLmsInstallation(env,{id:'school',ownerUserId:'owner',name:'Synthetic Moodle',
      issuer:'https://moodle.example',clientId:'client',deploymentId:'deployment',authorizationUrl:'https://moodle.example/auth',jwksUrl:'https://moodle.example/keys'});
    expect(connection.installationId).toBe('school');
    const resource=await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'source',{contextId:'course',resourceLinkId:'launch',
      generation:1,enabled:true,title:'Source lesson',file:{filename:'lesson.mp4',contentType:'video/mp4',size:10,contentHash:'a'.repeat(40)}});
    await owner.query("UPDATE videos SET status='completed',transcript=$1 WHERE id=$2",['1\n00:00:00,000 --> 00:00:01,000\nLesson\n',resource.videoId]);
    expect((await resolvedLtiConfig(env))?.registrations[0].resources[0]).toMatchObject({videoId:resource.videoId,learningAvailable:true});
    await putCredential(env,'c'.repeat(64),'test-role-proof',{checked:true},60);
    expect(await readCredential(env,'c'.repeat(64),'test-role-proof')).toEqual({checked:true});
    await issueMoodlePairing(env,'owner','https://moodle.example','https://videoq.example');
    expect((await toolJwks(env)).keys).toHaveLength(1);
    const principal={kind:'lti' as const,ownerUserId:'owner',courseId:resource.courseId!,authorId:'d'.repeat(64),videoIds:[resource.videoId!],
      permissions:{view:true,post:true,vote:true,deleteOwn:true,moderate:true,instructor:true}};
    const question=await mutate(env,principal,{name:'qa.ask',input:{courseId:resource.courseId!,videoId:resource.videoId!,title:'Question',body:'Role-restricted question'}});
    expect(question).toHaveProperty('id');
    expect((await listQuestions(env,principal,{courseId:resource.courseId!,limit:20,offset:0,search:'',unanswered:false,sort:'recent'})).items).toHaveLength(1);
    const scope:ManagedMaterialScope={installationId:'school',ownerUserId:'owner',courseId:resource.courseId!,contextId:'course',resourceLinkId:'launch',
      videoId:resource.videoId!,generation:1,actorKey:'b'.repeat(64)};
    const before=await manageLtiMaterial(env,scope,{action:'get',videoId:scope.videoId});
    const after=await manageLtiMaterial(env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision:before.material.revision,
      fields:{transcript:'1\n00:00:00,000 --> 00:00:01,000\nEdited lesson\n'}});
    expect(after.material.status).toBe('indexing');expect(after.externalTaskId).toBeTypeOf('number');
    expect((await api.query('SELECT action FROM lti_material_operations')).rows).toEqual([{action:'update'}]);
    expect((await api.query('SELECT kind FROM external_tasks WHERE id=$1',[after.externalTaskId])).rows).toEqual([{kind:'sqs_job'}]);
    const tagScope:CourseTagScope={...scope,manage:true,readableVideoIds:[],
      management:[{videoId:scope.videoId,resourceLinkId:scope.resourceLinkId,generation:scope.generation}]};
    const tags=await courseTags(env,tagScope,{action:'create',name:'Role-scoped vocabulary',color:'blue',operationId:crypto.randomUUID()});
    const assigned=await courseTags(env,tagScope,{action:'assign',videoId:scope.videoId,tagIds:[tags.tags[0].id],
      revision:tags.videos[0].revision,operationId:crypto.randomUUID()});
    expect(assigned.tags[0]).toMatchObject({name:'Role-scoped vocabulary',videoIds:[scope.videoId]});
    const deleted=await courseTags(env,tagScope,{action:'delete',id:assigned.tags[0].id,revision:assigned.tags[0].revision,operationId:crypto.randomUUID()});
    expect(deleted.tags).toEqual([]);
    expect((await api.query('SELECT count(*)::int AS n FROM lti_course_tag_operations')).rows).toEqual([{n:3}]);
    const jobsBefore=(await api.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n;
    await owner.query("UPDATE lti_course_tag_operations SET created_at=now()-interval '31 days'; UPDATE lti_material_operations SET created_at=now()-interval '31 days'");
    const retentionEnv={...env,LTI_CONFIG:JSON.stringify({toolOrigin:'https://videoq.example',databaseRegistrations:true,registrations:[],auditRetentionDays:30})};
    expect(await pruneLtiAudit(retentionEnv)).toMatchObject({materialOperations:1,tagOperations:3,backlog:false});
    expect((await api.query('SELECT count(*)::int AS n FROM lti_operation_reservations')).rows).toEqual([{n:4}]);
    expect((await api.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n).toBe(jobsBefore);
    expect((await api.query('SELECT count(*)::int AS n FROM videos')).rows).toEqual([{n:1}]);

  },20000);
  it('creates an empty course and coursewide Q&A/tag vocabulary with the actual restricted API login',async()=>{
    await provisionLmsInstallation(env,{id:'empty-school',ownerUserId:'owner',name:'Empty Moodle',
      issuer:'https://moodle.example',clientId:'empty-client',deploymentId:'empty-deployment',authorizationUrl:'https://moodle.example/auth',jwksUrl:'https://moodle.example/keys'});
    const before=(await api.query("SELECT used_storage_bytes,used_upload_bytes,used_ai_answers FROM users WHERE id='owner'")).rows[0];
    const counts=await api.query('SELECT (SELECT count(*) FROM videos) AS videos,(SELECT count(*) FROM external_tasks) AS jobs');
    const entry=await syncLmsResource(env,{id:'empty-school',ownerUserId:'owner'},'course_42',{kind:'course',contextId:'42',
      resourceLinkId:'empty-launch',generation:1,enabled:true,title:'VideoQ',courseTitle:'Empty course'});
    expect(entry).toMatchObject({kind:'course',videoId:null});
    expect((await resolvedLtiConfig(env))!.registrations.find(reg=>reg.id==='db:empty-school')!.resources)
      .toMatchObject([{kind:'course',courseId:entry.courseId,learningAvailable:false}]);
    expect((await api.query("SELECT used_storage_bytes,used_upload_bytes,used_ai_answers FROM users WHERE id='owner'")).rows[0]).toEqual(before);
    expect((await api.query('SELECT (SELECT count(*) FROM videos) AS videos,(SELECT count(*) FROM external_tasks) AS jobs')).rows).toEqual(counts.rows);
    const principal={kind:'lti' as const,ownerUserId:'owner',courseId:entry.courseId!,authorId:'e'.repeat(64),videoIds:[],
      permissions:{view:true,post:true,vote:true,deleteOwn:true,moderate:false,instructor:false}};
    expect(await mutate(env,principal,{name:'qa.ask',input:{courseId:entry.courseId!,videoId:null,title:'Coursewide',body:'No media required'}})).toHaveProperty('id');
    expect((await listQuestions(env,principal,{courseId:entry.courseId!,limit:20,offset:0,search:'',unanswered:false,sort:'recent'})).items).toHaveLength(1);
    const scope:CourseTagScope={installationId:'empty-school',contextId:'42',courseId:entry.courseId!,ownerUserId:'owner',actorKey:'e'.repeat(64),
      readableVideoIds:[],management:[],manage:true};
    expect((await courseTags(env,scope,{action:'create',name:'Unused vocabulary',color:'blue',operationId:crypto.randomUUID()})).tags).toHaveLength(1);
    expect((await courseTags(env,{...scope,manage:false},{action:'list'})).tags).toEqual([]);
    expect((await api.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl")).rows[0].ddl).toBe(false);
  });

  it('delivers an API transcript-clear job through the restricted Python worker, with atomic failure and idempotent retry',async()=>{
    await provisionLmsInstallation(env,{id:'clear-school',ownerUserId:'owner',name:'Clear fixture',
      issuer:'https://moodle.example',clientId:'clear-client',deploymentId:'clear-deployment',authorizationUrl:'https://moodle.example/auth',jwksUrl:'https://moodle.example/keys'});
    const sources=[];
    for(const id of ['clear-target','clear-sentinel'])sources.push(await syncLmsResource(env,{id:'clear-school',ownerUserId:'owner'},id,
      {contextId:'clear-course',resourceLinkId:id,generation:1,enabled:true,title:id,
        file:{filename:id+'.mp4',contentType:'video/mp4',size:10,contentHash:(id==='clear-target'?'c':'d').repeat(40)}}));
    const target=sources[0],sentinel=sources[1];
    // Synthetic completed rows/vectors exercise authorization and worker SQL;
    // they are not evidence of AI transcription or embedding quality.
    await owner.query("UPDATE videos SET status='completed',transcript=$1 WHERE id=ANY($2::bigint[])",
      ['1\n00:00:00,000 --> 00:00:01,000\nSynthetic clear fixture\n',sources.map(source=>source.videoId)]);
    for(const [table,dimensions] of [['scene_embeddings',1536],['scene_embeddings_768',768]] as const){
      for(const source of sources)await owner.query(`INSERT INTO ${table}(langchain_id,content,embedding,user_id,video_id)
        VALUES($1,'Synthetic authorization vector',array_fill(0.25::float8,ARRAY[$2::int])::vector,'owner',$3)`,
      [crypto.randomUUID(),dimensions,source.videoId]);
    }
    expect((await worker.query('SELECT current_user,session_user')).rows[0]).toEqual({current_user:'videoq_worker_access',session_user:workerLogin});
    for(const statement of ['CREATE TABLE forbidden_worker_ddl(id int)',
      'SELECT password FROM account LIMIT 0',"UPDATE users SET role='admin' WHERE false",
      "UPDATE videos SET user_id='another-owner' WHERE false",'SET ROLE videoq_migrate_20260918'])
      await expect(worker.query(statement)).rejects.toMatchObject({code:'42501'});
    const scope:ManagedMaterialScope={installationId:'clear-school',ownerUserId:'owner',courseId:target.courseId!,contextId:'clear-course',
      resourceLinkId:'clear-target',videoId:target.videoId!,generation:1,actorKey:'f'.repeat(64)};
    const before=await manageLtiMaterial(env,scope,{action:'get',videoId:scope.videoId});
    const cleared=await manageLtiMaterial(env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),
      revision:before.material.revision,fields:{transcript:''}});
    const message=(await api.query('SELECT payload FROM external_tasks WHERE id=$1',[cleared.externalTaskId])).rows[0].payload.message;
    expect(message).toMatchObject({type:'index_video_transcript',payload:{video_id:scope.videoId,allow_empty:true}});
    const execute=()=>new Promise<{batchItemFailures:{itemIdentifier:string}[];embeddingCalls:number;errors?:{type:string;sqlstate:string|null}[]}>((resolve,reject)=>{
      const child=execFile(process.env.LOCAL_AI_TEST_WORKER_PYTHON??'python3',
        [fileURLToPath(new URL('./helpers/moodle-worker-clear.py',import.meta.url))],
        {timeout:30000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,PYTHONPATH:fileURLToPath(new URL('../../worker/',import.meta.url)),
          DATABASE_URL:workerDatabaseUrl,AWS_EC2_METADATA_DISABLED:'true'}},(error,stdout)=>{
          if(error){reject(new Error('Restricted worker fixture failed (exit '+error.code+'): '+stdout));return;}
          try{resolve(JSON.parse(stdout));}catch{reject(new Error('Restricted worker returned invalid fixture output'));}
        });
      child.stdin!.end(JSON.stringify(message));
    });
    const counts=async()=> (await owner.query(`SELECT
      (SELECT count(*)::int FROM scene_embeddings WHERE video_id=$1) AS hosted,
      (SELECT count(*)::int FROM scene_embeddings_768 WHERE video_id=$1) AS local`,[scope.videoId])).rows[0];
    try{
      await owner.query('REVOKE DELETE ON scene_embeddings_768 FROM videoq_worker_access');
      const failed=await execute();expect(failed.embeddingCalls).toBe(0);expect(failed.batchItemFailures).toHaveLength(1);
      expect(failed.errors).toContainEqual({type:'InsufficientPrivilege',sqlstate:'42501'});
      expect(await counts()).toEqual({hosted:1,local:1});
      expect((await owner.query('SELECT status FROM videos WHERE id=$1',[scope.videoId])).rows[0].status).toBe('indexing');
      expect((await owner.query('SELECT status,attempts FROM job_executions WHERE job_id=$1',[message.job_id])).rows[0])
        .toEqual({status:'failed',attempts:1});
    }finally{await owner.query('GRANT DELETE ON scene_embeddings_768 TO videoq_worker_access');}
    expect(await execute()).toEqual({batchItemFailures:[],embeddingCalls:0});
    expect(await counts()).toEqual({hosted:0,local:0});
    expect((await owner.query('SELECT transcript,status FROM videos WHERE id=$1',[scope.videoId])).rows[0])
      .toEqual({transcript:'',status:'completed'});
    expect(await execute()).toEqual({batchItemFailures:[],embeddingCalls:0});
    expect((await owner.query('SELECT status,attempts FROM job_executions WHERE job_id=$1',[message.job_id])).rows[0])
      .toEqual({status:'completed',attempts:2});
    for(const table of ['scene_embeddings','scene_embeddings_768'])
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE video_id=$1`,[sentinel.videoId])).rows[0].n).toBe(1);
  },60000);
});
