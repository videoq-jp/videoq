import {APIError} from 'better-auth/api';
import type {Bindings} from '../../types/bindings';
import {session} from '../../db/schema/sqlite/better-auth';
import {and,asc,count,eq,gt,inArray,sql} from 'drizzle-orm';
import {toUtcIso} from '../../shared/datetime';
import {drizzle} from 'drizzle-orm/d1';
import {users} from '../../db/schema/sqlite/modern';
import {literalSearchPage} from '../../shared/literal-search';
import {buildJobMessage,JOB_DELETE_ACCOUNT_DATA} from '../../lib/job-message';
import {PLAN_CATALOG} from '../../features/billing/catalog';
import type {AdminUser,AdminUserRepository} from '../contracts/admin-user-repository';
const selected={id:users.id,username:users.username,email:users.email,
 is_active:sql<number>`NOT (COALESCE(${users.banned},0) AND (${users.banExpires} IS NULL OR julianday(${users.banExpires})>=julianday('now')))`,
 is_admin:sql<number>`instr(','||coalesce(${users.role},'')||',',',admin,')>0`,
 max_video_upload_size_mb:users.maxVideoUploadSizeMb,storage_limit_gb:users.storageLimitGb,monthly_upload_limit_gb:users.monthlyUploadLimitGb,
 processing_limit_minutes:users.processingLimitMinutes,ai_answers_limit:users.aiAnswersLimit,used_storage_bytes:users.usedStorageBytes,
 used_processing_seconds:users.usedProcessingSeconds,used_ai_answers:users.usedAiAnswers,usage_period_start:users.usagePeriodStart,
 is_over_quota:users.isOverQuota,plan_code:users.planCode,quota_source:users.quotaSource};
