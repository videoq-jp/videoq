import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {courseHistoryContract,seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL learning history',()=>{
 courseHistoryContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs};
   for(const statement of await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema)))await execute(statement.replaceAll('"public".',''));
   await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');
   return {env,execute,...await seedHistory(env,execute),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
