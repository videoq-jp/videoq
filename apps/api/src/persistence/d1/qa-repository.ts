import type {QaQuestion,QaReply} from '@videoq/trpc';
import type {QaRepository,QaPrincipal,QaAccess,QaCommand} from '../contracts/qa-repository';
import {ApiError,apiNotFound} from '../../shared/errors';
import {ltiSessionProof} from '../../shared/lti-session-proof';
import {toUtcIso} from '../../shared/datetime';
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
class Parameters{
 values:unknown[]=[];
 add(value:unknown){this.values.push(typeof value==='boolean'?Number(value):value);return '?'+this.values.length;}
 statement(database:D1Database,sql:string){
  const indexes=new Map<number,number>(),values:unknown[]=[];
  const compact=sql.replace(/\?(\d+)/g,(_match,raw:string)=>{const index=Number(raw);if(!indexes.has(index)){values.push(this.values[index-1]);indexes.set(index,values.length);}return '?'+indexes.get(index);});
  return database.prepare(compact).bind(...values);
 }
}
function actor(principal:QaPrincipal,access:QaAccess,p:Parameters){
 const lti=typeof principal==='object'&&principal!==null?principal:null;
 const course=p.add(access.courseId),user=p.add(typeof principal==='string'?principal:null),author=p.add(lti?.authorId??null);
 const owner=`(SELECT user_id FROM video_courses WHERE id=${course})`;
 const isOwner=`coalesce(${owner}=${user},0)`;
 let session='1';
 if(lti?.sessionProof){const proof=lti.sessionProof;ltiSessionProof(proof,proof.sessionHash);session=`EXISTS(SELECT 1 FROM users owner JOIN lti_credentials session ON session.id=${p.add(proof.sessionHash)} WHERE owner.id=${p.add(lti.ownerUserId)} AND session.kind='session' AND julianday(session.expires_at)>julianday('now') AND json_extract(session.payload,'$.registrationId')=${p.add(proof.registrationId)} AND json_extract(session.payload,'$.subjectHash')=${p.add(proof.subjectHash)})`;}
 const ids=lti?p.add(JSON.stringify(lti.videoIds)):undefined;
 const videos=`SELECT m.video_id FROM video_course_members m JOIN videos v ON v.id=m.video_id WHERE m.course_id=${course} AND v.user_id=${owner} AND m.video_id IN(SELECT value FROM json_each(${ids??"'[]'"}))`;
 let guard:string;
 if(lti){
  const valid=lti.kind==='lti'&&lti.courseId===access.courseId&&lti.permissions.view&&access.shareSlug===undefined&&/^[a-f0-9]{64}$/.test(lti.authorId)&&lti.videoIds.length<=1000;
  guard=`${p.add(valid)} AND EXISTS(SELECT 1 FROM video_courses WHERE id=${course} AND user_id=${p.add(lti.ownerUserId)}) AND (${p.add(lti.videoIds.length)}=0 OR EXISTS(${videos}))`;
 }else{
  const native=`EXISTS(SELECT 1 FROM video_courses c WHERE c.id=${course} AND NOT c.managed_by_lms AND NOT c.native_access_disabled AND NOT EXISTS(SELECT 1 FROM video_course_members m JOIN videos v ON v.id=m.video_id WHERE m.course_id=c.id AND v.managed_by_lms))`;
  guard=access.shareSlug!==undefined
   ?`${native} AND EXISTS(SELECT 1 FROM video_courses WHERE id=${course} AND lower(share_slug)=lower(${p.add(access.shareSlug)}))`
   :`EXISTS(SELECT 1 FROM video_courses WHERE id=${course}) AND (${isOwner} OR (${native} AND EXISTS(SELECT 1 FROM video_course_memberships WHERE course_id=${course} AND user_id=${user})))`;
 }
 const canPost=lti?p.add(lti.permissions.post):p.add(principal!==null),canVote=lti?p.add(lti.permissions.vote):p.add(principal!==null);
 const canDeleteOwn=lti?p.add(lti.permissions.deleteOwn):p.add(principal!==null),canModerate=lti?p.add(lti.permissions.moderate):isOwner;
 const own=(alias:string)=>`coalesce(${alias}.author_id=${user} OR ${alias}.lti_author_id=${author},0)`;
 const visible=`q.course_id=${course}${lti?` AND (q.source_video_id IS NULL OR q.source_video_id IN(${videos})) AND (q.video_id IS NULL OR q.video_id IN(${videos}))`:''}`;
 return {course,user,author,owner,session,guard,canPost,canVote,canDeleteOwn,canModerate,own,visible,videos,lti};
}
type Actor=ReturnType<typeof actor>;
function authorFields(alias:string,a:Actor){return `json_object('name',CASE WHEN ${alias}.lti_author_id='${'0'.repeat(64)}' THEN 'Deleted participant' WHEN ${alias}.lti_author_id IS NOT NULL THEN substr(${alias}.lti_author_id,1,12) ELSE u.username END,'source',CASE WHEN ${alias}.lti_author_id IS NULL THEN 'videoq' ELSE 'moodle' END,'instructor',CASE WHEN ${alias}.lti_author_id IS NOT NULL THEN ${alias}.lti_instructor ELSE coalesce(${alias}.author_id=${a.owner},0) END) AS author`;}
function questionFields(a:Actor){return `q.id,q.title,q.body,v.id AS videoId,v.title AS videoTitle,${authorFields('q',a)},q.created_at AS createdAt,q.updated_at AS updatedAt,q.featured,
 (SELECT count(*) FROM course_question_replies r WHERE r.question_id=q.id) AS replyCount,
 ((SELECT count(*) FROM course_question_votes vote WHERE vote.question_id=q.id)+(SELECT count(*) FROM course_question_lti_votes vote WHERE vote.question_id=q.id)) AS votes,
 (EXISTS(SELECT 1 FROM course_question_votes vote WHERE vote.question_id=q.id AND vote.user_id=${a.user}) OR EXISTS(SELECT 1 FROM course_question_lti_votes vote WHERE vote.question_id=q.id AND vote.lti_author_id=${a.author})) AS voted,
 (${a.own('q')} AND ${a.canPost}) AS canEdit,((${a.own('q')} AND ${a.canDeleteOwn}) OR ${a.canModerate}) AS canDelete`;}
