import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {lmsResourceSyncContract,seedSyncOwner} from './contracts/lms-resource-sync.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL LMS resource synchronization',()=>{
 lmsResourceSyncContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!);const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const snapshot=generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords});
   for(const statement of await generateMigration(generateDrizzleJson({}),snapshot))await execute(statement.replaceAll('"public".',''));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');await seedSyncOwner(execute);
   return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem',PERSISTENCE_BACKEND:'postgres',MIGRATION_ALLOW_CLOUD_POSTGRES:'true'} as Bindings,execute,
    count:async(table:string)=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
    quota:async()=>{const row=(await f.pool.query<{storage:string;upload:string}>("SELECT used_storage_bytes AS storage,used_upload_bytes AS upload FROM users WHERE id='owner'")).rows[0];return {storage:Number(row.storage),upload:Number(row.upload)};},
    tasks:async()=>(await f.pool.query<{kind:string;payload:Record<string,unknown>;dedupeKey:string;availableAt:string}>('SELECT kind,payload,dedupe_key AS "dedupeKey",available_at AS "availableAt" FROM external_tasks ORDER BY id')).rows,
    members:async(courseId:number)=>(await f.pool.query<{id:string}>('SELECT video_id AS id FROM video_course_members WHERE course_id=$1 ORDER BY video_id',[courseId])).rows.map(r=>Number(r.id)),
    failCommit:()=>execute("ALTER TABLE lms_resources ADD CONSTRAINT fail_sync CHECK(false) NOT VALID"),
    dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
