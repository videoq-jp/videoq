import {readFileSync} from 'node:fs';
import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {conversationContract} from './contracts/conversation.contract';
import {createPostgresConversationRepository} from '../../src/persistence/postgres/conversation';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL conversation read contract',()=>{
  conversationContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let index=0;await f.pool.query(sql.replaceAll('?',()=>`$${++index}`),args);};
    await execute(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text);
      CREATE TABLE videos(id bigint PRIMARY KEY,user_id text);
      CREATE TABLE video_course_members(course_id bigint,video_id bigint);
      CREATE TABLE chat_logs(id bigint PRIMARY KEY,feedback text);
      CREATE TABLE lti_credentials(id text PRIMARY KEY,kind text,payload jsonb,expires_at timestamptz);
      INSERT INTO users VALUES('owner');INSERT INTO video_courses VALUES(1,'owner');INSERT INTO videos VALUES(1,'owner'),(2,'owner');INSERT INTO video_course_members VALUES(1,1),(1,2);`);
    for(const name of ['0043_chat_conversation_memory.sql','0044_resumable_conversations.sql','0052_lti_personal_conversations.sql']){
      await execute(readFileSync(new URL(`../../drizzle/${name}`,import.meta.url),'utf8').replaceAll('--> statement-breakpoint','').replaceAll('"public".',''));
    }
    return {repository:createPostgresConversationRepository({DATABASE_POOL:f.pool} as Bindings),execute,dispose:f.dispose};
  });
});
