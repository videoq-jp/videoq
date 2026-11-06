import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { lockConversationTestRoles } from './helpers/conversation-role-lock';
import { provisionLmsInstallation } from '../src/repositories/lms-installation-repository';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { manageLtiMaterial, type ManagedMaterialScope } from '../src/features/lti/material-management';
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
  'lti_material_operations','course_questions','course_question_replies','course_question_votes',
  'course_question_lti_votes','course_qa_moderation'];

(databaseUrl?describe:describe.skip)('Moodle services using the deployed database security profile',()=>{
  const database='videoq_moodle_grants_'+crypto.randomUUID().replaceAll('-','');
  const apiLogin='videoq_moodle_api_'+crypto.randomUUID().replaceAll('-','');
  const createdRoles:string[]=[];
  let admin:pg.Pool,owner:pg.Pool,api:pg.Pool,env:Bindings,releaseRoles:(()=>Promise<void>)|undefined;
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
    env={DATABASE_POOL:api,LTI_CONFIG:JSON.stringify({toolOrigin:'https://videoq.example',databaseRegistrations:true,registrations:[]}),
      USER_SECRET_ENCRYPTION_KEY:'A'.repeat(43),USE_S3_STORAGE:'true'} as Bindings;
    await owner.query(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','owner','owner@example.invalid',false,0,0,0,1,2)`);
  },60000);
  afterAll(async()=>{
    try{
      await api?.end();await owner?.end();
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
  },20000);
});
