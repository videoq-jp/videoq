import {ExternalTaskLeaseLostError,type ExternalTaskLease} from '../contracts/external-task-repository';
import type {InvitationDeliveryRepository} from '../contracts/invitation-delivery-repository';
import type {InvitationStatus} from '../../lib/course-invitations';
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const NATIVE=`c.managed_by_lms=0 AND c.native_access_disabled=0 AND NOT EXISTS(
 SELECT 1 FROM video_course_members m JOIN videos v ON v.id=m.video_id WHERE m.course_id=c.id AND v.managed_by_lms=1)`;
const GATE='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
export function createD1InvitationDeliveryRepository(database:D1Database):InvitationDeliveryRepository{
 const prepare=(query:string,args:unknown[]=[])=>database.prepare(query).bind(...args);
 const capture=(token:string,lease:ExternalTaskLease)=>prepare(`INSERT INTO mutation_receipts(token,kind,resource_id)
  SELECT ?,'invitation_delivery',id FROM external_tasks WHERE id=? AND attempts=? AND julianday(locked_at)>julianday('now')-5.0/1440 AND completed_at IS NULL AND dead_at IS NULL`,[token,lease.id,lease.attempt]);
 return {
  async record(outcomes,opts){
   if(!outcomes.length&&!opts.completeTask)return;
   const token=crypto.randomUUID(),encoded=JSON.stringify(outcomes.map(o=>({id:o.invitationId,status:o.status,at:o.attemptedAt.toISOString(),error:o.error?.slice(0,1000)??null})));
   const result=await database.batch([
    capture(token,opts.lease),
    prepare(`WITH outcomes AS(SELECT key AS seq,json_extract(value,'$.id') AS id,json_extract(value,'$.status') AS status,
      json_extract(value,'$.at') AS at,json_extract(value,'$.error') AS error FROM json_each(?))
     UPDATE video_course_invitations SET
      delivery_status=(SELECT status FROM outcomes WHERE id=video_course_invitations.id ORDER BY seq DESC LIMIT 1),
      last_error=(SELECT error FROM outcomes WHERE id=video_course_invitations.id ORDER BY seq DESC LIMIT 1),
      updated_at=(SELECT at FROM outcomes WHERE id=video_course_invitations.id ORDER BY seq DESC LIMIT 1),
      send_attempts=send_attempts+(SELECT count(*) FROM outcomes WHERE id=video_course_invitations.id),
      last_sent_at=coalesce((SELECT at FROM outcomes WHERE id=video_course_invitations.id AND status='sent' ORDER BY seq DESC LIMIT 1),last_sent_at)
     WHERE id IN(SELECT id FROM outcomes) AND ${GATE}`,[encoded,token]),
    prepare(`UPDATE external_tasks SET completed_at=${NOW},locked_at=NULL,last_error='',updated_at=${NOW} WHERE id=? AND ?=1 AND ${GATE}`,[opts.lease.id,opts.completeTask?1:0,token]),
    prepare('SELECT token FROM mutation_receipts WHERE token=?',[token]),
    prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
   ]);
   if(!result[3].results.length)throw new ExternalTaskLeaseLostError();
  },
  async failStranded(now,graceMs){
   const cutoff=new Date(now.getTime()-graceMs).toISOString();
   const result=await prepare(`UPDATE video_course_invitations SET delivery_status='failed',last_error='Delivery task is no longer retrying.',updated_at=?
    WHERE status='pending' AND delivery_status='queued' AND julianday(updated_at)<julianday(?) AND NOT EXISTS(
     SELECT 1 FROM external_tasks t WHERE t.kind='invitation_email' AND t.completed_at IS NULL AND t.dead_at IS NULL
     AND CAST(json_extract(t.payload,'$.invitation_id') AS INTEGER)=video_course_invitations.id)`,[now.toISOString(),cutoff]).run();
   return {failed:result.meta.changes};
  },
  async rotate(id,hash,now,lease){
   const token=crypto.randomUUID(),at=now.toISOString();
   const result=await database.batch<Record<string,unknown>>([
    capture(token,lease),
    prepare('SELECT token FROM mutation_receipts WHERE token=?',[token]),
    prepare(`UPDATE video_course_invitations SET status=CASE WHEN julianday(expires_at)<=julianday(?) THEN 'expired' ELSE status END,
     token_hash=CASE WHEN julianday(expires_at)>julianday(?) THEN ? ELSE token_hash END,updated_at=?
     WHERE id=? AND status='pending' AND ${GATE} AND EXISTS(SELECT 1 FROM video_courses c JOIN users u ON u.id=video_course_invitations.invited_by_user_id WHERE c.id=video_course_invitations.course_id AND ${NATIVE})`,[at,at,hash,at,id,token]),
    prepare(`SELECT i.status,i.email,c.name AS course_name,u.name AS inviter_name,u.username AS inviter_username
     FROM video_course_invitations i JOIN video_courses c ON c.id=i.course_id JOIN users u ON u.id=i.invited_by_user_id
     WHERE i.id=? AND ${NATIVE} AND ${GATE}`,[id,token]),
    prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
   ]);
   if(!result[1].results.length)throw new ExternalTaskLeaseLostError();
   const row=result[3].results[0];if(!row)return {notFound:true};
   if(row.status!=='pending')return {invalidState:row.status as InvitationStatus};
   return {email:String(row.email),courseName:String(row.course_name),inviterName:String(row.inviter_name).trim()||String(row.inviter_username)};
  },
 };
}
