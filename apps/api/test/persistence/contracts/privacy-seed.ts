import {seedHistory} from './course-history.contract';
import {privacySubject,type PrivacyInstallation} from '../../../src/shared/privacy';
import {digest} from '../../../src/features/lti/store';
import {getLmsResource} from '../../../src/repositories/lms-resource-repository';
import type {Bindings} from '../../../src/types/bindings';
export const privacyFixtureInstallation:PrivacyInstallation={id:'school',ownerUserId:'installer',issuer:'https://lms.example',clientId:'client',deploymentId:'2',jwksUrl:'https://lms.example/jwks'};
export async function seedPrivacyFixture(env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,checkpoints:(thread:string,label:string)=>Promise<void>){
 const installation=privacyFixtureInstallation,seeded=await seedHistory(env,execute),courseId=seeded.courseId;
 const people={own:{question:'',reply:'',conversation:''},peer:{question:'',reply:'',conversation:''}};

 const resource=(await getLmsResource(env,{id:'school',ownerUserId:'owner'},'first'))!.resource;
 for(const [index,subject,label] of [[1,'11','own'],[2,'22','peer']] as const){
  const s=await privacySubject(installation,subject),qa=await digest(JSON.stringify(['lti-course-qa-v1',s.registrationId,s.subjectHash,courseId])),question=crypto.randomUUID(),reply=crypto.randomUUID(),conversation=crypto.randomUUID();
  Object.assign(people[label],{question,reply,conversation});
  const answer=JSON.stringify({segments:[{text:`${label}-private-answer`,sourceIds:[]}],sources:[]}),now=new Date().toISOString();
  await execute('INSERT INTO chat_logs(id,user_id,course_id,question,response,is_shared_origin,created_at,retrieved_contexts) VALUES(?,\'owner\',?,?,?,true,?,?)',[index,courseId,`${label}-private-question`,answer,now,JSON.stringify([`${label}-private-evidence`])]);
  await execute('INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids,registration_id,context_id) VALUES(?,?,?, ?,\'context\')',[index,s.subjectKey,'[]',s.registrationId]);
  await execute("INSERT INTO chat_log_evaluations(id,status,error_message,created_at,chat_log_id) VALUES(?,'pending','',?,?)",[index,now,index]);
  const thread=label+'-thread';await execute('INSERT INTO chat_conversations(thread_id,owner_user_id,course_id,conversation_id,expires_at,title) VALUES(?,\'owner\',?,?,?,?)',[thread,courseId,conversation,new Date(Date.now()+86400000).toISOString(),`${label}-private-title`]);
  await execute("INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids) VALUES(?,?,'[]')",[thread,s.subjectKey]);
  await execute('INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response,chat_log_id) VALUES(?,\'checkpoint\',?,?,?)',[thread,`${label}-private-turn`,answer,index]);
  await checkpoints(thread,label);
  await execute('INSERT INTO course_questions(id,course_id,title,body,lti_author_id,featured) VALUES(?,?,?,?,?,true)',[question,courseId,`${label}-private-qa`,`${label}-private-body`,qa]);
  await execute('INSERT INTO course_question_replies(id,question_id,body,lti_author_id) VALUES(?,?,?,?)',[reply,question,`${label}-private-reply`,qa]);
  await execute('INSERT INTO course_question_lti_votes(question_id,lti_author_id) VALUES(?,?)',[question,qa]);
  await execute("INSERT INTO course_qa_moderation(id,course_id,question_id,lti_actor_id,action) VALUES(?,?,?,?,'feature')",[crypto.randomUUID(),courseId,question,qa]);
  await execute("INSERT INTO lti_material_operations(id,resource_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision) VALUES(?,?,?,1,?,'update',?,?,?)",[crypto.randomUUID(),resource.id,courseId,s.subjectKey,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]);
  await execute("INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash) VALUES(?,?,?,'create',?)",[crypto.randomUUID(),courseId,s.subjectKey,'a'.repeat(64)]);
  await execute("INSERT INTO lti_report_accesses(id,installation_id,course_id,context_id,actor_key,from_date,to_date,resource_count,scope_hash) VALUES(?,'school',?,'context',?,'2026-11-01','2026-11-02',1,?)",[crypto.randomUUID(),courseId,s.subjectKey,'a'.repeat(64)]);
  await execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,'lti-history',?,?)",[await digest(label+'history'),JSON.stringify({registrationId:s.registrationId,subjectHash:s.subjectHash,courseId,contextId:'context',turns:[{question:`${label}-private-recent-history`}]}),new Date(Date.now()+86400000).toISOString()]);
 }
 await execute("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('secret','session',?,?)",[JSON.stringify({secret:'NEVER EXPORT AUTH'}),new Date(Date.now()+86400000).toISOString()]);
 return {courseId,...people};
}
