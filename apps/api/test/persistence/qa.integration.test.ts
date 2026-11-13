import {hashPassword} from 'better-auth/crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as authSchema from '../../src/db/schema/better-auth';
import * as schema from '../../src/db/schema';
import {createAuth} from '../../src/lib/auth';
import {createD1Auth} from '../../src/persistence/d1/auth';
import {createApp} from '../../src/app';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {qaInputSchemas,qaQuestionSchema} from '../../../../packages/trpc/src/qa';
import {listQuestions,getQuestion,mutate,type LtiQaPrincipal} from '../../src/features/qa/service';
import type {Bindings} from '../../src/types/bindings';
import {users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,courseQuestions,courseQuestionReplies,courseQuestionVotes,courseQuestionLtiVotes,courseQaModeration,ltiCredentials} from '../../src/db/schema';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres'] as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} Q&A persistence contract`,()=>{
  let env:Bindings,dispose:()=>Promise<void>,signIn:()=>Promise<Response>,pool:{query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[];rowCount:number}>};
  beforeEach(async()=>{
   if(backend==='d1'){
    const fixture=await createD1Fixture();dispose=fixture.dispose;env={DB:fixture.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
    signIn=()=>createD1Auth(env,fixture.database,'browser').api.signInEmail({body:{email:'alice@example.com',password:'Qa-contract-password-123'},asResponse:true});
    pool={query:async(sql,args=[])=>{let rows:Record<string,unknown>[]=[];for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)){
     const converted=statement.replace(/\$(\d+)/g,'?$1').replaceAll('::int','').replaceAll("repeat('0',64)","'"+'0'.repeat(64)+"'");
     const result=await fixture.database.prepare(converted).bind(...args).all<Record<string,unknown>>();rows=result.results.map(row=>({...row,...('managed_by_lms'in row?{managed_by_lms:Boolean(row.managed_by_lms)}:{})}));
    }return {rows,rowCount:rows.length};}};
   }else{
    const fixture=await isolatedPostgres(url!);dispose=fixture.dispose;env={DATABASE_POOL:fixture.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    signIn=()=>createAuth(env,drizzle(fixture.pool,{schema}),'browser').api.signInEmail({body:{email:'alice@example.com',password:'Qa-contract-password-123'},asResponse:true});
    await fixture.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,videoCourseMembers,videoCourseInvitations,videoCourseMemberships,courseQuestions,courseQuestionReplies,courseQuestionVotes,courseQuestionLtiVotes,courseQaModeration,ltiCredentials,...authSchema}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    pool={query:async(sql,args)=>{const result=await fixture.pool.query(sql,args);return {rows:result.rows,rowCount:result.rowCount??0};}};
   }
   Object.assign(env,{ENVIRONMENT:'test',BETTER_AUTH_URL:'https://qa.example.test',FRONTEND_URL:'https://qa.example.test',BETTER_AUTH_SECRET:'qa-contract-secret-012345678901234567890'});
   for(const [id,name] of [['owner','Instructor'],['alice','Alice'],['bob','Bob'],['outsider','Outsider']])await pool.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES($1,$2,$3,false,0,0,0,0)",[id,name,id+'@example.com']);
   await pool.query("INSERT INTO video_courses(id,user_id,share_slug,name,description,created_at,updated_at,display_order) VALUES(1,'owner','linear-algebra','Math','','2026-01-01','2026-01-01',0),(2,'outsider','other-course','Other','','2026-01-01','2026-01-01',0)");
   for(const [id,title,owner] of [[10,'Matrices','owner'],[11,'Vectors','owner'],[20,'Private lesson','outsider']])await pool.query("INSERT INTO videos(id,title,user_id,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES($1,$2,$3,$4,'','2026-01-01','','completed','','uploaded','','')",[id,title,owner,'file-'+id]);
   await pool.query("INSERT INTO video_course_members(course_id,video_id,added_at,\"order\") VALUES(1,10,'2026-01-01',0),(1,11,'2026-01-01',1),(2,20,'2026-01-01',0)");
   await pool.query("INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,'alice','2026-01-01'),(1,'bob','2026-01-01')");
  });
  afterEach(async()=>{await dispose?.();});
  const list = (actor: string | null, input = {}) => listQuestions(env, actor, qaInputSchemas['qa.list'].parse({ courseId: 1, ...input }));
  const get = (actor: string | null, questionId: string, input = {}) => getQuestion(env, actor, qaInputSchemas['qa.get'].parse({ courseId: 1, questionId, ...input }));
  const ask = async (actor = 'alice', patch = {}) => {
    const result = await mutate(env, actor, { name: 'qa.ask', input: qaInputSchemas['qa.ask'].parse({ courseId: 1, title: 'Rotation matrices', body: 'Why does the length stay the same?', videoId: 10, ...patch }) });
    if (!('id' in result)) throw new Error('Missing question id');
    return result.id;
  };
  const reply = async (id: string, actor = 'owner') => {
    const result = await mutate(env, actor, { name: 'qa.reply', input: { courseId: 1, questionId: id, body: 'A rotation preserves the inner product.' } });
    if (!('id' in result)) throw new Error('Missing reply id');
    return result.id;
  };
  const lti = (author = 'a', patch: Partial<LtiQaPrincipal['permissions']> = {}, videoIds = [10, 11]): LtiQaPrincipal => ({
    kind: 'lti', courseId: 1, ownerUserId: 'owner', authorId: author.repeat(64), videoIds,
    permissions: { view: true, post: true, vote: true, deleteOwn: true, moderate: false, instructor: false, ...patch },
  });
  const ltiAsk = async (principal = lti(), videoId: number | null = 10) => {
    const result = await mutate(env, principal, { name: 'qa.ask', input: { courseId: 1, videoId, title: 'Moodle question', body: 'Published course question' } });
    if (!('id' in result)) throw new Error('Missing LTI question');
    return result.id;
  };
  const ltiGet = (principal: LtiQaPrincipal, questionId: string) => getQuestion(env, principal,
    qaInputSchemas['qa.get'].parse({ courseId: 1, questionId }));
  const ltiList = (principal: LtiQaPrincipal, input = {}) => listQuestions(env, principal,
    qaInputSchemas['qa.list'].parse({ courseId: 1, ...input }));

  it('keeps Moodle authority across disconnects and blocks native invitations and public shares', async () => {
    await pool.query('UPDATE video_courses SET managed_by_lms=true WHERE id=1');
    const id = await ltiAsk();
    expect((await get('owner', id)).question.id).toBe(id);
    expect((await ltiGet(lti('b'), id)).question.id).toBe(id);
    for (const actor of ['alice', 'bob', null]) {
      await expect(list(actor)).rejects.toMatchObject({ status: 404 });
      await expect(get(actor, id, { shareSlug: 'linear-algebra' })).rejects.toMatchObject({ status: 404 });
    }
    await expect(ask('alice')).rejects.toMatchObject({ status: 404 });
    // Disconnecting an installation does not change persisted course authority.
    await expect(list('alice')).rejects.toMatchObject({ status: 404 });
    expect((await ltiList(lti())).total).toBe(1);
    expect((await pool.query('SELECT managed_by_lms FROM video_courses WHERE id=2')).rows[0].managed_by_lms).toBe(false);
  });

  it('uses separate course pseudonyms without creating users or impersonating the owner', async () => {
    const count = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const id = await ltiAsk();
    const row = (await pool.query('SELECT author_id,lti_author_id FROM course_questions WHERE id=$1', [id])).rows[0];
    expect(row).toEqual({ author_id: null, lti_author_id: 'a'.repeat(64) });
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(count);
    expect((await ltiGet(lti(), id)).question).toMatchObject({ author: { source: 'moodle', name: 'aaaaaaaaaaaa', instructor: false }, canEdit: true, canDelete: true });
    expect((await ltiGet(lti('b'), id)).question).toMatchObject({ canEdit: false, canDelete: false });
    expect(JSON.stringify(await ltiGet(lti('b'), id))).not.toMatch(/private@example|author_id|lti_author_id|a{64}/);
    await expect(mutate(env, lti('b'), { name: 'qa.updateQuestion', input: { courseId: 1, questionId: id, title: 'Hijacked', body: 'No' } })).rejects.toMatchObject({ status: 403 });
  });
  it('keeps native and Moodle identities separate even when their identifier strings coincide', async () => {
    const value = 'a'.repeat(64);
    await pool.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES($1,'Native user','native@example.invalid',false,0,0,0,0)", [value]);
    await pool.query('INSERT INTO video_course_memberships(course_id,user_id,joined_at) VALUES(1,$1,\'2026-01-01\')', [value]);
    const nativeId = await ask(value);
    const moodleId = await ltiAsk();
    await expect(mutate(env, lti(), { name: 'qa.updateQuestion', input: { courseId: 1, questionId: nativeId, title: 'Wrong identity', body: 'No' } })).rejects.toMatchObject({ status: 403 });
    await expect(mutate(env, value, { name: 'qa.updateQuestion', input: { courseId: 1, questionId: moodleId, title: 'Wrong identity', body: 'No' } })).rejects.toMatchObject({ status: 403 });
  });
  it('applies current resource scope to lists, counts, direct reads, writes and deleted sources', async () => {
    const id = await ltiAsk(lti(), 11);
    await ltiAsk(lti(), null);
    expect((await ltiList(lti('b', {}, [10]))).total).toBe(1);
    await expect(ltiGet(lti('b', {}, [10]), id)).rejects.toMatchObject({ status: 404 });
    await expect(ltiAsk(lti('b', {}, [10]), 11)).rejects.toMatchObject({ status: 404 });
    await pool.query('DELETE FROM videos WHERE id=11');
    expect((await pool.query('SELECT video_id,source_video_id::int FROM course_questions WHERE id=$1', [id])).rows[0]).toEqual({ video_id: null, source_video_id: 11 });
    expect((await ltiList(lti('b', {}, [10]))).total).toBe(1);
    await expect(ltiGet(lti(), id)).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks posting, voting, own deletion and moderation independently', async () => {
    const id = await ltiAsk();
    await expect(ltiAsk(lti('b', { post: false }))).rejects.toMatchObject({ status: 403 });
    await expect(mutate(env, lti('b', { vote: false }), { name: 'qa.vote', input: { courseId: 1, questionId: id, voted: true } })).rejects.toMatchObject({ status: 403 });
    await expect(mutate(env, lti('a', { deleteOwn: false }), { name: 'qa.deleteQuestion', input: { courseId: 1, questionId: id } })).rejects.toMatchObject({ status: 403 });
    const teacher = lti('c', { moderate: true, instructor: true });
    const response = await mutate(env, teacher, { name: 'qa.reply', input: { courseId: 1, questionId: id, body: 'Teacher response' } });
    if (!('id' in response)) throw new Error('Missing reply');
    expect((await ltiGet(lti(), id)).replies[0].author).toMatchObject({ source: 'moodle', instructor: true });
    await mutate(env, lti('c', { moderate: true, instructor: false }), { name: 'qa.updateReply', input: { courseId: 1, questionId: id, replyId: response.id, body: 'Revised after badge permission changed' } });
    expect((await ltiGet(lti(), id)).replies[0].author.instructor).toBe(false);
    await expect(mutate(env, teacher, { name: 'qa.updateQuestion', input: { courseId: 1, questionId: id, title: 'Other author', body: 'No' } })).rejects.toMatchObject({ status: 403 });
    await mutate(env, teacher, { name: 'qa.feature', input: { courseId: 1, questionId: id, featured: true } });
    await mutate(env, teacher, { name: 'qa.feature', input: { courseId: 1, questionId: id, featured: true } });
    await expect(mutate(env, lti('c', { moderate: false }), { name: 'qa.feature', input: { courseId: 1, questionId: id, featured: false } })).rejects.toMatchObject({ status: 403 });
    await mutate(env, teacher, { name: 'qa.deleteQuestion', input: { courseId: 1, questionId: id } });
    const audit = await pool.query('SELECT action,lti_actor_id,actor_user_id FROM course_qa_moderation ORDER BY created_at');
    expect(audit.rows).toEqual([{ action: 'feature', lti_actor_id: 'c'.repeat(64), actor_user_id: null }, { action: 'delete_question', lti_actor_id: 'c'.repeat(64), actor_user_id: null }]);
  });
  it('supports coursewide Q&A with no readable videos while hiding all source-bound and deleted-source posts', async () => {
    const hidden = await ltiAsk(lti(),11), coursewide = await ltiAsk(lti(),null);
    const empty = lti('b',{},[]);
    expect((await ltiList(empty)).items.map(q=>q.id)).toEqual([coursewide]);
    await expect(ltiGet(empty,hidden)).rejects.toMatchObject({status:404});
    await expect(ltiAsk(empty,10)).rejects.toMatchObject({status:404});
    await pool.query('DELETE FROM video_course_members WHERE course_id=1; DELETE FROM videos WHERE id IN (10,11)');
    expect((await ltiList(empty)).total).toBe(1);
    await expect(ltiGet(empty,hidden)).rejects.toMatchObject({status:404});
    const created = await ltiAsk(empty,null);
    expect((await ltiGet(empty,created)).question.canEdit).toBe(true);
    await expect(ltiList(lti('b',{view:false},[]))).rejects.toMatchObject({status:404});
    await expect(ltiAsk(lti('b',{post:false},[]),null)).rejects.toMatchObject({status:403});
    await expect(ltiList({...empty,ownerUserId:'outsider'})).rejects.toMatchObject({status:404});
  });
  it('combines native and LTI votes idempotently without letting one actor remove another vote', async () => {
    const id = await ltiAsk();
    for (let i = 0; i < 2; i++) await mutate(env, lti('b'), { name: 'qa.vote', input: { courseId: 1, questionId: id, voted: true } });
    await mutate(env, 'alice', { name: 'qa.vote', input: { courseId: 1, questionId: id, voted: true } });
    expect((await ltiGet(lti('b'), id)).question).toMatchObject({ votes: 2, voted: true });
    await mutate(env, lti('c'), { name: 'qa.vote', input: { courseId: 1, questionId: id, voted: false } });
    expect((await ltiGet(lti('b'), id)).question.votes).toBe(2);
    await mutate(env, lti('b'), { name: 'qa.vote', input: { courseId: 1, questionId: id, voted: false } });
    expect((await ltiGet(lti('b'), id)).question).toMatchObject({ votes: 1, voted: false });
  });
  it('rejects cross-course and cross-owner grants and loses access after membership removal', async () => {
    const id = await ltiAsk();
    await expect(ltiGet({ ...lti(), courseId: 2 }, id)).rejects.toMatchObject({ status: 404 });
    await expect(ltiGet({ ...lti(), ownerUserId: 'outsider' }, id)).rejects.toMatchObject({ status: 404 });
    await expect(ltiGet(lti('b', { view: false }), id)).rejects.toMatchObject({ status: 404 });
    await pool.query('DELETE FROM video_course_members WHERE course_id=1 AND video_id=10');
    await expect(ltiGet(lti(), id)).rejects.toMatchObject({ status: 404 });
    expect((await ltiList(lti())).total).toBe(0);
  });

  it('publishes questions and answers with instructor badges without exposing email or AI logs', async () => {
    const id = await ask(); await reply(id);
    const page = await list('bob');
    expect(page).toMatchObject({ total: 1, canPost: true, canModerate: false });
    expect(qaQuestionSchema.parse(page.items[0])).toMatchObject({ id, author: { name: 'Alice', instructor: false }, videoId: 10, videoTitle: 'Matrices', replyCount: 1, canEdit: false, canDelete: false });
    const detail = await get('bob', id);
    expect(detail.replies[0]).toMatchObject({ author: { name: 'Instructor', instructor: true } });
    expect(JSON.stringify(detail)).not.toContain('example.com');
  });
  it('allows public-link reading but requires a matching live capability', async () => {
    const id = await ask();
    expect(await list(null, { shareSlug: 'LINEAR-ALGEBRA' })).toMatchObject({ total: 1, canPost: false });
    expect((await get(null, id, { shareSlug: 'linear-algebra' })).question.id).toBe(id);
    for (const actor of [null, 'outsider']) await expect(list(actor)).rejects.toMatchObject({ status: 404 });
    await expect(list(null, { shareSlug: 'other-course' })).rejects.toMatchObject({ status: 404 });
    await pool.query("UPDATE video_courses SET share_slug=NULL WHERE id=1");
    await expect(list('owner', { shareSlug: 'linear-algebra' })).rejects.toMatchObject({ status: 404 });
  });
  it('rejects cross-course question ids, reply ids and video ids', async () => {
    const other = await ask('outsider', { courseId: 2, videoId: 20 });
    const otherReply = await mutate(env, 'outsider', { name: 'qa.reply', input: { courseId: 2, questionId: other, body: 'Private answer' } });
    await expect(get('alice', other)).rejects.toMatchObject({ status: 404 });
    await expect(ask('alice', { videoId: 20 })).rejects.toMatchObject({ status: 404 });
    const own = await ask();
    if (!('id' in otherReply)) throw new Error('Missing reply');
    await expect(mutate(env,'owner',{ name:'qa.deleteReply',input:{ courseId:1,questionId:own,replyId:otherReply.id } })).rejects.toMatchObject({ status:404 });
  });
  it('enforces author editing and instructor moderation', async () => {
    const id = await ask(); const replyId = await reply(id, 'bob');
    await expect(mutate(env,'bob',{ name:'qa.updateQuestion',input:{ courseId:1,questionId:id,title:'Hijacked',body:'No' } })).rejects.toMatchObject({ status:403 });
    await expect(mutate(env,'owner',{ name:'qa.updateReply',input:{ courseId:1,questionId:id,replyId,body:'Changed words' } })).rejects.toMatchObject({ status:403 });
    await mutate(env,'alice',{ name:'qa.updateQuestion',input:{ courseId:1,questionId:id,title:'Edited title',body:'Edited question' } });
    await mutate(env,'bob',{ name:'qa.updateReply',input:{ courseId:1,questionId:id,replyId,body:'Edited reply' } });
    expect((await get('alice',id)).replies[0]?.body).toBe('Edited reply');
    await expect(mutate(env,'bob',{ name:'qa.deleteQuestion',input:{ courseId:1,questionId:id } })).rejects.toMatchObject({ status:403 });
    await mutate(env,'owner',{ name:'qa.deleteReply',input:{ courseId:1,questionId:id,replyId } });
    expect((await get('owner',id)).replyTotal).toBe(0);
    await mutate(env,'owner',{ name:'qa.deleteQuestion',input:{ courseId:1,questionId:id } });
    expect((await list('owner')).total).toBe(0);
  });
  it('supports search, lecture filtering, unanswered filtering and stable pagination', async () => {
    const a = await ask(); await reply(a);
    await ask('bob', { title: 'Vector length', videoId: 11 });
    expect((await list('alice', { search: 'ROTATION' })).total).toBe(1);
    expect((await list('alice', { videoId: 11 })).items[0]?.title).toBe('Vector length');
    expect((await list('alice', { unanswered: true })).total).toBe(1);
    const first = await list('alice', { limit: 1 }); const second = await list('alice', { limit: 1, offset: 1 });
    expect(first.total).toBe(2); expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    const detail = await get('alice',a,{limit:1,offset:1}); expect(detail.replies).toEqual([]); expect(detail.replyTotal).toBe(1);
  });
  it('keeps voting idempotent and limits featured questions to the instructor', async () => {
    const a = await ask(); const b = await ask('bob', { title: 'Another question' });
    for (let i=0;i<2;i++) await mutate(env,'bob',{ name:'qa.vote',input:{ courseId:1,questionId:a,voted:true } });
    expect((await get('bob',a)).question).toMatchObject({ votes:1,voted:true });
    expect((await list('alice',{sort:'votes'})).items[0]?.id).toBe(a);
    await expect(mutate(env,'bob',{ name:'qa.feature',input:{ courseId:1,questionId:b,featured:true } })).rejects.toMatchObject({ status:403 });
    await mutate(env,'owner',{ name:'qa.feature',input:{ courseId:1,questionId:b,featured:true } });
    expect((await list('alice',{sort:'votes'})).items[0]?.id).toBe(b);
    await mutate(env,'bob',{ name:'qa.vote',input:{ courseId:1,questionId:a,voted:false } });
    expect((await get('bob',a)).question.votes).toBe(0);
  });
  it('rechecks revoked membership and cascades course deletion', async () => {
    const id = await ask(); await reply(id);
    await pool.query("DELETE FROM video_course_memberships WHERE user_id='alice'");
    await expect(get('alice',id)).rejects.toMatchObject({ status:404 });
    await pool.query('DELETE FROM video_courses WHERE id=1');
    expect((await pool.query('SELECT * FROM course_question_replies')).rowCount).toBe(0);
    await expect(get('owner',id)).rejects.toMatchObject({ status:404 });
  });
  it('projects erased Moodle posts as anonymous tombstones while preserving peer replies', async () => {
    const id = await ltiAsk();
    const ownReply = await mutate(env, lti(), { name: 'qa.reply', input: { courseId: 1, questionId: id, body: 'Own reply' } });
    if (!('id' in ownReply)) throw new Error('Missing own reply');
    await mutate(env, lti('b'), { name: 'qa.reply', input: { courseId: 1, questionId: id, body: 'Peer reply survives' } });
    await pool.query("UPDATE course_questions SET title='[deleted]',body='[deleted]',lti_author_id=repeat('0',64),lti_instructor=false WHERE id=$1", [id]);
    await pool.query("UPDATE course_question_replies SET body='[deleted]',lti_author_id=repeat('0',64),lti_instructor=false WHERE id=$1", [ownReply.id]);
    const result = await ltiGet(lti(), id);
    expect(result.question).toMatchObject({ title: '[deleted]', body: '[deleted]', canEdit: false,
      author: { name: 'Deleted participant', source: 'moodle', instructor: false } });
    expect(result.replies.find(row => row.id === ownReply.id)).toMatchObject({ body: '[deleted]', canEdit: false,
      author: { name: 'Deleted participant', source: 'moodle', instructor: false } });
    expect(result.replies.some(row => row.body === 'Peer reply survives')).toBe(true);
  });

  it('retains posts without personal identifiers when their author is deleted', async () => {
    const id = await ask();
    await pool.query("DELETE FROM users WHERE id='alice'");
    expect((await get('owner',id)).question).toMatchObject({author:{name:null,instructor:false},canEdit:false,canDelete:true});
  });
  it('uses a real cookie session through tRPC for posting and public reads',async()=>{
    await pool.query("UPDATE users SET email_verified=true,password_reset_required=false WHERE id='alice'");
    await pool.query("INSERT INTO account(id,account_id,user_id,provider_id,password) VALUES('account','alice','alice','credential',$1)",[await hashPassword('Qa-contract-password-123')]);
    const signedIn=await signIn();expect(signedIn.status).toBe(200);
    const cookie=signedIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),app=createApp();
    const post=await app.request('/api/trpc/qa.ask',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({courseId:1,title:'Cookie question',body:'Created by a real session',videoId:10})},env);
    expect(post.status).toBe(200);const data=await post.json<{result:{data:{id:string}}}>(),id=data.result.data.id;
    const read=await app.request('/api/trpc/qa.get?input='+encodeURIComponent(JSON.stringify({courseId:1,questionId:id,shareSlug:'linear-algebra'})),{},env);
    expect(read.status).toBe(200);expect(await read.json()).toMatchObject({result:{data:{question:{id,title:'Cookie question',canEdit:false},canPost:false}}});
    await pool.query("DELETE FROM session WHERE user_id='alice'");
    expect((await app.request('/api/trpc/qa.ask',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({courseId:1,title:'Revoked',body:'No',videoId:null})},env)).status).toBe(401);
  });
  it('treats search punctuation literally and binds the maximum LMS video scope',async()=>{
    const id=await ask('alice',{title:"Literal %_\\' marker"});
    for(const search of ['%','_','\\',"'",'%_'])expect((await list('alice',{search})).items.map(row=>row.id)).toEqual([id]);
    expect((await list('alice',{search:"' OR 1=1 --"})).total).toBe(0);
    const principal=lti('b',{},Array.from({length:1000},(_,index)=>index+1));
    expect((await ltiGet(principal,id)).question.id).toBe(id);
    await expect(ltiGet({...principal,videoIds:[...principal.videoIds,1001]},id)).rejects.toMatchObject({status:404});
  });
  it('rolls moderation and deletion back together when audit persistence fails',async()=>{
    const id=await ask(),replyId=await reply(id,'bob');
    if(backend==='d1')await env.DB!.prepare("CREATE TRIGGER reject_qa_audit BEFORE INSERT ON course_qa_moderation BEGIN SELECT RAISE(ABORT,'audit unavailable'); END").run();
    else await pool.query("CREATE FUNCTION reject_qa_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_qa_audit BEFORE INSERT ON course_qa_moderation FOR EACH ROW EXECUTE FUNCTION reject_qa_audit()");
    await expect(mutate(env,'owner',{name:'qa.feature',input:{courseId:1,questionId:id,featured:true}})).rejects.toThrow();
    await expect(mutate(env,'owner',{name:'qa.deleteReply',input:{courseId:1,questionId:id,replyId}})).rejects.toThrow();
    await expect(mutate(env,'owner',{name:'qa.deleteQuestion',input:{courseId:1,questionId:id}})).rejects.toThrow();
    expect((await get('alice',id)).question.featured).toBe(false);
    expect((await get('alice',id)).replies.map(r=>r.id)).toContain(replyId);
    expect((await pool.query('SELECT * FROM course_qa_moderation')).rows).toEqual([]);
    if(backend==='d1')expect((await pool.query('SELECT * FROM mutation_receipts')).rows).toEqual([]);
  });
  it('serializes concurrent feature changes and repeated votes without duplicate audit or votes',async()=>{
    const id=await ask();
    await Promise.all(Array.from({length:4},()=>mutate(env,'owner',{name:'qa.feature',input:{courseId:1,questionId:id,featured:true}})));
    await Promise.all(Array.from({length:4},()=>mutate(env,'bob',{name:'qa.vote',input:{courseId:1,questionId:id,voted:true}})));
    expect((await get('alice',id)).question).toMatchObject({featured:true,votes:1});
    expect((await pool.query("SELECT action FROM course_qa_moderation WHERE question_id=$1",[id])).rows).toEqual([{action:'feature'}]);
  });
  it('rejects expired or erased LTI sessions before reads and writes',async()=>{
    const id=await ltiAsk(),proof={sessionHash:'c'.repeat(64),registrationId:'registration',subjectHash:'d'.repeat(64)};
    const principal={...lti(),sessionProof:proof};
    const payload=JSON.stringify({registrationId:proof.registrationId,subjectHash:proof.subjectHash});
    await pool.query("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES($1,'session',$2,'2099-01-01')",[proof.sessionHash,payload]);
    expect((await ltiGet(principal,id)).question.canEdit).toBe(true);
    await pool.query("UPDATE lti_credentials SET expires_at='2000-01-01' WHERE id=$1",[proof.sessionHash]);
    await expect(ltiGet(principal,id)).rejects.toMatchObject({status:403});
    await expect(ltiList(principal)).rejects.toMatchObject({status:403});
    await expect(mutate(env,principal,{name:'qa.deleteQuestion',input:{courseId:1,questionId:id}})).rejects.toMatchObject({status:403});
    await pool.query("DELETE FROM lti_credentials WHERE id=$1",[proof.sessionHash]);
    await expect(ltiGet(principal,id)).rejects.toMatchObject({status:403});
    expect((await ltiGet(lti(),id)).question.id).toBe(id);
  });
  if(backend==='d1'){
    const beforeBatch=(change:()=>Promise<unknown>)=>{
      const original=env.DB!;let pending=true;
      env.DB=new Proxy(original,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending){pending=false;await change();}return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    };
    it('rechecks native membership at the atomic mutation boundary',async()=>{
      const id=await ask();
      beforeBatch(()=>pool.query("DELETE FROM video_course_memberships WHERE user_id='alice'"));
      await expect(mutate(env,'alice',{name:'qa.updateQuestion',input:{courseId:1,questionId:id,title:'Unauthorized edit',body:'No'}})).rejects.toMatchObject({status:404});
      expect((await get('owner',id)).question.title).toBe('Rotation matrices');
      expect((await pool.query('SELECT * FROM mutation_receipts')).rows).toEqual([]);
    });
    it('rechecks source visibility at the atomic mutation boundary',async()=>{
      const id=await ltiAsk();
      beforeBatch(()=>pool.query('DELETE FROM video_course_members WHERE course_id=1 AND video_id=10'));
      await expect(mutate(env,lti(),{name:'qa.reply',input:{courseId:1,questionId:id,body:'Stale visibility'}})).rejects.toMatchObject({status:404});
      expect((await get('owner',id)).replies).toEqual([]);
    });
    it('rechecks native course authority before returning public data',async()=>{
      await ask();beforeBatch(()=>pool.query('UPDATE video_courses SET native_access_disabled=true WHERE id=1'));
      await expect(list(null,{shareSlug:'linear-algebra'})).rejects.toMatchObject({status:404});
      expect((await list('owner')).total).toBe(1);
    });
    it('rolls a reply insertion back when the parent update fails',async()=>{
      const id=await ask();
      await env.DB!.prepare("CREATE TRIGGER reject_qa_parent BEFORE UPDATE ON course_questions BEGIN SELECT RAISE(ABORT,'parent unavailable'); END").run();
      await expect(reply(id)).rejects.toThrow();
      expect((await get('owner',id)).replies).toEqual([]);
      expect((await pool.query('SELECT * FROM mutation_receipts')).rows).toEqual([]);
    });
  }

 });
}
