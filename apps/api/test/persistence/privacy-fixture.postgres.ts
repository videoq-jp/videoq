import pg from 'pg';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs,chatLogEvaluations,chatConversations,chatConversationTurns,ltiChatLogSubjects,ltiConversationScopes,courseQuestions,courseQuestionReplies,courseQuestionLtiVotes,courseQaModeration,ltiMaterialOperations,ltiCourseTagOperations,ltiOperationReservations,ltiReportAccesses} from '../../src/db/schema';
import {setupConversationCheckpoints} from '../../scripts/migrations/conversation/setup';
import {seedPrivacyFixture} from './contracts/privacy-seed';
import type {Bindings} from '../../src/types/bindings';
export async function createPostgresPrivacyFixture(url:string){
 const name='privacy_contract_'+crypto.randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:url});await admin.connect();
 let pool:pg.Pool|undefined;
 const dispose=async()=>{try{await pool?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}"`);}finally{await admin.end();}};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const connection=new URL(url);connection.pathname='/'+name;const activePool=new pg.Pool({connectionString:connection.toString(),max:4});pool=activePool;
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await activePool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  const schema={users,videos,videoCourses,videoCourseMembers,lmsInstallations,teachingConnections,lmsCourses,lmsResources,externalTasks,ltiCourseTags,ltiCourseVideoTags,mcpIdempotencyRecords,ltiCredentials,chatLogs,chatLogEvaluations,chatConversations,chatConversationTurns,ltiChatLogSubjects,ltiConversationScopes,courseQuestions,courseQuestionReplies,courseQuestionLtiVotes,courseQaModeration,ltiMaterialOperations,ltiCourseTagOperations,ltiOperationReservations,ltiReportAccesses};
  await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));
  await execute('CREATE TABLE scene_embeddings(video_id bigint); CREATE TABLE mutation_receipts(token text)');await setupConversationCheckpoints(activePool);
  const env={DATABASE_POOL:activePool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
  const seeded=await seedPrivacyFixture(env,execute,async(thread,label)=>{
   await activePool.query("INSERT INTO chat_memory.checkpoints(thread_id,checkpoint_id,checkpoint,metadata) VALUES($1,'checkpoint',$2,$3)",[thread,JSON.stringify({messages:[label+'-private-model-memory']}),JSON.stringify({writes:label+'-private-metadata'})]);
   await activePool.query("INSERT INTO chat_memory.checkpoint_blobs(thread_id,channel,version,type,blob) VALUES($1,'messages','v1','json',$2)",[thread,Buffer.from(label+'-private-model-memory')]);
   await activePool.query("INSERT INTO chat_memory.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) VALUES($1,'checkpoint','task',0,'messages','json',$2)",[thread,Buffer.from(label+'-private-pending-write')]);
  });
  return {env,execute,pool:activePool,...seeded,dispose};
 }catch(error){await dispose();throw error;}
}