const FROM='FROM course_questions q LEFT JOIN users u ON u.id=q.author_id LEFT JOIN videos v ON v.id=q.video_id AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.course_id=q.course_id AND m.video_id=v.id)';
function decode(row:Record<string,unknown>){const author=JSON.parse(String(row.author)) as QaQuestion['author'];return {...row,author:{...author,instructor:Boolean(author.instructor)},createdAt:toUtcIso(String(row.createdAt)),updatedAt:toUtcIso(String(row.updatedAt)),canEdit:Boolean(row.canEdit),canDelete:Boolean(row.canDelete)};}
const question=(row:Record<string,unknown>)=>({...decode(row),featured:Boolean(row.featured),voted:Boolean(row.voted)}) as QaQuestion;
const reply=(row:Record<string,unknown>)=>decode(row) as QaReply;
function check(code:number){
 if(code===4030)throw new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
 if(code===4031)throw new ApiError(403,'FORBIDDEN','You cannot perform this Q&A operation.');
 if(code)throw apiNotFound(code===4041?'Question not found':code===4042?'Reply not found':code===4043?'Video not found in this course':'Course not found');
}
function accessStatement(database:D1Database,principal:QaPrincipal,input:QaAccess){const p=new Parameters(),a=actor(principal,input,p);return p.statement(database,`SELECT CASE WHEN NOT (${a.session}) THEN 4030 WHEN NOT (${a.guard}) THEN 4040 ELSE 0 END AS code,${a.canPost} AS canPost,${a.canVote} AS canVote,${a.canModerate} AS canModerate`);}
function abilities(row:Record<string,unknown>){check(Number(row.code));return {canPost:Boolean(row.canPost),canVote:Boolean(row.canVote),canModerate:Boolean(row.canModerate)};}
export function createD1QaRepository(database:D1Database):QaRepository{return {
 async list(principal,input){
  const select=(total=false)=>{const p=new Parameters(),a=actor(principal,input,p);
   const filter=`${a.session} AND (${a.guard}) AND ${a.visible} AND (${p.add(input.videoId??null)} IS NULL OR q.video_id=${p.add(input.videoId??null)}) AND (${p.add(input.search)}='' OR instr(lower(q.title||' '||q.body),lower(${p.add(input.search)}))>0) AND (NOT ${p.add(input.unanswered)} OR NOT EXISTS(SELECT 1 FROM course_question_replies r WHERE r.question_id=q.id))`;
   return p.statement(database,total?`SELECT count(*) AS total FROM course_questions q WHERE ${filter}`:`SELECT ${questionFields(a)} ${FROM} WHERE ${filter} ORDER BY q.featured DESC,${input.sort==='votes'?'votes DESC,':''}q.created_at DESC,q.id DESC LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`);
  };
  const result=await database.batch<Record<string,unknown>>([accessStatement(database,principal,input),select(),select(true)]);
  return {items:result[1].results.map(question),total:Number(result[2].results[0].total),...abilities(result[0].results[0])};
 },
 async get(principal,input){
  const select=(replies=false)=>{const p=new Parameters(),a=actor(principal,input,p);const visible=`${a.session} AND (${a.guard}) AND ${a.visible} AND q.id=${p.add(input.questionId)}`;
   return p.statement(database,replies?`SELECT r.id,r.body,${authorFields('r',a)},r.created_at AS createdAt,r.updated_at AS updatedAt,(${a.own('r')} AND ${a.canPost}) AS canEdit,((${a.own('r')} AND ${a.canDeleteOwn}) OR ${a.canModerate}) AS canDelete FROM course_question_replies r LEFT JOIN users u ON u.id=r.author_id WHERE r.question_id IN(SELECT q.id FROM course_questions q WHERE ${visible}) ORDER BY r.created_at,r.id LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`:`SELECT ${questionFields(a)} ${FROM} WHERE ${visible}`);
  };
  const result=await database.batch<Record<string,unknown>>([accessStatement(database,principal,input),select(),select(true)]);
  const permissions=abilities(result[0].results[0]),row=result[1].results[0];if(!row)throw apiNotFound('Question not found');
  const q=question(row);return {question:q,replies:result[2].results.map(reply),replyTotal:q.replyCount,...permissions};
 },
 async mutate(principal,command){return mutate(database,principal,command);},
};}
async function mutate(database:D1Database,principal:Exclude<QaPrincipal,null>,command:QaCommand):Promise<{id:string}|{success:true}>{
 const {name,input}=command,token=crypto.randomUUID(),id=crypto.randomUUID();
 const initial=new Parameters(),a=actor(principal,input,initial),checks=[`WHEN NOT (${a.session}) THEN 4030`,`WHEN NOT (${a.guard}) THEN 4040`];
 const qid='questionId'in input?initial.add(input.questionId):"''";
 const qwhere=`${a.visible} AND q.id=${qid}`;
 const ownQ=`EXISTS(SELECT 1 FROM course_questions q WHERE ${qwhere} AND ${a.own('q')})`;
 const replyId='replyId'in input?initial.add(input.replyId):"''";
 const ownR=`EXISTS(SELECT 1 FROM course_question_replies r WHERE r.id=${replyId} AND r.question_id=${qid} AND ${a.own('r')})`;
 if(name==='qa.ask'){
  checks.push(`WHEN NOT ${a.canPost} THEN 4031`);
  if(input.videoId!==null)checks.push(`WHEN NOT EXISTS(SELECT 1 FROM video_course_members WHERE course_id=${a.course} AND video_id=${initial.add(input.videoId)}${a.lti?` AND video_id IN(${a.videos})`:''}) THEN 4043`);
 }else{
  checks.push(`WHEN NOT EXISTS(SELECT 1 FROM course_questions q WHERE ${qwhere}) THEN 4041`);
  if(name==='qa.updateReply'||name==='qa.deleteReply')checks.push(`WHEN NOT EXISTS(SELECT 1 FROM course_question_replies WHERE id=${replyId} AND question_id=${qid}) THEN 4042`);
  const permitted=name==='qa.updateQuestion'?`(${ownQ} AND ${a.canPost})`:name==='qa.deleteQuestion'?`((${ownQ} AND ${a.canDeleteOwn}) OR ${a.canModerate})`:name==='qa.updateReply'?`(${ownR} AND ${a.canPost})`:name==='qa.deleteReply'?`((${ownR} AND ${a.canDeleteOwn}) OR ${a.canModerate})`:name==='qa.reply'?a.canPost:name==='qa.vote'?a.canVote:a.canModerate;
  checks.push(`WHEN NOT ${permitted} THEN 4031`);
 }
 const statements=[initial.statement(database,`INSERT INTO mutation_receipts(token,kind,resource_id) VALUES(${initial.add(token)},'qa',CASE ${checks.join(' ')} ELSE 0 END)`)];
 const add=(build:(p:Parameters,gate:string,a:Actor)=>string)=>{const p=new Parameters(),current=actor(principal,input,p);const gate=`EXISTS(SELECT 1 FROM mutation_receipts WHERE token=${p.add(token)} AND kind='qa' AND resource_id=0)`;statements.push(p.statement(database,build(p,gate,current)));};
 const audit=(action:string,replyId:string|null=null,condition:(a:Actor,p:Parameters)=>string=()=> '1')=>add((p,gate,current)=>`INSERT INTO course_qa_moderation(id,course_id,question_id,reply_id,actor_user_id,lti_actor_id,action) SELECT ${p.add(crypto.randomUUID())},${current.course},${p.add('questionId'in input?input.questionId:'')},${p.add(replyId)},${current.user},${current.author},${p.add(action)} WHERE ${gate} AND (${condition(current,p)})`);
 const ownQuestion=(current:Actor,p:Parameters)=>`EXISTS(SELECT 1 FROM course_questions q WHERE q.id=${p.add('questionId'in input?input.questionId:'')} AND ${current.own('q')})`;
 if(name==='qa.ask')add((p,gate,current)=>`INSERT INTO course_questions(id,course_id,video_id,source_video_id,author_id,lti_author_id,lti_instructor,title,body) SELECT ${p.add(id)},${current.course},${p.add(input.videoId)},${p.add(input.videoId)},${current.user},${current.author},${p.add(current.lti?.permissions.instructor??false)},${p.add(input.title)},${p.add(input.body)} WHERE ${gate}`);
 else if(name==='qa.updateQuestion')add((p,gate,current)=>`UPDATE course_questions SET title=${p.add(input.title)},body=${p.add(input.body)},lti_instructor=${p.add(current.lti?.permissions.instructor??false)},updated_at=${NOW} WHERE id=${p.add(input.questionId)} AND ${gate}`);
 else if(name==='qa.deleteQuestion'){
  audit('delete_question',null,(current,p)=>`NOT (${ownQuestion(current,p)})`);
  add((p,gate)=>`DELETE FROM course_questions WHERE id=${p.add(input.questionId)} AND ${gate}`);
 }else if(name==='qa.reply')add((p,gate,current)=>`INSERT INTO course_question_replies(id,question_id,author_id,lti_author_id,lti_instructor,body) SELECT ${p.add(id)},${p.add(input.questionId)},${current.user},${current.author},${p.add(current.lti?.permissions.instructor??false)},${p.add(input.body)} WHERE ${gate}`);
 else if(name==='qa.updateReply')add((p,gate,current)=>`UPDATE course_question_replies SET body=${p.add(input.body)},lti_instructor=${p.add(current.lti?.permissions.instructor??false)},updated_at=${NOW} WHERE id=${p.add(input.replyId)} AND ${gate}`);
 else if(name==='qa.deleteReply'){
  audit('delete_reply',input.replyId,(current,p)=>`NOT EXISTS(SELECT 1 FROM course_question_replies r WHERE r.id=${p.add(input.replyId)} AND ${current.own('r')})`);
  add((p,gate)=>`DELETE FROM course_question_replies WHERE id=${p.add(input.replyId)} AND ${gate}`);
 }else if(name==='qa.vote')add((p,gate,current)=>{
  const table=current.lti?'course_question_lti_votes':'course_question_votes',column=current.lti?'lti_author_id':'user_id',voter=current.lti?current.author:current.user;
  return input.voted?`INSERT INTO ${table}(question_id,${column}) SELECT ${p.add(input.questionId)},${voter} WHERE ${gate} ON CONFLICT DO NOTHING`:`DELETE FROM ${table} WHERE question_id=${p.add(input.questionId)} AND ${column}=${voter} AND ${gate}`;
 });
 else if(name==='qa.feature'){
  audit(input.featured?'feature':'unfeature',null,(_current,p)=>`EXISTS(SELECT 1 FROM course_questions WHERE id=${p.add(input.questionId)} AND featured<>${p.add(input.featured)})`);
  add((p,gate)=>`UPDATE course_questions SET featured=${p.add(input.featured)} WHERE id=${p.add(input.questionId)} AND ${gate}`);
 }
 if(name==='qa.reply'||name==='qa.updateReply'||name==='qa.deleteReply')add((p,gate)=>`UPDATE course_questions SET updated_at=${NOW} WHERE id=${p.add(input.questionId)} AND ${gate}`);
 statements.push(database.prepare("DELETE FROM mutation_receipts WHERE token=? AND kind='qa' RETURNING resource_id AS code").bind(token));
 const results=await database.batch<{code:number}>(statements);check(results[results.length-1].results[0].code);
 return name==='qa.ask'||name==='qa.reply'?{id}:{success:true};
}
