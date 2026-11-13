import {normalizeInvitationEmail} from '@videoq/trpc/course-invitations';
import {validateInvitationBatch,type InvitationCreateRepository} from '../contracts/invitation-create-repository';
const NATIVE=`c.managed_by_lms=0 AND c.native_access_disabled=0 AND NOT EXISTS(SELECT 1 FROM video_course_members m JOIN videos v ON v.id=m.video_id WHERE m.course_id=c.id AND v.managed_by_lms=1)`;
const MEMBERS=`(SELECT json_group_array(json_array(member.id,member.email)) FROM (SELECT m.id,u.email FROM video_course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=c.id ORDER BY m.id) member)`;
const GATE='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
export function createD1InvitationCreateRepository(database:D1Database,emailDelivery:boolean):InvitationCreateRepository{
 const prepare=(query:string,args:unknown[]=[])=>database.prepare(query).bind(...args);
 return {async create(courseId,ownerId,inputs){
  validateInvitationBatch(inputs);const issuedAt=inputs[0]?.createdAt??new Date();
  for(let attempt=0;attempt<5;attempt++){
   const snapshot=await prepare(`SELECT owner.email AS owner_email,${MEMBERS} AS members FROM video_courses c JOIN users owner ON owner.id=c.user_id WHERE c.id=? AND c.user_id=? AND ${NATIVE}`,[courseId,ownerId]).first<{owner_email:string;members:string}>();
   if(!snapshot)return {notFound:true};
   const emails=new Set(inputs.map(i=>i.email)),alreadyMembers=new Set<string>();
   const ownerEmail=normalizeInvitationEmail(snapshot.owner_email);if(ownerEmail&&emails.has(ownerEmail))alreadyMembers.add(ownerEmail);
   const members=JSON.parse(snapshot.members) as [number,string][];
   for(const [,raw]of members){const email=normalizeInvitationEmail(raw);if(email&&emails.has(email))alreadyMembers.add(email);}
   const token=crypto.randomUUID(),encoded=JSON.stringify(inputs.map(i=>({email:i.email,hash:i.tokenHash,expires:i.expiresAt.toISOString(),created:i.createdAt.toISOString()})));
   const result=await database.batch<Record<string,unknown>>([
    prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'invitation_create',c.id FROM video_courses c JOIN users owner ON owner.id=c.user_id
     WHERE c.id=? AND c.user_id=? AND owner.email=? AND ${MEMBERS}=? AND ${NATIVE}`,[token,courseId,ownerId,snapshot.owner_email,snapshot.members]),
    prepare(`UPDATE video_course_invitations SET status='expired',updated_at=? WHERE course_id=? AND status='pending' AND julianday(expires_at)<=julianday(?) AND ${GATE}`,[issuedAt.toISOString(),courseId,issuedAt.toISOString(),token]),
    prepare(`INSERT INTO video_course_invitations(course_id,email,invited_by_user_id,status,delivery_status,token_hash,expires_at,created_at,updated_at,send_attempts,creation_nonce)
     SELECT ?,json_extract(input.value,'$.email'),?,'pending','queued',json_extract(input.value,'$.hash'),json_extract(input.value,'$.expires'),json_extract(input.value,'$.created'),json_extract(input.value,'$.created'),0,?
     FROM json_each(?) input WHERE ${GATE}
      AND json_extract(input.value,'$.email') NOT IN(SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM video_course_invitations pending WHERE pending.course_id=? AND pending.email=json_extract(input.value,'$.email') AND pending.status='pending')
     ON CONFLICT DO NOTHING`,[courseId,ownerId,token,encoded,token,JSON.stringify([...alreadyMembers]),courseId]),
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'invitation_email',json_object('invitation_id',id),'invitation_email:'||id||':'||? FROM video_course_invitations
     WHERE creation_nonce=? AND ?=1 AND ${GATE} ON CONFLICT DO NOTHING`,[issuedAt.getTime(),token,emailDelivery?1:0,token]),
    prepare(`SELECT id,email FROM video_course_invitations WHERE creation_nonce=? AND ${GATE} ORDER BY id`,[token,token]),
    prepare('SELECT token FROM mutation_receipts WHERE token=?',[token]),
    prepare('UPDATE video_course_invitations SET creation_nonce=NULL WHERE creation_nonce=?',[token]),
    prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
   ]);
   if(!result[5].results.length)continue;
   const created=result[4].results.map(r=>({id:Number(r.id),email:String(r.email)})),createdEmails=new Set(created.map(r=>r.email));
   return {created,alreadyMemberEmails:[...alreadyMembers],alreadyPendingEmails:[...new Set(inputs.filter(i=>!alreadyMembers.has(i.email)&&!createdEmails.has(i.email)).map(i=>i.email))]};
  }
  throw new Error('Course membership changed repeatedly; retry invitation creation');
 }};
}
