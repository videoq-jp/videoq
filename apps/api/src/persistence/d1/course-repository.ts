import {and,asc,desc,eq,or,sql,type SQL} from 'drizzle-orm';
import {videoStatusSchema} from '@videoq/trpc';
import {createD1Connection} from '../../db/d1/connection';
import {videoCourses,videos,videoCourseMembers} from '../../db/schema/sqlite';
import {mapVideoListRow} from '../../repositories/video-mapping';
import {toUtcIso} from '../../shared/datetime';
import type {Bindings} from '../../types/bindings';
import type {CourseRepository,CourseDetail,CourseReadOptions} from '../contracts/course-repository';
import {NATIVE_COURSE_EXTERNAL} from './course-access';
import {videoListProjection} from './video-read-repository';
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const external=sql.raw(NATIVE_COURSE_EXTERNAL.replaceAll('course.','"video_courses".'));
const count=sql<number>`(SELECT count(*) FROM video_course_members m WHERE m.course_id="video_courses"."id")`.as('video_count');
const projection={id:videoCourses.id,name:videoCourses.name,description:videoCourses.description,display_order:videoCourses.displayOrder,
  created_at:videoCourses.createdAt,updated_at:videoCourses.updatedAt,share_slug:videoCourses.shareSlug,video_count:count,owner_user_id:videoCourses.userId};
