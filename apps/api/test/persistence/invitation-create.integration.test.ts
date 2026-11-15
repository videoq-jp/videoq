import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks} from '../../src/db/schema';
import {createPendingCourseInvitations,acceptCourseInvitation} from '../../src/repositories/course-invitation-repository';
import {inviteCourseMembers,previewCourseInvitation} from '../../src/features/course-memberships/service';
import {claimExternalTasks} from '../../src/repositories/external-task-repository';
import {deliverInvitationEmail} from '../../src/lib/invitation-delivery';
import {sendMail} from '../../src/lib/mail';
import {hashInvitationToken} from '../../src/lib/course-invitations';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
vi.mock('../../src/lib/mail',()=>({sendMail:vi.fn(async()=>{})}));
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} atomic invitation creation contract`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,rows:(sql:string)=>Promise<Record<string,unknown>[]>,dispose:()=>Promise<void>,database:D1Database|undefined;
  const at=new Date('2026-11-13T00:00:00Z');
  beforeEach(async()=>{
   vi.mocked(sendMail).mockClear();
   if(backend==='d1'){
    const f=await createD1Fixture();database=f.database;dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node'} as Bindings;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};rows=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};rows=async(sql)=>(await f.pool.query(sql)).rows;
   }
   Object.assign(env,{BETTER_AUTH_URL:'https://invitations.example',ENVIRONMENT:'development',BETTER_AUTH_SECRET:'invitation-creation-secret-01234567890123456789'});
   for(const id of ['owner','learner','peer'])await execute('INSERT INTO users(id,username,name,email,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,?,?,0,0,0)',[id,id,id,id+'@example.test',true,false]);
   await execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'Course','','2026-01-01','2026-01-01','owner',0)");
  });
  afterEach(async()=>{vi.restoreAllMocks();await dispose?.();});
  const input=(email='learner@example.test',hash=crypto.randomUUID())=>({email,tokenHash:hash,createdAt:at,expiresAt:new Date('2099-01-01')});
  const create=(inputs=[input()])=>createPendingCourseInvitations(env,1,'owner',inputs);
  const snapshot=async()=>({invitations:await rows('SELECT id,email,status,token_hash FROM video_course_invitations ORDER BY id'),tasks:await rows('SELECT kind,payload,dedupe_key FROM external_tasks ORDER BY id')});
  it('creates invitations once and returns existing pending recipients without new deliveries',async()=>{
   const first=await create();expect(first).toMatchObject({created:[{id:expect.any(Number),email:'learner@example.test'}],alreadyMemberEmails:[],alreadyPendingEmails:[]});const before=await snapshot();expect(before.tasks).toHaveLength(backend==='d1'?1:0);
   expect(await create()).toEqual({created:[],alreadyMemberEmails:[],alreadyPendingEmails:['learner@example.test']});expect(await snapshot()).toEqual(before);
  });
  it('skips the owner and existing members using shared whitespace/Unicode normalization',async()=>{
   await execute("UPDATE users SET email=' ÜSER@Example.Test ' WHERE id='learner'");await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'learner','2026-01-01')");
   const result=await create([input('owner@example.test'),input('üser@example.test'),input('peer@example.test')]);expect(result).toMatchObject({created:[{email:'peer@example.test'}],alreadyPendingEmails:[]});if(!('created'in result))throw new Error('not found');expect(result.alreadyMemberEmails.sort()).toEqual(['owner@example.test','üser@example.test']);
  });
  it('expires stale pending rows before re-inviting without losing their history',async()=>{
   await create();await execute("UPDATE video_course_invitations SET expires_at='2000-01-01'");const result=await create();expect(result).toMatchObject({created:[{email:'learner@example.test'}],alreadyPendingEmails:[]});expect((await snapshot()).invitations.map(i=>i.status)).toEqual(['expired','pending']);
  });
  it('handles duplicate recipients and token hash conflicts without duplicate deliveries',async()=>{
   const recipient=input();expect(await create([recipient,recipient])).toMatchObject({created:[{email:recipient.email}],alreadyPendingEmails:[]});const before=await snapshot();expect(await create([input('peer@example.test',recipient.tokenHash)])).toEqual({created:[],alreadyMemberEmails:[],alreadyPendingEmails:['peer@example.test']});expect(await snapshot()).toEqual(before);
  });
  it('limits batches to 100 and creates the maximum batch atomically',async()=>{
   const inputs=Array.from({length:100},(_,i)=>input(`learner${i}@example.test`));await expect(create([...inputs,input('overflow@example.test')])).rejects.toThrow('100');expect((await snapshot()).invitations).toHaveLength(0);
   const result=await create(inputs);if(!('created'in result))throw new Error('not found');expect(result.created).toHaveLength(100);expect(new Set(result.created.map(i=>i.id)).size).toBe(100);expect((await snapshot()).tasks).toHaveLength(backend==='d1'?100:0);
   if(backend==='d1')expect(await rows('SELECT id FROM video_course_invitations WHERE creation_nonce IS NOT NULL')).toEqual([]);
  });
  it('serializes overlapping creations and assigns one invitation per recipient',async()=>{
   const results=await Promise.all([create([input('learner@example.test'),input('peer@example.test')]),create([input('peer@example.test')])]);expect(results.flatMap(r=>'created'in r?r.created:[])).toHaveLength(2);expect((await snapshot()).invitations).toHaveLength(2);
  });
  it.each(['managed','disabled','protected-video']as const)('denies native invitations for %s courses',async(kind)=>{
   if(kind==='managed')await execute('UPDATE video_courses SET managed_by_lms=?',[true]);else if(kind==='disabled')await execute('UPDATE video_courses SET native_access_disabled=?',[true]);else{await execute("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id,managed_by_lms) VALUES(1,'','Video','','2026-01-01','','completed','','owner','uploaded','','',?)",[true]);await execute('INSERT INTO video_course_members(added_at,"order",course_id,video_id) VALUES(?,0,1,1)',['2026-01-01']);}
   expect(await create()).toEqual({notFound:true});expect((await snapshot()).invitations).toEqual([]);expect((await snapshot()).tasks).toEqual([]);
  });
  it('requires the owner and treats an empty batch as a valid no-op',async()=>{
   expect(await createPendingCourseInvitations(env,1,'peer',[input()])).toEqual({notFound:true});expect(await create([])).toEqual({created:[],alreadyMemberEmails:[],alreadyPendingEmails:[]});expect((await snapshot()).tasks).toEqual([]);
  });
  it('rolls back all invitations and expiration updates when an outbox insert fails',async()=>{
   await create();await execute("UPDATE video_course_invitations SET expires_at='2000-01-01'");if(backend==='postgres'){env.DEPLOYMENT_EDITION='cloud';env.PERSISTENCE_BACKEND='postgres';env.MIGRATION_ALLOW_CLOUD_POSTGRES='true';}
   if(backend==='d1')await execute("CREATE TRIGGER fail_mail BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'mail failure'); END");else await execute("CREATE FUNCTION fail_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mail failure'; END $$; CREATE TRIGGER fail_mail BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION fail_mail()");
   const before=await snapshot();await expect(create([input(),input('peer@example.test')])).rejects.toThrow();expect(await snapshot()).toEqual(before);
  });
  it('supports the real service lifecycle with cloud mail or onprem manual links',async()=>{
   const result=await inviteCourseMembers(env,1,'owner',['learner@example.test'],new Date());if(!('results'in result))throw new Error('creation failed');expect(result.results[0].status).toBe('queued');let token:string;
   if(backend==='d1'){
    expect(result.results[0].invitation_url).toBeUndefined();const [lease]=await claimExternalTasks(env,{limit:1});expect(await deliverInvitationEmail(env,result.results[0].invitation_id!,lease)).toEqual({delivered:true});const link=vi.mocked(sendMail).mock.calls[0][3].find(s=>s.startsWith('https://'))!;token=decodeURIComponent(new URL(link).pathname.split('/').pop()!);
   }else token=decodeURIComponent(new URL(result.results[0].invitation_url!).pathname.split('/').pop()!);
   expect(await previewCourseInvitation(env,token)).toMatchObject({course_id:1,status:'pending'});expect(await acceptCourseInvitation(env,await hashInvitationToken(token),'learner',new Date())).toEqual({ok:true,courseId:1});expect(await rows('SELECT user_id FROM video_course_memberships')).toEqual([{user_id:'learner'}]);expect(JSON.stringify(await snapshot())).not.toContain(token);
  });
  if(backend==='d1')it.each(['member','owner-email','course']as const)('rechecks changed %s snapshots before creating',async(kind)=>{
   const db=database!,original=db.batch.bind(db);let changed=false;env.DB=new Proxy(db,{get(object,key){if(key!=='batch'){const v=Reflect.get(object,key);return typeof v==='function'?v.bind(object):v;}return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;if(kind==='member')await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'learner','2026-01-01')");else if(kind==='owner-email')await execute("UPDATE users SET email='new-owner@example.test' WHERE id='owner'");else await execute('UPDATE video_courses SET managed_by_lms=?',[true]);}return original(statements);};}});
   // The email uniqueness constraint prevents an owner adopting another user's
   // address: use a distinct recipient for that owner-email race.
   const result=await create([input(kind==='owner-email'?'new-owner@example.test':'learner@example.test')]);if(kind==='course')expect(result).toEqual({notFound:true});else expect(result).toMatchObject({created:[],alreadyMemberEmails:[kind==='member'?'learner@example.test':'new-owner@example.test']});
   expect((await snapshot()).invitations).toEqual([]);expect(await rows('SELECT token FROM mutation_receipts')).toEqual([]);
  });
 });
}
