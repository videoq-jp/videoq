import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks} from '../../src/db/schema';
import {recordInvitationDeliveryOutcomes,rotateInvitationTokenForDelivery,failInvitationsWithoutLiveDelivery,listCourseParticipants,getCourseInvitationByTokenHash} from '../../src/repositories/course-invitation-repository';
import {claimExternalTasks,failExternalTask} from '../../src/repositories/external-task-repository';
import {deliverInvitationEmail} from '../../src/lib/invitation-delivery';
import {hashInvitationToken} from '../../src/lib/course-invitations';
import {sendMail} from '../../src/lib/mail';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
import type {ExternalTaskLease} from '../../src/persistence/contracts/external-task-repository';
vi.mock('../../src/lib/mail',()=>({sendMail:vi.fn(async()=>{})}));
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} invitation delivery contract`,()=>{
  let env:Bindings,lease:ExternalTaskLease,execute:(sql:string,args?:unknown[])=>Promise<void>,rows:(sql:string)=>Promise<Record<string,unknown>[]>,dispose:()=>Promise<void>;
  beforeEach(async()=>{
   vi.mocked(sendMail).mockClear();vi.mocked(sendMail).mockResolvedValue();
   if(backend==='d1'){
    const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node'} as Bindings;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};rows=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};rows=async(sql)=>(await f.pool.query(sql)).rows;
   }
   await execute('INSERT INTO users(id,username,name,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,?,0,0,0)',['owner','owner','Teacher','owner@example.test',false]);
   await execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'Course','','2026-01-01','2026-01-01','owner',0)");
   await execute("INSERT INTO video_course_invitations(id,course_id,email,invited_by_user_id,token_hash,expires_at,created_at,updated_at) VALUES(1,1,'learner@example.test','owner','initial-hash','2099-01-01','2000-01-01','2000-01-01')");
   await execute('INSERT INTO external_tasks(id,kind,payload,dedupe_key) VALUES(?,?,?,?)',[1,'invitation_email',JSON.stringify({invitation_id:1}),'delivery']);
   [lease]=await claimExternalTasks(env,{limit:1,taskId:1});expect(lease).toBeDefined();
  });
  afterEach(async()=>{vi.restoreAllMocks();await dispose?.();});
  const state=async()=>({invitations:await rows('SELECT id,status,delivery_status,token_hash,last_sent_at,last_error,send_attempts,updated_at FROM video_course_invitations ORDER BY id'),tasks:await rows('SELECT id,attempts,locked_at,completed_at,last_error FROM external_tasks ORDER BY id')});
  it('previews an exact hash, normalizes dates and falls back to the inviter username',async()=>{
   expect(await getCourseInvitationByTokenHash(env,'missing')).toBeNull();expect(await getCourseInvitationByTokenHash(env,'initial-hash')).toEqual({course_id:1,course_name:'Course',inviter_name:'Teacher',email:'learner@example.test',status:'pending',expires_at:'2099-01-01T00:00:00.000Z'});
   await execute("UPDATE users SET name=' ' WHERE id='owner'");expect((await getCourseInvitationByTokenHash(env,'initial-hash'))?.inviter_name).toBe('owner');
  });
  it('restricts the participant list to its owner and presents expired invitations without mutating them',async()=>{
   await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',['learner','learner','learner@example.test',false]);
   await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'learner','2026-01-01T09:00:00+09:00')");
   await execute("UPDATE video_course_invitations SET expires_at='2000-01-01' WHERE id=1");
   expect(await listCourseParticipants(env,1,'learner')).toEqual({notFound:true});expect(await listCourseParticipants(env,99,'owner')).toEqual({notFound:true});
   expect(await listCourseParticipants(env,1,'owner')).toEqual({invitations:[{id:1,email:'learner@example.test',status:'expired',delivery_status:'queued',expires_at:'2000-01-01T00:00:00.000Z',created_at:'2000-01-01T00:00:00.000Z',last_sent_at:null,send_attempts:0}],members:[{user_id:'learner',username:'learner',email:'learner@example.test',joined_at:'2026-01-01T00:00:00.000Z'}]});
   expect((await state()).invitations[0].status).toBe('pending');
  });
  it('rotates only the hash and commits delivery status and task completion together',async()=>{
   const now=new Date();expect(await rotateInvitationTokenForDelivery(env,1,'next-hash',now,lease)).toEqual({email:'learner@example.test',courseName:'Course',inviterName:'Teacher'});
   await recordInvitationDeliveryOutcomes(env,[{invitationId:1,status:'sent',attemptedAt:now}],{lease,completeTask:true});const current=await state();expect(current.invitations[0]).toMatchObject({token_hash:'next-hash',delivery_status:'sent',send_attempts:1,last_error:null});expect(current.tasks[0].completed_at).not.toBeNull();expect(current.tasks[0].locked_at).toBeNull();
   await expect(rotateInvitationTokenForDelivery(env,1,'late-hash',now,lease)).rejects.toThrow('lease');
  });
  it('records failed attempts without completing the task and preserves the most recent sent time',async()=>{
   const sent=new Date('2026-01-01T00:00:00Z'),failed=new Date('2026-01-02T00:00:00Z');
   await recordInvitationDeliveryOutcomes(env,[{invitationId:1,status:'sent',attemptedAt:sent},{invitationId:1,status:'failed',attemptedAt:failed,error:'x'.repeat(1100)}],{lease});
   const current=await state();expect(current.invitations[0]).toMatchObject({delivery_status:'failed',send_attempts:2,last_error:'x'.repeat(1000)});expect(new Date(current.invitations[0].last_sent_at as string).toISOString()).toBe(sent.toISOString());expect(current.tasks[0].completed_at).toBeNull();
  });
  it('keeps ordered bulk outcomes atomic without an unbounded D1 statement batch',async()=>{
   const outcomes=Array.from({length:100},(_,i)=>({invitationId:1,status:i%2===0?'sent' as const:'failed' as const,attemptedAt:new Date(Date.UTC(2026,0,1,0,0,i)),error:i%2===0?undefined:'retry'}));
   await recordInvitationDeliveryOutcomes(env,outcomes,{lease});const current=await state();expect(current.invitations[0]).toMatchObject({send_attempts:100,delivery_status:'failed',last_error:'retry'});expect(new Date(current.invitations[0].last_sent_at as string).toISOString()).toBe(outcomes[98].attemptedAt.toISOString());expect(current.tasks[0].completed_at).toBeNull();
  });
  it('supports completing an otherwise empty delivery without changing invitation counters',async()=>{
   const before=(await state()).invitations;await recordInvitationDeliveryOutcomes(env,[],{lease,completeTask:true});expect((await state()).invitations).toEqual(before);expect((await state()).tasks[0].completed_at).not.toBeNull();
  });
  it('rejects expired and superseded leases before changing the invitation',async()=>{
   await execute("UPDATE external_tasks SET locked_at='2000-01-01' WHERE id=1");const before=await state();
   await expect(rotateInvitationTokenForDelivery(env,1,'stale',new Date(),lease)).rejects.toThrow('lease');await expect(recordInvitationDeliveryOutcomes(env,[{invitationId:1,status:'sent',attemptedAt:new Date()}],{lease,completeTask:true})).rejects.toThrow('lease');expect(await state()).toEqual(before);
   const [fresh]=await claimExternalTasks(env,{limit:1,taskId:1});expect(fresh.attempt).toBe(lease.attempt+1);await expect(rotateInvitationTokenForDelivery(env,1,'stale',new Date(),lease)).rejects.toThrow('lease');expect(await rotateInvitationTokenForDelivery(env,1,'fresh',new Date(),fresh)).toMatchObject({email:'learner@example.test'});
  });
  it.each(['accepted','revoked','expired']as const)('skips %s invitations without replacing their token',async(status)=>{
   if(status==='expired')await execute("UPDATE video_course_invitations SET expires_at='2000-01-01' WHERE id=1");else await execute('UPDATE video_course_invitations SET status=? WHERE id=1',[status]);
   expect(await rotateInvitationTokenForDelivery(env,1,'new-hash',new Date(),lease)).toEqual({invalidState:status});expect((await state()).invitations[0]).toMatchObject({token_hash:'initial-hash',status});
  });
  it.each(['managed','disabled','protected-video']as const)('does not send native invitations into %s LMS scope',async(kind)=>{
   if(kind==='managed')await execute('UPDATE video_courses SET managed_by_lms=? WHERE id=1',[true]);
   else if(kind==='disabled')await execute('UPDATE video_courses SET native_access_disabled=? WHERE id=1',[true]);
   else {await execute("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id,managed_by_lms) VALUES(1,'','Video','','2026-01-01','','completed','','owner','uploaded','','',?)",[true]);await execute('INSERT INTO video_course_members(added_at,"order",course_id,video_id) VALUES(?,0,1,1)',['2026-01-01']);}
   expect(await getCourseInvitationByTokenHash(env,'initial-hash')).toBeNull();expect(await rotateInvitationTokenForDelivery(env,1,'new-hash',new Date(),lease)).toEqual({notFound:true});expect((await state()).invitations[0].token_hash).toBe('initial-hash');
  });
  it('only marks stranded queued deliveries failed while preserving live retries and terminal invitations',async()=>{
   const now=new Date();expect(await failInvitationsWithoutLiveDelivery(env,now,60000)).toEqual({failed:0});await execute("UPDATE external_tasks SET dead_at=? WHERE id=1",[now.toISOString()]);expect(await failInvitationsWithoutLiveDelivery(env,now,60000)).toEqual({failed:1});expect(await failInvitationsWithoutLiveDelivery(env,now,60000)).toEqual({failed:0});expect((await state()).invitations[0].delivery_status).toBe('failed');
  });
  it('rolls back invitation results if completing the task fails afterwards',async()=>{
   if(backend==='d1')await execute("CREATE TRIGGER fail_complete BEFORE UPDATE OF completed_at ON external_tasks WHEN NEW.completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'completion failure'); END");
   else await execute("CREATE FUNCTION fail_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'completion failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_complete BEFORE UPDATE ON external_tasks FOR EACH ROW EXECUTE FUNCTION fail_complete()");
   const before=await state();await expect(recordInvitationDeliveryOutcomes(env,[{invitationId:1,status:'sent',attemptedAt:new Date()}],{lease,completeTask:true})).rejects.toThrow();expect(await state()).toEqual(before);
  });
  if(backend==='d1')it('recovers a provider failure with a fresh delivery lease and token',async()=>{
   vi.mocked(sendMail).mockRejectedValueOnce(new Error('provider unavailable'));
   await expect(deliverInvitationEmail(env,1,lease)).rejects.toThrow('provider unavailable');const failed=await state();expect(failed.invitations[0]).toMatchObject({delivery_status:'failed',send_attempts:1});expect(failed.tasks[0].completed_at).toBeNull();
   await failExternalTask(env,lease,'provider unavailable');await execute("UPDATE external_tasks SET available_at='2000-01-01' WHERE id=1");const [fresh]=await claimExternalTasks(env,{limit:1,taskId:1});expect(await deliverInvitationEmail(env,1,fresh)).toEqual({delivered:true});const current=await state();expect(current.invitations[0]).toMatchObject({delivery_status:'sent',send_attempts:2,last_error:null});expect(current.invitations[0].token_hash).not.toBe(failed.invitations[0].token_hash);expect(current.tasks[0].completed_at).not.toBeNull();
  });
  if(backend==='d1')it('delivers through the real orchestrator with a mocked mail provider and persists no plaintext token',async()=>{
   expect(await deliverInvitationEmail(env,1,lease)).toEqual({delivered:true});expect(sendMail).toHaveBeenCalledTimes(1);
   const lines=vi.mocked(sendMail).mock.calls[0][3],url=lines.find(line=>line.startsWith('https://'))!;const token=decodeURIComponent(new URL(url).pathname.split('/').pop()!);expect(token).toBeTruthy();const current=await state();expect(current.invitations[0].token_hash).toBe(await hashInvitationToken(token));expect(JSON.stringify(current)).not.toContain(token);expect(current.tasks[0].completed_at).not.toBeNull();
  });
 });
}
