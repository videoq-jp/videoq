import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {plainChatAnswer} from '@videoq/trpc/chat';
import {conversationThreadId} from '../../../src/shared/conversation-scope';
import type {ConversationRepository,ConversationScope} from '../../../src/persistence/contracts/conversation';
type Fixture={repository:ConversationRepository;execute:(sql:string,args?:unknown[])=>Promise<void>;dispose:()=>Promise<void>};
export function conversationContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} conversation contract`,()=>{
    let f:Fixture;
    const scope:ConversationScope={ownerUserId:'owner',actorUserId:'owner',courseId:1,shareSlug:null};
    const personal=(ids=[1,2]):ConversationScope=>({...scope,actorUserId:null,ltiSubject:{subjectKey:'a'.repeat(64),resourceVideoIds:ids}});
    const seed=async(s=scope,question='question')=>{
      const id=crypto.randomUUID(),thread=await conversationThreadId(s,id),key=await conversationThreadId(s,'scope');
      await f.execute(`INSERT INTO chat_conversations(thread_id,conversation_id,scope_key,title,owner_user_id,actor_user_id,course_id,committed_checkpoint_id,expires_at)
        VALUES(?,?,?,?,?,?,?,'committed','2099-01-01T00:00:00Z')`,[thread,id,key,question,s.ownerUserId,s.actorUserId,s.courseId]);
      await f.execute('INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response) VALUES(?,?,?,?)',[thread,crypto.randomUUID(),question,JSON.stringify(plainChatAnswer('answer'))]);
      if(s.ltiSubject)await f.execute('INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids) VALUES(?,?,?)',[thread,s.ltiSubject.subjectKey,JSON.stringify(s.ltiSubject.resourceVideoIds)]);
      return {id,thread};
    };
    beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    it('lists committed conversations with pagination and normalizes detail types',async()=>{
      const first=await seed();await seed(scope,'second');
      const list=await f.repository.list(scope,{limit:1,offset:0});expect(list.items).toHaveLength(1);expect(list.hasMore).toBe(true);
      expect(list.items[0].isGenerating).toBe(false);expect(list.items[0].createdAt).toMatch(/Z$/);
      const detail=await f.repository.detail(scope,{conversationId:first.id,limit:10});expect(detail.turns[0]).toMatchObject({question:'question',chatLogId:null,feedback:null});
      expect(detail.turns[0].id).toBeTypeOf('string');expect(detail.turns[0].createdAt).toMatch(/Z$/);
      await f.execute('UPDATE chat_conversations SET committed_checkpoint_id=NULL WHERE thread_id=?',[first.thread]);
      expect((await f.repository.list(scope,{limit:10,offset:0})).items).toHaveLength(1);
    });
    it('pages transcript from newest to oldest and returns each page chronologically',async()=>{
      const {id,thread}=await seed();
      for(const question of ['two','three'])await f.execute('INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response) VALUES(?,?,?,?)',[thread,crypto.randomUUID(),question,JSON.stringify(plainChatAnswer(question))]);
      const page=await f.repository.detail(scope,{conversationId:id,limit:2});expect(page.turns.map(t=>t.question)).toEqual(['two','three']);expect(page.hasMore).toBe(true);
      const older=await f.repository.detail(scope,{conversationId:id,beforeTurnId:page.turns[0].id,limit:2});expect(older.turns.map(t=>t.question)).toEqual(['question']);expect(older.hasMore).toBe(false);
    });
    it('isolates account and shared browser identities and limits shared candidate IDs',async()=>{
      const {id}=await seed();const other={...scope,actorUserId:'outsider'};
      await expect(f.repository.detail(other,{conversationId:id,limit:10})).rejects.toMatchObject({status:404});await f.repository.delete(other,id);
      expect((await f.repository.detail(scope,{conversationId:id,limit:10})).turns).toHaveLength(1);
      const shared={...scope,actorUserId:null,shareSlug:'public',visitorSessionId:'browser-one'},item=await seed(shared);
      expect((await f.repository.list(shared,{limit:10,offset:0})).items).toEqual([]);
      expect((await f.repository.list(shared,{limit:10,offset:0,conversationIds:[item.id]})).items).toHaveLength(1);
      await expect(f.repository.detail({...shared,visitorSessionId:'browser-two'},{conversationId:item.id,limit:10})).rejects.toMatchObject({status:404});
    });
    it('blocks deletion during an answer and deletes a released transcript',async()=>{
      const {id,thread}=await seed();await f.execute("UPDATE chat_conversations SET lease_id=?,leased_until='2099-01-01' WHERE thread_id=?",[crypto.randomUUID(),thread]);
      await expect(f.repository.delete(scope,id)).rejects.toMatchObject({status:409});expect((await f.repository.detail(scope,{conversationId:id,limit:10})).isGenerating).toBe(true);
      await f.execute('UPDATE chat_conversations SET lease_id=NULL,leased_until=NULL WHERE thread_id=?',[thread]);await f.repository.delete(scope,id);
      await expect(f.repository.detail(scope,{conversationId:id,limit:10})).rejects.toMatchObject({status:404});
    });
    it('hides narrowed Moodle memory but allows its subject to delete even an empty scope',async()=>{
      const {id}=await seed(personal());const narrowed=personal([1]);
      expect((await f.repository.list(narrowed,{limit:10,offset:0})).items).toEqual([]);
      await expect(f.repository.detail(narrowed,{conversationId:id,limit:10})).rejects.toMatchObject({status:404});
      await f.repository.delete(personal([]),id);await expect(f.repository.detail(personal(),{conversationId:id,limit:10})).rejects.toMatchObject({status:404});
    });
    it('rejects revoked Moodle sessions for list, detail and deletion',async()=>{
      const proof={sessionHash:'b'.repeat(64),registrationId:'db:installation',subjectHash:'c'.repeat(64)};
      const current={...personal(),ltiSubject:{...personal().ltiSubject!,sessionProof:proof}};
      await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[proof.sessionHash,'session',JSON.stringify(proof),'2099-01-01']);
      const {id}=await seed(current);expect((await f.repository.detail(current,{conversationId:id,limit:10})).turns).toHaveLength(1);
      await f.execute("UPDATE lti_credentials SET expires_at='2000-01-01'");
      await expect(f.repository.list(current,{limit:10,offset:0})).rejects.toMatchObject({status:403});
      await expect(f.repository.detail(current,{conversationId:id,limit:10})).rejects.toMatchObject({status:403});
      await expect(f.repository.delete(current,id)).rejects.toMatchObject({status:403});
      expect((await f.repository.detail(personal(),{conversationId:id,limit:10})).turns).toHaveLength(1);
    });

  });
}
