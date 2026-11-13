import {normalizeInvitationEmail} from '@videoq/trpc/course-invitations';
import type {InvitationStatus} from '../../lib/course-invitations';
import type {InvitationWriteRepository} from '../contracts/invitation-write-repository';
const NATIVE=`c.managed_by_lms=0 AND c.native_access_disabled=0 AND NOT EXISTS(SELECT 1 FROM video_course_members m JOIN videos v ON v.id=m.video_id WHERE m.course_id=c.id AND v.managed_by_lms=1)`;
export function createD1InvitationWriteRepository(database:D1Database,emailDelivery:boolean):InvitationWriteRepository{
 const prepare=(query:string,args:unknown[]=[])=>database.prepare(query).bind(...args);
 return {
  async decide(action,hash,userId,now){
   const at=now.toISOString();
   for(let attempt=0;attempt<5;attempt++){
    // JS and SQLite have different Unicode case conversion. Bind a normalized
    // email only while the exact source email/verification snapshot still holds.
    const user=await prepare('SELECT email,email_verified FROM users WHERE id=?',[userId]).first<{email:string;email_verified:number}>();
    const token=crypto.randomUUID();
    const result=await database.batch<Record<string,unknown>>([
     prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'invitation_decision:'||CASE
      WHEN ?='accept' AND i.status='accepted' AND i.accepted_by_user_id=? THEN 'replay'
      WHEN i.status<>'pending' THEN 'state:'||i.status
      WHEN julianday(i.expires_at)<=julianday(?) THEN 'expired'
      WHEN u.id IS NULL OR u.email_verified<>1 THEN 'unverified'
      WHEN u.email IS NOT ? OR u.email_verified IS NOT ? THEN 'retry'
      WHEN ? IS NULL OR ?<>i.email THEN 'mismatch'
      ELSE 'apply' END,i.id
      FROM video_course_invitations i JOIN video_courses c ON c.id=i.course_id LEFT JOIN users u ON u.id=?
      WHERE i.token_hash=? AND (?='decline' OR (${NATIVE}))`,[token,action,userId,at,user?.email??null,user?.email_verified??null,user?normalizeInvitationEmail(user.email):null,user?normalizeInvitationEmail(user.email):null,userId,hash,action]),
     prepare(`INSERT INTO video_course_memberships(course_id,user_id,invitation_id,joined_at)
      SELECT i.course_id,?,i.id,? FROM video_course_invitations i JOIN mutation_receipts r ON r.resource_id=i.id
      WHERE r.token=? AND r.kind='invitation_decision:apply' AND ?='accept' ON CONFLICT DO NOTHING`,[userId,at,token,action]),
     prepare(`UPDATE video_course_invitations SET status=CASE WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:expired') THEN 'expired' ELSE ? END,
      accepted_by_user_id=CASE WHEN ?='accept' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:apply') THEN ? ELSE accepted_by_user_id END,
      accepted_at=CASE WHEN ?='accept' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:apply') THEN ? ELSE accepted_at END,updated_at=?
      WHERE id IN(SELECT resource_id FROM mutation_receipts WHERE token=? AND kind IN('invitation_decision:apply','invitation_decision:expired'))`,[token,action==='accept'?'accepted':'declined',action,token,userId,action,token,at,at,token]),
     prepare('SELECT r.kind,i.course_id FROM mutation_receipts r JOIN video_course_invitations i ON i.id=r.resource_id WHERE r.token=?',[token]),
     prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
    ]);
    const row=result[3].results[0];if(!row)return {notFound:true};
    const code=String(row.kind).slice('invitation_decision:'.length);
    if(code==='retry')continue;
    if(code==='expired')return {expired:true};if(code==='unverified')return {emailUnverified:true};if(code==='mismatch')return {emailMismatch:true};
    if(code.startsWith('state:'))return {invalidState:code.slice(6) as InvitationStatus};
    return {ok:true,courseId:Number(row.course_id)};
   }
   throw new Error('Invitation identity changed repeatedly; retry the operation');
  },
  async control(action,courseId,invitationId,ownerId,now,replacement){
   if(action==='resend'&&!replacement)throw new Error('Missing replacement token');
   const token=crypto.randomUUID(),at=now.toISOString();
   const result=await database.batch<Record<string,unknown>>([
    prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'invitation_control:'||CASE WHEN i.status<>'pending' THEN 'state:'||i.status WHEN julianday(i.expires_at)<=julianday(?) THEN 'state:expired' ELSE 'apply' END,i.id
     FROM video_course_invitations i JOIN video_courses c ON c.id=i.course_id WHERE i.id=? AND i.course_id=? AND c.user_id=? AND (?='revoke' OR (${NATIVE}))`,[token,at,invitationId,courseId,ownerId,action]),
    prepare(`UPDATE video_course_invitations SET status=CASE WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:state:expired') THEN 'expired' WHEN ?='revoke' THEN 'revoked' ELSE status END,
     token_hash=CASE WHEN ?='resend' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN ? ELSE token_hash END,
     expires_at=CASE WHEN ?='resend' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN ? ELSE expires_at END,
     delivery_status=CASE WHEN ?='resend' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN 'queued' ELSE delivery_status END,
     last_error=CASE WHEN ?='resend' AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN NULL ELSE last_error END,updated_at=?
     WHERE id IN(SELECT resource_id FROM mutation_receipts WHERE token=? AND kind IN('invitation_control:apply','invitation_control:state:expired')) AND status='pending'`,[token,action,action,token,replacement?.tokenHash??null,action,token,replacement?.expiresAt.toISOString()??null,action,token,action,token,at,token]),
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'invitation_email',json_object('invitation_id',resource_id),? FROM mutation_receipts
     WHERE token=? AND kind='invitation_control:apply' AND ?='resend' AND ?=1 ON CONFLICT DO NOTHING`,[`invitation_email:${invitationId}:${now.getTime()}`,token,action,emailDelivery?1:0]),
    prepare('SELECT kind FROM mutation_receipts WHERE token=?',[token]),
    prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
   ]);
   const row=result[3].results[0];if(!row)return {notFound:true};const code=String(row.kind).slice('invitation_control:'.length);
   return code==='apply'?{ok:true}:{invalidState:code.slice(6) as InvitationStatus};
  },
  async remove(courseId,memberId,ownerId){
   const result=await prepare(`DELETE FROM video_course_memberships WHERE course_id=? AND user_id=? AND EXISTS(SELECT 1 FROM video_courses WHERE id=? AND user_id=?) RETURNING id`,[courseId,memberId,courseId,ownerId]).all();
   return result.results.length?{ok:true}:{notFound:true};
  },
  async leave(courseId,userId){
   const result=await prepare('DELETE FROM video_course_memberships WHERE course_id=? AND user_id=? RETURNING id',[courseId,userId]).all();return result.results.length?{ok:true}:{notFound:true};
  },
 };
}
