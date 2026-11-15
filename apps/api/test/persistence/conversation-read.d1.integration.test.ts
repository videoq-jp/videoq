import {createD1Fixture} from './d1-fixture';
import {conversationContract} from './contracts/conversation.contract';
import {createD1ConversationRepository} from '../../src/persistence/d1/conversation';
conversationContract('D1 workerd',async()=>{
  const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
  await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)");
  await execute("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','course','','2026-01-01','2026-01-01',0)");
  for(const id of [1,2])await execute("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (?,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')",[id]);
  await execute('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,?,0),(1,2,?,1)',['2026-11-13','2026-11-13']);
  return {repository:createD1ConversationRepository(f.database),execute,dispose:f.dispose};
});
