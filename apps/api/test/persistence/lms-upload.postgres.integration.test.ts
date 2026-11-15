import {describe,vi} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {lmsUploadContract} from './contracts/lms-upload.contract';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import {digest} from '../../src/features/lti/store';
import type {Bindings} from '../../src/types/bindings';
vi.mock('../../src/lib/external-tasks',async original=>({...await original<typeof import('../../src/lib/external-tasks')>(),processExternalTaskById:vi.fn(async()=>{})}));
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL immutable LMS upload',()=>{
 lmsUploadContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials};
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');await seedSyncOwner(execute);
   await execute("UPDATE lms_installations SET materials_service=NULL,sync_token_hash=? WHERE id='school'",[await digest('f'.repeat(64))]);return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,execute,
    tasks:async()=>(await f.pool.query<{id:string;kind:string;payload:Record<string,unknown>}>('SELECT id,kind,payload FROM external_tasks ORDER BY id')).rows.map(r=>({...r,id:Number(r.id)})),
    quota:async()=>{const r=(await f.pool.query<{storage:string;upload:string}>("SELECT used_storage_bytes AS storage,used_upload_bytes AS upload FROM users WHERE id='owner'")).rows[0];return {storage:Number(r.storage),upload:Number(r.upload)};},
    failAdopt:()=>execute("CREATE FUNCTION reject_adopt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.file<>OLD.file THEN RAISE EXCEPTION 'adopt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_adopt BEFORE UPDATE OF file ON videos FOR EACH ROW EXECUTE FUNCTION reject_adopt()"),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
