import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks,runtimeRateLimits} from '../../src/db/schema';
import {createApp} from '../../src/app';
import {testAuthHeaders} from '../helpers/auth';
import {hashInvitationToken} from '../../src/lib/course-invitations';
import * as invitations from '../../src/repositories/course-invitation-repository';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} invitation decisions and control contract`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,rows:(sql:string)=>Promise<Record<string,unknown>[]>,dispose:()=>Promise<void>,database:D1Database|undefined;
  beforeEach(async()=>{
   if(backend==='d1'){
    const f=await createD1Fixture();database=f.database;dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node'} as Bindings;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};rows=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,externalTasks,runtimeRateLimits}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};rows=async(sql)=>(await f.pool.query(sql)).rows;
   }
   Object.assign(env,{ENVIRONMENT:'development',BETTER_AUTH_URL:'https://invitations.example',BETTER_AUTH_SECRET:'invitation-fixture-secret-01234567890123456789'});
   for(const id of ['owner','learner','peer'])await execute('INSERT INTO users(id,username,email,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,?,0,0,0)',[id,id,id+'@example.test',true,false]);
   await execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'Course','','2026-01-01','2026-01-01','owner',0)");
   await execute("INSERT INTO video_course_invitations(id,course_id,email,invited_by_user_id,token_hash,expires_at,created_at,updated_at) VALUES(1,1,'learner@example.test','owner','hash','2099-01-01','2026-01-01','2026-01-01')");
  });
  afterEach(async()=>{await dispose?.();});
  const accept=()=>invitations.acceptCourseInvitation(env,'hash','learner',new Date());
  const decline=()=>invitations.declineCourseInvitation(env,'hash','learner',new Date());
  const resend=()=>invitations.rotatePendingCourseInvitation(env,1,1,'owner','replacement',new Date('2099-02-01'),new Date());
  const state=async()=>({invitations:await rows('SELECT id,status,token_hash,expires_at,accepted_by_user_id,accepted_at,updated_at,delivery_status,last_error FROM video_course_invitations'),members:await rows('SELECT course_id,user_id,invitation_id FROM video_course_memberships'),tasks:await rows('SELECT kind,payload FROM external_tasks')});
  it('accepts once, makes replay idempotent and never restores a removed membership on replay',async()=>{
   expect(await accept()).toEqual({ok:true,courseId:1});expect(await accept()).toEqual({ok:true,courseId:1});expect((await state()).members).toEqual([{course_id:backend==='postgres'?'1':1,user_id:'learner',invitation_id:backend==='postgres'?'1':1}]);
   expect(await invitations.removeCourseUserMember(env,1,'learner','owner')).toEqual({ok:true});expect(await accept()).toEqual({ok:true,courseId:1});expect((await state()).members).toEqual([]);
  });
  it('accepts a plaintext invitation through the real tRPC boundary without persisting it',async()=>{
   const token='long-random-invitation-token-for-integration';await execute('UPDATE video_course_invitations SET token_hash=? WHERE id=1',[await hashInvitationToken(token)]);
   const response=await createApp().request('/api/trpc/courseMemberships.accept',{method:'POST',headers:{...testAuthHeaders('learner'),'content-type':'application/json'},body:JSON.stringify({token})},env);
   expect(response.status).toBe(200);expect(await response.json()).toEqual({result:{data:{course_id:1,status:'accepted'}}});expect((await state()).members).toHaveLength(1);expect(JSON.stringify(await state())).not.toContain(token);
  });
  it('does not duplicate pre-existing independent course membership',async()=>{
   await execute("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'learner','2026-01-01')");expect(await accept()).toEqual({ok:true,courseId:1});expect((await state()).members).toHaveLength(1);
  });
  it.each(['accept','decline']as const)('requires a verified matching user for %s',async(action)=>{
   const decide=()=>action==='accept'?accept():decline();await execute("UPDATE users SET email_verified=? WHERE id='learner'",[false]);expect(await decide()).toEqual({emailUnverified:true});
   await execute("UPDATE users SET email_verified=?,email='other@example.test' WHERE id='learner'",[true]);expect(await decide()).toEqual({emailMismatch:true});expect((await state()).members).toEqual([]);expect((await state()).invitations[0].status).toBe('pending');
  });
  it.each([' Learner@Example.Test ','ÜSER@example.test'])('normalizes verified recipient email with the shared JS contract (%s)',async(email)=>{
   await execute("UPDATE users SET email=? WHERE id='learner'",[email]);await execute('UPDATE video_course_invitations SET email=? WHERE id=1',[email.trim().toLowerCase()]);expect(await accept()).toEqual({ok:true,courseId:1});
  });
  it.each(['accepted','declined','revoked','expired']as const)('rejects a terminal %s state',async(status)=>{
   await execute('UPDATE video_course_invitations SET status=? WHERE id=1',[status]);expect(await accept()).toEqual({invalidState:status});expect(await decline()).toEqual({invalidState:status});expect((await state()).members).toEqual([]);
  });
  it('expires a pending invitation before checking verification without granting membership',async()=>{
   await execute("UPDATE video_course_invitations SET expires_at='2000-01-01' WHERE id=1");await execute("UPDATE users SET email_verified=? WHERE id='learner'",[false]);expect(await accept()).toEqual({expired:true});expect((await state()).invitations[0].status).toBe('expired');expect((await state()).members).toEqual([]);
  });
  it('declines without creating membership and treats missing hashes as notFound',async()=>{
   expect(await decline()).toEqual({ok:true,courseId:1});expect((await state()).invitations[0].status).toBe('declined');expect((await state()).members).toEqual([]);expect(await invitations.acceptCourseInvitation(env,'missing','learner',new Date())).toEqual({notFound:true});
  });
  it('serializes competing accept/decline decisions',async()=>{
   const results=await Promise.all([accept(),decline()]);expect(results.filter(r=>'ok'in r)).toHaveLength(1);const current=await state();expect(current.members).toHaveLength(current.invitations[0].status==='accepted'?1:0);
  });
  it('serializes owner revocation against acceptance without granting a revoked invitation',async()=>{
   const results=await Promise.all([accept(),invitations.revokePendingCourseInvitation(env,1,1,'owner',new Date())]);expect(results.filter(r=>'ok'in r)).toHaveLength(1);const current=await state();expect(current.members).toHaveLength(current.invitations[0].status==='accepted'?1:0);
  });
  it('makes concurrent acceptance by the same recipient idempotent',async()=>{
   expect(await Promise.all([accept(),accept()])).toEqual([{ok:true,courseId:1},{ok:true,courseId:1}]);expect((await state()).members).toHaveLength(1);
  });
  it('requires current native course authority even for an accepted token replay',async()=>{
   await accept();await execute('UPDATE video_courses SET managed_by_lms=? WHERE id=1',[true]);expect(await accept()).toEqual({notFound:true});expect(await resend()).toEqual({notFound:true});
  });
  it('resends with atomic hash/expiry/queued state and edition-specific delivery outbox',async()=>{
   await execute("UPDATE video_course_invitations SET delivery_status='failed',last_error='provider failure' WHERE id=1");expect(await resend()).toEqual({ok:true});const current=await state();expect(current.invitations[0]).toMatchObject({token_hash:'replacement',delivery_status:'queued',last_error:null,status:'pending'});expect(new Date(current.invitations[0].expires_at as string).toISOString()).toBe('2099-02-01T00:00:00.000Z');expect(current.tasks).toHaveLength(backend==='d1'?1:0);
   expect(await accept()).toEqual({notFound:true});
  });
  it('only lets the owner revoke or resend, and never revives expired invitations',async()=>{
   expect(await invitations.revokePendingCourseInvitation(env,1,1,'peer',new Date())).toEqual({notFound:true});expect(await invitations.rotatePendingCourseInvitation(env,1,1,'peer','replacement',new Date('2099-02-01'),new Date())).toEqual({notFound:true});
   await execute("UPDATE video_course_invitations SET expires_at='2000-01-01' WHERE id=1");expect(await resend()).toEqual({invalidState:'expired'});expect((await state()).invitations[0]).toMatchObject({status:'expired',token_hash:'hash'});expect((await state()).tasks).toEqual([]);
  });
  it('revokes a live pending invitation without a delivery task',async()=>{
   expect(await invitations.revokePendingCourseInvitation(env,1,1,'owner',new Date())).toEqual({ok:true});expect(await accept()).toEqual({invalidState:'revoked'});expect((await state()).tasks).toEqual([]);
  });
  it('limits member removal to the course owner and leave to the supplied member',async()=>{
   await accept();expect(await invitations.removeCourseUserMember(env,1,'learner','peer')).toEqual({notFound:true});expect(await invitations.leaveCourseMembership(env,1,'peer')).toEqual({notFound:true});expect(await invitations.leaveCourseMembership(env,1,'learner')).toEqual({ok:true});expect(await invitations.leaveCourseMembership(env,1,'learner')).toEqual({notFound:true});
  });
  it('rolls back membership insertion if accepting the invitation fails afterwards',async()=>{
   if(backend==='d1')await execute("CREATE TRIGGER fail_accept BEFORE UPDATE ON video_course_invitations WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'accept failure'); END");
   else await execute("CREATE FUNCTION fail_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='accepted' THEN RAISE EXCEPTION 'accept failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_accept BEFORE UPDATE ON video_course_invitations FOR EACH ROW EXECUTE FUNCTION fail_accept()");
   const before=await state();await expect(accept()).rejects.toThrow();expect(await state()).toEqual(before);
  });
  it('rolls back replacement token and queued state on delivery outbox failure',async()=>{
   if(backend==='postgres'){env.DEPLOYMENT_EDITION='cloud';env.PERSISTENCE_BACKEND='postgres';env.MIGRATION_ALLOW_CLOUD_POSTGRES='true';}
   if(backend==='d1')await execute("CREATE TRIGGER fail_mail BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'mail failure'); END");
   else await execute("CREATE FUNCTION fail_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mail failure'; END $$; CREATE TRIGGER fail_mail BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION fail_mail()");
   const before=await state();await expect(resend()).rejects.toThrow();expect(await state()).toEqual(before);
  });
  if(backend==='d1')it.each(['email','verification','course']as const)('rechecks changed %s authority before authorizing membership',async(kind)=>{
   const db=database!,original=db.batch.bind(db);let injected=false;
   env.DB=new Proxy(db,{get(object,key){if(key!=='batch'){const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}return async(statements:D1PreparedStatement[])=>{if(!injected){injected=true;if(kind==='email')await execute("UPDATE users SET email='other@example.test' WHERE id='learner'");else if(kind==='verification')await execute("UPDATE users SET email_verified=? WHERE id='learner'",[false]);else await execute('UPDATE video_courses SET managed_by_lms=? WHERE id=1',[true]);}return original(statements);};}});
   expect(await accept()).toEqual(kind==='email'?{emailMismatch:true}:kind==='verification'?{emailUnverified:true}:{notFound:true});expect((await state()).members).toEqual([]);expect((await rows('SELECT token FROM mutation_receipts'))).toEqual([]);
  });
 });
}
