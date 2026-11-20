import { invitationDecisionState, invitationRecipientState, invitationControlState, invitationDecisionEffects, invitationControlEffects } from '../../application/invitation-lifecycle';
import { invitationStringChoice } from '../invitation-policy-sql';
import { nativeCourseExternalSql } from './course-access';
import {normalizeInvitationEmail} from '@videoq/domain/course-invitations';
import type {InvitationStatus} from '../../lib/course-invitations';
import type {InvitationWriteRepository} from '../contracts/invitation-write-repository';
const NATIVE=nativeCourseExternalSql('c');
export function createD1InvitationWriteRepository(database:D1Database,emailDelivery:boolean):InvitationWriteRepository{
 const prepare=(query:string,args:unknown[]=[])=>database.prepare(query).bind(...args);
 return {
  async decide(action,hash,userId,now){
   const at=now.toISOString(),effects=invitationDecisionEffects(action);
   const recipient=invitationRecipientState({unverified:'u.id IS NULL OR u.email_verified<>1',identityChanged:'u.email IS NOT ? OR u.email_verified IS NOT ?',emailMismatch:'? IS NULL OR ?<>i.email'},
    {unverified:"'unverified'",retry:"'retry'",mismatch:"'mismatch'",apply:"'apply'"},invitationStringChoice);
   const state=invitationDecisionState({accepting:'?',accepted:"i.status='accepted'",acceptedByActor:'i.accepted_by_user_id=?',notPending:"i.status<>'pending'",expired:'julianday(i.expires_at)<=julianday(?)'},
    {replay:"'replay'",invalidState:"'state:'||i.status",expired:"'expired'",recipient},invitationStringChoice);
   for(let attempt=0;attempt<5;attempt++){
    // JS and SQLite have different Unicode case conversion. Bind a normalized
    // email only while the exact source email/verification snapshot still holds.
    const user=await prepare('SELECT email,email_verified FROM users WHERE id=?',[userId]).first<{email:string;email_verified:number}>();
    const token=crypto.randomUUID();
    const result=await database.batch<Record<string,unknown>>([
     prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'invitation_decision:'||${state},i.id
      FROM video_course_invitations i JOIN video_courses c ON c.id=i.course_id LEFT JOIN users u ON u.id=?
      WHERE i.token_hash=? AND (?=0 OR (${NATIVE}))`,[token,Number(effects.addMembership),userId,at,user?.email??null,user?.email_verified??null,user?normalizeInvitationEmail(user.email):null,user?normalizeInvitationEmail(user.email):null,userId,hash,Number(effects.requiresNative)]),
     prepare(`INSERT INTO video_course_memberships(course_id,user_id,invitation_id,joined_at)
      SELECT i.course_id,?,i.id,? FROM video_course_invitations i JOIN mutation_receipts r ON r.resource_id=i.id
      WHERE r.token=? AND r.kind='invitation_decision:apply' AND ?=1 ON CONFLICT DO NOTHING`,[userId,at,token,Number(effects.addMembership)]),
     prepare(`UPDATE video_course_invitations SET status=CASE WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:expired') THEN 'expired' ELSE ? END,
      accepted_by_user_id=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:apply') THEN ? ELSE accepted_by_user_id END,
      accepted_at=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_decision:apply') THEN ? ELSE accepted_at END,updated_at=?
      WHERE id IN(SELECT resource_id FROM mutation_receipts WHERE token=? AND kind IN('invitation_decision:apply','invitation_decision:expired'))`,[token,effects.status,Number(effects.addMembership),token,userId,Number(effects.addMembership),token,at,at,token]),
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
   const effects=invitationControlEffects(action);
   if(effects.rotateToken&&!replacement)throw new Error('Missing replacement token');
   const token=crypto.randomUUID(),at=now.toISOString();
   const state=invitationControlState({notPending:"i.status<>'pending'",expired:'julianday(i.expires_at)<=julianday(?)'},
    {invalidState:"'state:'||i.status",expired:"'state:expired'",apply:"'apply'"},invitationStringChoice);
   const result=await database.batch<Record<string,unknown>>([
    prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'invitation_control:'||${state},i.id
     FROM video_course_invitations i JOIN video_courses c ON c.id=i.course_id WHERE i.id=? AND i.course_id=? AND c.user_id=? AND (?=0 OR (${NATIVE}))`,[token,at,invitationId,courseId,ownerId,Number(effects.requiresNative)]),
    prepare(`UPDATE video_course_invitations SET status=CASE WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:state:expired') THEN 'expired' WHEN ?=0 THEN 'revoked' ELSE status END,
     token_hash=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN ? ELSE token_hash END,
     expires_at=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN ? ELSE expires_at END,
     delivery_status=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN 'queued' ELSE delivery_status END,
     last_error=CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND kind='invitation_control:apply') THEN NULL ELSE last_error END,updated_at=?
     WHERE id IN(SELECT resource_id FROM mutation_receipts WHERE token=? AND kind IN('invitation_control:apply','invitation_control:state:expired')) AND status='pending'`,[token,Number(effects.rotateToken),Number(effects.rotateToken),token,replacement?.tokenHash??null,Number(effects.rotateToken),token,replacement?.expiresAt.toISOString()??null,Number(effects.rotateToken),token,Number(effects.rotateToken),token,at,token]),
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'invitation_email',json_object('invitation_id',resource_id),? FROM mutation_receipts
     WHERE token=? AND kind='invitation_control:apply' AND ?=1 AND ?=1 ON CONFLICT DO NOTHING`,[`invitation_email:${invitationId}:${now.getTime()}`,token,Number(effects.rotateToken),emailDelivery?1:0]),
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
