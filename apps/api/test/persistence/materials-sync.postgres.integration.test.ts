import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials} from '../../src/db/schema';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {materialsSyncContract} from './contracts/materials-sync.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL materials synchronization',()=>{
 materialsSyncContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const snapshot=generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials});
   for(const statement of await generateMigration(generateDrizzleJson({}),snapshot))await execute(statement.replaceAll('"public".',''));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');await seedSyncOwner(execute);
   return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,execute,
    state:async(id:string)=>{const row=(await f.pool.query<{payload:Record<string,unknown>;expiresAt:Date}>('SELECT payload,expires_at AS "expiresAt" FROM lti_credentials WHERE id=$1',[id])).rows[0];return row?{...row,expiresAt:row.expiresAt.toISOString()}:null;},
    taskCount:async()=>Number((await f.pool.query<{n:string}>("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'")).rows[0].n),
    cursor:async()=>Number((await f.pool.query<{cursor:number}>('SELECT materials_cursor AS cursor FROM lms_installations')).rows[0].cursor),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
