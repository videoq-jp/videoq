import {afterEach,beforeEach,describe,expect,it} from "vitest";
import type {ChatRepository,CreateChatLogInput} from "../../../src/persistence/contracts/chat-repository";
export interface ChatFixture {repository:ChatRepository;execute(sql:string,args?:unknown[]):Promise<void>;count(table:string):Promise<number>;subject():Promise<{subjectKey:string;resourceVideoIds:number[];registrationId:string|null;contextId:string|null}|null>;failAttribution():Promise<void>;failHistoryDelete():Promise<void>;dispose():Promise<void>}
const answer={segments:[{text:'回答',sourceIds:[]}],sources:[]};
const input=(shared=false):CreateChatLogInput=>({userId:shared?'owner':'learner',courseId:1,question:'質問',answer,isShared:shared,retrievedContexts:['context']});
export function chatContract(name:string,create:()=>Promise<ChatFixture>) {
  describe(`${name}: chat persistence`,()=>{
    let f:ChatFixture;beforeEach(async()=>{f=await create();});afterEach(async()=>{await f?.dispose();});
    it('resolves owner, member, share and scoped LTI contexts',async()=>{
      expect(await f.repository.context({courseId:1,userId:'owner'})).toEqual({id:1,userId:'owner',memberVideoIds:[2,1]});
      expect(await f.repository.context({courseId:1,userId:'learner'})).toHaveProperty('id',1);
      expect(await f.repository.context({courseId:1,userId:'outsider'})).toBeNull();
      expect(await f.repository.context({courseId:1,shareToken:'public'})).toHaveProperty('id',1);
      expect(await f.repository.context({courseId:1,ltiCourseGrant:1,ltiVideoGrant:[1]})).toEqual({id:1,userId:'owner',memberVideoIds:[1]});
      await f.execute('UPDATE videos SET managed_by_lms=true WHERE id=2');
      expect(await f.repository.context({courseId:1,userId:'learner'})).toBeNull();
      expect(await f.repository.context({courseId:1,shareToken:'public'})).toBeNull();
      expect(await f.repository.shareExists('public')).toBe(false);
      expect(await f.repository.context({courseId:1,userId:'owner'})).not.toBeNull();
      expect(await f.repository.context({courseId:1,ltiCourseGrant:1})).not.toBeNull();
      await f.execute('UPDATE users SET banned=true WHERE id=?',['owner']);
      expect(await f.repository.context({courseId:1,ltiCourseGrant:1})).toBeNull();
    });
    it('keeps structured answers and suppresses shared authors',async()=>{
      const native=await f.repository.create(input());const shared=await f.repository.create(input(true));
      const page=await f.repository.history(1,'owner',10,0);
      if ('notFound' in page) throw new Error('Missing history');
      expect(page.count).toBe(2);expect(page.results.map(r=>r.id)).toEqual([shared.id,native.id]);
      expect(page.results[0].asked_by).toBeNull();
      expect(page.results[1].asked_by).toEqual({user_id:'learner',username:'learner',email:'learner@example.test'});
      expect(page.results[0].answer).toEqual(answer);
      expect(await f.repository.history(1,'learner',10,0)).toEqual({notFound:true});
      expect(await f.repository.history(1,'owner',10,50)).toEqual({count:2,results:[]});
    });
    it('enforces feedback authorization in the write',async()=>{
      const native=await f.repository.create(input());const shared=await f.repository.create(input(true));
      expect(await f.repository.feedback(native.id,'good',{userId:'outsider'})).toEqual({forbidden:true});
      expect(await f.repository.feedback(native.id,'good',{shareSlug:'public'})).toEqual({forbidden:true});
      expect(await f.repository.feedback(shared.id,'bad',{shareSlug:'public'})).toEqual({id:shared.id,feedback:'bad'});
      expect(await f.repository.feedback(native.id,'good',{userId:'learner'})).toEqual({id:native.id,feedback:'good'});
      await f.execute('UPDATE video_courses SET managed_by_lms=true WHERE id=1');
      expect(await f.repository.feedback(shared.id,null,{shareSlug:'public'})).toEqual({forbidden:true});
      expect(await f.repository.feedback(shared.id,null,{ltiCourseGrant:1})).toEqual({id:shared.id,feedback:null});
      expect(await f.repository.feedback(native.id,null,{userId:'learner'})).toEqual({forbidden:true});
      expect(await f.repository.feedback(native.id,null,{userId:'owner'})).toEqual({id:native.id,feedback:null});
      expect(await f.repository.feedback(999,null,{userId:'owner'})).toEqual({notFound:true});
    });
    it('exports every tied timestamp once with a bounded stable cursor',async()=>{
      for (let i=0;i<105;i++) await f.repository.create({...input(i%2===0),question:`question-${i}`});
      await f.execute("UPDATE chat_logs SET created_at='2026-11-13T00:00:00.123456Z'");
      const first=await f.repository.exportPage(1,'owner',null);
      expect(first.rows).toHaveLength(100);expect(first.nextCursor).not.toBeNull();
      const second=await f.repository.exportPage(1,'owner',first.nextCursor);
      expect(second.rows).toHaveLength(5);expect(second.nextCursor).toBeNull();
      expect(new Set([...first.rows,...second.rows].map(r=>r.question)).size).toBe(105);
      expect(first.rows[0].answer).toBe('回答');expect(first.rows[0].asked_by).toBeNull();
      expect(await f.repository.exportPage(1,'learner',null)).toEqual({rows:[],nextCursor:null});
    });
    it('aggregates UTC dates and counts only NULL feedback as none',async()=>{
      for (let i=0;i<3;i++) {
        const row=await f.repository.create(input());
        await f.execute('UPDATE chat_logs SET created_at=?,feedback=? WHERE id=?',[i===2?'2026-11-14T00:00:00.000001Z':'2026-11-13T23:59:59.999999Z',i===0?'good':i===1?'':null,row.id]);
      }
      expect(await f.repository.analytics(1,'owner')).toEqual({summary:{total_questions:3,date_range:{first:'2026-11-13T23:59:59.999Z',last:'2026-11-14T00:00:00.000Z'}},
        time_series:[{date:'2026-11-13',count:2},{date:'2026-11-14',count:1}],feedback:{good:1,bad:0,none:1}});
      expect(await f.repository.analytics(1,'learner')).toEqual({notFound:true});
    });
    it('validates LTI attribution and writes log/subject together',async()=>{
      const subject={subjectKey:'a'.repeat(64),resourceVideoIds:[2,1,2],sessionProof:{sessionHash:'b'.repeat(64),registrationId:'db:installation',subjectHash:'c'.repeat(64)}};
      const payload={registrationId:subject.sessionProof.registrationId,subjectHash:subject.sessionProof.subjectHash,courseId:1,contextId:'context'};
      await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES (?,?,?,?)',[subject.sessionProof.sessionHash,'session',JSON.stringify(payload),'2099-01-01T00:00:00.000Z']);
      await f.repository.create({...input(true),ltiSubject:subject});
      expect(await f.count('chat_logs')).toBe(1);expect(await f.count('lti_chat_log_subjects')).toBe(1);
      expect(await f.subject()).toEqual({subjectKey:subject.subjectKey,resourceVideoIds:[1,2],registrationId:'db:installation',contextId:'context'});
      await f.execute("UPDATE lti_credentials SET expires_at='2000-01-01T00:00:00.000Z'");
      await expect(f.repository.create({...input(true),ltiSubject:subject})).rejects.toThrow();
      expect(await f.count('chat_logs')).toBe(1);
      await expect(f.repository.create({...input(),ltiSubject:subject})).rejects.toThrow('external course grant');
    });
    it.each(['classroom','native'])('snapshots the verified %s question author in history and CSV without trusting another course',async transport=>{
      const subject={subjectKey:'a'.repeat(64),resourceVideoIds:[1],sessionProof:{sessionHash:'b'.repeat(64),registrationId:'db:installation',subjectHash:'c'.repeat(64)}};
      const claimed={user_id:'external-student',username:'Student',email:'student@example.test'};
      const payload={registrationId:subject.sessionProof.registrationId,subjectHash:subject.sessionProof.subjectHash,courseId:1,transport,
        ...(transport==='classroom'?{classroomAuthor:claimed}:{moodleAuthor:claimed})};
      await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[subject.sessionProof.sessionHash,'session',JSON.stringify(payload),'2099-01-01T00:00:00.000Z']);
      const saved=await f.repository.create({...input(true),ltiSubject:subject});
      await f.execute('UPDATE lti_credentials SET payload=?',[JSON.stringify({...payload,classroomAuthor:{...claimed,username:'changed'},moodleAuthor:{...claimed,username:'changed'}})]);
      const page=await f.repository.history(1,'owner',10,0);if('notFound' in page)throw new Error('Missing history');
      expect(page.results[0]).toMatchObject({id:saved.id,asked_by:claimed,is_shared_origin:true});
      expect((await f.repository.exportPage(1,'owner',null)).rows[0].asked_by).toEqual(claimed);
      for(const altered of [{...payload,courseId:2},{...payload,transport:'unknown'}]){
        await f.execute('UPDATE lti_credentials SET payload=?',[JSON.stringify(altered)]);
        await f.repository.create({...input(true),ltiSubject:subject});
        const history=await f.repository.history(1,'owner',1,0);if('notFound' in history)throw new Error('Missing history');
        expect(history.results[0].asked_by).toBeNull();
      }
    });
    it('deletes course history and conversations only for the current owner',async()=>{
      await f.repository.create(input());
      await f.execute('INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,course_id,expires_at) VALUES (?,?,?,?,?)',['thread','conversation','owner',1,'2099-01-01T00:00:00.000Z']);
      expect(await f.repository.deleteHistory(1,'learner')).toEqual({notFound:true});
      expect(await f.count('chat_logs')).toBe(1);
      expect(await f.repository.deleteHistory(1,'owner')).toEqual({ok:true});
      expect(await f.count('chat_logs')).toBe(0);expect(await f.count('chat_conversations')).toBe(0);
      expect(await f.repository.analytics(1,'owner')).toEqual({summary:{total_questions:0,date_range:{first:null,last:null}},time_series:[],feedback:{good:0,bad:0,none:0}});
    });
    it('rolls back an answer when its attribution cannot be stored',async()=>{
      await f.failAttribution();
      await expect(f.repository.create({...input(true),ltiSubject:{subjectKey:'a'.repeat(64),resourceVideoIds:[1]}})).rejects.toThrow();
      expect(await f.count('chat_logs')).toBe(0);expect(await f.count('lti_chat_log_subjects')).toBe(0);
    });
    it('rolls back conversation deletion when history deletion fails',async()=>{
      await f.repository.create(input());
      await f.execute('INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,course_id,expires_at) VALUES (?,?,?,?,?)',['thread','conversation','owner',1,'2099-01-01T00:00:00.000Z']);
      await f.failHistoryDelete();
      await expect(f.repository.deleteHistory(1,'owner')).rejects.toThrow();
      expect(await f.count('chat_conversations')).toBe(1);expect(await f.count('chat_logs')).toBe(1);
    });

  });
}
