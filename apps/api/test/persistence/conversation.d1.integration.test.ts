import {runChatRag} from '../../src/lib/conversation-execution';
import {chatCompletionResponse} from '../helpers/chat-completion-response';
import {requestBodyText} from '../helpers/request-body';
import type {Bindings} from '../../src/types/bindings';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {emptyCheckpoint} from '@langchain/langgraph-checkpoint';
import {plainChatAnswer} from '@videoq/trpc/chat';
import {createD1Fixture} from './d1-fixture';
import {openD1Conversation,pruneD1Conversations} from '../../src/persistence/d1/conversation';
import {ConversationBusyError,ConversationNotFoundError,type OpenConversation} from '../../src/persistence/contracts/conversation';
let f:Awaited<ReturnType<typeof createD1Fixture>>;
const scope={ownerUserId:'owner',actorUserId:'owner',courseId:1,shareSlug:null};
const answer=plainChatAnswer('answer');
const prepare=()=>({userId:'owner',courseId:1,question:'question',answer,retrievedContexts:[],isShared:false});
const open=(id='conversation',existing=false)=>openD1Conversation(f.database,scope,id,existing);
async function result(chat:OpenConversation){
  const checkpoint=emptyCheckpoint();
  await chat.saver.put({configurable:{thread_id:chat.threadId}},checkpoint,{source:'loop',step:0,parents:{}},{});
  return {queryText:'question',answer,retrievedContexts:[],checkpointId:checkpoint.id};
}
async function count(table:string){return f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');}
beforeEach(async()=>{
  f=await createD1Fixture();
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  await f.database.prepare("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'course','','2026-01-01','2026-01-01','owner',0)").run();
});
afterEach(async()=>{vi.unstubAllGlobals();await f?.dispose();});
describe('D1 conversation lease and answer commit',()=>{
  it('claims one lease and atomically saves a log, transcript and committed checkpoint',async()=>{
    const chat=await open();await expect(open()).rejects.toBeInstanceOf(ConversationBusyError);
    const turn=await result(chat),saved=await chat.commit(turn,prepare);
    expect(saved.chatLogId).toBeTypeOf('number');expect(await count('chat_logs')).toBe(1);
    expect(await f.database.prepare('SELECT chat_log_id FROM chat_conversation_turns').first('chat_log_id')).toBe(saved.chatLogId);
    await chat.close();const resumed=await open('conversation',true);
    expect(resumed.checkpointId).toBe(turn.checkpointId);
    expect((await resumed.saver.getTuple({configurable:{thread_id:resumed.threadId,checkpoint_id:resumed.checkpointId}}))?.checkpoint.id).toBe(turn.checkpointId);
    await resumed.close();expect(await count('mutation_receipts')).toBe(0);
  });
  it('fences expired and replaced handles including stale close',async()=>{
    const old=await open(),turn=await result(old);
    await f.database.prepare("UPDATE chat_conversations SET leased_until='2000-01-01'").run();
    await expect(old.commit(turn,prepare)).rejects.toBeInstanceOf(ConversationBusyError);
    const next=await open();await old.close();await expect(open()).rejects.toBeInstanceOf(ConversationBusyError);
    await expect(old.commit(turn,prepare)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(await count('chat_logs')).toBe(0);expect(await count('chat_conversation_turns')).toBe(0);
    await next.close();
  });
  it('rolls back log creation when transcript insertion fails and preserves uncommitted model state',async()=>{
    const chat=await open(),turn=await result(chat);
    await f.database.prepare("CREATE TRIGGER fail_turn BEFORE INSERT ON chat_conversation_turns BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    await expect(chat.commit(turn,prepare)).rejects.toThrow('injected');
    expect(await count('chat_logs')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
    expect(await f.database.prepare('SELECT committed_checkpoint_id FROM chat_conversations').first('committed_checkpoint_id')).toBeNull();
    expect(await count('conversation_checkpoints')).toBe(1);
    await f.database.prepare('DROP TRIGGER fail_turn').run();await chat.commit(turn,prepare);
    await expect(chat.commit(turn,prepare)).rejects.toThrow();expect(await count('chat_logs')).toBe(1);await chat.close();
  });
  it('rejects missing checkpoints and preparation failure without publishing an answer',async()=>{
    const chat=await open(),turn=await result(chat);
    await expect(chat.commit({...turn,checkpointId:'missing'},prepare)).rejects.toBeInstanceOf(ConversationBusyError);
    await expect(chat.commit(turn,()=>{throw new Error('preparation failed');})).rejects.toThrow('preparation failed');
    expect(await count('chat_logs')).toBe(0);expect(await count('chat_conversation_turns')).toBe(0);await chat.close();
  });
  it('requires an existing live conversation and cascades expired checkpoints',async()=>{
    await expect(open('absent',true)).rejects.toBeInstanceOf(ConversationNotFoundError);
    const chat=await open();await result(chat);await chat.close();
    await f.database.prepare("UPDATE chat_conversations SET expires_at='2000-01-01'").run();
    await expect(open('conversation',true)).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await pruneD1Conversations(f.database)).toBe(1);expect(await count('conversation_checkpoints')).toBe(0);
    expect((await open()).checkpointId).toBeNull();
  });
  it('rechecks Moodle membership at commit and hides memory after scope narrows',async()=>{
    for(const id of [1,2])await f.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (?,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')").bind(id).run();
    await f.database.prepare('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,?,0),(1,2,?,1)').bind('2026-11-13','2026-11-13').run();
    const lti={...scope,actorUserId:null,ltiSubject:{subjectKey:'a'.repeat(64),resourceVideoIds:[1,2]}};
    const chat=await openD1Conversation(f.database,lti,'lti'),turn=await result(chat);
    const log=()=>({...prepare(),isShared:true,ltiSubject:lti.ltiSubject});
    await f.database.prepare('DELETE FROM video_course_members WHERE video_id=2').run();
    await expect(chat.commit(turn,log)).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await count('chat_logs')).toBe(0);
    await f.database.prepare('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,2,?,1)').bind('2026-11-13').run();
    await chat.commit(turn,log);await chat.close();
    const narrow={...lti,ltiSubject:{...lti.ltiSubject,resourceVideoIds:[1]}};
    await expect(openD1Conversation(f.database,narrow,'lti')).rejects.toBeInstanceOf(ConversationNotFoundError);
    await f.database.prepare("UPDATE chat_conversations SET expires_at='2000-01-01'").run();
    const fresh=await openD1Conversation(f.database,narrow,'lti');expect(fresh.checkpointId).toBeNull();await fresh.close();
  });
  it('prunes expired attributed logs with conversations but retains native course logs',async()=>{
    const chat=await open(),turn=await result(chat);await chat.commit(turn,prepare);await chat.close();
    await f.database.prepare("INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids) SELECT id,?,'[1]' FROM chat_logs").bind('a'.repeat(64)).run();
    const native=await open('native');await native.commit(await result(native),prepare);await native.close();
    await f.database.prepare("UPDATE chat_conversations SET expires_at='2000-01-01'").run();
    expect(await pruneD1Conversations(f.database)).toBe(2);
    expect(await count('chat_logs')).toBe(1);expect(await count('lti_chat_log_subjects')).toBe(0);
    expect(await count('conversation_checkpoints')).toBe(0);
  });

  it('runs the application RAG path and resumes from the committed pointer after a failed answer save',async()=>{
    const requests:Array<{messages:Array<{content:string}>}>=[];
    vi.stubGlobal('fetch',(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(requestBodyText(init.body));requests.push(body);
      return chatCompletionResponse({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({segments:answer.segments})}}]},!!body.stream,crypto.randomUUID());
    });
    const env={DB:f.database,DEPLOYMENT_EDITION:'cloud',OPENAI_API_KEY:'test',OPENAI_BASE_URL:'https://model.test/v1'} as Bindings;
    const invoke=(question:string,persistLog=prepare)=>runChatRag(env,{ownerUserId:'owner',videoIds:null,locale:'en',messages:[{role:'user',content:question}]},
      {id:'application',scope,persistLog});
    await invoke('first committed question');
    await expect(invoke('failed hidden question',()=>{throw new Error('injected save failure');})).rejects.toThrow();
    await invoke('resumed question');
    const messages=requests.at(-1)!.messages.map(m=>m.content).join(' ');
    expect(messages).toContain('first committed question');expect(messages).not.toContain('failed hidden question');
    expect(await count('chat_conversation_turns')).toBe(2);expect(await count('chat_logs')).toBe(2);
  });
  it('rolls back log deletion and checkpoint cascade when conversation deletion fails',async()=>{
    const chat=await open();await chat.commit(await result(chat),prepare);await chat.close();
    await f.database.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON chat_conversations BEGIN SELECT RAISE(ABORT,'injected deletion'); END").run();
    const {createD1ConversationRepository}=await import('../../src/persistence/d1/conversation');
    await expect(createD1ConversationRepository(f.database).delete(scope,'conversation')).rejects.toThrow('injected deletion');
    expect(await count('chat_logs')).toBe(1);expect(await count('chat_conversation_turns')).toBe(1);expect(await count('conversation_checkpoints')).toBe(1);
    expect(await count('mutation_receipts')).toBe(0);
  });

  it('fences a revoked Moodle session on open and answer commit',async()=>{
    await f.database.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','completed','','','2026-11-13T00:00:00Z','','uploaded','','')").run();
    await f.database.prepare('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,?,0)').bind('2026-11-13').run();
    const proof={sessionHash:'b'.repeat(64),registrationId:'db:installation',subjectHash:'c'.repeat(64)};
    await f.database.prepare("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,'session',?,'2099-01-01')").bind(proof.sessionHash,JSON.stringify(proof)).run();
    const lti={...scope,actorUserId:null,ltiSubject:{subjectKey:'a'.repeat(64),resourceVideoIds:[1],sessionProof:proof}};
    const chat=await openD1Conversation(f.database,lti,'revoked'),turn=await result(chat);
    await f.database.prepare("UPDATE lti_credentials SET expires_at='2000-01-01'").run();
    await expect(openD1Conversation(f.database,lti,'new')).rejects.toMatchObject({status:403});
    await expect(chat.commit(turn,()=>({...prepare(),isShared:true,ltiSubject:lti.ltiSubject}))).rejects.toMatchObject({status:403});
    expect(await count('chat_logs')).toBe(0);expect(await count('chat_conversation_turns')).toBe(0);await chat.close();
  });

});