const owned=(id:number,userId:string)=>and(eq(videoCourses.id,id),eq(videoCourses.userId,userId));
const editable=(id:number,userId:string)=>and(owned(id,userId),eq(videoCourses.managedByLms,false))!;
const readable=(userId:string)=>or(eq(videoCourses.userId,userId),and(external,sql`EXISTS(SELECT 1 FROM video_course_memberships m WHERE m.course_id=${videoCourses.id} AND m.user_id=${userId})`))!;
type Metadata={id:number;name:string;description:string;display_order:number;created_at:string;updated_at:string;share_slug:string|null;video_count:number;owner_user_id:string};
export function createD1CourseRepository(database:D1Database,env:Bindings):CourseRepository {
  const db=createD1Connection(database);
  const members=(where:SQL,options:CourseReadOptions)=>db.select({...videoListProjection,
    tags:options.includeTags===false?sql<string>`'[]'`.as('tags'):videoListProjection.tags,member_order:videoCourseMembers.order})
    .from(videoCourseMembers).innerJoin(videos,eq(videos.id,videoCourseMembers.videoId)).innerJoin(videoCourses,eq(videoCourses.id,videoCourseMembers.courseId))
    .where(where).orderBy(asc(videoCourseMembers.order),asc(videoCourseMembers.addedAt),asc(videoCourseMembers.id))
    .limit(options.videoLimit??Number.MAX_SAFE_INTEGER).offset(options.videoOffset??0);
  async function detail(course:Metadata,rows:Awaited<ReturnType<typeof members>>,viewer:'public'|{viewerUserId:string},options:CourseReadOptions):Promise<CourseDetail>{
    return {id:course.id,name:course.name,description:course.description,display_order:course.display_order,created_at:toUtcIso(course.created_at),
      updated_at:toUtcIso(course.updated_at),share_slug:course.share_slug,video_count:course.video_count,
      access_role:viewer==='public'?'public':course.owner_user_id===viewer.viewerUserId?'owner':'member',
      videos:await Promise.all(rows.map(async row=>({...await mapVideoListRow(env,row,{includeFileUrl:options.includeFileUrls!==false}),order:row.member_order})))};
  }
  async function fetchDetail(where:SQL,viewer:'public'|{viewerUserId:string},options:CourseReadOptions){
    const [courses,rows]=await db.batch([db.select(projection).from(videoCourses).where(where).limit(1),members(where,options)]);
    return courses[0]?detail(courses[0],rows,viewer,options):null;
  }
  return {
    async getInfo(courseId,ownerUserId,options){
      const where=owned(courseId,ownerUserId)!;
      const [courses,rows]=await db.batch([
        db.select({name:videoCourses.name,description:sql<string>`substr(${videoCourses.description},1,${options.courseDescriptionLimit+1})`,video_count:count})
          .from(videoCourses).where(where).limit(1),
        db.select({id:videos.id,title:videos.title,description:sql<string>`substr(${videos.description},1,${options.videoDescriptionLimit+1})`,status:videos.status,order:videoCourseMembers.order})
          .from(videoCourseMembers).innerJoin(videos,eq(videos.id,videoCourseMembers.videoId)).innerJoin(videoCourses,eq(videoCourses.id,videoCourseMembers.courseId))
          .where(where).orderBy(asc(videoCourseMembers.order),asc(videoCourseMembers.addedAt),asc(videoCourseMembers.id)).limit(options.videoLimit).offset(options.videoOffset),
      ]);
      return courses[0]?{...courses[0],videos:rows.map(row=>({...row,status:videoStatusSchema.parse(row.status)}))}:null;
    },
    getDetail:(id,userId,options={})=>fetchDetail(and(eq(videoCourses.id,id),readable(userId))!,{viewerUserId:userId},options),
    getShared:(slug,options={})=>fetchDetail(and(eq(videoCourses.shareSlug,slug),external)!,'public',options),
    async create(userId,name,description,idempotency){
      const identity=idempotency??{action:'create_course',key:`internal:${crypto.randomUUID()}`,requestHash:'0'.repeat(64)};
      const values=[userId,identity.action,identity.key];
      const results=await database.batch<{resource_id:number;request_hash:string;created:number}>([
        database.prepare(`INSERT INTO video_courses(user_id,name,description,display_order,created_at,updated_at,share_slug)
          SELECT ?,?,?,(SELECT coalesce(max(display_order),-1)+1 FROM video_courses WHERE user_id=?),${NOW},${NOW},NULL
          WHERE NOT EXISTS(SELECT 1 FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=?)`).bind(userId,name,description,userId,...values),
        database.prepare(`INSERT INTO mcp_idempotency_records(user_id,action,key,request_hash,resource_id)
          SELECT ?,?,?,?,last_insert_rowid() WHERE changes()=1`).bind(...values,identity.requestHash),
        database.prepare('SELECT resource_id,request_hash,changes() AS created FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=?').bind(...values),
        database.prepare('DELETE FROM mcp_idempotency_records WHERE user_id=? AND action=? AND key=? AND ?=0').bind(...values,idempotency?1:0),
      ]);
      const row=results[2].results[0];if(!row)throw new Error('Missing created course');
      return row.request_hash!==identity.requestHash?{idempotencyConflict:true}:{ok:true,courseId:row.resource_id,reused:!row.created};
    },
    async update(id,userId,fields){
      const where=editable(id,userId),options={includeTags:false};
      const query=fields.name!==undefined || fields.description!==undefined
        ?db.update(videoCourses).set({name:fields.name,description:fields.description}).where(where).returning(projection)
        :db.select(projection).from(videoCourses).where(where).limit(1);
      const [courses,rows]=await db.batch([query,members(where,options)]);
      return courses[0]?{course:await detail(courses[0],rows,{viewerUserId:userId},options)}:{notFound:true};
    },
    async delete(id,userId){
      const results=await database.batch([
        database.prepare(`DELETE FROM mcp_idempotency_records WHERE user_id=? AND action='create_course' AND resource_id=?
          AND EXISTS(SELECT 1 FROM video_courses WHERE id=? AND user_id=? AND managed_by_lms=0)`).bind(userId,id,id,userId),
        database.prepare('DELETE FROM video_courses WHERE id=? AND user_id=? AND managed_by_lms=0 RETURNING id').bind(id,userId),
      ]);
      return results[1].results.length?{ok:true}:{notFound:true};
    },
    async reorder(userId,ids){
      if(!ids.length || new Set(ids).size!==ids.length)return {mismatch:true};
      const encoded=JSON.stringify(ids);
      const permitted='(SELECT count(*) FROM video_courses WHERE user_id=? AND id IN(SELECT value FROM json_each(?)))=?';
      const result=await database.batch<{allowed:number}>([
        database.prepare(`SELECT (${permitted}) AS allowed`).bind(userId,encoded,ids.length),
        database.prepare(`WITH slots AS MATERIALIZED(SELECT display_order,row_number() OVER(ORDER BY display_order,id)-1 AS ordinal FROM video_courses
            WHERE user_id=? AND id IN(SELECT value FROM json_each(?))),
          desired AS MATERIALIZED(SELECT input.value AS id,slots.display_order FROM json_each(?) input JOIN slots ON slots.ordinal=CAST(input.key AS INTEGER))
          UPDATE video_courses SET display_order=(SELECT display_order FROM desired WHERE desired.id=video_courses.id)
          WHERE user_id=? AND id IN(SELECT id FROM desired) AND (${permitted})
          AND display_order<>(SELECT display_order FROM desired WHERE desired.id=video_courses.id)`)
          .bind(userId,encoded,encoded,userId,userId,encoded,ids.length),
      ]);
      return result[0].results[0].allowed?{ok:true}:{mismatch:true};
    },
    async ownedBy(id,userId){return Boolean((await db.select({id:videoCourses.id}).from(videoCourses).where(owned(id,userId)).limit(1))[0]);},
    async setShareSlug(id,userId,slug){
      try{
        const rows=await db.update(videoCourses).set({shareSlug:slug}).where(and(owned(id,userId),external)).returning({id:videoCourses.id});
        return rows.length?{ok:true}:{notFound:true};
      }catch(error){
        const cause=error instanceof Error && error.cause?error.cause:error;
        if(cause instanceof Error && /UNIQUE constraint failed.*video_courses_share_slug_ci_uniq/.test(cause.message))return {conflict:true};
        throw error;
      }
    },
    async clearShareSlug(id,userId){
      const result=await database.batch([
        database.prepare('SELECT id FROM video_courses WHERE id=? AND user_id=?').bind(id,userId),
        database.prepare("UPDATE video_courses SET share_slug=NULL WHERE id=? AND user_id=? AND coalesce(share_slug,'')<>'' RETURNING id").bind(id,userId),
      ]);
      return !result[0].results.length?{notFound:true}:result[1].results.length?{ok:true}:{notConfigured:true};
    },
    async listPage(userId,limit,offset){
      const where=readable(userId),role=sql<'owner'|'member'>`CASE WHEN ${videoCourses.userId}=${userId} THEN 'owner' ELSE 'member' END`;
      const [totals,rows]=await db.batch([
        db.select({count:sql<number>`count(*)`}).from(videoCourses).where(where),
        db.select({id:videoCourses.id,name:videoCourses.name,description:videoCourses.description,display_order:videoCourses.displayOrder,
          created_at:videoCourses.createdAt,video_count:count,access_role:role}).from(videoCourses).where(where)
          .orderBy(sql`CASE WHEN ${videoCourses.userId}=${userId} THEN 0 ELSE 1 END`,asc(videoCourses.displayOrder),desc(videoCourses.createdAt),asc(videoCourses.id)).limit(limit).offset(offset),
      ]);
      return {count:totals[0].count,results:rows.map(row=>({...row,created_at:toUtcIso(row.created_at)}))};
    },
  };
}