function map(row:Omit<AdminUser,'is_active'|'is_admin'|'quota_source'> & {is_active:number;is_admin:number;quota_source:string}):AdminUser{
 return {...row,usage_period_start:row.usage_period_start===null?null:toUtcIso(row.usage_period_start),is_active:Boolean(row.is_active),is_admin:Boolean(row.is_admin),is_over_quota:Boolean(row.is_over_quota),quota_source:row.quota_source==='admin'?'admin':'plan'};
}
export function createD1AdminUserRepository(database:D1Database,env:Bindings):AdminUserRepository{
 const db=drizzle(database);
 const find=async(id:string)=>{const [row]=await db.select(selected).from(users).where(eq(users.id,id)).limit(1).all();return row?map(row):null;};
 return {
  async patchFlags(actorId,targetId,patch,headers){
   if(actorId===targetId&&(patch.is_active===false||patch.is_admin===false))throw new APIError('BAD_REQUEST',{message:'Cannot deactivate yourself or remove your own administrator role.'});
   if(patch.is_active===undefined&&patch.is_admin===undefined)return find(targetId);
   const {createD1Auth}=await import('./auth');
   const native=createD1Auth(env,database,'browser');
   const permission=await native.api.userHasPermission({headers,body:{permissions:{user:[...(patch.is_active!==undefined?['ban' as const]:[]),...(patch.is_admin!==undefined?['set-role' as const]:[])]}}});
   if(!permission.success)throw new APIError('FORBIDDEN',{message:'Administrator permission required.'});
   const auth=await native.api.getSession({headers,query:{disableCookieCache:true}});
   if(!auth||auth.user.id!==actorId)throw new APIError('UNAUTHORIZED',{message:'Invalid administrator session.'});
   const authority=sql`EXISTS(SELECT 1 FROM session s JOIN users a ON a.id=s.user_id
    WHERE s.id=${auth.session.id} AND s.token=${auth.session.token} AND a.id=${actorId}
      AND julianday(s.expires_at)>julianday('now')
      AND instr(','||coalesce(a.role,'')||',',',admin,')>0
      AND NOT (coalesce(a.banned,0) AND (a.ban_expires IS NULL OR julianday(a.ban_expires)>=julianday('now'))))`;
   const set:Partial<typeof users.$inferInsert>={updatedAt:new Date()};
   if(patch.is_active!==undefined){set.banned=!patch.is_active;set.banExpires=null;set.banReason=patch.is_active?null:'No reason';}
   if(patch.is_admin!==undefined)set.role=patch.is_admin?'admin':'user';
   const result=await db.batch([
    db.select({allowed:sql<number>`${authority}`}).from(users).where(eq(users.id,actorId)).limit(1),
    db.update(users).set(set).where(and(eq(users.id,targetId),authority)),
    db.delete(session).where(and(eq(session.userId,targetId),sql`${patch.is_active===false?1:0}`,authority)),
    db.select(selected).from(users).where(and(eq(users.id,targetId),authority)).limit(1),
   ]).catch(()=>{
    // Drizzle errors include bound parameters, including the session token.
    // Never pass those errors to the request logger or attach them as a cause.
    throw new Error('Administrator flag persistence failed.');
   });
   if(!result[0][0]?.allowed)throw new APIError('FORBIDDEN',{message:'Administrator authorization changed.'});
   return result[3][0]?map(result[3][0]):null;
  },
  async lockForHardDelete(id){
   const message=buildJobMessage(JOB_DELETE_ACCOUNT_DATA,{user_id:id}),dedupe=`account-delete:${id}`;
   const eligible="EXISTS(SELECT 1 FROM users WHERE id=? AND instr(','||coalesce(role,'')||',',',admin,')=0)";
   const prepare=(query:string,args:unknown[])=>database.prepare(query).bind(...args);
   const result=await database.batch<Record<string,unknown>>([
    prepare("SELECT instr(','||coalesce(role,'')||',',',admin,')>0 AS is_admin FROM users WHERE id=?",[id]),
    prepare(`UPDATE users SET banned=1,ban_expires=NULL WHERE id=? AND ${eligible}`,[id,id]),
    prepare(`DELETE FROM session WHERE user_id=? AND ${eligible}`,[id,id]),
    prepare(`DELETE FROM oauth_access_token WHERE user_id=? AND ${eligible}`,[id,id]),
    prepare(`UPDATE oauth_refresh_token SET revoked=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND revoked IS NULL AND ${eligible}`,[id,id]),
    prepare(`DELETE FROM oauth_consent WHERE user_id=? AND ${eligible}`,[id,id]),
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,? WHERE ${eligible} ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({message}),dedupe,id]),
    prepare(`SELECT id,CASE WHEN json_type(payload,'$.message.job_id')='text' AND length(json_extract(payload,'$.message.job_id'))>0 THEN json_extract(payload,'$.message.job_id') ELSE json('INVALID_DELETION_JOB') END AS job_id FROM external_tasks WHERE dedupe_key=? AND ${eligible}`,[dedupe,id]),
   ]);
   const target=result[0].results[0];if(!target)return {notFound:true};if(target.is_admin)return {forbiddenAdmin:true};
   const task=result[7].results[0];if(!task||typeof task.job_id!=='string')throw new Error('Persisted deletion job ID is missing.');
   return {taskId:Number(task.id),jobId:task.job_id};
  },
  async isAdmin(id){const [row]=await db.select({role:users.role}).from(users).where(eq(users.id,id)).limit(1).all();return row?.role?.split(',').includes('admin')??false;},
  async list(q,limit,offset){
   if(!q){
    const [totals,rows]=await db.batch([db.select({n:count()}).from(users),db.select(selected).from(users).orderBy(asc(users.id)).limit(limit).offset(offset)]);
    return {count:totals[0].n,results:rows.map(map)};
   }
   const result=await literalSearchPage(q,limit,offset,after=>db.select({id:users.id,username:users.username,email:users.email}).from(users).where(after===null?undefined:gt(users.id,after)).orderBy(asc(users.id)).limit(200).all(),row=>[row.username,row.email]);
   if(!result.ids.length)return {count:result.count,results:[]};
   const rows=await db.select(selected).from(users).where(inArray(users.id,result.ids)).orderBy(asc(users.id)).all();
   return {count:result.count,results:rows.map(map)};
  },find,
  async patchQuota(id,patch){
   if(patch.quota_source==='plan'){
    const entitlement=<K extends keyof typeof PLAN_CATALOG.free.entitlements>(key:K)=>sql`CASE WHEN ${users.subscriptionStatus} IN ('active','trialing','past_due') AND ${users.planCode}='pro' THEN ${PLAN_CATALOG.pro.entitlements[key]} WHEN ${users.subscriptionStatus} IN ('active','trialing','past_due') AND ${users.planCode}='basic' THEN ${PLAN_CATALOG.basic.entitlements[key]} ELSE ${PLAN_CATALOG.free.entitlements[key]} END`;
    const [row]=await db.update(users).set({quotaSource:'plan',updatedAt:sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
     maxVideoUploadSizeMb:entitlement('maxVideoUploadSizeMb'),storageLimitGb:entitlement('storageLimitGb'),monthlyUploadLimitGb:entitlement('monthlyUploadLimitGb'),processingLimitMinutes:entitlement('processingLimitMinutes'),aiAnswersLimit:entitlement('aiAnswersLimit')})
     .where(eq(users.id,id)).returning(selected).all();return row?map(row):null;
   }
   const set:Partial<typeof users.$inferInsert>={};
   if(patch.monthly_upload_limit_gb!==undefined)set.monthlyUploadLimitGb=patch.monthly_upload_limit_gb;
   if(patch.storage_limit_gb!==undefined)set.storageLimitGb=patch.storage_limit_gb;
   if(patch.processing_limit_minutes!==undefined)set.processingLimitMinutes=patch.processing_limit_minutes;
   if(patch.ai_answers_limit!==undefined)set.aiAnswersLimit=patch.ai_answers_limit;
   if(patch.quota_source!==undefined)set.quotaSource=patch.quota_source;else if(Object.keys(set).length)set.quotaSource='admin';
   if(!Object.keys(set).length)return find(id);
   const [row]=await db.update(users).set(set).where(eq(users.id,id)).returning(selected).all();return row?map(row):null;
  },
  async patchUsage(id,patch){
   const set:Partial<typeof users.$inferInsert>={};
   if(patch.used_storage_bytes!==undefined)set.usedStorageBytes=patch.used_storage_bytes;
   if(patch.used_processing_seconds!==undefined)set.usedProcessingSeconds=patch.used_processing_seconds;
   if(patch.used_ai_answers!==undefined)set.usedAiAnswers=patch.used_ai_answers;
   if(patch.usage_period_start!==undefined)set.usagePeriodStart=patch.usage_period_start;
   if(patch.is_over_quota!==undefined)set.isOverQuota=patch.is_over_quota;
   if(!Object.keys(set).length)return find(id);
   const [row]=await db.update(users).set(set).where(eq(users.id,id)).returning(selected).all();return row?map(row):null;
  },
 };
}
